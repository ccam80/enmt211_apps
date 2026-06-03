"use strict";

// =============================================================================
//  LIB.MotorRun — headless per-tick temporal driver
//
//  Owns the true-state tier and the per-tick chain:
//    excitation → circuit current step → torque → mechanical integrate
//
//  This is the single code path the mount and the milestone test both drive.
//  Consumes LIB.MotorStack (Phase 5), LIB.Excitation (Phase 3),
//  LIB.MotorCircuit (Phase 4). No DOM access.
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
    var integ = LIB.BDF.create({
      n:        m0 + 2,
      rtol:     opts.bdfRtol     != null ? opts.bdfRtol     : 1e-4,
      atol:     opts.bdfAtol     != null ? opts.bdfAtol     : 1e-6,
      method:   opts.bdfMethod   || "gear",
      dtMax:    opts.bdfDtMax    != null ? opts.bdfDtMax    : Infinity,
      dtStart:  opts.bdfDtStart  != null ? opts.bdfDtStart  : 1e-4,
      maxOrder: opts.bdfMaxOrder != null ? opts.bdfMaxOrder : 2,
    });
    var integSeeded = false;

    // Resistive coupling matrix (cage end-rings) or per-circuit diagonal R.
    function Rof(ka, kb) {
      if (Rmatrix) return Rmatrix[ka * m0 + kb];
      return ka === kb ? circuits[ka].R : 0;
    }

    // Monolithic-Newton warm-start carried across steps: the per-slice converged
    // field A and the recovered currents. warmA = null ⇒ cold field start (after
    // reset/seed); solveCoupled converges from A=0 in a handful of iterations.
    var warmA = null;
    var prevI = new Float64Array(m0);

    // Pooled drive-eval + seed scratch (no hot-path allocation).
    var _ctx   = { t: 0, theta: 0, stepIndex: 0 };
    var _conds = new Array(m0);
    for (var _ci = 0; _ci < m0; _ci++) _conds[_ci] = { kind: "", V: 0, I: 0 };
    var _lamSeed = new Float64Array(m0 + 2);

    var coupleTol    = opts.coupleTol      != null ? opts.coupleTol      : 1e-9;
    var coupleTolFld = opts.coupleTolField != null ? opts.coupleTolField : 1e-7;
    var maxCouple    = opts.maxCouple      != null ? opts.maxCouple      : 25;
    var lastCouple   = 0;   // Newton iterations of the last step (diagnostics)

    // One BDF step's residual function for the adaptive integrator: solve the
    // monolithic field-circuit-motion system for the new differential state
    // y = [λ,ω,θ] given the integrator's (ag0, hist). out ← [λ,ω,θ]; the field A
    // and currents i are recovered and carried as warm-start. The drive is
    // evaluated at the predicted angle so the terminal conditions match this step.
    function stepSolve(tNew, dt, ag0, hist, yGuess, out) {
      var th = yGuess[IDX_TH];
      _ctx.t = tNew; _ctx.theta = th; _ctx.stepIndex = state.stepIndex;
      LIB.Excitation.evalDriveInto(circuits, _ctx, _conds);

      var res = stack.solveCoupled({
        ag0: ag0, hist: hist, cond: _conds, Rof: Rof,
        J: mechanical.J, damping: mechanical.damping, loadTorque: mechanical.loadTorque,
        warm: { A: warmA, i: prevI, omega: yGuess[IDX_W], theta: th },
        tol: coupleTol, tolField: coupleTolFld, maxIter: maxCouple,
      });

      for (var k = 0; k < m0; k++) out[k] = res.lambda[k];
      out[IDX_W] = res.omega;
      out[IDX_TH] = res.theta;

      // Carry the converged field + currents for the next step's warm-start, and
      // post-process the field once for viz/readouts (NO second field solve —
      // fieldBundle just recovers nodal A + B + projections from the converged A).
      warmA = res.A;
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
    //  runtime.step(dt) → state
    //
    //  Advance `dt` of sim-time with the adaptive integrator. Each accepted
    //  sub-step is ONE monolithic field-circuit-motion Newton (stepSolve →
    //  stack.solveCoupled); the LTE controller sizes the step. Field viz /
    //  readouts read the converged lastSolve.
    // -------------------------------------------------------------------------
    function step(dt) {
      if (stateDiverged()) syncStateToInteg();

      var tEnd = integ.t + dt;
      var guard = 0;
      while (integ.t < tEnd - 1e-15 && guard++ < 100000) {
        if (integ.t + integ.dt > tEnd) integ.dt = tEnd - integ.t;
        integ.step(stepSolve);
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
      reset:            reset,
      clearFieldCache:  clearFieldCache,
    };
  }

  LIB.MotorRun = { create: create };
})();
