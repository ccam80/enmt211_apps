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
      // solveField (default true): when false, skip the expensive per-step
      // nonlinear field solve (Step 6) and reuse the most-recent torque for the
      // mechanical integration. The circuit currents and mechanics still advance
      // every step from the cached per-θ-bin coefficients (cheap), so 240 Hz
      // current/rotor accuracy is preserved. The LIVE app uses this multi-rate
      // fast-path — solving the full field only when the rotor has advanced past
      // a small Δθ (so cogging/ripple stays θ-resolved where it's visible) and
      // once per render frame for the field viz. Default true ⇒ solve every step
      // (unchanged behaviour for the headless tests).
      var solveField = !opts || opts.solveField !== false;
      var m = stack.nCircuits;

      // Step 1: commutation context
      var ctx = {
        t:         state.t,
        theta:     state.theta,
        stepIndex: state.stepIndex,
      };

      // Step 2: evaluate terminal conditions
      var conditions = LIB.Excitation.evalDrive(circuits, ctx);

      // Step 3: build circuit-step inputs
      var terminalStates = new Array(m);
      var V = new Float64Array(m);
      var R = new Float64Array(m);

      for (var k = 0; k < m; k++) {
        var cond = conditions[k];
        if (cond.kind === "open") {
          terminalStates[k] = "OPEN";
          V[k] = 0;
        } else if (cond.kind === "short") {
          terminalStates[k] = "SHORT";
          V[k] = 0;
        } else {
          // kind === "voltage" — map all voltage conditions to "DC"
          // (Phase 4 stepCurrents branches only on OPEN/SHORT and uses V[k]
          // for every other token)
          terminalStates[k] = "DC";
          V[k] = cond.V;
        }
        R[k] = circuits[k].R;
      }

      // Step 4: fetch coefficients (cached by bin, extracted on miss)
      var coeffs = cache.coeffs(state.theta, function (thC) {
        return stack.extractCoeffs(thC);
      });

      // Step 5: advance currents
      var advanced = LIB.MotorCircuit.advance(coeffs, {
        R:              R,
        V:              V,
        i:              state.i,
        omega:          state.omega,
        dt:             dt,
        terminalStates: terminalStates,
      });
      state.i = advanced.i;

      // Step 6: solve field + torque (Arkkio gap-band) — skippable fast-path
      var tau;
      if (solveField) {
        var solved = stack.solve(state.theta, state.i);
        lastSolve = solved;
        tau = solved.torque;
      } else {
        // Reuse the most-recent solve's torque (held); circuits still advanced above.
        tau = lastSolve ? lastSolve.torque : 0;
      }

      // Step 7: mechanics — semi-implicit Euler with IMPLICIT damping.
      //   ω^{n+1} = ω^n + (τ_em − b·ω^{n+1} − τ_load)·dt/J
      // ⇒ ω^{n+1} = [ω^n + (τ_em − τ_load)·dt/J] / (1 + b·dt/J)
      // Treating the damping term implicitly is unconditionally stable for any
      // damping; the previous explicit form (b·ω^n) diverges once b·dt/J > 2,
      // which the damping slider reaches for small-inertia machines. In the
      // low-damping regime (b·dt/J ≪ 1) this is identical to the explicit form,
      // so headless machine trajectories are unchanged.
      var dtOverJ = dt / mechanical.J;
      state.omega = (state.omega + (tau - mechanical.loadTorque) * dtOverJ) /
                    (1 + mechanical.damping * dtOverJ);
      state.theta = state.theta + state.omega * dt;

      // Step 8: advance time
      state.t = state.t + dt;

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
