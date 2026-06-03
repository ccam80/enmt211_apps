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

    // Build the θ-binned coefficient cache.
    var cache = LIB.MotorCircuit.makeCache({
      period: TWO_PI,
      binCount: opts.binCount !== undefined ? opts.binCount : 360,
    });

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

    // Hoisted coeff-extraction closure (avoids re-allocating it per sub-step).
    var extractFn = function (thC) { return stack.extractCoeffs(thC); };

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

    // Adaptive integrator over y = [i_0…i_{m-1}, ω, θ] (machine ODE: L(θ)·di/dt =
    // V − R·i − ω·(dL/dθ·i + dλpm/dθ); J·dω/dt = T − load − damping·ω; dθ/dt = ω).
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

    // Pooled per-sub-step scratch (no hot-path allocation).
    var terminalStates = new Array(m0);
    var Vbuf = new Float64Array(m0);
    var Rbuf = new Float64Array(m0);
    var Iimp = new Float64Array(m0);
    var Mff  = new Float64Array(m0 * m0);   // free×free system (stride = #free currents)
    var RHSf = new Float64Array(m0);
    var freeIdx = new Int32Array(m0);
    var _yseed = new Float64Array(m0 + 2);
    var _icur  = new Float64Array(m0);
    var _ctx   = { t: 0, theta: 0, stepIndex: 0 };
    var _conds = new Array(m0);
    for (var _ci = 0; _ci < m0; _ci++) _conds[_ci] = { kind: "", V: 0, I: 0 };

    function Rof(ka, kb) {
      if (Rmatrix) return Rmatrix[ka * m0 + kb];
      return ka === kb ? Rbuf[ka] : 0;
    }

    // Dense Gaussian elimination with partial pivoting (n×n, row-major stride n;
    // solution overwrites b). n = #free currents, small (≤ m0).
    function gaussSolve(A, b, n) {
      var col, r, cc;
      for (col = 0; col < n; col++) {
        var piv = col, best = Math.abs(A[col * n + col]);
        for (r = col + 1; r < n; r++) { var v = Math.abs(A[r * n + col]); if (v > best) { best = v; piv = r; } }
        if (piv !== col) {
          for (cc = 0; cc < n; cc++) { var tmp = A[col * n + cc]; A[col * n + cc] = A[piv * n + cc]; A[piv * n + cc] = tmp; }
          var tb = b[col]; b[col] = b[piv]; b[piv] = tb;
        }
        var d0 = A[col * n + col]; if (Math.abs(d0) < 1e-300) d0 = d0 < 0 ? -1e-300 : 1e-300;
        for (r = col + 1; r < n; r++) {
          var f = A[r * n + col] / d0; if (f === 0) continue;
          for (cc = col; cc < n; cc++) A[r * n + cc] -= f * A[col * n + cc];
          b[r] -= f * b[col];
        }
      }
      for (r = n - 1; r >= 0; r--) {
        var s = b[r];
        for (cc = r + 1; cc < n; cc++) s -= A[r * n + cc] * b[cc];
        var dd = A[r * n + r]; if (Math.abs(dd) < 1e-300) dd = dd < 0 ? -1e-300 : 1e-300;
        b[r] = s / dd;
      }
    }

    // One implicit BDF sub-step for [i, ω, θ] at frozen torque Tval and coeffs at
    // thPred: ω (scalar) → θ (scalar) → free currents (dense solve).
    function solveCircuitMech(tNew, ag0, hist, Tval, thPred, out) {
      var coeffs = cache.coeffs(thPred, extractFn);
      var L = coeffs.L, dLdth = coeffs.dLdth, dlpm = coeffs.dLambdaPmdth;
      _ctx.t = tNew; _ctx.theta = thPred; _ctx.stepIndex = state.stepIndex;
      LIB.Excitation.evalDriveInto(circuits, _ctx, _conds);
      var k;
      for (k = 0; k < m0; k++) {
        var c = _conds[k];
        if (c.kind === "open")        { terminalStates[k] = "OPEN";    Vbuf[k] = 0;   Iimp[k] = 0; }
        else if (c.kind === "short")  { terminalStates[k] = "SHORT";   Vbuf[k] = 0;   Iimp[k] = 0; }
        else if (c.kind === "current"){ terminalStates[k] = "CURRENT"; Vbuf[k] = 0;   Iimp[k] = c.I; }
        else                          { terminalStates[k] = "DC";      Vbuf[k] = c.V; Iimp[k] = 0; }
        Rbuf[k] = circuits[k].R;
      }

      // ω: (J·ag0 + damping)·ω = T − load − J·hist_ω
      var wNew = (Tval - mechanical.loadTorque - mechanical.J * hist[IDX_W]) /
                 (mechanical.J * ag0 + mechanical.damping);
      // θ: ag0·θ = ω − hist_θ
      var thNew = (wNew - hist[IDX_TH]) / ag0;

      // Currents: pinned (CURRENT→Iimp, OPEN→0) set directly; free (DC/SHORT)
      // solved from  (ag0·L + R + ω·dL/dθ)·i = Veff − ω·dλpm − L·hist_i.
      var nf = 0;
      for (k = 0; k < m0; k++) {
        if (terminalStates[k] === "CURRENT") out[k] = Iimp[k];
        else if (terminalStates[k] === "OPEN") out[k] = 0;
        else freeIdx[nf++] = k;
      }
      var a, b, d;
      for (a = 0; a < nf; a++) {
        var ra = freeIdx[a];
        var rhs = (terminalStates[ra] === "SHORT" ? 0 : Vbuf[ra]) - wNew * dlpm[ra];
        for (b = 0; b < m0; b++) rhs -= L[ra * m0 + b] * hist[b];        // −L·hist_i (all currents)
        for (b = 0; b < m0; b++) {                                        // move pinned columns to RHS
          if (terminalStates[b] === "CURRENT" || terminalStates[b] === "OPEN") {
            var ic = out[b];
            if (ic !== 0) rhs -= (ag0 * L[ra * m0 + b] + Rof(ra, b) + wNew * dLdth[ra * m0 + b]) * ic;
          }
        }
        RHSf[a] = rhs;
        for (d = 0; d < nf; d++) {
          var rc = freeIdx[d];
          Mff[a * nf + d] = ag0 * L[ra * m0 + rc] + Rof(ra, rc) + wNew * dLdth[ra * m0 + rc];
        }
      }
      gaussSolve(Mff, RHSf, nf);
      for (a = 0; a < nf; a++) out[freeIdx[a]] = RHSf[a];

      out[IDX_W] = wNew;
      out[IDX_TH] = thNew;
    }

    // Coupled sub-step: iterate field-solve ⇄ circuit/mechanics to a consistent
    // fixed point so T, i, and ω satisfy their implicit equations together (the
    // map ω→T(i(ω))→ω contracts via dT/dω<0). Block-iteration form of the
    // monolithic coupling — no ∂T/∂A; bordered Newton is the later acceleration.
    var _ywork = new Float64Array(m0 + 2);
    var coupleTol = opts.coupleTol != null ? opts.coupleTol : 1e-5;
    var maxCouple = opts.maxCouple != null ? opts.maxCouple : 12;
    var lastCouple = 0;   // coupling iterations of the last sub-step (diagnostics)
    function coupledStepSolve(tNew, dt, ag0, hist, yGuess, out) {
      var k;
      for (k = 0; k < m0 + 2; k++) _ywork[k] = yGuess[k];
      var it = 0;
      for (; it < maxCouple; it++) {
        for (k = 0; k < m0; k++) _icur[k] = _ywork[k];
        var solved = stack.solve(_ywork[IDX_TH], _icur);
        lastSolve = solved; lastIters = solved.iters;
        solveCircuitMech(tNew, ag0, hist, solved.torque, _ywork[IDX_TH], out);
        var dmax = Math.abs(out[IDX_W] - _ywork[IDX_W]) / (Math.abs(out[IDX_W]) + 1);
        for (k = 0; k < m0; k++) {
          var dk = Math.abs(out[k] - _ywork[k]) / (Math.abs(out[k]) + 1);
          if (dk > dmax) dmax = dk;
        }
        for (k = 0; k < m0 + 2; k++) _ywork[k] = out[k];
        if (dmax < coupleTol) { it++; break; }
      }
      lastCouple = it;
    }

    function syncStateToInteg() {
      for (var k = 0; k < m0; k++) _yseed[k] = state.i[k];
      _yseed[IDX_W] = state.omega;
      _yseed[IDX_TH] = state.theta;
      integ.setState(_yseed, state.t);
      integSeeded = true;
    }
    function syncIntegToState() {
      for (var k = 0; k < m0; k++) state.i[k] = integ.y[k];
      state.omega = integ.y[IDX_W];
      state.theta = integ.y[IDX_TH];
      state.t = integ.t;
    }
    // External mutation of `state` (reset / seedState) ⇒ re-seed the integrator.
    function stateDiverged() {
      if (!integSeeded) return true;
      if (state.omega !== integ.y[IDX_W] || state.theta !== integ.y[IDX_TH] || state.t !== integ.t) return true;
      for (var k = 0; k < m0; k++) if (state.i[k] !== integ.y[k]) return true;
      return false;
    }

    // -------------------------------------------------------------------------
    //  runtime.step(dt) → state
    //
    //  Advance `dt` of sim-time with the adaptive integrator. Each accepted
    //  sub-step solves field + circuit + mechanics together to a consistent
    //  fixed point (coupledStepSolve); the LTE controller sizes the step. Field
    //  viz / readouts read the converged lastSolve.
    // -------------------------------------------------------------------------
    function step(dt) {
      if (stateDiverged()) syncStateToInteg();

      var tEnd = integ.t + dt;
      var guard = 0;
      while (integ.t < tEnd - 1e-15 && guard++ < 100000) {
        if (integ.t + integ.dt > tEnd) integ.dt = tEnd - integ.t;
        integ.step(coupledStepSolve);
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
    //  Zeroes all true-state fields and clears the warm-start + coefficient caches.
    // -------------------------------------------------------------------------
    function reset() {
      state.theta     = 0;
      state.omega     = 0;
      state.t         = 0;
      state.stepIndex = 0;
      state.i         = new Float64Array(stack.nCircuits);
      stack.clearWarmStart();
      cache.clear();
      lastSolve = null;
    }

    // -------------------------------------------------------------------------
    //  runtime.clearFieldCache()
    //
    //  Geometry-edit invalidation: clears the warm-start cache and the
    //  coefficient cache without zeroing true state (theta, omega, i, t).
    // -------------------------------------------------------------------------
    function clearFieldCache() {
      stack.clearWarmStart();
      cache.clear();
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
