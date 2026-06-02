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
    //  torque — real-space Maxwell stress via local field reconstruction.
    //
    //  The gap is current-free, so its vector potential is the unique harmonic
    //  extension of the two ring fields. The legacy single mid-gap chord stencil
    //  over-reads the r^±k radial curvature by ~+(k·Δr/r)² (proven: +3.5% at k=8,
    //  +12% at k=16, +19% at k=20 on a 3mm/50mm gap) and attenuates ∂_θ by the
    //  central-diff sinc + linear-interp roll-off. We replace it with:
    //    1. Resample BOTH rings onto a UNIFORM grid (Nu = max(Ngr,Ngs)) with a
    //       periodic 4-point CUBIC (Catmull-Rom) interpolation — pins the angular
    //       axis against the cage/slot harmonics that linear interp would damp.
    //    2. Reconstruct L−1 INTERIOR rings (radii Rr+m·dr/L, m=1..L−1) by solving
    //       the discrete polar-Laplace BVP — a single SPD cyclic-block-tridiagonal
    //       system, ASSEMBLED + FACTORED ONCE in build() (constant coefficients).
    //    3. Band-AVERAGE Maxwell stress over the L sub-contours (each spanning
    //       dr/L) using a 4th-order central angular derivative for B_r. Sub-dividing
    //       the gap radially is what kills the (k·Δr/r)² chord over-read: with L
    //       sub-contours the per-chord error scales 1/L².
    //
    //  Choosing L: the chord over-read is governed by the product k·(Δr/r), NOT k
    //  alone — the per-sub-chord error scales (k·Δr/(L·r))². And the GAP itself
    //  bounds which k matter: a harmonic decays across the gap as ~e^(−k·Δr/r), and
    //  torque needs the harmonic present on BOTH rings, so torque-carrying harmonics
    //  universally satisfy k·(Δr/r) ≲ 3 regardless of pole/slot/tooth count. (The
    //  generator's highest feature count is the hybrid stepper's 50 rotor teeth, but
    //  its 2mm/21mm gap, Δr/r≈0.095, low-passes that to a torque band of k≲30.)
    //  So the bar is machine-independent: accurate to k·(Δr/r)≈2–3, not to k=50.
    //  Measured at the worst (stepper) gap: at k·(Δr/r)=2, L=4→+5%, L=8→+1.5%; at
    //  the penetration edge k·(Δr/r)=3 (~5% amplitude), L=4→+14%, L=8→+4%, L=12→+2.5%.
    //  L=8 holds the well-penetrated torque band (k·Δr/r≤2) under 1.5% on ANY gap;
    //  the edge residual sits on near-filtered harmonics. ~100µs/torque (<2% of a
    //  solve). See tests/airgap/torque-formula-field + the L-vs-(k,gap) probe.
    // -------------------------------------------------------------------------
    const rMid = 0.5 * (Rr + Rs);
    const dr = Rs - Rr;
    // Radial sub-contour count (L sub-contours ⇒ L−1 interior reconstruction rings).
    const L_SUB = 8;

    // Interpolate rotor-ring nodal A (rotor frame angles thR) sampled at a lab
    // angle α → rotor-frame angle (α - φ). Linear interp on the sorted rotor ring.
    // Kept for any other caller; torque() below uses the cubic resampler.
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

    // ---- uniform internal grid for the reconstruction ----------------------
    const Nu = Math.max(Ngr, Ngs);
    const hth = TWO_PI / Nu;

    // Periodic 4-point Catmull-Rom cubic resample of a ring sampled at angles
    // `th` (NOT necessarily uniform — the FEA rings are uniform but rotor-frame
    // may carry an offset) with values `vals`, evaluated at target angle `ang`.
    // The ring is uniform-in-index when th = (i+off)·2π/n, which is the case for
    // every FEA gap ring. We exploit that: locate the integer cell, take the four
    // surrounding samples in index order, and Catmull-Rom across the cell.
    // perm = ascending angular order; n = ring node count; th0 = base angle of
    // perm[0]; step = uniform angular step (TWO_PI/n).
    function cubicRing(vals, perm, n, th0, step, ang) {
      // fractional index position of `ang` within the sorted ring
      let u = (ang - th0) / step;
      // wrap into [0, n)
      u = u - Math.floor(u / n) * n;
      const i1 = Math.floor(u);
      const t = u - i1;            // local parameter in [0,1)
      const i0 = (i1 - 1 + n) % n;
      const i2 = (i1 + 1) % n;
      const i3 = (i1 + 2) % n;
      const p0 = vals[perm[i0]], p1 = vals[perm[i1 % n]],
            p2 = vals[perm[i2]], p3 = vals[perm[i3]];
      // Catmull-Rom basis
      const t2 = t * t, t3 = t2 * t;
      return 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
      );
    }
    // Base angle + step of each ring in ascending order (uniform rings).
    const thS0 = thS[permS[0]];
    const thR0 = thR[permR[0]];
    const stepS = TWO_PI / Ngs;
    const stepR = TWO_PI / Ngr;

    // ---- ONCE: assemble + factor the SPD cyclic-block-tridiagonal system -----
    // Reconstruct L−1 interior rings at radii r_m = Rr + m·hsub (m=1..L−1) by the
    // discrete polar-Laplace BVP on the uniform θ-grid. Each interior ring m has
    // Nu unknowns; couplings: radial (±ar to rings m±1) and angular (±bang(r_m) to
    // j±1, periodic). The Rr and Rs rings are Dirichlet boundaries (known fields),
    // so they fold into the RHS, not the matrix. Constant-coefficient ⇒ assemble
    // + analyze + factorize EXACTLY ONCE here; per-call work is only resample +
    // RHS + solveInto + integrate.
    const hsub = dr / L_SUB;
    const ar = 1 / (hsub * hsub);             // radial 2nd-diff coefficient
    const nInt = L_SUB - 1;                   // interior reconstruction rings
    const nTot = nInt * Nu;                   // total interior unknowns
    const rInt = new Float64Array(nInt);      // interior ring radii
    for (let m = 0; m < nInt; m++) rInt[m] = Rr + hsub * (m + 1);
    const recSolver = LIB.FeaSolver.create();
    {
      // Full-symmetric triplets: per interior node — diag + 2 angular + ≤2 radial.
      // Upper bound 5 per node; emit only the present couplings.
      const cap = 5 * nTot;
      const I = new Int32Array(cap), J = new Int32Array(cap), V = new Float64Array(cap);
      let p = 0;
      const idx = (m, j) => m * Nu + j;
      for (let m = 0; m < nInt; m++) {
        const r = rInt[m];
        const bang = 1 / (hth * hth * r * r);
        const diag = 2 * ar + 2 * bang;
        for (let j = 0; j < Nu; j++) {
          const row = idx(m, j);
          const jm = (j - 1 + Nu) % Nu, jp = (j + 1) % Nu;
          I[p] = row; J[p] = row;          V[p] = diag;  p++;
          I[p] = row; J[p] = idx(m, jm);   V[p] = -bang; p++;
          I[p] = row; J[p] = idx(m, jp);   V[p] = -bang; p++;
          if (m > 0)        { I[p] = row; J[p] = idx(m - 1, j); V[p] = -ar; p++; }
          if (m < nInt - 1) { I[p] = row; J[p] = idx(m + 1, j); V[p] = -ar; p++; }
        }
      }
      recSolver.setPattern(nTot, I.subarray(0, p), J.subarray(0, p));
      recSolver.setValues(V.subarray(0, p));
      recSolver.analyze();
      recSolver.factorize();
    }

    // Pre-allocated per-call scratch — reused every torque() call (no per-call alloc).
    const aS_u = new Float64Array(Nu);        // stator ring resampled to uniform grid
    const aR_u = new Float64Array(Nu);        // rotor ring resampled (rotor frame)
    const RHS  = new Float64Array(nTot);      // BVP right-hand side
    const Xint = new Float64Array(nTot);      // solved interior-ring fields
    const cmid = new Float64Array(Nu);        // per-sub-contour mid-radius A (for ∂_θ)

    function torque(ARotGap, AStatGap, phi) {
      // 1. Resample both rings onto the uniform grid via periodic cubic.
      //    Stator: lab angle φ_j. Rotor: rotor-frame angle (φ_j − phi).
      for (let j = 0; j < Nu; j++) {
        const ang = j * hth;
        aS_u[j] = cubicRing(AStatGap, permS, Ngs, thS0, stepS, ang);
        aR_u[j] = cubicRing(ARotGap, permR, Ngr, thR0, stepR, ang - phi);
      }
      // 2. RHS: the Rr/Rs Dirichlet rings fold into the first/last interior rows.
      RHS.fill(0);
      for (let j = 0; j < Nu; j++) {
        RHS[j] += ar * aR_u[j];                         // ring m=0 couples to Rr
        RHS[(nInt - 1) * Nu + j] += ar * aS_u[j];       // ring m=nInt−1 couples to Rs
      }
      recSolver.solveInto(RHS, Xint);

      // 3. Band-average Maxwell stress over the L sub-contours. Ring 0 = aR_u,
      //    interior rings 1..nInt = Xint, ring L = aS_u; sub-contour s spans
      //    rings s..s+1 at centre radius rc, chord B_θ over hsub.
      const inv12h = 1 / (12 * hth);
      const ringAt = (s, j) => (s === 0 ? aR_u[j]
                              : s === L_SUB ? aS_u[j]
                              : Xint[(s - 1) * Nu + j]);
      let T = 0;
      for (let s = 0; s < L_SUB; s++) {
        const rin = Rr + s * hsub, rout = rin + hsub, rc = 0.5 * (rin + rout);
        for (let j = 0; j < Nu; j++) cmid[j] = 0.5 * (ringAt(s, j) + ringAt(s + 1, j));
        let acc = 0;
        for (let j = 0; j < Nu; j++) {
          const jm2 = (j - 2 + Nu) % Nu, jm1 = (j - 1 + Nu) % Nu;
          const jp1 = (j + 1) % Nu,      jp2 = (j + 2) % Nu;
          // B_θ = −∂A/∂r across the sub-contour (chord over hsub).
          const Bt = -(ringAt(s + 1, j) - ringAt(s, j)) / hsub;
          // B_r = (1/rc)·∂A/∂θ via 4th-order central difference (periodic).
          const D4 = (-cmid[jp2] + 8 * cmid[jp1] - 8 * cmid[jm1] + cmid[jm2]) * inv12h;
          acc += (D4 / rc) * Bt;
        }
        T += rc * rc * acc * hth;                       // Arkkio integrand on this contour
      }
      // Band-average over the L sub-contours.
      return (ell / mu0) * (T / L_SUB);
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
