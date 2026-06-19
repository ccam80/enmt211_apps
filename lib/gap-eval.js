// =============================================================================
//  LIB.GapEval - polar-Laplace air-gap field reconstruction helper
// =============================================================================
//
//  Given the two gap-ring boundary fields (rotor + stator, each as a set of
//  nodal A values on a ring of radius gapR), solves the current-free annulus
//  BVP and returns the reconstructed vector potential A(r,theta) and field B
//  on a caller-supplied polar render grid.
//
//  No machine-type dispatch, no DOM access, no engine coupling internals.
//  Depends on LIB.FeaSolver (loaded before this file).
// =============================================================================
(function () {
  "use strict";
  const LIB = (typeof window !== "undefined" ? window : globalThis).LIB ||
    ((typeof window !== "undefined" ? window : globalThis).LIB = {});

  const TWO_PI = 2 * Math.PI;

  // Returns an Int32Array of indices into theta that sort it ascending.
  function sortedPerm(theta) {
    const n = theta.length;
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(i);
    arr.sort((a, b) => theta[a] - theta[b]);
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = arr[i];
    return perm;
  }

  // Periodic 4-point Catmull-Rom cubic resample of a uniformly-spaced ring.
  //   vals  - nodal A values in original node order
  //   perm  - ascending-sort permutation (perm[i] is original index of i-th sorted node)
  //   n     - node count
  //   th0   - base angle (theta[perm[0]])
  //   step  - uniform angular step (2pi/n)
  //   ang   - query angle in the ring's own frame
  function cubicRing(vals, perm, n, th0, step, ang) {
    let u = (ang - th0) / step;
    u = u - Math.floor(u / n) * n;
    const i1 = Math.floor(u);
    const t = u - i1;
    const i0 = (i1 - 1 + n) % n;
    const i2 = (i1 + 1) % n;
    const i3 = (i1 + 2) % n;
    const p0 = vals[perm[i0]], p1 = vals[perm[i1 % n]],
          p2 = vals[perm[i2]], p3 = vals[perm[i3]];
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (
      (2 * p1) +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  // Memoized BVP solver cache - keyed on (Nr, Ntheta, Rr, Rs).
  let _cache = null;

  function _cacheKey(Nr, Ntheta, Rr, Rs) {
    return Nr + "," + Ntheta + "," + Rr + "," + Rs;
  }

  function _getOrBuildSolver(Nr, Ntheta, Rr, Rs) {
    const key = _cacheKey(Nr, Ntheta, Rr, Rs);
    if (_cache && _cache.key === key) return _cache;

    const nInt = Nr - 2;
    const nTot = nInt * Ntheta;

    let solver = null;
    if (nInt >= 1) {
      const hr = (Rs - Rr) / (Nr - 1);
      const ar = 1 / (hr * hr);
      const hth = TWO_PI / Ntheta;

      const rInt = new Float64Array(nInt);
      for (let m = 0; m < nInt; m++) rInt[m] = Rr + hr * (m + 1);

      solver = LIB.FeaSolver.create();
      const cap = 5 * nTot;
      const I = new Int32Array(cap), J = new Int32Array(cap), V = new Float64Array(cap);
      let p = 0;
      const idx = (m, j) => m * Ntheta + j;

      for (let m = 0; m < nInt; m++) {
        const r = rInt[m];
        const bang = 1 / (hth * hth * r * r);
        const diag = 2 * ar + 2 * bang;
        for (let j = 0; j < Ntheta; j++) {
          const row = idx(m, j);
          const jm = (j - 1 + Ntheta) % Ntheta, jp = (j + 1) % Ntheta;
          I[p] = row; J[p] = row;           V[p] = diag;  p++;
          I[p] = row; J[p] = idx(m, jm);    V[p] = -bang; p++;
          I[p] = row; J[p] = idx(m, jp);    V[p] = -bang; p++;
          if (m > 0)        { I[p] = row; J[p] = idx(m - 1, j); V[p] = -ar; p++; }
          if (m < nInt - 1) { I[p] = row; J[p] = idx(m + 1, j); V[p] = -ar; p++; }
        }
      }
      solver.setPattern(nTot, I.subarray(0, p), J.subarray(0, p));
      solver.setValues(V.subarray(0, p));
      solver.analyze();
      solver.factorize();
    }

    _cache = { key, solver, nInt, nTot };
    return _cache;
  }

  function _validate(gapInput, opts) {
    if (!gapInput || !gapInput.rotor || !gapInput.stator) {
      throw new Error("GapEval.evalAOnGrid: gapInput must have rotor and stator fields");
    }
    const { rotor, stator } = gapInput;
    if (typeof rotor.gapR !== "number" || !rotor.gapTheta || !rotor.A) {
      throw new Error("GapEval.evalAOnGrid: rotor must have gapR, gapTheta, and A");
    }
    if (typeof stator.gapR !== "number" || !stator.gapTheta || !stator.A) {
      throw new Error("GapEval.evalAOnGrid: stator must have gapR, gapTheta, and A");
    }
    if (stator.gapR <= rotor.gapR) {
      throw new Error("GapEval.evalAOnGrid: stator.gapR must be > rotor.gapR");
    }
    const Nr = opts && opts.Nr;
    if (!Nr || Nr < 2) {
      throw new Error("GapEval.evalAOnGrid: opts.Nr must be >= 2");
    }
  }

  // evalAOnGrid(gapInput, opts)
  //
  // gapInput = { rotor, stator, phi }
  //   rotor/stator = { gapR, gapTheta: Float64Array, A: Float64Array }
  //   Rotor ring angles are in rotor body frame; stator ring angles in lab frame.
  //   phi: rotor body-frame angle (lab angle of rotor node i = gapTheta[i] + phi).
  //
  // opts = { Nr, Ntheta }
  //   Nr:     radial rings in output, inclusive of both boundaries (Nr >= 2)
  //   Ntheta: uniform angular samples in output
  //
  // Returns { rs, thetas, Az, Br, Bth, Bmag }
  function evalAOnGrid(gapInput, opts) {
    _validate(gapInput, opts);

    const { rotor, stator, phi } = gapInput;
    const Nr = opts.Nr;
    const Ntheta = opts.Ntheta;
    const Rr = rotor.gapR, Rs = stator.gapR;
    const hr = (Rs - Rr) / (Nr - 1);
    const hth = TWO_PI / Ntheta;

    const rs = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) rs[i] = Rr + i * hr;
    const thetas = new Float64Array(Ntheta);
    for (let j = 0; j < Ntheta; j++) thetas[j] = j * hth;

    const permR = sortedPerm(rotor.gapTheta);
    const permS = sortedPerm(stator.gapTheta);
    const nR = rotor.gapTheta.length;
    const nS = stator.gapTheta.length;
    const th0R = rotor.gapTheta[permR[0]];
    const th0S = stator.gapTheta[permS[0]];
    const stepR = TWO_PI / nR;
    const stepS = TWO_PI / nS;

    const aR_u = new Float64Array(Ntheta);
    const aS_u = new Float64Array(Ntheta);
    for (let j = 0; j < Ntheta; j++) {
      aR_u[j] = cubicRing(rotor.A, permR, nR, th0R, stepR, thetas[j] - phi);
      aS_u[j] = cubicRing(stator.A, permS, nS, th0S, stepS, thetas[j]);
    }

    const cached = _getOrBuildSolver(Nr, Ntheta, Rr, Rs);
    const { solver, nInt } = cached;

    let Xint = null;
    if (nInt >= 1) {
      const ar = 1 / (hr * hr);
      Xint = new Float64Array(nInt * Ntheta);
      const RHS = new Float64Array(nInt * Ntheta);
      for (let j = 0; j < Ntheta; j++) {
        RHS[j] += ar * aR_u[j];
        RHS[(nInt - 1) * Ntheta + j] += ar * aS_u[j];
      }
      solver.solveInto(RHS, Xint);
    }

    // Assemble Az row-major: row 0 = aR_u, rows 1..nInt = interior, row Nr-1 = aS_u
    const Az = new Float64Array(Nr * Ntheta);
    for (let j = 0; j < Ntheta; j++) Az[j] = aR_u[j];
    for (let m = 0; m < nInt; m++) {
      for (let j = 0; j < Ntheta; j++) Az[(m + 1) * Ntheta + j] = Xint[m * Ntheta + j];
    }
    for (let j = 0; j < Ntheta; j++) Az[(Nr - 1) * Ntheta + j] = aS_u[j];

    // Br = (1/r) * dA/dtheta via periodic central difference in theta
    const Br = new Float64Array(Nr * Ntheta);
    for (let i = 0; i < Nr; i++) {
      const r = rs[i];
      for (let j = 0; j < Ntheta; j++) {
        const jp = (j + 1) % Ntheta;
        const jm = (j - 1 + Ntheta) % Ntheta;
        const dAdth = (Az[i * Ntheta + jp] - Az[i * Ntheta + jm]) / (2 * hth);
        Br[i * Ntheta + j] = dAdth / r;
      }
    }

    // Bth = -dA/dr via central difference in r, one-sided at boundaries
    const Bth = new Float64Array(Nr * Ntheta);
    for (let j = 0; j < Ntheta; j++) {
      Bth[j] = -(Az[Ntheta + j] - Az[j]) / hr;
      for (let i = 1; i < Nr - 1; i++) {
        Bth[i * Ntheta + j] = -(Az[(i + 1) * Ntheta + j] - Az[(i - 1) * Ntheta + j]) / (2 * hr);
      }
      Bth[(Nr - 1) * Ntheta + j] = -(Az[(Nr - 1) * Ntheta + j] - Az[(Nr - 2) * Ntheta + j]) / hr;
    }

    // Bmag = hypot(Br, Bth)
    const Bmag = new Float64Array(Nr * Ntheta);
    for (let k = 0; k < Nr * Ntheta; k++) {
      Bmag[k] = Math.hypot(Br[k], Bth[k]);
    }

    return { rs, thetas, Az, Br, Bth, Bmag };
  }

  LIB.GapEval = { evalAOnGrid };
})();