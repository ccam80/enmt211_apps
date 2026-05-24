"use strict";

// =============================================================================
//  LIB.MotorCircuit — circuit-ODE primitives for air-gap coupled electrics
//
//  Implements the semi-implicit current step:
//    (L + R·dt)·i^{n+1} = L·i^n + (V − e)·dt
//  where e = ω·(dL/dθ·i + dλ_pm/dθ) is the motional back-EMF.
//
//  API (all attached to LIB.MotorCircuit):
//    extract(op, solveFn, sources, thetaR, opts)  → coeffs
//    makeCache({ period, binCount })              → cache
//    backEmf(coeffs, i, omega)                   → Float64Array(m)
//    stepCurrents({ L, R, V, i, dt, terminalStates, e }) → { i, vOpen }
//    advance(coeffs, { R, V, i, omega, dt, terminalStates }) → { i, e, vOpen }
//
//  Conventions:
//    m = circuit count
//    L   is a flat row-major Float64Array(m*m): L[k*m + l] = flux linkage in
//        circuit k per unit current in circuit l.
//    dLdth is the same layout: ∂L[k*m+l]/∂θ.
//    lambdaPm and dLambdaPmdth are Float64Array(m).
//    R, V are Float64Array(m).
//    terminalStates is a length-m array of strings:
//      "AC" | "DC" | "PULSE" | "STEP" → driven (use supplied V)
//      "SHORT" → effective V = 0
//      "OPEN"  → branch removed from system; current pinned to 0
//
//  No DOM/canvas access at module load. No Phase 2 / Phase 3 import.
//  Depends only on Phase 1 (GridOperator + solveFn injected as arguments).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  // ---------------------------------------------------------------------------
  //  solveDense(A, b, n) — partial-pivot Gaussian elimination
  //  Solves the n×n system A·x = b in place; returns the solution Float64Array.
  //  A is a flat row-major Float64Array(n*n) — MODIFIED IN PLACE.
  //  b is a Float64Array(n) — MODIFIED IN PLACE.
  // ---------------------------------------------------------------------------
  function solveDense(A, b, n) {
    // Forward elimination with partial pivoting
    for (let col = 0; col < n; col++) {
      // Find pivot row
      let pivotRow = col;
      let pivotVal = Math.abs(A[col * n + col]);
      for (let row = col + 1; row < n; row++) {
        const v = Math.abs(A[row * n + col]);
        if (v > pivotVal) {
          pivotVal = v;
          pivotRow = row;
        }
      }
      // Swap rows col and pivotRow in A and b
      if (pivotRow !== col) {
        for (let k = 0; k < n; k++) {
          const tmp = A[col * n + k];
          A[col * n + k] = A[pivotRow * n + k];
          A[pivotRow * n + k] = tmp;
        }
        const tmp = b[col];
        b[col] = b[pivotRow];
        b[pivotRow] = tmp;
      }
      // Eliminate below
      const diag = A[col * n + col];
      if (diag === 0) continue; // singular column — leave as zero
      for (let row = col + 1; row < n; row++) {
        const factor = A[row * n + col] / diag;
        for (let k = col; k < n; k++) {
          A[row * n + k] -= factor * A[col * n + k];
        }
        b[row] -= factor * b[col];
      }
    }
    // Back-substitution
    const x = new Float64Array(n);
    for (let row = n - 1; row >= 0; row--) {
      let s = b[row];
      for (let k = row + 1; k < n; k++) {
        s -= A[row * n + k] * x[k];
      }
      const diag = A[row * n + row];
      x[row] = diag !== 0 ? s / diag : 0;
    }
    return x;
  }

  // ---------------------------------------------------------------------------
  //  extract(op, solveFn, sources, thetaR, opts) → { L, dLdth, lambdaPm, dLambdaPmdth }
  //
  //  Builds the inductance matrix and PM flux linkage at thetaR using central
  //  finite differences for derivatives.
  //
  //  sources = { jzBasis, coilMasks, magnetization }
  //    jzBasis[j]  — Float64Array(Nr·Ntheta): J_z map for circuit j at unit current
  //    coilMasks   — m-entry array passed to op.fluxLinkage
  //    magnetization — { Mr, Mθ } or null (null ⇒ λ_pm = 0, zero-not-skip)
  //  opts = { derivStep = op.dtheta, x0 = null }
  // ---------------------------------------------------------------------------
  function extract(op, solveFn, sources, thetaR, opts) {
    opts = opts || {};
    const derivStep = (opts.derivStep !== undefined) ? opts.derivStep : op.dtheta;
    const x0 = opts.x0 || null;

    const { jzBasis, coilMasks, magnetization } = sources;
    const m = coilMasks.length;

    // evalAt(theta) → { L: Float64Array(m*m), lambdaPm: Float64Array(m) }
    function evalAt(theta) {
      op.setRotorAngle(theta);

      // PM flux linkage
      const lambdaPm = new Float64Array(m);
      if (magnetization !== null) {
        const b_pm = op.assembleRHS({ magnetization });
        const Az_pm = solveFn(op, b_pm, { x0 }).x;
        const lams = op.fluxLinkage(Az_pm, coilMasks);
        for (let l = 0; l < m; l++) lambdaPm[l] = lams[l];
      }
      // else lambdaPm stays all-zero (zero-not-skip)

      // Inductance matrix: one solve per circuit column
      const L = new Float64Array(m * m);
      for (let j = 0; j < m; j++) {
        const b_j = op.assembleRHS({ Jz: jzBasis[j] });
        const Az_j = solveFn(op, b_j, { x0 }).x;
        const col = op.fluxLinkage(Az_j, coilMasks);
        for (let i = 0; i < m; i++) {
          L[i * m + j] = col[i];
        }
      }

      return { L, lambdaPm };
    }

    // Three evaluations for central differences
    const center = evalAt(thetaR);
    const plus   = evalAt(thetaR + derivStep);
    const minus  = evalAt(thetaR - derivStep);

    // Restore op to the center angle before returning
    op.setRotorAngle(thetaR);

    // Central-difference derivatives
    const inv2h = 1 / (2 * derivStep);
    const dLdth = new Float64Array(m * m);
    for (let k = 0; k < m * m; k++) {
      dLdth[k] = (plus.L[k] - minus.L[k]) * inv2h;
    }
    const dLambdaPmdth = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      dLambdaPmdth[k] = (plus.lambdaPm[k] - minus.lambdaPm[k]) * inv2h;
    }

    return {
      L:              center.L,
      dLdth:          dLdth,
      lambdaPm:       center.lambdaPm,
      dLambdaPmdth:   dLambdaPmdth,
    };
  }

  // ---------------------------------------------------------------------------
  //  makeCache({ period, binCount }) → cache
  //
  //  θ-binned memoization of extract coefficients.
  //  Bins are evenly spaced over [0, period).
  // ---------------------------------------------------------------------------
  function makeCache({ period = 2 * Math.PI, binCount = 360 } = {}) {
    const binWidth = period / binCount;
    // Sparse slot storage: array of length binCount, each entry null or coeffs.
    const slots = new Array(binCount).fill(null);

    function binIndex(theta) {
      // Normalize theta into [0, period) and floor-divide by binWidth
      const normalized = ((theta % period) + period) % period;
      return Math.floor(normalized / binWidth);
    }

    function coeffs(theta, extractAt) {
      const idx = binIndex(theta);
      if (slots[idx] === null) {
        const binCenter = (idx + 0.5) * binWidth;
        slots[idx] = extractAt(binCenter);
      }
      return slots[idx];
    }

    function clear() {
      for (let i = 0; i < binCount; i++) slots[i] = null;
    }

    return { binWidth, binIndex, coeffs, clear };
  }

  // ---------------------------------------------------------------------------
  //  backEmf(coeffs, i, omega) → Float64Array(m)
  //
  //  e[k] = ω · ( Σ_l dLdth[k*m + l]·i[l] + dLambdaPmdth[k] )
  // ---------------------------------------------------------------------------
  function backEmf(coeffs, i, omega) {
    const { dLdth, dLambdaPmdth } = coeffs;
    const m = dLambdaPmdth.length;
    const e = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      let sum = dLambdaPmdth[k];
      for (let l = 0; l < m; l++) {
        sum += dLdth[k * m + l] * i[l];
      }
      e[k] = omega * sum;
    }
    return e;
  }

  // ---------------------------------------------------------------------------
  //  stepCurrents({ L, R, V, i, dt, terminalStates, e }) → { i: Float64Array(m), vOpen: Float64Array(m) }
  //
  //  Semi-implicit step over the active set A (indices where state !== "OPEN").
  //  OPEN entries: current pinned to 0; vOpen = induced open-circuit voltage.
  //  SHORT entries: effective V = 0.
  //  All other states: use supplied V.
  // ---------------------------------------------------------------------------
  function stepCurrents({ L, R, V, i, dt, terminalStates, e }) {
    const m = terminalStates.length;
    const iNext  = new Float64Array(m);
    const vOpen  = new Float64Array(m);

    // Active set: ascending indices where state !== "OPEN"
    const A = [];
    for (let k = 0; k < m; k++) {
      if (terminalStates[k] !== "OPEN") A.push(k);
    }
    const ma = A.length;

    if (ma === 0) {
      // Every circuit OPEN: return zero currents, vOpen = e[k] for all k
      for (let k = 0; k < m; k++) vOpen[k] = e[k];
      return { i: iNext, vOpen };
    }

    // Effective voltages
    const Veff = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      Veff[k] = (terminalStates[k] === "SHORT") ? 0 : V[k];
    }

    // Assemble reduced system Ar (ma×ma) and rhs (length ma)
    // Ar[a*ma + b] = L[A[a]*m + A[b]] + (a===b ? dt·R[A[a]] : 0)
    // rhs[a] = Σ_b L[A[a]*m + A[b]]·i[A[b]] + dt·(Veff[A[a]] − e[A[a]])
    const Ar  = new Float64Array(ma * ma);
    const rhs = new Float64Array(ma);

    for (let a = 0; a < ma; a++) {
      const ka = A[a];
      let rhsVal = dt * (Veff[ka] - e[ka]);
      for (let b = 0; b < ma; b++) {
        const kb = A[b];
        const Lkakb = L[ka * m + kb];
        Ar[a * ma + b] = Lkakb + (a === b ? dt * R[ka] : 0);
        rhsVal += Lkakb * i[kb];
      }
      rhs[a] = rhsVal;
    }

    // Solve reduced system
    const x = solveDense(Ar, rhs, ma);

    // Write active currents into iNext; OPEN entries stay 0
    for (let a = 0; a < ma; a++) {
      iNext[A[a]] = x[a];
    }

    // Compute open-circuit voltages for OPEN circuits
    // vOpen[k] = e[k] + Σ_l L[k*m + l]·(iNext[l] − i[l]) / dt
    for (let k = 0; k < m; k++) {
      if (terminalStates[k] === "OPEN") {
        let induced = 0;
        for (let l = 0; l < m; l++) {
          induced += L[k * m + l] * (iNext[l] - i[l]);
        }
        vOpen[k] = e[k] + induced / dt;
      }
      // non-OPEN: vOpen[k] stays 0
    }

    return { i: iNext, vOpen };
  }

  // ---------------------------------------------------------------------------
  //  advance(coeffs, { R, V, i, omega, dt, terminalStates }) → { i, e, vOpen }
  //
  //  Pure composition: e = backEmf(coeffs, i, omega), then stepCurrents.
  //  Reads no op; consumes pre-fetched coeffs.
  // ---------------------------------------------------------------------------
  function advance(coeffs, { R, V, i, omega, dt, terminalStates }) {
    const e = backEmf(coeffs, i, omega);
    const { i: iNext, vOpen } = stepCurrents({
      L: coeffs.L,
      R,
      V,
      i,
      dt,
      terminalStates,
      e,
    });
    return { i: iNext, e, vOpen };
  }

  // ---------------------------------------------------------------------------
  //  Attach to LIB
  // ---------------------------------------------------------------------------
  LIB.MotorCircuit = { extract, makeCache, backEmf, stepCurrents, advance };
})();
