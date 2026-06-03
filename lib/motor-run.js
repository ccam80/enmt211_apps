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

    // Adaptive-Δθ stepping budgets. step(dt) consumes dt in full-solve sub-steps,
    // each bounded so the rotor advances ≤ maxDthetaElec ELECTRICAL and ≤ maxDthetaMech
    // MECHANICAL — a fixed coarse dt aliases the torque ripple at speed (f_ripple ≫
    // Nyquist) and feeds a wrong cycle-mean to the mechanics; bounding Δθ resolves it.
    // ω is bounded to change ≤ maxDomega per sub-step (the startup Δω=τ·dt/J kick on
    // a light rotor). One full field solve per sub-step; symplectic kick-then-drift
    // mechanics (energy-stable for the synchronous oscillator). When |ω| and τ are
    // small the bounds exceed dt ⇒ a single full step (slow machines, pinned-ω tests).
    var maxDthetaElec = opts.maxDthetaElec != null ? opts.maxDthetaElec : (3 * Math.PI / 180);
    var maxDthetaMech = opts.maxDthetaMech != null ? opts.maxDthetaMech : (3 * Math.PI / 180);
    var maxDomega     = opts.maxDomega     != null ? opts.maxDomega     : 5;

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
    var lastIters = 0;   // Newton iters of the last solve (adaptive-dt cost signal / diagnostics)

    // -------------------------------------------------------------------------
    //  runtime.step(dt) → state
    //
    //  Per-tick chain:
    //   1. Build commutation context.
    //   2. Evaluate drive conditions (excitation).
    //   3. Fetch/compute circuit coefficients from cache.
    //   4. Advance currents (implicit step).
    //   5. Solve field + torque (Arkkio).
    //   6. Integrate mechanics (semi-implicit Euler).
    //   7. Advance time.
    // -------------------------------------------------------------------------
    function step(dt, opts) {
      // solveField (default true): when false, skip the per-step nonlinear field
      // solve (Step 6) and reuse the most-recent torque; circuit + mechanics still
      // advance from the cached per-θ-bin coefficients. Default true ⇒ full field
      // solve every step. No caller passes false — the app full-solves each step.
      var solveField = !opts || opts.solveField !== false;
      var m = stack.nCircuits;
      var pp = poles > 0 ? poles : 1;

      // Reused across all sub-steps (rebuilt each from the drive).
      var terminalStates = new Array(m);
      var V = new Float64Array(m);
      var R = new Float64Array(m);
      var Iimp = new Float64Array(m);

      // Advance the circuit currents by `hdt`, evaluating the drive at (tDrive, thC)
      // and the motional EMF at `omega`. Mutates state.i in place.
      function advanceCircuit(thC, tDrive, omega, hdt) {
        var conditions = LIB.Excitation.evalDrive(circuits, { t: tDrive, theta: thC, stepIndex: state.stepIndex });
        for (var k = 0; k < m; k++) {
          var cond = conditions[k];
          if (cond.kind === "open") {
            terminalStates[k] = "OPEN"; V[k] = 0; Iimp[k] = 0;
          } else if (cond.kind === "short") {
            terminalStates[k] = "SHORT"; V[k] = 0; Iimp[k] = 0;
          } else if (cond.kind === "current") {
            terminalStates[k] = "CURRENT"; Iimp[k] = cond.I; V[k] = 0;
          } else {
            terminalStates[k] = "DC"; V[k] = cond.V; Iimp[k] = 0;
          }
          R[k] = circuits[k].R;
        }
        var coeffs = cache.coeffs(thC, extractFn);
        state.i = LIB.MotorCircuit.advance(coeffs, {
          R: Rmatrix || R, V: V, i: state.i, omega: omega, dt: hdt,
          terminalStates: terminalStates, Iimp: Iimp,
        }).i;
      }

      // Consume `dt` of sim-time in adaptive full-solve sub-steps. Each sub-step is a
      // time-symmetric LEAPFROG: drift the circuit + θ by a half-step, KICK ω with the
      // torque solved at the time-and-θ-CENTERED midpoint, then drift the second half.
      // The midpoint evaluation is what makes it 2nd-order in time: a torque held from
      // the sub-step START rectifies a fast AC drive into spurious net work (a driven-
      // system energy-injection defect — it spuriously self-starts a synchronous motor);
      // the centered evaluation cancels that to O(sdt²). Sub-step size is bounded so the
      // rotor advances ≤ a few electrical/mechanical degrees (ripple resolved — no
      // aliasing) and ω changes ≤ maxDomega (startup kick bounded). The Δω bound uses
      // the previous sub-step's midpoint torque (`tauHeld`); it is seeded by one solve
      // on the very first call (lastSolve === null) so the first startup kick is bounded.
      var tauHeld;
      if (lastSolve) {
        tauHeld = lastSolve.torque;
      } else {
        var s0 = stack.solve(state.theta, state.i);
        lastSolve = s0; lastIters = s0.iters; tauHeld = s0.torque;
      }

      var remaining = dt;
      var guard = 0;
      while (remaining > 1e-15 && guard++ < 20000) {
        // Sub-step dt from the accuracy/stability bounds (Δω uses the held midpoint τ).
        var sdt = remaining;
        var dtThE = maxDthetaElec / (Math.abs(state.omega) * pp + 1e-9); // electrical-ripple cap
        var dtThM = maxDthetaMech / (Math.abs(state.omega) + 1e-9);      // mechanical (slot/cogging) cap
        var dtW   = maxDomega * mechanical.J / (Math.abs(tauHeld - mechanical.loadTorque) + 1e-12); // Δω cap
        if (dtThE < sdt) sdt = dtThE;
        if (dtThM < sdt) sdt = dtThM;
        if (dtW   < sdt) sdt = dtW;
        if (!(sdt > 0) || !isFinite(sdt)) sdt = remaining;
        var half = 0.5 * sdt;

        // DRIFT (first half): circuit + θ by half with the OLD ω, drive at t_n.
        advanceCircuit(state.theta, state.t, state.omega, half);
        state.theta = state.theta + state.omega * half;
        var tMid = state.t + half;

        // KICK: torque at the time-and-θ-centered midpoint → ω update over the full sdt.
        var tau;
        if (solveField) {
          var solved = stack.solve(state.theta, state.i);
          lastSolve = solved; lastIters = solved.iters; tau = solved.torque;
        } else {
          tau = lastSolve ? lastSolve.torque : 0;
        }
        tauHeld = tau;
        var wNew = (state.omega + (tau - mechanical.loadTorque) * sdt / mechanical.J) /
                   (1 + mechanical.damping * sdt / mechanical.J);

        // DRIFT (second half): circuit + θ by half with the NEW ω, drive at the midpoint.
        advanceCircuit(state.theta, tMid, wNew, half);
        state.theta = state.theta + wNew * half;
        state.omega = wNew;
        state.t = state.t + sdt;
        remaining -= sdt;
      }

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
