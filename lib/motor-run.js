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

    // Nested kinematic multi-rate budgets (both Δθ-paced, so dt → ∞ as ω → 0 is
    // bounded by the caller's dt). Two coupled instabilities at a coarse fixed dt,
    // both fixed by Δθ-bounding (verified — neither is circuit stiffness):
    //   • CIRCUIT: the explicit motional EMF ω·(dL/dθ)·i is a first-order-in-Δθ
    //     extrapolation of the θ-varying coefficients; it diverges once the rotor
    //     turns more than a few degrees per advance (coeff staleness). Bounded by
    //     maxDtheta (default 2°; onset ~5-9°).
    //   • MECHANICS: a light rotor has Δω = τ·dt/J per step (tens of rad/s at a
    //     coarse dt), so torque sampled/integrated once per coarse step kicks θ
    //     and feeds back. The field solve + mechanical integrate run at the
    //     coarser maxDthetaTorque (default 15° — resolves motion-relevant torque
    //     ripple) with mdt small enough to bound Δω, the circuit nested finer.
    // When |ω|·dt is below both budgets this is a single full step (Kt=Kc=1),
    // reproducing the prior path for slow machines and pinned-ω tests.
    var maxDtheta       = opts.maxDtheta != null       ? opts.maxDtheta       : (2  * Math.PI / 180);
    var maxDthetaTorque = opts.maxDthetaTorque != null ? opts.maxDthetaTorque : (15 * Math.PI / 180);

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

      // Outer loop: TORQUE/MECHANICS sub-steps of mdt ≤ maxDthetaTorque of rotation.
      var Kt = 1;
      if (maxDthetaTorque > 0 && state.omega !== 0) {
        Kt = Math.ceil(Math.abs(state.omega) * dt / maxDthetaTorque);
        if (Kt < 1) Kt = 1;
      }
      var mdt = dt / Kt;

      // Reused across all sub-steps (rebuilt each circuit advance from the drive).
      var terminalStates = new Array(m);
      var V = new Float64Array(m);
      var R = new Float64Array(m);
      var Iimp = new Float64Array(m);

      for (var mt = 0; mt < Kt; mt++) {
        // ω is held across this torque sub-step's circuit advances (updated once
        // below by the mechanical integrate). θ and t advance kinematically.
        var w = state.omega;

        // Inner loop: CIRCUIT sub-steps of cdt ≤ maxDtheta of rotation.
        var Kc = 1;
        if (maxDtheta > 0 && w !== 0) {
          Kc = Math.ceil(Math.abs(w) * mdt / maxDtheta);
          if (Kc < 1) Kc = 1;
        }
        var cdt = mdt / Kc;
        var thLast = state.theta;  // angle of the last circuit advance (field-solve angle)

        for (var ct = 0; ct < Kc; ct++) {
          // Step 1: commutation context at the intra-step angle/time
          var ctx = { t: state.t, theta: state.theta, stepIndex: state.stepIndex };

          // Step 2: evaluate terminal conditions
          var conditions = LIB.Excitation.evalDrive(circuits, ctx);

          // Step 3: build circuit-step inputs (every slot rewritten each advance)
          for (var k = 0; k < m; k++) {
            var cond = conditions[k];
            if (cond.kind === "open") {
              terminalStates[k] = "OPEN"; V[k] = 0; Iimp[k] = 0;
            } else if (cond.kind === "short") {
              terminalStates[k] = "SHORT"; V[k] = 0; Iimp[k] = 0;
            } else if (cond.kind === "current") {
              terminalStates[k] = "CURRENT"; Iimp[k] = cond.I; V[k] = 0;
            } else {
              // kind === "voltage" — map all voltage conditions to "DC"
              terminalStates[k] = "DC"; V[k] = cond.V; Iimp[k] = 0;
            }
            R[k] = circuits[k].R;
          }

          // Step 4: fetch coefficients at the intra-step angle (cached by bin)
          var coeffs = cache.coeffs(state.theta, extractFn);

          // Step 5: advance currents (coupled R when a cage end-ring matrix exists)
          var advanced = LIB.MotorCircuit.advance(coeffs, {
            R:              Rmatrix || R,
            V:              V,
            i:              state.i,
            omega:          w,
            dt:             cdt,
            terminalStates: terminalStates,
            Iimp:           Iimp,
          });
          state.i = advanced.i;

          // Advance angle/time kinematically (ω held within this torque sub-step)
          thLast = state.theta;
          state.theta = state.theta + w * cdt;
          state.t = state.t + cdt;
        }

        // Step 6: solve field + torque (Arkkio gap-band) at the resolved angle of
        // the last circuit advance — skippable fast-path. (For Kt=Kc=1, thLast =
        // θ_n, reproducing the prior solve angle exactly.)
        var tau;
        if (solveField) {
          var solved = stack.solve(thLast, state.i);
          lastSolve = solved;
          tau = solved.torque;
        } else {
          // Reuse the most-recent solve's torque (held); circuits still advanced.
          tau = lastSolve ? lastSolve.torque : 0;
        }

        // Step 7: mechanics — semi-implicit Euler with IMPLICIT damping, at mdt.
        //   ω^{n+1} = [ω^n + (τ_em − τ_load)·mdt/J] / (1 + b·mdt/J)
        // Implicit damping is unconditionally stable for any damping; in the
        // low-damping regime (b·mdt/J ≪ 1) it matches the explicit form.
        var dtOverJ = mdt / mechanical.J;
        state.omega = (w + (tau - mechanical.loadTorque) * dtOverJ) /
                      (1 + mechanical.damping * dtOverJ);
      }

      // state.theta and state.t were advanced kinematically by the circuit
      // sub-steps (Σ cdt = dt); nothing further to integrate here.
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
