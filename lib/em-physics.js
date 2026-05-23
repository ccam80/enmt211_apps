"use strict";

// =============================================================================
//  LIB.EM — electromagnetic primitives for AC-motor lessons.
//
//  Models a coil as a circular current loop embedded in 3D world space:
//
//    LIB.EM.loop({ center, normal, radius, N=1, R, L, axis_u? }) → Loop
//      Frozen object holding the loop's pose + circuit parameters:
//        center    — 3D point, loop's geometric centre
//        n         — unit normal (loop axis, right-hand rule from i)
//        u, v      — orthonormal in-plane axes (v = n × u). u defaults to an
//                    arbitrary perpendicular to n; pass axis_u to pin it.
//        radius    — scalar (m)
//        N         — turns
//        R         — winding resistance (Ω) — optional, lesson reads it back
//        L         — self-inductance (H)   — optional, lesson reads it back
//        A         — π·radius²            (m²)
//
//      Derived geometry (n, u, v) is recomputed if you re-call loop(); the
//      result is frozen so lessons that need to *move* a coil should call
//      loop() afresh each frame with the new pose.
//
//    LIB.EM.sampleLoopPoints(loop, K=64) → [{x,y,z}, …]
//      K points evenly spaced around the loop, k → center + r·(cosθ·u + sinθ·v)
//      with θ = 2π·k/K. Used by the renderer to project the wire to screen.
//
//    LIB.EM.pointOnLoop(loop, phi) → {x,y,z}
//      Single point at angle φ rad. Used by current-dot animation to write
//      dots at arbitrary phase without allocating a sample array.
//
//    LIB.EM.moment(loop, current) → {x,y,z}
//      Magnetic dipole moment m = N·I·A·n.
//
//  --- Mutual inductance ---
//
//    LIB.EM.Mneumann(loopA, loopB, K=24) → scalar (H)
//      Numerical Neumann formula:
//        M = (μ₀/4π) · ∮_A ∮_B (dl_A · dl_B) / |r_A − r_B|
//      Sampled with K segments per loop, each segment treated as a chord with
//      midpoint and tangent. Multiplied by N_A·N_B for multi-turn coils.
//      O(K²) per call. K=24 is a good speed/accuracy tradeoff for typical
//      AC-motor geometries (rotor inside stator, well separated wires).
//
//    LIB.EM.dM_dq(loopFn, q, dq=1e-3, K=24) → { M, dMdq }
//      Convenience: builds M for two loops at parameter q and at q+dq via the
//      caller-provided loopFn(q) → [loopA, loopB] and returns the central-
//      difference derivative dM/dq. Used by lessons to get dM/dθ for the
//      back-EMF and torque terms.
//
//  --- Coupled RL solver ---
//
//    LIB.EM.solveCurrentRates(Lmat, R, V, dLdt, i) → di/dt[]
//      Solve  Lmat · (di/dt) = V − R·i − dLdt·i
//      where:
//        Lmat   row-major Float64Array of length N²; full inductance matrix
//               (self on diagonal, mutual off-diagonal). MUST be symmetric.
//        R      Float64Array of length N; per-coil resistance.
//        V      Float64Array of length N; applied terminal voltage.
//        dLdt   row-major Float64Array of length N²; time-derivative of Lmat.
//               For an AC-motor lesson with rotor angle θ, this is
//               (dLmat/dθ) · ω evaluated at the current θ.
//        i      Float64Array of length N; current in each coil now.
//      Returns Float64Array of length N. Gaussian-elimination solve.
//
//  --- Torque ---
//
//    LIB.EM.coenergyTorque(dLmat_dθ, currents) → scalar (N·m)
//      τ = ½ · iᵀ · (dL/dθ) · i
//      Standard co-energy formulation: derivative of (1/2)Σ_ij i_i·L_ij·i_j
//      with respect to θ at constant currents. Self-inductance terms vanish
//      (dL_ii/dθ = 0 for a rigid coil), so only mutual-inductance angular
//      dependence shows up.
//
//  --- AC drive ---
//
//    LIB.EM.acVoltage(t, amp, omega, phase=0) → V_amp · sin(ω·t + φ)
//      Convenience for sinusoidal terminal-voltage sources.
//
//  --- Vector helpers (3-vectors as plain {x,y,z}) ---
//
//    LIB.EM.v3 = { add, sub, scale, dot, cross, norm, normalize, axisFromNormal }
//
//  Zero dependencies. The Gaussian solver is private to this module so EM
//  doesn't pull in lib/integrate.js.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  const MU0_OVER_4PI = 1e-7;   // μ₀/4π in SI (henries per metre).

  // ---------------------------------------------------------------------------
  //  vector helpers
  // ---------------------------------------------------------------------------

  function vAdd(a, b)  { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  function vSub(a, b)  { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  function vScale(a,k) { return { x: a.x * k,    y: a.y * k,    z: a.z * k    }; }
  function vDot(a, b)  { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function vCross(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }
  function vNorm(a) { return Math.hypot(a.x, a.y, a.z); }
  function vNormalize(a) {
    const n = vNorm(a) || 1;
    return { x: a.x / n, y: a.y / n, z: a.z / n };
  }
  // Pick any unit vector perpendicular to n. Robust against the world axis
  // most parallel to n by choosing whichever world axis is least aligned.
  function axisFromNormal(n) {
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    let ref;
    if (ax <= ay && ax <= az)      ref = { x: 1, y: 0, z: 0 };
    else if (ay <= ax && ay <= az) ref = { x: 0, y: 1, z: 0 };
    else                            ref = { x: 0, y: 0, z: 1 };
    return vNormalize(vCross(n, ref));
  }

  // ---------------------------------------------------------------------------
  //  Loop primitive
  // ---------------------------------------------------------------------------

  function loop(spec) {
    if (!spec || !spec.center || !spec.normal) {
      throw new Error("LIB.EM.loop: { center, normal, radius } required");
    }
    const center = { x: +spec.center.x, y: +spec.center.y, z: +spec.center.z };
    const n      = vNormalize(spec.normal);
    const u      = spec.axis_u ? vNormalize(spec.axis_u) : axisFromNormal(n);
    // Re-orthogonalise u against n in case axis_u was supplied non-perpendicular.
    const uPerp  = vNormalize(vSub(u, vScale(n, vDot(u, n))));
    const v      = vNormalize(vCross(n, uPerp));
    const radius = +spec.radius;
    const N      = (spec.N != null) ? Math.max(1, Math.round(+spec.N)) : 1;
    const A      = Math.PI * radius * radius;
    return Object.freeze({
      center, n, u: uPerp, v, radius, N, A,
      R: (spec.R != null) ? +spec.R : 0,
      L: (spec.L != null) ? +spec.L : 0,
    });
  }

  function pointOnLoop(lp, phi) {
    const c = Math.cos(phi), s = Math.sin(phi);
    return {
      x: lp.center.x + lp.radius * (c * lp.u.x + s * lp.v.x),
      y: lp.center.y + lp.radius * (c * lp.u.y + s * lp.v.y),
      z: lp.center.z + lp.radius * (c * lp.u.z + s * lp.v.z),
    };
  }
  function tangentOnLoop(lp, phi) {
    // d/dφ pointOnLoop = r·(−sin·u + cos·v).  Magnitude = r (so this is
    // *not* a unit tangent; multiply by dφ to get an arc-length segment.)
    const c = Math.cos(phi), s = Math.sin(phi);
    return {
      x: lp.radius * (-s * lp.u.x + c * lp.v.x),
      y: lp.radius * (-s * lp.u.y + c * lp.v.y),
      z: lp.radius * (-s * lp.u.z + c * lp.v.z),
    };
  }

  function sampleLoopPoints(lp, K) {
    K = Math.max(3, Math.round(+K || 64));
    const pts = new Array(K);
    const dPhi = 2 * Math.PI / K;
    for (let k = 0; k < K; k++) pts[k] = pointOnLoop(lp, k * dPhi);
    return pts;
  }

  function moment(lp, current) {
    const m = lp.N * current * lp.A;
    return { x: m * lp.n.x, y: m * lp.n.y, z: m * lp.n.z };
  }

  // ---------------------------------------------------------------------------
  //  Mutual inductance — Neumann formula, numerical
  //
  //  M = (μ₀/4π) · ∮_A ∮_B (dl_A · dl_B) / |r_A − r_B|
  //
  //  We discretise each loop into K equal arcs centred at φ_k = (k+0.5)·2π/K
  //  with tangent dl_k = tangentOnLoop(loop, φ_k) · dφ. Midpoint quadrature is
  //  second-order in dφ, which is enough for the smooth 1/r kernel between two
  //  non-touching loops.
  //
  //  The N_A·N_B factor accounts for multi-turn windings (each turn links the
  //  same flux from the other coil's current).
  // ---------------------------------------------------------------------------

  function Mneumann(loopA, loopB, K) {
    K = Math.max(8, Math.round(+K || 24));
    const dPhi = 2 * Math.PI / K;
    const pA = new Array(K), tA = new Array(K);
    const pB = new Array(K), tB = new Array(K);
    for (let k = 0; k < K; k++) {
      const phi = (k + 0.5) * dPhi;
      pA[k] = pointOnLoop(loopA, phi);
      pB[k] = pointOnLoop(loopB, phi);
      tA[k] = tangentOnLoop(loopA, phi);
      tB[k] = tangentOnLoop(loopB, phi);
    }
    let acc = 0;
    for (let i = 0; i < K; i++) {
      const a = pA[i], ta = tA[i];
      for (let j = 0; j < K; j++) {
        const b = pB[j], tb = tB[j];
        const rx = a.x - b.x, ry = a.y - b.y, rz = a.z - b.z;
        const r  = Math.hypot(rx, ry, rz);
        if (r < 1e-9) continue;            // skip pathological coincident sample
        const dot = ta.x * tb.x + ta.y * tb.y + ta.z * tb.z;
        acc += dot / r;
      }
    }
    return MU0_OVER_4PI * loopA.N * loopB.N * acc * dPhi * dPhi;
  }

  // ---------------------------------------------------------------------------
  //  dM/dq via central difference. loopFn(q) → [loopA, loopB]. The caller
  //  is responsible for keeping all other geometry constant — only the
  //  parameter q (typically rotor angle θ) should drive the change.
  // ---------------------------------------------------------------------------

  function dM_dq(loopFn, q, dq, K) {
    dq = (dq != null) ? +dq : 1e-3;
    const [aPlus,  bPlus ] = loopFn(q + dq);
    const [aMinus, bMinus] = loopFn(q - dq);
    const Mp = Mneumann(aPlus,  bPlus,  K);
    const Mm = Mneumann(aMinus, bMinus, K);
    const [a0, b0] = loopFn(q);
    const M0 = Mneumann(a0, b0, K);
    return { M: M0, dMdq: (Mp - Mm) / (2 * dq) };
  }

  // ---------------------------------------------------------------------------
  //  Coupled RL solver
  //
  //    L · (di/dt) = V − R·i − (dL/dt)·i
  //
  //  L is symmetric (mutual inductance is symmetric M_ij = M_ji), so the
  //  Gaussian-elimination solve below is well-conditioned for any physically
  //  realisable matrix. dL/dt is *not* symmetric in general — the lesson
  //  computes it as (dL/dθ)·ω at the current θ.
  // ---------------------------------------------------------------------------

  // Solve M·x = r in place. Returns x (new Float64Array). Mutates M and r.
  function gaussSolve(M, r, n) {
    for (let i = 0; i < n; i++) {
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

  function solveCurrentRates(Lmat, R, V, dLdt, i) {
    const n = R.length;
    // Build M = L (copy, will be mutated by solver) and r = V − R·i − dLdt·i.
    const M = new Float64Array(n * n);
    const r = new Float64Array(n);
    for (let row = 0; row < n; row++) {
      let acc = V[row] - R[row] * i[row];
      for (let col = 0; col < n; col++) {
        M[row * n + col] = Lmat[row * n + col];
        acc -= dLdt[row * n + col] * i[col];
      }
      r[row] = acc;
    }
    return gaussSolve(M, r, n);
  }

  // ---------------------------------------------------------------------------
  //  Torque from co-energy
  //
  //    τ = ½ · iᵀ · (dL/dθ) · i
  //
  //  Holds for any linear magnetic system (saturation aside). The factor of ½
  //  is the standard one — applies to BOTH self and mutual terms in the
  //  symmetric sum, but self-inductance terms drop out because they don't
  //  depend on θ for a rigid coil.
  // ---------------------------------------------------------------------------

  function coenergyTorque(dLdth, currents) {
    const n = currents.length;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const ii = currents[i];
      for (let j = 0; j < n; j++) {
        acc += ii * dLdth[i * n + j] * currents[j];
      }
    }
    return 0.5 * acc;
  }

  // ---------------------------------------------------------------------------
  //  AC source helper
  // ---------------------------------------------------------------------------

  function acVoltage(t, amp, omega, phase) {
    return amp * Math.sin(omega * t + (phase || 0));
  }

  // ---------------------------------------------------------------------------
  //  Public surface
  // ---------------------------------------------------------------------------

  LIB.EM = {
    MU0_OVER_4PI,
    loop,
    sampleLoopPoints, pointOnLoop, tangentOnLoop,
    moment,
    Mneumann, dM_dq,
    solveCurrentRates,
    coenergyTorque,
    acVoltage,
    v3: {
      add: vAdd, sub: vSub, scale: vScale,
      dot: vDot, cross: vCross,
      norm: vNorm, normalize: vNormalize,
      axisFromNormal,
    },
  };
})();
