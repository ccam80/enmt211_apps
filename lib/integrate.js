"use strict";

// =============================================================================
//  LIB.Integrate — fixed-step ODE integrators for spec.physics.dxdt.
//
//  Each integrator operates on a state OBJECT with named DOF keys:
//      state = { x: 1.2, v: 0.5, theta: 0, omega: 0, /* + book-keeping */ }
//      dof   = ["x", "v", "theta", "omega"]
//      dxdt(state, params, t) → { x: dx/dt, v: dv/dt, theta: dθ/dt, omega: dω/dt }
//
//  The integrator reads each DOF off `state`, advances it by `dt`, writes the
//  result back. Non-DOF keys (latches, lastTau, thermal, exploded) are NEVER
//  touched — those belong to spec.physics.preStep / postStep.
//
//  Integrators
//  -----------
//    rk4(state, dof, dxdt, params, t, dt)
//      Classic 4th-order Runge-Kutta. Default for non-stiff systems.
//
//    rk45(state, dof, dxdt, params, t, dt) → errorMagnitude
//      Cash-Karp embedded 4(5). Reports an L∞ local-error estimate so the
//      caller can decide whether to refine. The shell does NOT auto-substep;
//      a constant dt keeps plot history regular and makes pointer-driven
//      states predictable.
//
//    siEuler(state, dof, dxdt, params, t, dt)
//      Symplectic / semi-implicit Euler. Caller passes DOFs in pos/vel pairs:
//      [pos0, vel0, pos1, vel1, …]. Velocities are advanced first under the
//      current positions; positions are advanced with the new velocities.
//      Drift-free for harmonic-oscillator energy at fixed dt.
//
//    implicitEuler(state, dof, dxdt, jacobian, params, t, dt)
//      Linearly-implicit Euler (one Newton step at x_n):
//          (I − dt·J) · Δx = dt · f(x_n)
//          x_{n+1} = x_n + Δx
//      `jacobian(state, params, t)` returns ∂dxdt/∂dof as a row-major
//      Float64Array of length n². Stable at any step size for stiff linear
//      systems; mild-nonlinear systems (saturation, Coulomb friction) tolerate
//      it as long as the linearisation is valid over one dt.
//
//    implicitLinear(state, dof, A, b, dt)
//      One step of dx/dt = A·x + b via (I − dt·A)·x_{n+1} = x_n + dt·b. For
//      callers that have already linearised their physics; saves the dxdt
//      callback. A is row-major Float64Array (n²); b is Float64Array (n).
//
//  Conventions
//  -----------
//    • dxdt return is a plain object {key: number}. Missing keys are zero.
//      Keys not in `dof` are ignored.
//    • The matrix solver uses Gaussian elimination with partial pivoting.
//      n is small (≤ ~8 in practice); no pivot strategy needed.
//    • Integrators are pure of globals — no window.* reads, no scratch
//      shared between calls, fully re-entrant.
//
//  Zero dependencies. Loaded after lib/util.js by convention but doesn't
//  need it.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  // ---------- helpers ----------

  function readVec(state, dof) {
    const n = dof.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = +state[dof[i]] || 0;
    return out;
  }
  function writeVec(state, dof, vec) {
    for (let i = 0; i < dof.length; i++) state[dof[i]] = vec[i];
  }
  function evalDeriv(state, dof, dxdt, params, t) {
    const r = dxdt(state, params, t) || {};
    const n = dof.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = +r[dof[i]] || 0;
    return out;
  }

  // Solve M·x = r in place. Returns x as a new Float64Array. Uses Gaussian
  // elimination with partial pivoting. Caller's M and r are mutated.
  function gaussSolve(M, r, n) {
    for (let i = 0; i < n; i++) {
      // partial pivot
      let piv = i;
      let pivVal = Math.abs(M[i * n + i]);
      for (let k = i + 1; k < n; k++) {
        const v = Math.abs(M[k * n + i]);
        if (v > pivVal) { piv = k; pivVal = v; }
      }
      if (piv !== i) {
        for (let j = i; j < n; j++) {
          const t = M[i * n + j]; M[i * n + j] = M[piv * n + j]; M[piv * n + j] = t;
        }
        const t = r[i]; r[i] = r[piv]; r[piv] = t;
      }
      const diag = M[i * n + i] || 1e-12;
      for (let k = i + 1; k < n; k++) {
        const f = M[k * n + i] / diag;
        if (f === 0) continue;
        for (let j = i; j < n; j++) M[k * n + j] -= f * M[i * n + j];
        r[k] -= f * r[i];
      }
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = r[i];
      for (let j = i + 1; j < n; j++) s -= M[i * n + j] * x[j];
      x[i] = s / (M[i * n + i] || 1e-12);
    }
    return x;
  }

  // ---------- public ----------

  LIB.Integrate = {

    rk4(state, dof, dxdt, params, t, dt) {
      const n = dof.length;
      const x0 = readVec(state, dof);
      // Scratch state — shallow clone, reused across stages so we don't
      // allocate a new object per stage.
      const s = Object.assign({}, state);

      const k1 = evalDeriv(state, dof, dxdt, params, t);

      for (let i = 0; i < n; i++) s[dof[i]] = x0[i] + 0.5 * dt * k1[i];
      const k2 = evalDeriv(s, dof, dxdt, params, t + 0.5 * dt);

      for (let i = 0; i < n; i++) s[dof[i]] = x0[i] + 0.5 * dt * k2[i];
      const k3 = evalDeriv(s, dof, dxdt, params, t + 0.5 * dt);

      for (let i = 0; i < n; i++) s[dof[i]] = x0[i] + dt * k3[i];
      const k4 = evalDeriv(s, dof, dxdt, params, t + dt);

      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = x0[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      }
      writeVec(state, dof, out);
    },

    // Cash-Karp 4(5). Returns the L∞ local-error estimate.
    rk45(state, dof, dxdt, params, t, dt) {
      const n = dof.length;
      const x0 = readVec(state, dof);
      const s = Object.assign({}, state);

      function stage(frac, ks, ws) {
        for (let i = 0; i < n; i++) {
          let acc = x0[i];
          for (let j = 0; j < ks.length; j++) acc += dt * ws[j] * ks[j][i];
          s[dof[i]] = acc;
        }
        return evalDeriv(s, dof, dxdt, params, t + frac * dt);
      }

      const k1 = evalDeriv(state, dof, dxdt, params, t);
      const k2 = stage(1/5,  [k1], [1/5]);
      const k3 = stage(3/10, [k1, k2], [3/40, 9/40]);
      const k4 = stage(3/5,  [k1, k2, k3], [3/10, -9/10, 6/5]);
      const k5 = stage(1,    [k1, k2, k3, k4], [-11/54, 5/2, -70/27, 35/27]);
      const k6 = stage(7/8,  [k1, k2, k3, k4, k5],
                       [1631/55296, 175/512, 575/13824, 44275/110592, 253/4096]);

      const w4 = [37/378,    0, 250/621,    125/594,    0,         512/1771];
      const w5 = [2825/27648,0, 18575/48384,13525/55296,277/14336, 1/4    ];
      const out = new Float64Array(n);
      let err = 0;
      for (let i = 0; i < n; i++) {
        const ks = [k1[i], k2[i], k3[i], k4[i], k5[i], k6[i]];
        let s4 = 0, s5 = 0;
        for (let j = 0; j < 6; j++) { s4 += w4[j] * ks[j]; s5 += w5[j] * ks[j]; }
        out[i] = x0[i] + dt * s4;
        const e = Math.abs(dt * (s4 - s5));
        if (e > err) err = e;
      }
      writeVec(state, dof, out);
      return err;
    },

    // Symplectic Euler. DOF must be paired [pos0, vel0, pos1, vel1, …]; any
    // unpaired trailing DOF is advanced by plain Euler.
    siEuler(state, dof, dxdt, params, t, dt) {
      const n = dof.length;
      const x0 = readVec(state, dof);
      const k0 = evalDeriv(state, dof, dxdt, params, t);
      const xMid = new Float64Array(n);
      for (let i = 0; i < n; i++) xMid[i] = x0[i];
      // 1) advance velocities under current state
      for (let i = 0; i + 1 < n; i += 2) xMid[i + 1] = x0[i + 1] + dt * k0[i + 1];
      // 2) re-evaluate position derivatives with the new velocities
      const s = Object.assign({}, state);
      for (let i = 0; i < n; i++) s[dof[i]] = xMid[i];
      const k1 = evalDeriv(s, dof, dxdt, params, t + dt);
      for (let i = 0; i + 1 < n; i += 2) xMid[i] = x0[i] + dt * k1[i];
      // unpaired trailing DOF (rare): plain Euler
      if (n % 2 === 1) xMid[n - 1] = x0[n - 1] + dt * k0[n - 1];
      writeVec(state, dof, xMid);
    },

    // Linearly-implicit Euler. Solves (I − dt·J)·Δx = dt·f(x_n) and applies
    // x ← x + Δx. Stable at any dt for stiff *linear* systems; for mildly
    // nonlinear systems we accept the local linearisation error.
    implicitEuler(state, dof, dxdt, jacobian, params, t, dt) {
      const n = dof.length;
      const f = evalDeriv(state, dof, dxdt, params, t);
      const J = jacobian(state, params, t);
      // Build M = I − dt·J, r = dt·f
      const M = new Float64Array(n * n);
      const r = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          M[i * n + j] = (i === j ? 1 : 0) - dt * J[i * n + j];
        }
        r[i] = dt * f[i];
      }
      const dx = gaussSolve(M, r, n);
      const x0 = readVec(state, dof);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = x0[i] + dx[i];
      writeVec(state, dof, out);
    },

    // Direct implicit-Euler step for callers that have already linearised
    // their physics into dx/dt = A·x + b. Solves (I − dt·A)·x_{n+1} = x_n + dt·b.
    implicitLinear(state, dof, A, b, dt) {
      const n = dof.length;
      const x0 = readVec(state, dof);
      const M = new Float64Array(n * n);
      const r = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          M[i * n + j] = (i === j ? 1 : 0) - dt * A[i * n + j];
        }
        r[i] = x0[i] + dt * b[i];
      }
      const x = gaussSolve(M, r, n);
      writeVec(state, dof, x);
    },
  };
})();
