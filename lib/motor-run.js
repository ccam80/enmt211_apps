"use strict";

// =============================================================================
//  LIB.MotorRun — headless per-tick temporal driver
//
//  Owns the true-state tier and the per-tick chain:
//    excitation → circuit current step → torque → mechanical integrate
//
//  This is the single code path the mount and the milestone test both drive.
//  Consumes LIB.MotorStack, LIB.Excitation, LIB.MotorCircuit. No DOM access.
//
//  State tiers (Reset-zeroed): theta, omega, i[], stepIndex, t.
//  Derived each tick (not stored in state): field, λ, torque (in lastSolve).
//  Config (persists across Reset): circuits, mechanical, poles.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const TWO_PI = 2 * Math.PI;

  // ---------------------------------------------------------------------------
  //  LIB.MotorRun.create(expanded, opts = {}) → runtime
  //
  //  expanded = {
  //    slices:     [ { section, offset }, … ],
  //    nCircuits:  number,
  //    circuits:   [ { terminal, commutation, R }, … ],
  //    mechanical: { J, damping, loadTorque },
  //    poles:      number,
  //    …
  //  }
  //
  //  opts are forwarded to LIB.MotorStack.create (and thus to each MotorSlice).
  //  opts.binCount overrides the cache bin count (default: 360).
  // ---------------------------------------------------------------------------
  function create(expanded, opts) {
    opts = opts || {};

    // Build the spatial aggregator (N≥1 slices, unconditional loop).
    var stack = LIB.MotorStack.create(expanded, opts);

    // Mutable drive specs — the mount mutates terminal.amp/freq/etc. via sliders.
    var circuits = expanded.circuits;

    // Optional coupled (off-diagonal) resistance matrix (Float64Array(m*m)) for
    // resistively-coupled circuits — e.g. a rotor cage's end rings. Built once
    // from geometry by config-schema.expand(); null for machines with only
    // independent (diagonal-R) circuits. When present it is passed to the circuit
    // step in place of the per-circuit diagonal R vector.
    var Rmatrix = expanded.Rcoupling || null;

    // Mutable mechanical params — the mount mutates loadTorque via sliders.
    var mechanical = {
      J:           expanded.mechanical.J,
      damping:     expanded.mechanical.damping !== undefined ? expanded.mechanical.damping : 0,
      loadTorque:  expanded.mechanical.loadTorque !== undefined ? expanded.mechanical.loadTorque : 0,
      frictionTorque: expanded.mechanical.frictionTorque !== undefined ? expanded.mechanical.frictionTorque : 0,
    };

    var poles = expanded.poles;

    // True-state tier (Reset-zeroed).
    var state = {
      theta:     0,
      omega:     0,
      i:         new Float64Array(stack.nCircuits),
      t:         0,
      stepIndex: 0,
    };

    // Last solve result (derived — cleared on Reset).
    var lastSolve = null;
    var lastIters = 0;   // Newton iters of the last field solve (diagnostics)

    // Adaptive integrator over the DIFFERENTIAL state y = [λ_0…λ_{m-1}, ω, θ].
    // Full field-coupled DAE: λ_k(A,θ) is the TRUE field flux linkage (not a
    // lumped L·i). Each BDF step is ONE monolithic field-circuit-motion Newton
    // (stack.solveCoupled) — NO field⇄circuit operator splitting. The field A and
    // the currents i are algebraic; i is recovered each step and carried as the
    // next step's warm-start. LTE is measured on [λ,ω,θ], the genuine states.
    var m0 = stack.nCircuits;
    var IDX_W = m0, IDX_TH = m0 + 1;
    var bdfRtol = opts.bdfRtol != null ? opts.bdfRtol : 1e-3;

    // Resistive coupling matrix (cage end-rings) or per-circuit diagonal R.
    function Rof(ka, kb) {
      if (Rmatrix) return Rmatrix[ka * m0 + kb];
      return ka === kb ? circuits[ka].R : 0;
    }

    // -------- per-state physical LTE error scales --------
    // The LTE weight is atol_i + rtol_i·|y_i|. A scalar atol across flux
    // (~1e-3 Wb), speed (~1e2 rad/s) and a monotonically growing angle mis-scales
    // the practical error, so anchor each state to its own physical magnitude:
    //   λ_k : atol = rtol · (characteristic flux) — max of |λpm_k| and |L_kk·I_rated|
    //   ω   : atol = rtol · ω_ref (small speed floor; rtol·|ω| dominates once spinning)
    //   θ   : atol = rtol · (2π/poles) ABSOLUTE, rtol_θ = 0 — the field repeats every
    //         pole pitch, so angle resolution must NOT loosen as θ accumulates.
    // The flux linkage IS the integrated state, so size its atol to the flux
    // itself, from the field solve (linear material — the cold-start solve is
    // cheap and robust where the saturating product solve can stall at high
    // current). λpm comes from a zero-current solve; each circuit's self-
    // inductance flux from a single-circuit solve (so inter-phase cancellation
    // at θ=0 cannot shrink any circuit's scale).
    var iRated = new Float64Array(m0);
    for (var _k = 0; _k < m0; _k++) {
      var _amp = (circuits[_k].terminal && circuits[_k].terminal.amp) ? Math.abs(circuits[_k].terminal.amp) : 0;
      var _R = Math.abs(Rof(_k, _k)) || 1;
      iRated[_k] = _amp / _R;
    }
    var _lamPM = stack.linearFluxLinkages(0, new Float64Array(m0));   // PM flux λpm
    var atolVec = new Float64Array(m0 + 2);
    var rtolVec = new Float64Array(m0 + 2);
    var _ek = new Float64Array(m0);
    for (var _k2 = 0; _k2 < m0; _k2++) {
      _ek.fill(0); _ek[_k2] = iRated[_k2];
      var _Lflux = stack.linearFluxLinkages(0, _ek)[_k2] - _lamPM[_k2];   // L_kk·I_rated
      var _lamRef = Math.max(Math.abs(_lamPM[_k2]), Math.abs(_Lflux), 1e-12);
      atolVec[_k2] = bdfRtol * _lamRef;
      rtolVec[_k2] = bdfRtol;
    }
    var omegaRef = opts.omegaRef != null ? opts.omegaRef : 1.0;       // rad/s reference floor
    atolVec[IDX_W]  = bdfRtol * omegaRef;            rtolVec[IDX_W]  = bdfRtol;
    atolVec[IDX_TH] = bdfRtol * (2 * Math.PI / poles); rtolVec[IDX_TH] = 0;   // absolute angle

    var integ = LIB.BDF.create({
      n:        m0 + 2,
      rtol:     rtolVec,
      atol:     atolVec,
      method:   opts.bdfMethod   || "gear",
      // Finite backstop on the adaptive step. At steady state the LTE estimate → 0
      // and the step would otherwise grow without bound, racing integ.t past float64
      // resolution (integ.t + dt == integ.t) — at which point the advance loop in
      // step() stops firing and the sim silently freezes. 10 ms sits far above any
      // LTE-limited transient step, so it only binds on a genuinely settled machine.
      dtMax:    opts.bdfDtMax    != null ? opts.bdfDtMax    : 1e-2,
      dtStart:  opts.bdfDtStart  != null ? opts.bdfDtStart  : 1e-4,
      maxOrder: opts.bdfMaxOrder != null ? opts.bdfMaxOrder : 2,
      // Step control tuned for the monolithic solve: cap growth (the LTE estimate
      // over-reaches into rejects at the default 4) and hold dt through small
      // changes (dead band) to keep the variable-step Gear history clean.
      maxGrow:  opts.bdfMaxGrow  != null ? opts.bdfMaxGrow  : 2,
      growDbLo: opts.bdfGrowDbLo != null ? opts.bdfGrowDbLo : 0.9,
      growDbHi: opts.bdfGrowDbHi != null ? opts.bdfGrowDbHi : 1.1,
    });
    var integSeeded = false;

    // Monolithic-Newton warm-start carried across steps: the per-slice converged
    // field A and the recovered currents. warmA = null ⇒ cold field start (after
    // reset/seed); solveCoupled converges from A=0 in a handful of iterations.
    var warmA = null;
    // Axial flux-loop fluxes Φ, warm-started across steps like A — else the coupled
    // Newton burns an extra iteration each step dragging Φ up from 0. Empty for
    // machines with no axial loop. null ⇒ cold Φ start (after reset/seed).
    var warmPhi = null;
    var prevI = new Float64Array(m0);

    // Commutation/drive-discontinuity breakpoint. A commandStep (or an external drive
    // change via breakpoint()) makes the residual discontinuous; the next step() must
    // restart the integrator at the event instead of integrating across it.
    var _breakpoint = false;

    // Pooled drive-eval + seed scratch (no hot-path allocation).
    var _ctx   = { t: 0, theta: 0, stepIndex: 0 };
    var _conds = new Array(m0);
    for (var _ci = 0; _ci < m0; _ci++) _conds[_ci] = { kind: "", V: 0, I: 0 };
    var _lamSeed = new Float64Array(m0 + 2);

    // Newton convergence is per-equation RELATIVE (see stack.solveCoupled). Tie it
    // to 0.1·rtol so the algebraic (Newton) error sits an order below the time-
    // truncation (LTE) error — no point converging the step tighter than the
    // discretization that defines it. rtol 1e-3 ⇒ relTol 1e-4.
    var relTol     = opts.coupleRelTol != null ? opts.coupleRelTol : 0.1 * bdfRtol;
    var maxCouple  = opts.maxCouple    != null ? opts.maxCouple    : 25;
    var lastCouple = 0;   // Newton iterations of the last step (diagnostics)

    // One BDF step's residual function for the adaptive integrator: solve the
    // monolithic field-circuit-motion system for the new differential state
    // y = [λ,ω,θ] given the integrator's (ag0, hist). out ← [λ,ω,θ]; the field A
    // and currents i are recovered and carried as warm-start. The drive is
    // evaluated at the predicted angle so the terminal conditions match this step.
    function stepSolve(tNew, dt, ag0, hist, yGuess, out) {
      // θ predictor: dθ/dt = ω EXACTLY, so θ_end ≈ θ_start + ω·dt is a first-order
      // extrapolation that starts the Newton (and the drive eval) at the step-end
      // angle instead of the step-start value — a near-free reduction in iterations.
      var th = yGuess[IDX_TH] + yGuess[IDX_W] * dt;
      _ctx.t = tNew; _ctx.theta = th; _ctx.stepIndex = state.stepIndex;
      LIB.Excitation.evalDriveInto(circuits, _ctx, _conds);

      var res = stack.solveCoupled({
        ag0: ag0, hist: hist, cond: _conds, Rof: Rof,
        J: mechanical.J, damping: mechanical.damping, loadTorque: mechanical.loadTorque,
        frictionTorque: mechanical.frictionTorque,
        warm: { A: warmA, i: prevI, omega: yGuess[IDX_W], theta: th, Phi: warmPhi },
        relTol: relTol, maxIter: maxCouple,
      });

      for (var k = 0; k < m0; k++) out[k] = res.lambda[k];
      out[IDX_W] = res.omega;
      out[IDX_TH] = res.theta;

      // Carry the converged field + currents for the next step's warm-start, and
      // post-process the field once for viz/readouts (NO second field solve —
      // fieldBundle just recovers nodal A + B + projections from the converged A).
      warmA = res.A;
      warmPhi = res.Phi;
      prevI = res.i;
      lastIters = res.iters;
      lastCouple = res.iters;
      lastSolve = stack.fieldBundle(res.A, res.theta);
      lastSolve.iters = res.iters;
    }

    function syncStateToInteg() {
      // Seed the differential state from the true (i, ω, θ): map i → flux λ via
      // ONE field solve at the current operating point (the only place a field
      // solve is needed to enter the λ-state; every subsequent step recovers i
      // from the coupled Newton). A cold field warm-start follows the (re)seed.
      var fl = stack.solve(state.theta, state.i).fluxLinkages;
      for (var k = 0; k < m0; k++) _lamSeed[k] = fl[k];
      _lamSeed[IDX_W] = state.omega;
      _lamSeed[IDX_TH] = state.theta;
      integ.setState(_lamSeed, state.t);
      integSeeded = true;
      warmA = null;
      warmPhi = null;
      for (k = 0; k < m0; k++) prevI[k] = state.i[k];
    }
    function syncIntegToState() {
      for (var k = 0; k < m0; k++) state.i[k] = prevI[k];   // i: recovered current
      state.omega = integ.y[IDX_W];
      state.theta = integ.y[IDX_TH];
      state.t = integ.t;
    }
    // External mutation of `state` (reset / seedState) ⇒ re-seed the integrator.
    // integ.y now holds [λ,ω,θ], so compare ω/θ/t and the recovered currents.
    function stateDiverged() {
      if (!integSeeded) return true;
      if (state.omega !== integ.y[IDX_W] || state.theta !== integ.y[IDX_TH] || state.t !== integ.t) return true;
      for (var k = 0; k < m0; k++) if (state.i[k] !== prevI[k]) return true;
      return false;
    }

    // -------------------------------------------------------------------------
    //  runtime.step(dt, wallBudgetMs?) → state
    //
    //  Advance `dt` of sim-time with the adaptive integrator. Each accepted
    //  sub-step is ONE monolithic field-circuit-motion Newton (stepSolve →
    //  stack.solveCoupled); the LTE controller sizes the step. Field viz /
    //  readouts read the converged lastSolve.
    //
    //  When `wallBudgetMs` is given, the call returns early once that much
    //  wall-clock has elapsed — checked AFTER each solve, so at least one step
    //  always lands and the sim cannot stall. The advance is then short of `dt`;
    //  the caller compares `state.t` before/after to detect it (the live UI uses
    //  this to flag "below ordered speed"). Omitted → deterministic full-`dt`
    //  coverage with no wall-clock dependence (the path every test drives).
    // -------------------------------------------------------------------------
    function step(dt, wallBudgetMs) {
      if (stateDiverged()) syncStateToInteg();
      // Drive discontinuity since the last step: restart the BDF at the current state.
      // λ (flux) is continuous across a commutation — only the step controller resets
      // (order→1, dt→dtStart), so it re-evaluates the new drive immediately and does
      // not carry pre-event divided differences across the jump. (When stateDiverged
      // re-seeded above, the integrator is already fresh, so skip the redundant reset.)
      else if (_breakpoint && integSeeded) integ.setState(integ.y, integ.t);
      _breakpoint = false;

      // Free-run: advance the BDF at its own LTE-controlled step until it has
      // covered dt (a small overshoot is carried into the next call). The step is
      // NOT clipped to land on tEnd — clipping injected a tiny final sub-step every
      // call that wasted a solve and polluted the variable-step Gear history.
      var tEnd = integ.t + dt;
      var guard = 0;
      var wallStart = wallBudgetMs != null ? performance.now() : 0;
      while (integ.t < tEnd - 1e-15 && guard++ < 100000) {
        integ.step(stepSolve);
        if (wallBudgetMs != null && performance.now() - wallStart >= wallBudgetMs) break;
      }
      syncIntegToState();
      return state;
    }

    // -------------------------------------------------------------------------
    //  runtime.commandStep(n = 1)
    //
    //  Open-loop sequencer advance — called from a step button or stepHz timer.
    // -------------------------------------------------------------------------
    function commandStep(n) {
      state.stepIndex += (n !== undefined ? n : 1);
      _breakpoint = true;
    }

    // -------------------------------------------------------------------------
    //  runtime.reset()
    //
    //  Zeroes all true-state fields and clears the field warm-start.
    // -------------------------------------------------------------------------
    function reset() {
      state.theta     = 0;
      state.omega     = 0;
      state.t         = 0;
      state.stepIndex = 0;
      state.i         = new Float64Array(stack.nCircuits);
      stack.clearWarmStart();
      warmA = null;
      warmPhi = null;
      lastSolve = null;
    }

    // -------------------------------------------------------------------------
    //  runtime.clearFieldCache()
    //
    //  Geometry-edit invalidation: clears the field warm-start without zeroing
    //  true state (theta, omega, i, t). The next step re-seeds λ from (i,ω,θ).
    // -------------------------------------------------------------------------
    function clearFieldCache() {
      stack.clearWarmStart();
      warmA = null;
      warmPhi = null;
      integSeeded = false;
    }

    return {
      stack:            stack,
      state:            state,
      circuits:         circuits,
      mechanical:       mechanical,
      get lastSolve()   { return lastSolve; },
      step:             step,
      commandStep:      commandStep,
      breakpoint:       function () { _breakpoint = true; },
      reset:            reset,
      clearFieldCache:  clearFieldCache,
    };
  }

  LIB.MotorRun = { create: create };
})();
