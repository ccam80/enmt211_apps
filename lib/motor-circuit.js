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
//  No DOM/canvas access at module load.
//  Depends only on GridOperator + solveFn injected as arguments.
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

      // Use the rotor-rotated conductor maps at this angle so that wound-rotor
      // circuits' unit-current source (Jz) and flux-linkage readout reflect the
      // moved conductors — this is what makes dM/dθ and dλpm/dθ non-zero for
      // wound rotors. Falls back to the static masks when the op exposes none.
      const masks = (typeof op.rotatedCoilMasks === "function" && op.rotatedCoilMasks())
        ? op.rotatedCoilMasks()
        : coilMasks;

      // PM flux linkage
      const lambdaPm = new Float64Array(m);
      if (magnetization !== null) {
        const b_pm = op.assembleRHS({ magnetization });
        const Az_pm = solveFn(op, b_pm, { x0 }).x;
        const lams = op.fluxLinkage(Az_pm, masks);
        for (let l = 0; l < m; l++) lambdaPm[l] = lams[l];
      }
      // else lambdaPm stays all-zero (zero-not-skip)

      // Inductance matrix: one solve per circuit column
      const L = new Float64Array(m * m);
      for (let j = 0; j < m; j++) {
        const b_j = op.assembleRHS({ Jz: masks[j] });
        const Az_j = solveFn(op, b_j, { x0 }).x;
        const col = op.fluxLinkage(Az_j, masks);
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
      // A diverged sim can hand us a non-finite θ; without this guard
      // binIndex(NaN)=NaN → slots[NaN]=undefined → coeffs destructure throws,
      // turning a numerical divergence into an opaque crash. Map non-finite θ to
      // bin 0 so the run fails on its own assertion (e.g. runaway θ) rather than
      // an undefined-property error. (The coeffs are meaningless once diverged.)
      if (!Number.isFinite(theta)) return 0;
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
    // Back-EMF is a CIRCUIT VOLTAGE, e = dλ/dt, and λ (the conductor loop integral
    // ∮A·dl) is physical webers with NO gap Parseval π (λ ratio 1.0 to the Stokes
    // field-side reference). e = ∂_t/∂_θ of λ cannot manufacture a measure λ lacks,
    // so the motional back-EMF is measure-1 (GAP_MEASURE = 1). The ∫₀^{2π}cos²=π
    // Parseval measure is a property of the gap-energy/stress ring integral and
    // lives ONLY in the torque, not in a voltage. Pinned independently by the
    // rotor-cage synchronous speed: a spurious π on e would lock the cage at
    // ω_e/(2π) instead of the correct ω_e/2 = 157 rad/s.
    const GAP_MEASURE = 1;
    for (let k = 0; k < m; k++) {
      let sum = dLambdaPmdth[k];
      for (let l = 0; l < m; l++) {
        sum += dLdth[k * m + l] * i[l];
      }
      e[k] = GAP_MEASURE * omega * sum;
    }
    return e;
  }

  // ---------------------------------------------------------------------------
  //  stepCurrents({ L, R, V, i, dt, terminalStates, e, Iimp }) → { i: Float64Array(m), vOpen: Float64Array(m) }
  //
  //  Partitions circuits into CURRENT (pinned), OPEN (pinned to 0), and free F.
  //  CURRENT entries: iNext[k] = Iimp[k] exactly.
  //  OPEN entries: current pinned to 0; vOpen = induced open-circuit voltage.
  //  SHORT entries: effective V = 0.
  //  All other states (free set F): solved via reduced semi-implicit system with
  //  CURRENT contributions moved to the RHS.
  //
  //  Invariant: Iimp must be provided when any terminalStates entry is "CURRENT".
  //  Callers that pass no CURRENT states may omit Iimp.
  // ---------------------------------------------------------------------------
  function stepCurrents({ L, R, V, i, dt, terminalStates, e, Iimp }) {
    const m = terminalStates.length;
    const iNext  = new Float64Array(m);
    const vOpen  = new Float64Array(m);

    // R is normally a DIAGONAL per-circuit vector (Float64Array(m)). It may also
    // be a COUPLED m×m matrix (Float64Array(m*m)) for resistively-coupled
    // circuits — e.g. a rotor cage, whose end-ring segments couple adjacent
    // bars OFF-diagonally. Rget(ka,kb) reads the coupling either way; a plain
    // diagonal vector yields off-diagonal 0, reproducing the prior behavior
    // byte-for-byte for every non-cage machine.
    const Rcoupled = !!(R && R.length === m * m);
    function Rget(ka, kb) {
      return Rcoupled ? R[ka * m + kb] : (ka === kb ? R[ka] : 0);
    }

    // Partition into CURRENT, OPEN, and free (F) sets
    const F       = [];  // free indices (voltage-driven or short)
    const CURRENT = [];  // current-pinned indices
    for (let k = 0; k < m; k++) {
      if (terminalStates[k] === "CURRENT") {
        CURRENT.push(k);
        iNext[k] = Iimp[k];  // pin immediately
      } else if (terminalStates[k] === "OPEN") {
        // iNext[k] stays 0
      } else {
        F.push(k);
      }
    }

    const mf = F.length;

    if (mf > 0) {
      // Effective voltages for free set
      const Veff = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        Veff[k] = (terminalStates[k] === "SHORT") ? 0 : V[k];
      }

      // Assemble reduced system Ar (mf×mf) and rhs (length mf). Semi-implicit:
      //   (L + dt·R)·i^{n+1} = L·i^n + dt·(Veff − e)
      // Ar[a*mf + b] = L[F[a]*m + F[b]] + dt·R(F[a],F[b])   (R off-diagonal supported)
      // rhs[a] = Σ_{kb∈F} L[F[a]*m + kb]·i[kb] + dt·(Veff[F[a]] − e[F[a]])
      //          + Σ_{kc∈CURRENT} [ L[F[a]*m + kc]·(i[kc] − Iimp[kc]) − dt·R(F[a],kc)·Iimp[kc] ]
      const Ar  = new Float64Array(mf * mf);
      const rhs = new Float64Array(mf);

      for (let a = 0; a < mf; a++) {
        const ka = F[a];
        let rhsVal = dt * (Veff[ka] - e[ka]);
        for (let b = 0; b < mf; b++) {
          const kb = F[b];
          const Lkakb = L[ka * m + kb];
          Ar[a * mf + b] = Lkakb + dt * Rget(ka, kb);
          rhsVal += Lkakb * i[kb];
        }
        // CURRENT contribution moved from LHS to RHS — both the L coupling and
        // any off-diagonal R coupling to a pinned-current circuit (the R term is
        // identically 0 for a diagonal R, so non-cage behavior is unchanged).
        for (let c = 0; c < CURRENT.length; c++) {
          const kc = CURRENT[c];
          rhsVal += L[ka * m + kc] * (i[kc] - Iimp[kc]);
          rhsVal -= dt * Rget(ka, kc) * Iimp[kc];
        }
        rhs[a] = rhsVal;
      }

      // Solve reduced system and write free currents into iNext
      const x = solveDense(Ar, rhs, mf);
      for (let a = 0; a < mf; a++) {
        iNext[F[a]] = x[a];
      }
    }

    // Compute open-circuit voltages for OPEN circuits
    // vOpen[k] = e[k] + Σ_l L[k*m + l]·(iNext[l] − i[l]) / dt
    // iNext now includes pinned CURRENT values, so the formula is correct.
    // CURRENT circuits leave vOpen[k] = 0 (no source voltage exposed).
    for (let k = 0; k < m; k++) {
      if (terminalStates[k] === "OPEN") {
        let induced = 0;
        for (let l = 0; l < m; l++) {
          induced += L[k * m + l] * (iNext[l] - i[l]);
        }
        vOpen[k] = e[k] + induced / dt;
      }
    }

    return { i: iNext, vOpen };
  }

  // ---------------------------------------------------------------------------
  //  advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp }) → { i, e, vOpen }
  //
  //  Pure composition: e = backEmf(coeffs, i, omega), then stepCurrents.
  //  Reads no op; consumes pre-fetched coeffs.
  //  Iimp is optional; omit when no CURRENT terminal states are present.
  // ---------------------------------------------------------------------------
  function advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp }) {
    const e = backEmf(coeffs, i, omega);
    const { i: iNext, vOpen } = stepCurrents({
      L: coeffs.L,
      R,
      V,
      i,
      dt,
      terminalStates,
      e,
      Iimp,
    });
    return { i: iNext, e, vOpen };
  }

  // ---------------------------------------------------------------------------
  //  Attach to LIB
  // ---------------------------------------------------------------------------
  LIB.MotorCircuit = { extract, makeCache, backEmf, stepCurrents, advance };
})();
