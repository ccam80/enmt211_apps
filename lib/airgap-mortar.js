// =============================================================================
//  LIB.AirgapMortar — moving-band air-gap coupling (drop-in for AirgapHarmonic)
// =============================================================================
//
//  Replaces the harmonic Dirichlet-to-Neumann gap coupling with a real-space FE
//  air-gap band: a single layer of air triangles meshed between the rotor gap
//  ring (rotated by φ) and the stator gap ring. The two rings are EXISTING body
//  DOFs (no harmonic DOFs, no new nodes) — the band only adds sparse triplets
//  coupling rotor-ring ↔ stator-ring. This captures the full gap field with NO
//  Fourier truncation (cage / slot / cogging / high-tooth content native).
//
//  Contract with motor-slice.js (mirrors AirgapHarmonic exactly):
//    build(rotorGap, statorGap, opts) → {
//      dofMap: { gapRotor, gapStator, harmonics:{ perBody:0, ... } },  // perBody=0 ⇒ nHarmonicDofs=0
//      stamp(phi)            → { n, I, J, V }    (local indices, see below)
//      stampInto(phi,I,J,V)  → nt
//      tripletCapacity       (worst-case nt)
//      torque(ARotGap, AStatGap, phi) → Nm  (real-space Maxwell stress)
//      projectInto(gapTheta, Anodal, a, b)  // diagnostic only (mean term)
//      perBody:0, nHarmonicDofs:0, kList:[], maxK:0, …
//    }
//
//  Local DOF layout (consumed by motor-slice's remapGapTriplets):
//    [ gapRotor (Ngr) | gapStator (Ngs) ]   — NO harmonic block.
//    local rotor-ring node i → index i ; stator-ring node j → index Ngr + j.
//
//  Pattern note: the band re-zips as φ rotates, so the sparsity PATTERN is
//  φ-dependent. The engine re-analyzes per solve(θ) when gapMethod==='mortar'
//  (the band is fixed across the Newton iters at a given θ). This is the moving-
//  band cost — traded for a sparse (cheap) factorize vs the harmonic dense block.
// =============================================================================
(function () {
  "use strict";
  const LIB = (typeof window !== "undefined" ? window : globalThis).LIB ||
    ((typeof window !== "undefined" ? window : globalThis).LIB = {});
  const MU0 = 4e-7 * Math.PI;
  const TWO_PI = 2 * Math.PI;

  // Sorted permutation of an angle array (ascending), returns Int32Array of
  // original indices in angular order.
  function sortedPerm(theta) {
    const n = theta.length;
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) perm[i] = i;
    const arr = Array.from(perm);
    arr.sort((a, b) => theta[a] - theta[b]);
    for (let i = 0; i < n; i++) perm[i] = arr[i];
    return perm;
  }

  function build(rotorGap, statorGap, opts) {
    opts = opts || {};
    const ell = opts.ell;
    if (ell == null) throw new Error("AirgapMortar.build: opts.ell required");
    const mu0 = opts.mu0 != null ? opts.mu0 : MU0;
    const nuAir = 1 / mu0;

    const thR = rotorGap.gapTheta;          // rotor gap-ring angles (rotor frame)
    const thS = statorGap.gapTheta;          // stator gap-ring angles
    const Rr = rotorGap.gapR;                // rotor gap-ring radius
    const Rs = statorGap.gapR;               // stator gap-ring radius
    const Ngr = thR.length;
    const Ngs = thS.length;
    if (!(Rs > Rr)) throw new Error("AirgapMortar.build: need Rs>Rr (gap)");

    // angular order of each ring (for the zip); cos/sin base of stator (fixed)
    const permR = sortedPerm(thR);
    const permS = sortedPerm(thS);
    const cosS = new Float64Array(Ngs), sinS = new Float64Array(Ngs);
    for (let j = 0; j < Ngs; j++) { cosS[j] = Math.cos(thS[j]); sinS[j] = Math.sin(thS[j]); }

    // worst-case triangle count of the zip over one revolution = Ngr+Ngs;
    // 9 triplets per T3.  margin ×1 (exact bound) + a few.
    const maxTris = Ngr + Ngs + 4;
    const tripletCapacity = 9 * maxTris;

    // --- air T3 stiffness stamp into local indices, 9 triplets ---
    // node positions xy[0..5], local global-ids g[0..2].
    function stampTriInto(xy, g, outI, outJ, outV, p) {
      const xi = xy[0], yi = xy[1], xj = xy[2], yj = xy[3], xk = xy[4], yk = xy[5];
      const det = (xj - xi) * (yk - yi) - (xk - xi) * (yj - yi);
      const A2 = Math.abs(det);
      if (A2 <= 0) {
        // degenerate triangle: emit 9 zero triplets at (g0,g0) so the stamp
        // count stays EXACTLY 9·(Ngr+Ngs) for every φ (fixed value-buffer size;
        // only the pattern coordinates rotate → engine re-analyzes per θ).
        for (let z = 0; z < 9; z++) { outI[p] = g[0]; outJ[p] = g[0]; outV[p] = 0; p++; }
        return p;
      }
      const b0 = yj - yk, b1 = yk - yi, b2 = yi - yj;
      const c0 = xk - xj, c1 = xi - xk, c2 = xj - xi;
      const bb = [b0, b1, b2], cc = [c0, c1, c2];
      const coef = nuAir / (2 * A2);
      for (let a = 0; a < 3; a++) {
        for (let d = 0; d < 3; d++) {
          outI[p] = g[a]; outJ[p] = g[d];
          outV[p] = coef * (bb[a] * bb[d] + cc[a] * cc[d]);
          p++;
        }
      }
      return p;
    }

    // Zip the two rotating rings into an annular T3 band and stamp.
    // Local index: rotor ring node i → i ; stator ring node j → Ngr + j.
    function stampInto(phi, outI, outJ, outV) {
      // rotor lab positions at this φ
      // (compute per call — Ngr cos/sin; cheap relative to factorize)
      let p = 0;
      // two-pointer merge-walk over angular order, periodic.
      // rotor angle at order-position pr: thR[permR[pr]] + phi   (mod 2π)
      // stator angle at order-position ps: thS[permS[ps]]
      const rAng = (pr) => {
        let a = thR[permR[pr % Ngr]] + phi + (pr >= Ngr ? TWO_PI : 0);
        return a;
      };
      const sAng = (ps) => thS[permS[ps % Ngs]] + (ps >= Ngs ? TWO_PI : 0);
      const rPos = (pr) => {
        const idx = permR[pr % Ngr]; const a = thR[idx] + phi;
        return { g: idx, x: Rr * Math.cos(a), y: Rr * Math.sin(a) };
      };
      const sPos = (ps) => {
        const idx = permS[ps % Ngs];
        return { g: Ngr + idx, x: Rs * cosS[idx], y: Rs * sinS[idx] };
      };
      // start aligned: find the stator start whose angle ≥ rotor[0] angle.
      let pr = 0, ps = 0;
      // align ps to just-below rotor start so the strip is well-formed
      const r0 = ((thR[permR[0]] + phi) % TWO_PI + TWO_PI) % TWO_PI;
      // advance ps to first stator angle >= r0
      while (ps < Ngs && (thS[permS[ps]] % TWO_PI) < r0) ps++;
      ps = ps % Ngs;
      const prEnd = pr + Ngr, psEnd = ps + Ngs;
      let guard = 2 * (Ngr + Ngs) + 8;
      while ((pr < prEnd || ps < psEnd) && guard-- > 0) {
        const r0p = rPos(pr), s0p = sPos(ps);
        const rNextA = rAng(pr + 1), sNextA = sAng(ps + 1);
        if (pr < prEnd && (ps >= psEnd || rNextA <= sNextA)) {
          // triangle: rotor[pr], rotor[pr+1], stator[ps]
          const rN = rPos(pr + 1);
          p = stampTriInto([r0p.x, r0p.y, rN.x, rN.y, s0p.x, s0p.y],
            [r0p.g, rN.g, s0p.g], outI, outJ, outV, p);
          pr++;
        } else {
          // triangle: rotor[pr], stator[ps], stator[ps+1]
          const sN = sPos(ps + 1);
          p = stampTriInto([r0p.x, r0p.y, s0p.x, s0p.y, sN.x, sN.y],
            [r0p.g, s0p.g, sN.g], outI, outJ, outV, p);
          ps++;
        }
      }
      return p;
    }

    function stamp(phi) {
      const n = Ngr + Ngs;
      const I = new Int32Array(tripletCapacity);
      const J = new Int32Array(tripletCapacity);
      const V = new Float64Array(tripletCapacity);
      const nt = stampInto(phi, I, J, V);
      return { n, I: I.subarray(0, nt), J: J.subarray(0, nt), V: V.subarray(0, nt) };
    }

    // -------------------------------------------------------------------------
    //  torque — real-space Maxwell stress on a mid-gap contour.
    //
    //  T = (ell / μ0) ∮ r · B_r · B_θ dθ  evaluated at mid-gap.
    //  From the two ring nodal-A vectors (rotor ring at lab angle θ+φ, stator at
    //  θ): interpolate the rotor A onto the stator lab angles, then per stator
    //  node:  B_θ ≈ -(A_stator - A_rotor@θ)/(Rs - Rr)   (radial grad across gap)
    //         B_r ≈ (1/r_mid)·dA/dθ  (central diff of the mid-gap A around θ)
    //  Captures ALL harmonics present on the rings — no truncation.
    // -------------------------------------------------------------------------
    const permS_inv = null; // unused; stator nodes addressed directly
    const rMid = 0.5 * (Rr + Rs);
    const dr = Rs - Rr;

    // Interpolate rotor-ring nodal A (rotor frame angles thR) sampled at a lab
    // angle α → rotor-frame angle (α - φ). Linear interp on the sorted rotor ring.
    function rotorAatLab(ARot, alpha, phi) {
      let a = ((alpha - phi) % TWO_PI + TWO_PI) % TWO_PI;  // rotor-frame angle
      // find bracketing rotor nodes in angular order
      // binary search on thR[permR]
      let lo = 0, hi = Ngr;
      while (lo < hi) { const m = (lo + hi) >> 1; if (thR[permR[m]] < a) lo = m + 1; else hi = m; }
      const i1 = lo % Ngr, i0 = (lo - 1 + Ngr) % Ngr;
      let a0 = thR[permR[i0]], a1 = thR[permR[i1]];
      let da = a1 - a0; if (da <= 0) da += TWO_PI;
      let t = (a - a0); if (t < 0) t += TWO_PI; t = da > 0 ? t / da : 0;
      return ARot[permR[i0]] * (1 - t) + ARot[permR[i1]] * t;
    }

    function torque(ARotGap, AStatGap, phi) {
      // Mid-gap A on the stator lab grid: average of stator node A and rotor A
      // interpolated to the same lab angle.
      const N = Ngs;
      const Amid = new Float64Array(N);
      const labAng = new Float64Array(N);
      const Bt = new Float64Array(N);   // B_θ at each node
      for (let j = 0; j < N; j++) {
        const idx = permS[j];
        const alpha = thS[idx];
        labAng[j] = alpha;
        const aR = rotorAatLab(ARotGap, alpha, phi);
        const aS = AStatGap[idx];
        Amid[j] = 0.5 * (aR + aS);
        Bt[j] = -(aS - aR) / dr;          // B_θ = -∂A/∂r across the gap
      }
      // B_r = (1/r_mid) dA/dθ via central difference on the (sorted) lab grid.
      // Arkkio single-circle Maxwell stress at mid-gap (Arkkio 1987; same integrand
      // as tests/harmonic/_fixtures.js annulusOracle.arkkioAtRadius, frac=0.5):
      //   T = (ell/μ0) · r_mid² · ∮ B_r·B_θ dθ,  B_r=(1/r)∂A/∂θ, B_θ=−∂A/∂r.
      let acc = 0;
      for (let j = 0; j < N; j++) {
        const jm = (j - 1 + N) % N, jp = (j + 1) % N;
        let dth = labAng[jp] - labAng[jm];
        if (dth <= 0) dth += TWO_PI;
        const dAdth = (Amid[jp] - Amid[jm]) / dth;          // central diff over 2·dθ
        const Br = dAdth / rMid;
        let segm = labAng[jp] - labAng[jm];
        if (segm <= 0) segm += TWO_PI;
        const dth_j = 0.5 * segm;                            // node's share of the contour
        acc += Br * Bt[j] * dth_j;
      }
      return (ell / mu0) * rMid * rMid * acc;                // r_mid² (was r_mid¹ — bug)
    }

    // diagnostic projector (mean only) — keeps solve()'s field.gap output alive.
    function projectInto(gapTheta, Anodal, a, b) {
      let s = 0; const n = Anodal.length;
      for (let i = 0; i < n; i++) s += Anodal[i];
      if (a && a.length) a[0] = s / (n || 1);
      if (b && b.length) b[0] = 0;
    }

    const dofMap = {
      gapRotor:  { base: 0,   count: Ngr },
      gapStator: { base: Ngr, count: Ngs },
      harmonics: {
        base: Ngr + Ngs,
        count: 0,
        perBody: 0,
        layout: [],
        kList: [],
        maxK: 0,
        bodies: ["rotor", "stator"],
      },
    };

    return {
      method: "mortar",

      // ---- GapEngine interface (engine-agnostic; see LIB.GapEngine contract) ----
      // Coupling + extraction:
      stamp,                 // stamp(phi) → { n, I, J, V }   border coupling triplets
      stampInto,             // stampInto(phi, I, J, V) → nt  (into preallocated buffers)
      tripletCapacity,       // upper bound on triplets per stamp
      torque,                // torque(A_rotorGap, A_statorGap, phi) → N·m (Maxwell stress)
      projectInto,           // projectInto(gapTheta, Anodal, a, b) — field projection (viz/flux)
      dofMap,                // DOF layout: { gapRotor, gapStator, extra }
      // Capabilities (let the slice avoid engine-specific branches):
      extraDofsPerBody: 0,   // mortar adds NO per-body DOFs beyond the gap rings
      projectionOrder: 0,    // mean-only field projection (no Fourier orders)
      reanalyzePerSolve: true,   // the band pattern rotates with φ → re-stamp each solve(θ)
      hasDenseBorderBlock: false, // no dense border block → no Newton-Schur condensation

      // ---- Legacy harmonic-shaped fields (consumed by the slice until migrated;
      //      all zero/empty for mortar — it carries no harmonics) ----
      K: 0, kList: [], nHarm: 0, maxK: 0, nHarmonicDofs: 0,
      nGapRotor: Ngr, nGapStator: Ngs,
      project: function () { return { a: new Float64Array(1), b: new Float64Array(1) }; },
      _internals: { permR, permS, Rr, Rs, ell, nuAir },
    };
  }

  // requiredGapNodes(slots, poles): the gap-ring node floor the mesh must satisfy
  // for this engine, evaluated BEFORE build() (mesh sizing). Preserves the prior
  // mesh resolution (12·max(slots,poles) = 4·defaultK) so behaviour is unchanged;
  // a mortar-native floor is a separate optimisation.
  LIB.AirgapMortar = {
    build: build,
    requiredGapNodes: function (slots, poles) { return 12 * Math.max(slots, poles); },
    // defaultK kept for API symmetry (mortar carries no harmonics).
    defaultK: function () { return 0; },
  };
})();
