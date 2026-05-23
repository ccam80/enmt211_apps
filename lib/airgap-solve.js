"use strict";

// =============================================================================
//  LIB.AirgapSolve — Jacobi-preconditioned CG solver + global saturation ceiling
//
//  pcg(op, b, opts) → { x, iters, residual }
//    Jacobi-PCG against op.matvec / op.diagonal.
//    Warm-startable via opts.x0.
//    Stops when ‖r‖₂ / ‖b‖₂ ≤ tol or iters === maxIter.
//    Holds the pinned node fixed (index 0).
//
//  solveSaturated(op, b, opts) → { x, iters, residual, satScale }
//    1. Linear solve via pcg.
//    2. Compute Bpeak over ironMask cells.  s = max(1, (Bpeak/Bknee)^p).
//    3. If s > 1: op.setIronScale(s), one corrective pcg (warm-started),
//       then op.setIronScale(1) to restore.
//    4. Return final x, total iters, final residual, satScale.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  // Euclidean norm of a Float64Array
  function norm2(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
  }

  // Dot product
  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  // ---------------------------------------------------------------------------
  //  pcg(op, b, { x0, tol, maxIter }) → { x, iters, residual }
  // ---------------------------------------------------------------------------
  function pcg(op, b, { x0 = null, tol = 1e-6, maxIter = 400 } = {}) {
    const N = b.length;
    const pin = 0;

    // Initial guess
    const x = new Float64Array(N);
    if (x0) {
      for (let i = 0; i < N; i++) x[i] = x0[i];
    }
    // Pin the gauge node
    x[pin] = 0;

    // Diagonal (Jacobi preconditioner)
    const diag = op.diagonal();

    // r = b - A*x
    const Ax = op.matvec(x);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = b[i] - Ax[i];
    r[pin] = 0;

    const bnorm = norm2(b);
    // If b is zero, solution is zero
    if (bnorm === 0) {
      return { x, iters: 0, residual: 0 };
    }

    // z = M^{-1} r  (Jacobi preconditioner: z = r / diag)
    const z = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      z[i] = (i === pin || diag[i] === 0) ? 0 : r[i] / diag[i];
    }

    // p = z
    const p = new Float64Array(N);
    for (let i = 0; i < N; i++) p[i] = z[i];

    let rz = dot(r, z);
    let iters = 0;
    let residual = norm2(r) / bnorm;

    while (residual > tol && iters < maxIter) {
      // q = A*p
      const q = op.matvec(p);
      q[pin] = 0;

      const pq = dot(p, q);
      if (pq === 0) break;

      const alpha = rz / pq;

      // x = x + alpha * p
      for (let i = 0; i < N; i++) x[i] += alpha * p[i];
      x[pin] = 0;

      // r = r - alpha * q
      for (let i = 0; i < N; i++) r[i] -= alpha * q[i];
      r[pin] = 0;

      // z = M^{-1} r
      for (let i = 0; i < N; i++) {
        z[i] = (i === pin || diag[i] === 0) ? 0 : r[i] / diag[i];
      }

      const rz_new = dot(r, z);
      const beta = rz_new / rz;
      rz = rz_new;

      // p = z + beta * p
      for (let i = 0; i < N; i++) p[i] = z[i] + beta * p[i];
      p[pin] = 0;

      iters++;
      residual = norm2(r) / bnorm;
    }

    return { x, iters, residual };
  }

  // ---------------------------------------------------------------------------
  //  solveSaturated(op, b, { x0, tol, maxIter, ceiling }) → { x, iters, residual, satScale }
  //    ceiling = { enabled=true, Bknee=1.6, p=2, ironMask }
  // ---------------------------------------------------------------------------
  function solveSaturated(op, b, {
    x0 = null,
    tol = 1e-6,
    maxIter = 400,
    ceiling = {},
  } = {}) {
    const {
      enabled = true,
      Bknee = 1.6,
      p = 2,
      ironMask,
    } = ceiling;

    // Step 1: linear solve
    const result1 = pcg(op, b, { x0, tol, maxIter });
    let totalIters = result1.iters;

    if (!enabled || !ironMask) {
      return {
        x: result1.x,
        iters: totalIters,
        residual: result1.residual,
        satScale: 1,
      };
    }

    // Step 2: compute Bpeak over iron cells
    const { Br, Bt } = op.field(result1.x);
    let Bpeak = 0;
    for (let idx = 0; idx < ironMask.length; idx++) {
      if (ironMask[idx]) {
        const Bmag = Math.hypot(Br[idx], Bt[idx]);
        if (Bmag > Bpeak) Bpeak = Bmag;
      }
    }

    const s = Math.max(1, Math.pow(Bpeak / Bknee, p));

    if (s === 1) {
      // Below the knee — identity, single solve
      return {
        x: result1.x,
        iters: totalIters,
        residual: result1.residual,
        satScale: 1,
      };
    }

    // Step 3: corrective solve with scaled iron reluctivity
    op.setIronScale(s, ironMask);
    const result2 = pcg(op, b, { x0: result1.x, tol, maxIter });
    op.setIronScale(1, ironMask);
    totalIters += result2.iters;

    return {
      x: result2.x,
      iters: totalIters,
      residual: result2.residual,
      satScale: s,
    };
  }

  LIB.AirgapSolve = { pcg, solveSaturated };
})();
