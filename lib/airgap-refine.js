"use strict";

// =============================================================================
//  LIB.AirgapRefine — refined SolveBackend: finer grid + corner regularization
//                     + geometric multigrid (Galerkin + radial-line smoother)
//
//  Provides a Phase-5 SolveBackend that runs the same agnostic pipeline as
//  the coarse Live tier, but on a uniformly-finer polar grid, with tooth-tip
//  corner reluctivity regularization and a geometric-multigrid linear solve.
//
//  MU0 = 4π × 1e-7  (declared once here, consistent with airgap-grid.js)
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const MU0 = 4 * Math.PI * 1e-7;

  // ---------------------------------------------------------------------------
  //  Euclidean norm of a Float64Array
  // ---------------------------------------------------------------------------
  function norm2(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s);
  }

  // ---------------------------------------------------------------------------
  //  refineSection(section, { factor = 3 }) → section'
  //
  //  Pure. Returns a new section with grid Nr/Ntheta multiplied by factor,
  //  physical extents unchanged, gapBand indices scaled by factor, and
  //  features deep-cloned.
  // ---------------------------------------------------------------------------
  function refineSection(section, { factor = 3 } = {}) {
    if (!Number.isInteger(factor) || factor < 1) {
      throw new Error(
        "airgap-refine: factor must be a positive integer, got " + factor
      );
    }

    const g = section.grid;
    const gb = section.gapBand;

    const refinedGrid = {
      Nr: g.Nr * factor,
      Ntheta: g.Ntheta * factor,
      rInner: g.rInner,
      rOuter: g.rOuter,
      ell: g.ell,
    };

    const refinedGapBand = {
      iInner: gb.iInner * factor,
      iOuter: gb.iOuter * factor,
    };

    // Deep-clone features: each feature is a plain object with no circular refs
    const refinedFeatures = JSON.parse(JSON.stringify(section.features));

    return {
      grid: refinedGrid,
      gapBand: refinedGapBand,
      features: refinedFeatures,
    };
  }

  // ---------------------------------------------------------------------------
  //  filletCorners(nu, grid, { strength = 1 } = {}) → Float64Array
  //
  //  Pure. Returns a new Float64Array regularizing reluctivity at iron convex
  //  corners. A cell is iron when nu[idx] < 0.999 * airNu. A convex corner
  //  iron cell has exactly one radial neighbour and exactly one angular
  //  neighbour that are air — i.e. exactly two air face-neighbours, one from
  //  each axis. For each such cell, set nu'[idx] = nu[idx] * (airNu/nu[idx])^(0.5*strength).
  //  All other cells copy nu verbatim. strength is clamped to [0,1].
  // ---------------------------------------------------------------------------
  function filletCorners(nu, grid, { strength = 1 } = {}) {
    const { Nr, Ntheta } = grid;
    const airNu = 1 / MU0;
    const ironThreshold = 0.999 * airNu;

    const s = Math.max(0, Math.min(1, strength));

    const out = nu.slice(); // copy all values

    if (s === 0) return out;

    for (let i = 0; i < Nr; i++) {
      for (let j = 0; j < Ntheta; j++) {
        const idx = i * Ntheta + j;

        // Only process iron cells
        if (nu[idx] >= ironThreshold) continue;

        // Count air face-neighbours, tracking which axes they come from
        let radialAirCount = 0;
        let angularAirCount = 0;

        // Radial neighbours: N = i+1, S = i-1 (clamped at rims)
        if (i + 1 < Nr) {
          const idxN = (i + 1) * Ntheta + j;
          if (nu[idxN] >= ironThreshold) radialAirCount++;
        }
        if (i > 0) {
          const idxS = (i - 1) * Ntheta + j;
          if (nu[idxS] >= ironThreshold) radialAirCount++;
        }

        // Angular neighbours: E = j+1, W = j-1 (periodic)
        const jE = (j + 1) % Ntheta;
        const jW = (j + Ntheta - 1) % Ntheta;
        if (nu[i * Ntheta + jE] >= ironThreshold) angularAirCount++;
        if (nu[i * Ntheta + jW] >= ironThreshold) angularAirCount++;

        // Convex corner: exactly one radial air neighbour AND exactly one angular air neighbour
        if (radialAirCount === 1 && angularAirCount === 1) {
          // nu'[idx] = nu[idx] * (airNu/nu[idx])^(0.5*s)
          // = nu[idx]^(1 - 0.5*s) * airNu^(0.5*s)
          out[idx] = Math.pow(nu[idx], 1 - 0.5 * s) * Math.pow(airNu, 0.5 * s);
        }
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  //  Transfer operators: prolongation P (coarse→fine in θ) and restriction R=Pᵀ
  //
  //  prolongVec: linear interpolation in θ, Nr fixed.
  //    Coarse grid: Nr × Nt_c  →  Fine grid: Nr × Nt_f  (Nt_f = 2 * Nt_c)
  //    ef[i, 2*jc]   = ec[i, jc]
  //    ef[i, 2*jc+1] = 0.5*(ec[i, jc] + ec[i, (jc+1) % Nt_c])
  //
  //  restrictVec: variational transpose R = Pᵀ (full-weighting in θ)
  //    rc[i, jc] = 0.5*rf[i, 2*jc] + 0.25*(rf[i, 2*jc-1] + rf[i, 2*jc+1])
  //    (all indices periodic in θ)
  // ---------------------------------------------------------------------------
  function prolongVec(ec, Nr, Nt_c) {
    const Nt_f = Nt_c * 2;
    const ef = new Float64Array(Nr * Nt_f);
    for (let i = 0; i < Nr; i++) {
      for (let jc = 0; jc < Nt_c; jc++) {
        const vc = ec[i * Nt_c + jc];
        const vc_next = ec[i * Nt_c + (jc + 1) % Nt_c];
        ef[i * Nt_f + 2 * jc] += vc;
        ef[i * Nt_f + 2 * jc + 1] += 0.5 * (vc + vc_next);
      }
    }
    return ef;
  }

  function restrictVec(rf, Nr, Nt_f) {
    const Nt_c = Nt_f / 2;
    const rc = new Float64Array(Nr * Nt_c);
    for (let i = 0; i < Nr; i++) {
      for (let jc = 0; jc < Nt_c; jc++) {
        const jf = 2 * jc;
        const jf_m = (jf - 1 + Nt_f) % Nt_f;
        const jf_p = (jf + 1) % Nt_f;
        rc[i * Nt_c + jc] =
          0.5  * rf[i * Nt_f + jf] +
          0.25 * rf[i * Nt_f + jf_m] +
          0.25 * rf[i * Nt_f + jf_p];
      }
    }
    return rc;
  }

  // ---------------------------------------------------------------------------
  //  buildGalerkinOp(fineOp, Nr, Nt_f, Nt_c)
  //
  //  Assembles the Galerkin coarse operator A_c = R · A_f · P by applying
  //  A_f to each column of P (≈ Nt_c matvecs on the fine level) and then
  //  restricting each column.
  //
  //  Returns an operator object with:
  //    matvec(x)      → Float64Array (A_c · x)
  //    diagonal()     → Float64Array (main diagonal of A_c)
  //    radialCoeffs() → { aN, aS } per-cell radial couplings extracted from A_c
  //
  //  The Galerkin matrix is stored as a dense column-major Float64Array
  //  of shape (Nr*Nt_c) × (Nr*Nt_c).  For the grids we use (Nr≤50, Nt_c≤64)
  //  this is at most 50×64 = 3200 unknowns → 10 MB, acceptable.
  //
  //  Gauge pin (index 0) is forced: row 0 and col 0 of A_c are identity.
  // ---------------------------------------------------------------------------
  function buildGalerkinOp(fineOp, Nr, Nt_f, Nt_c) {
    const Nc = Nr * Nt_c; // coarse dof count

    // Build A_c column by column: A_c[:,k] = R * A_f * P[:,k]
    // P[:,k] = prolongation of e_k (standard basis vector on coarse grid)
    const Ac = new Float64Array(Nc * Nc); // row-major: Ac[row*Nc + col]

    for (let k = 0; k < Nc; k++) {
      // e_k on coarse grid
      const ek_c = new Float64Array(Nc);
      ek_c[k] = 1.0;

      // Prolong to fine grid: P * e_k
      const ek_f = prolongVec(ek_c, Nr, Nt_c);

      // Apply fine operator: A_f * P * e_k
      const Aek_f = fineOp.matvec(ek_f);

      // Restrict to coarse grid: R * A_f * P * e_k
      const Aek_c = restrictVec(Aek_f, Nr, Nt_f);

      // Store as column k of A_c
      for (let row = 0; row < Nc; row++) {
        Ac[row * Nc + k] = Aek_c[row];
      }
    }

    // Enforce gauge pin at index 0: row 0 = identity row, col 0 = identity col
    for (let k = 0; k < Nc; k++) {
      Ac[0 * Nc + k] = (k === 0) ? 1.0 : 0.0;
      Ac[k * Nc + 0] = (k === 0) ? 1.0 : 0.0;
    }

    // Precompute diagonal
    const diag = new Float64Array(Nc);
    for (let idx = 0; idx < Nc; idx++) diag[idx] = Ac[idx * Nc + idx];

    // Precompute radial coupling arrays aN and aS from A_c.
    // For the Galerkin operator, the coupling between (i,j) and (i+1,j) is
    // -Ac[(i*Nt_c+j)*Nc + ((i+1)*Nt_c+j)], i.e. the negative off-diagonal
    // in the radial direction. We store the magnitude (conductance).
    const aN_c = new Float64Array(Nc);
    const aS_c = new Float64Array(Nc);
    for (let i = 0; i < Nr; i++) {
      for (let j = 0; j < Nt_c; j++) {
        const idx = i * Nt_c + j;
        if (i + 1 < Nr) {
          const idxN = (i + 1) * Nt_c + j;
          aN_c[idx] = -Ac[idx * Nc + idxN]; // off-diag entry (negative)
        }
        if (i > 0) {
          const idxS = (i - 1) * Nt_c + j;
          aS_c[idx] = -Ac[idx * Nc + idxS];
        }
      }
    }

    return {
      Nt: Nt_c,
      Nr,
      matvec(x) {
        const out = new Float64Array(Nc);
        for (let row = 0; row < Nc; row++) {
          let sum = 0;
          const rowBase = row * Nc;
          for (let col = 0; col < Nc; col++) {
            sum += Ac[rowBase + col] * x[col];
          }
          out[row] = sum;
        }
        return out;
      },
      diagonal() {
        return diag.slice();
      },
      radialCoeffs() {
        return { aN: aN_c.slice(), aS: aS_c.slice() };
      },
    };
  }

  // ---------------------------------------------------------------------------
  //  buildHierarchy(op, grid, { minNtheta = 16, maxLevels = 6 }) → hierarchy
  //
  //  Builds the semi-coarsened-in-θ Galerkin multigrid stack from the fine
  //  operator op. Level 0 stores { op: null, Nr, Ntheta } (the fine level —
  //  vcycleSolve receives op directly). Each successive level halves Ntheta
  //  (keeping Nr fixed) and stores a Galerkin coarse operator assembled as
  //  A_l = R · A_{l-1} · P. Stops when Ntheta_l ≤ minNtheta or maxLevels
  //  reached. Requires Ntheta divisible by 2 down to coarsest level.
  // ---------------------------------------------------------------------------
  function buildHierarchy(op, grid, { minNtheta = 16, maxLevels = 6 } = {}) {
    const { Nr, Ntheta } = grid;

    // Validate that Ntheta can be halved the required number of times
    let Nt = Ntheta;
    while (Nt > minNtheta) {
      if (Nt % 2 !== 0) {
        throw new Error(
          "airgap-refine: Ntheta=" + Ntheta +
          " is not divisible by 2 down to minNtheta=" + minNtheta
        );
      }
      Nt = Nt / 2;
    }

    // Level 0: fine grid — op = null (caller passes op directly to vcycleSolve)
    const levels = [{ op: null, Nr, Ntheta }];

    // Build Galerkin coarse levels by successive R·A·P
    // prevLevelOp is the operator at the previous (finer) level
    let prevLevelOp = op;       // fine level op (Phase-1 GridOperator)
    let prevNt = Ntheta;

    for (let lvl = 1; lvl < maxLevels; lvl++) {
      if (prevNt <= minNtheta) break;
      if (prevNt % 2 !== 0) break; // already validated above

      const nextNt = prevNt / 2;

      // Assemble Galerkin coarse operator: A_c = R · A_prev · P
      const coarseOp = buildGalerkinOp(prevLevelOp, Nr, prevNt, nextNt);

      levels.push({ op: coarseOp, Nr, Ntheta: nextNt });

      prevLevelOp = coarseOp;
      prevNt = nextNt;
    }

    return levels;
  }

  // ---------------------------------------------------------------------------
  //  Radial-line (block) smoother — one sweep
  //
  //  For each angular column j (fixed θ), solve the radial tridiagonal system
  //  T_j · δ_j = r_j  using the Thomas algorithm, where:
  //    - T_j diagonal  (row i):      aP[i*Nt+j]       (positive)
  //    - T_j super-diag (row i → i+1): -aN[i*Nt+j]    (negative, stored as magnitude)
  //    - T_j sub-diag   (row i → i-1): -aS[i*Nt+j]    (negative, stored as magnitude)
  //    - r_j[i] = residual[i*Nt+j] (angular east/west couplings carried explicitly)
  //  Then update x ← x + omega·δ.
  //
  //  Thomas algorithm for the tridiagonal system:
  //    -aS[i]*δ[i-1] + aP[i]*δ[i] - aN[i]*δ[i+1] = r[i]
  //
  //  Forward sweep eliminates the sub-diagonal. Because the sub-diagonal entry
  //  is -aS[i] (negative), adding m * row_{i-1} (not subtracting) kills x[i-1]:
  //    m     = aS[i] / w[i-1]
  //    w[i]  = aP[i] - m * aN[i-1]   (modified main diagonal)
  //    g[i]  = r[i]  + m * g[i-1]    (modified RHS — note the + sign)
  //
  //  Back substitution:
  //    δ[Nr-1] = g[Nr-1] / w[Nr-1]
  //    δ[i]    = (g[i] + aN[i] * δ[i+1]) / w[i]   (+ because super-diag is -aN)
  //
  //  Parameters:
  //    op     — operator at this level (must expose matvec, diagonal, radialCoeffs)
  //    x      — current approximation (modified in place)
  //    b      — RHS
  //    omega  — under-relaxation factor
  //    Nr, Nt — grid dimensions at this level
  // ---------------------------------------------------------------------------
  function lineSmoothSweep(op, x, b, omega, Nr, Nt) {
    const N = Nr * Nt;

    // Compute full residual r = b - A*x (angular couplings carried explicitly here)
    const Ax = op.matvec(x);
    const r = new Float64Array(N);
    for (let k = 0; k < N; k++) r[k] = b[k] - Ax[k];
    r[0] = 0; // pin

    // Get diagonal and radial coupling magnitude arrays
    const diag = op.diagonal();
    const { aN, aS } = op.radialCoeffs();

    // Working arrays reused across columns (length Nr)
    const w = new Float64Array(Nr);     // modified diagonal
    const g = new Float64Array(Nr);     // modified RHS
    const delta = new Float64Array(Nr); // solution δ_j

    for (let j = 0; j < Nt; j++) {
      // Forward elimination: add m * row_{i-1} to row i to kill sub-diagonal term
      for (let i = 0; i < Nr; i++) {
        const idx = i * Nt + j;
        const d = diag[idx];
        const rhs = r[idx];

        if (i === 0) {
          w[0] = d;
          g[0] = rhs;
        } else {
          const sub = aS[idx]; // magnitude of sub-diagonal (matrix entry = -sub)
          if (w[i - 1] === 0) {
            w[i] = d;
            g[i] = rhs;
          } else {
            const m = sub / w[i - 1];
            w[i] = d - m * aN[(i - 1) * Nt + j];
            g[i] = rhs + m * g[i - 1]; // + because sub-diag is negative; see derivation above
          }
        }
      }

      // Back substitution
      delta[Nr - 1] = (w[Nr - 1] === 0) ? 0 : g[Nr - 1] / w[Nr - 1];
      for (let i = Nr - 2; i >= 0; i--) {
        const idx = i * Nt + j;
        if (w[i] === 0) {
          delta[i] = 0;
        } else {
          delta[i] = (g[i] + aN[idx] * delta[i + 1]) / w[i];
        }
      }

      // Update x ← x + omega * δ
      for (let i = 0; i < Nr; i++) {
        const idx = i * Nt + j;
        if (idx === 0) continue; // pin
        x[idx] += omega * delta[i];
      }
    }

    x[0] = 0; // ensure pin is fixed
    return x;
  }

  // ---------------------------------------------------------------------------
  //  vcycleSolve(op, b, { x0, tol, maxCycles, hierarchy, nu1, nu2, omega })
  //    → { x, iters, residual }
  //
  //  Geometric-multigrid V-cycle linear solve with radial-line smoother.
  //  Same call shape as LIB.AirgapSolve.pcg. The fine level uses op
  //  (so setRotorAngle is honoured); coarse-grid corrections use the Galerkin
  //  operators from hierarchy (levels ≥ 1). hierarchy is required.
  // ---------------------------------------------------------------------------
  function vcycleSolve(op, b, {
    x0 = null,
    tol = 1e-6,
    maxCycles = 30,
    hierarchy,
    nu1 = 2,
    nu2 = 2,
    omega = 2 / 3,
  } = {}) {
    if (!hierarchy) {
      throw new Error("airgap-refine: vcycleSolve requires hierarchy");
    }

    const N = b.length;
    const Nr = hierarchy[0].Nr;
    const Ntheta = hierarchy[0].Ntheta;

    // Initial guess
    const x = new Float64Array(N);
    if (x0) {
      for (let k = 0; k < N; k++) x[k] = x0[k];
    }
    x[0] = 0;

    const bnorm = norm2(b);
    if (bnorm === 0) return { x, iters: 0, residual: 0 };

    // Recursive V-cycle
    // levelIdx: index into hierarchy (0 = fine, op passed explicitly; >0 = Galerkin coarse)
    // levelOp: operator at this level
    // xL: current approximation (modified in place)
    // bL: RHS at this level
    function vcycle(levelOp, xL, bL, levelIdx) {
      const NtL = hierarchy[levelIdx].Ntheta;

      // Pre-smooth with radial-line smoother
      for (let s = 0; s < nu1; s++) {
        lineSmoothSweep(levelOp, xL, bL, omega, Nr, NtL);
      }

      // At coarsest level: exact PCG solve
      if (levelIdx + 1 >= hierarchy.length) {
        const coarseSol = LIB.AirgapSolve.pcg(levelOp, bL, { x0: xL.slice(), tol: 1e-8 });
        const NL = bL.length;
        for (let k = 0; k < NL; k++) xL[k] = coarseSol.x[k];
        xL[0] = 0;
        return;
      }

      // Compute residual rL = bL - A*xL
      const AxL = levelOp.matvec(xL);
      const NL = bL.length;
      const rL = new Float64Array(NL);
      for (let k = 0; k < NL; k++) rL[k] = bL[k] - AxL[k];
      rL[0] = 0;

      // Restrict residual to next coarser level
      const rc = restrictVec(rL, Nr, NtL);
      rc[0] = 0;

      // Recurse into coarser level
      const nextLevel = hierarchy[levelIdx + 1];
      const coarseOp = nextLevel.op;
      const ec = new Float64Array(rc.length);
      vcycle(coarseOp, ec, rc, levelIdx + 1);

      // Prolongate correction and add to current approximation
      const ef = prolongVec(ec, Nr, nextLevel.Ntheta);
      for (let k = 0; k < NL; k++) xL[k] += ef[k];
      xL[0] = 0;

      // Post-smooth with radial-line smoother
      for (let s = 0; s < nu2; s++) {
        lineSmoothSweep(levelOp, xL, bL, omega, Nr, NtL);
      }
    }

    let iters = 0;
    let residual = 1;

    for (let cycle = 0; cycle < maxCycles; cycle++) {
      const Ax = op.matvec(x);
      const r = new Float64Array(N);
      for (let k = 0; k < N; k++) r[k] = b[k] - Ax[k];
      r[0] = 0;
      residual = norm2(r) / bnorm;

      if (residual <= tol) break;

      vcycle(op, x, b, 0);
      iters++;
    }

    // Final residual check
    {
      const Ax = op.matvec(x);
      const r = new Float64Array(N);
      for (let k = 0; k < N; k++) r[k] = b[k] - Ax[k];
      r[0] = 0;
      residual = norm2(r) / bnorm;
    }

    return { x, iters, residual };
  }

  // ---------------------------------------------------------------------------
  //  solveSaturated(op, b, { x0, tol, maxCycles, hierarchy, ceiling })
  //    → { x, iters, residual, satScale }
  //
  //  Live-style global flux-dependent ceiling wrapped around V-cycle.
  //  Same contract as LIB.AirgapSolve.solveSaturated.
  // ---------------------------------------------------------------------------
  function solveSaturated(op, b, {
    x0 = null,
    tol = 1e-6,
    maxCycles = 30,
    hierarchy,
    ceiling = {},
  } = {}) {
    const {
      enabled = true,
      Bknee = 1.6,
      p = 2,
      ironMask,
    } = ceiling;

    // First V-cycle solve
    const result1 = vcycleSolve(op, b, { x0, tol, maxCycles, hierarchy });
    let totalIters = result1.iters;

    if (!enabled || !ironMask) {
      return {
        x: result1.x,
        iters: totalIters,
        residual: result1.residual,
        satScale: 1,
      };
    }

    // Compute Bpeak over iron cells
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
      return {
        x: result1.x,
        iters: totalIters,
        residual: result1.residual,
        satScale: 1,
      };
    }

    // Corrective solve with scaled iron reluctivity.
    // The pre-built hierarchy coarsened the un-scaled operator, so it is stale after
    // setIronScale. We must rebuild the coarse levels from the scaled operator so the
    // Galerkin correction is consistent with the modified stencil.
    op.setIronScale(s, ironMask);
    const { Nr: hierNr, Ntheta: hierNt } = hierarchy[0];
    const scaledGrid = { Nr: hierNr, Ntheta: hierNt,
      rInner: op.r[0] - op.dr * 0.5,
      rOuter: op.r[hierNr - 1] + op.dr * 0.5,
      ell: op.ell };
    const scaledHierarchy = buildHierarchy(op, scaledGrid,
      { minNtheta: hierarchy[hierarchy.length - 1].Ntheta,
        maxLevels: hierarchy.length });
    const result2 = vcycleSolve(op, b, { x0: result1.x, tol, maxCycles, hierarchy: scaledHierarchy });
    op.setIronScale(1, ironMask);
    totalIters += result2.iters;

    return {
      x: result2.x,
      iters: totalIters,
      residual: result2.residual,
      satScale: s,
    };
  }

  // ---------------------------------------------------------------------------
  //  backend({ factor = 3, fillet = { strength: 1 }, mg = {} } = {}) → backend
  //
  //  Returns a Phase-5 SolveBackend:
  //    prepare(section) → { op, compiled }
  //    solveSaturated(op, b, o) → { x, iters, residual, satScale }
  //    linearSolve(op, b, o) → { x, iters, residual }
  // ---------------------------------------------------------------------------
  function backend({ factor = 3, fillet = { strength: 1 }, mg = {} } = {}) {
    return {
      prepare(section) {
        const refined = refineSection(section, { factor });
        const op = LIB.AirgapGrid.create(refined.grid);
        const compiled = LIB.MotorCompile.compile(refined);
        const nuFillet = filletCorners(compiled.nu, refined.grid, fillet);
        op.setMaterials({ nu: nuFillet });
        op.setRotorRegion({
          rotorMask: compiled.rotorMask,
          magnetization: compiled.magnetization,
        });
        op.setGapBand(refined.gapBand);
        // Build Galerkin hierarchy from the filleted fine operator (materials already set)
        op._refineHierarchy = buildHierarchy(op, refined.grid, mg);
        return { op, compiled };
      },

      solveSaturated(op, b, o) {
        return solveSaturated(op, b, {
          ...o,
          hierarchy: op._refineHierarchy,
        });
      },

      linearSolve(op, b, o) {
        return vcycleSolve(op, b, {
          ...o,
          hierarchy: op._refineHierarchy,
        });
      },
    };
  }

  LIB.AirgapRefine = {
    refineSection,
    filletCorners,
    buildHierarchy,
    vcycleSolve,
    solveSaturated,
    backend,
  };
})();
