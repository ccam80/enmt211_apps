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
  //  Sparse stencil representation of a level operator.
  //
  //  A level operator is a stencil { Nr, Nt, rows } where rows[r] =
  //  { cols: Int32Array, vals: Float64Array } lists the nonzero entries of row r
  //  of the matrix (i.e. A[r][cols[t]] = vals[t]). The matrices on every level
  //  are extremely sparse — the fine FV operator is 5-point, and the θ-only
  //  Galerkin coarse operators are compact 9-point stencils (3×3 in (i,jθ)) — so
  //  storing them sparsely turns the O(Nc²) dense Galerkin assembly + matvec into
  //  O(Nc) work. The Gauge pin (index 0) row/col is identity, exactly as the
  //  dense form enforced.
  //
  //  The returned operator object exposes the same interface the smoother and
  //  V-cycle consume: matvec(x), diagonal(), radialCoeffs() → { aN, aS }. It also
  //  carries `_columns` (column-form of the stencil) so the next coarser Galerkin
  //  level can be assembled from it without re-probing.
  // ---------------------------------------------------------------------------
  const PIN = 0;

  // Extract the 5-point stencil of the fine FV operator by graph colouring. The
  // radial axis is non-periodic (colour period 3); the angular axis is periodic
  // with Nt a power of two, so colour period 4 (divides Nt, ≥ 3) leaves no seam
  // at the θ wrap and keeps same-colour cells ≥ 4 apart, guaranteeing that for any
  // row at most one same-colour source lies in its 5-point support. 3×4 = 12 fine
  // matvecs reconstruct the entire stencil exactly (verified bit-identical to the
  // dense R·A·P assembly).
  function extractFineStencil(fineOp, Nr, Nt) {
    const N = Nr * Nt;
    const rowMaps = new Array(N);
    for (let k = 0; k < N; k++) rowMaps[k] = new Map();

    const pr = 3, pa = 4;
    for (let ci = 0; ci < pr; ci++) {
      for (let cj = 0; cj < pa; cj++) {
        const e = new Float64Array(N);
        for (let i = 0; i < Nr; i++) {
          if (i % pr !== ci) continue;
          for (let j = 0; j < Nt; j++) {
            if (j % pa === cj) e[i * Nt + j] = 1;
          }
        }
        const Ae = fineOp.matvec(e);
        for (let row = 0; row < N; row++) {
          const v = Ae[row];
          if (v === 0) continue;
          const ri = (row / Nt) | 0, rj = row % Nt;
          // Candidate stencil cells of this row: {self, N, S, E, W}. The unique
          // one carrying the probed colour is the source of this contribution.
          const cands = [[ri, rj]];
          if (ri + 1 < Nr) cands.push([ri + 1, rj]);
          if (ri - 1 >= 0) cands.push([ri - 1, rj]);
          cands.push([ri, (rj + 1) % Nt]);
          cands.push([ri, (rj + Nt - 1) % Nt]);
          for (let c = 0; c < cands.length; c++) {
            const ci2 = cands[c][0], cj2 = cands[c][1];
            if (ci2 % pr === ci && cj2 % pa === cj) {
              const k = ci2 * Nt + cj2;
              rowMaps[row].set(k, (rowMaps[row].get(k) || 0) + v);
            }
          }
        }
      }
    }
    return rowMapsToStencil(rowMaps, Nr, Nt);
  }

  // Convert per-row Maps to a typed-array stencil and its column form.
  function rowMapsToStencil(rowMaps, Nr, Nt) {
    const N = Nr * Nt;
    const rows = new Array(N);
    const colMaps = new Array(N);
    for (let k = 0; k < N; k++) colMaps[k] = [];
    for (let r = 0; r < N; r++) {
      const m = rowMaps[r];
      const cols = new Int32Array(m.size);
      const vals = new Float64Array(m.size);
      let t = 0;
      for (const [c, v] of m) { cols[t] = c; vals[t] = v; t++; }
      rows[r] = { cols, vals };
      for (let s = 0; s < cols.length; s++) colMaps[cols[s]].push([r, vals[s]]);
    }
    return makeStencilOp(rows, colMaps, Nr, Nt);
  }

  // prolong basis e_k (coarse) → fine, returned as a small [fineIdx, weight] list.
  function prolongBasis(k, Nr, Nt_c) {
    const Nt_f = Nt_c * 2;
    const i = (k / Nt_c) | 0, jc = k % Nt_c;
    const jcm = (jc - 1 + Nt_c) % Nt_c;
    return [
      [i * Nt_f + 2 * jc, 1.0],
      [i * Nt_f + 2 * jc + 1, 0.5],
      [i * Nt_f + 2 * jcm + 1, 0.5],
    ];
  }

  // Coarse cells a given fine index restricts into (R = Pᵀ, full-weighting in θ):
  //   even fine 2jc → coarse jc weight 0.5
  //   odd  fine 2jc+1 → coarse jc weight 0.25 and coarse jc+1 weight 0.25
  function restrictTargetsOfFine(fineIdx, Nr, Nt_f) {
    const Nt_c = Nt_f / 2;
    const i = (fineIdx / Nt_f) | 0, jf = fineIdx % Nt_f;
    if (jf % 2 === 0) {
      const jc = jf / 2;
      return [[i * Nt_c + jc, 0.5]];
    }
    const jc = (jf - 1) / 2;
    return [
      [i * Nt_c + jc, 0.25],
      [i * Nt_c + ((jc + 1) % Nt_c), 0.25],
    ];
  }

  // ---------------------------------------------------------------------------
  //  buildGalerkinOp(fineOp, Nr, Nt_f, Nt_c)
  //
  //  Assembles the sparse Galerkin coarse operator A_c = R · A_f · P. Each coarse
  //  column A_c[:,k] = R · A_f · (P·e_k) is computed locally: P·e_k has ≤ 3 fine
  //  nonzeros, so A_f·(P·e_k) reaches only those cells' stencil neighbourhoods,
  //  and restriction collapses them to a handful of coarse rows — O(Nc) total
  //  rather than the O(Nc²) dense assembly. The fine column form is read from
  //  fineOp._columns when present (a previous sparse Galerkin level) or extracted
  //  from the fine FV operator by colouring (level 1). Numerically identical to
  //  the dense R·A·P; the gauge pin row/col is forced to identity.
  // ---------------------------------------------------------------------------
  function buildGalerkinOp(fineOp, Nr, Nt_f, Nt_c) {
    const fineCols = fineOp._columns
      ? fineOp._columns
      : extractFineStencil(fineOp, Nr, Nt_f)._columns;

    const Nc = Nr * Nt_c;
    const rowMaps = new Array(Nc);
    for (let r = 0; r < Nc; r++) rowMaps[r] = new Map();

    for (let k = 0; k < Nc; k++) {
      // A_f · (P·e_k) as a fine sparse vector
      const pe = prolongBasis(k, Nr, Nt_c);
      const fineAcc = new Map();
      for (let p = 0; p < pe.length; p++) {
        const fidx = pe[p][0], w = pe[p][1];
        const col = fineCols[fidx];
        for (let t = 0; t < col.length; t++) {
          const row = col[t][0], val = col[t][1];
          fineAcc.set(row, (fineAcc.get(row) || 0) + w * val);
        }
      }
      // Restrict to coarse: these become A_c[coarseRow][k]
      for (const [fineRow, v] of fineAcc) {
        const tgts = restrictTargetsOfFine(fineRow, Nr, Nt_f);
        for (let q = 0; q < tgts.length; q++) {
          const crow = tgts[q][0], rw = tgts[q][1];
          rowMaps[crow].set(k, (rowMaps[crow].get(k) || 0) + rw * v);
        }
      }
    }

    // Enforce gauge pin: row 0 and col 0 are identity.
    for (let r = 0; r < Nc; r++) {
      if (r === PIN) continue;
      rowMaps[r].delete(PIN);
    }
    rowMaps[PIN].clear();
    rowMaps[PIN].set(PIN, 1);

    return rowMapsToStencil(rowMaps, Nr, Nt_c);
  }

  // Build a level-operator object from a typed-array row stencil + column form.
  function makeStencilOp(rows, colMaps, Nr, Nt) {
    const N = Nr * Nt;

    // Precompute diagonal and radial (north/south) coupling magnitudes.
    const diag = new Float64Array(N);
    const aN = new Float64Array(N);
    const aS = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      const { cols, vals } = rows[r];
      const i = (r / Nt) | 0, j = r % Nt;
      const idxN = (i + 1 < Nr) ? (i + 1) * Nt + j : -1;
      const idxS = (i > 0) ? (i - 1) * Nt + j : -1;
      for (let t = 0; t < cols.length; t++) {
        const c = cols[t];
        if (c === r) diag[r] = vals[t];
        else if (c === idxN) aN[r] = -vals[t];
        else if (c === idxS) aS[r] = -vals[t];
      }
    }

    return {
      Nt,
      Nr,
      _columns: colMaps,
      matvec(x) {
        const out = new Float64Array(N);
        for (let r = 0; r < N; r++) {
          const { cols, vals } = rows[r];
          let sum = 0;
          for (let t = 0; t < cols.length; t++) sum += vals[t] * x[cols[t]];
          out[r] = sum;
        }
        return out;
      },
      diagonal() {
        return diag.slice();
      },
      radialCoeffs() {
        return { aN: aN.slice(), aS: aS.slice() };
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
  //
  //  The hierarchy is a multigrid PRECONDITIONER: the V-cycle's fine level always
  //  uses the live operator `op` and the per-cycle residual is measured against
  //  `op`, so the converged solution is the live operator's solution regardless of
  //  how stale the coarse Galerkin levels are. The corrective (saturated) solve
  //  therefore reuses the same hierarchy as preconditioner for the scaled stencil
  //  instead of reassembling a scaled Galerkin stack — convergence to `tol` against
  //  the live scaled operator is unchanged, only the preconditioner quality varies.
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

    // Corrective solve with scaled iron reluctivity. Reuse the cached hierarchy
    // as the preconditioner — the V-cycle converges to the live scaled operator
    // (fine-level smoother and residual use `op` directly after setIronScale).
    op.setIronScale(s, ironMask);
    const result2 = vcycleSolve(op, b, { x0: result1.x, tol, maxCycles, hierarchy });
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
  //  rebuildEvery — number of solves a cached Galerkin hierarchy is reused for
  //  before it is reassembled from the current fine operator.
  //
  //  The hierarchy is a multigrid PRECONDITIONER. The V-cycle's fine level always
  //  uses the live operator and the residual is measured against it every cycle,
  //  so a slightly-stale set of coarse Galerkin levels never changes the converged
  //  answer — it only mildly affects the V-cycle count. Reassembling the dense
  //  Galerkin levels (≈ Nt_c fine matvecs per level) on every solve dominates the
  //  cost of a refined dynamic sweep; reusing it across a small window of rotor
  //  steps removes that cost while keeping the preconditioner fresh enough that
  //  the V-cycle count stays in the grid-independent band.
  // ---------------------------------------------------------------------------
  const DEFAULT_REBUILD_EVERY = 8;

  //  ensureHierarchy(op) → hierarchy
  //
  //  Returns the operator's cached Galerkin hierarchy, reassembling it from the
  //  current fine stencil when the cache is absent or has been reused for
  //  `rebuildEvery` solves. The age counter is incremented on every call so the
  //  cache is refreshed periodically as the rotor advances.
  function ensureHierarchy(op) {
    const every = (op._refineRebuildEvery > 0) ? op._refineRebuildEvery : DEFAULT_REBUILD_EVERY;
    if (!op._refineHierarchy || op._refineHierAge >= every) {
      op._refineHierarchy = buildHierarchy(op, op._refineGrid, op._refineMg);
      op._refineHierAge = 0;
    }
    op._refineHierAge++;
    return op._refineHierarchy;
  }

  // ---------------------------------------------------------------------------
  //  backend({ factor = 3, fillet = { strength: 1 }, mg = {}, rebuildEvery })
  //    → backend
  //
  //  Returns a Phase-5 SolveBackend:
  //    prepare(section) → { op, compiled }
  //    solveSaturated(op, b, o) → { x, iters, residual, satScale }
  //    linearSolve(op, b, o) → { x, iters, residual }
  //
  //  rebuildEvery (default 8) bounds how stale the cached multigrid preconditioner
  //  is allowed to get between reassemblies (see ensureHierarchy).
  // ---------------------------------------------------------------------------
  function backend({ factor = 3, fillet = { strength: 1 }, mg = {}, rebuildEvery = DEFAULT_REBUILD_EVERY } = {}) {
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
        // Register conductor maps so rotor-member windings rotate with thetaR
        // (FIX 1). The Live backend (motor-slice.prepare) does this too; without
        // it the refined runtime's coeffs extraction returns undefined/NaN.
        op.setRotorCoilMasks(compiled.coilMasks);
        op.setGapBand(refined.gapBand);
        // Stash grid for hierarchy rebuild; stash mg opts for reuse.
        op._refineGrid = refined.grid;
        op._refineMg   = mg;
        op._refineRebuildEvery = rebuildEvery;
        // Build initial hierarchy (rotor at angle 0 from prepare) and seed the
        // reuse age so the next `rebuildEvery` solves reuse it.
        op._refineHierarchy = buildHierarchy(op, refined.grid, mg);
        op._refineHierAge = 0;
        return { op, compiled };
      },

      solveSaturated(op, b, o) {
        return solveSaturated(op, b, {
          ...o,
          hierarchy: ensureHierarchy(op),
        });
      },

      linearSolve(op, b, o) {
        return vcycleSolve(op, b, {
          ...o,
          hierarchy: ensureHierarchy(op),
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
