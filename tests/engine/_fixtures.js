"use strict";

// =============================================================================
//  Shared test fixtures and helpers for engine tests.
//  Not a test file — no .test.js suffix. Required by test files.
//
//  The salient fixture is a REAL magnetic machine: an iron rotor, a genuine
//  always-air gap, and an iron stator, carrying a sinusoidal stator winding.
//  Saliency is geometric — the rotor iron's outer surface depth is θ-modulated
//  (a staircase salient rotor on the polar grid) so the effective air-gap
//  permeance realizes  1/g(θ,θr) ∝ a0 + a2·cos2(θ−θr).  This produces a
//  physically meaningful Maxwell shear in the gap, so Arkkio is non-trivial and
//  agrees with both the co-energy decomposition and the closed-form torque.
// =============================================================================

const assert = require("node:assert/strict");
const LIB = require("../_shim.js");

// ---------------------------------------------------------------------------
//  assertClose(actual, expected, tol, msg)
//  Passes if |actual - expected| <= tol * max(1, |expected|)
//  (relative tolerance, falling back to absolute when |expected| < 1).
// ---------------------------------------------------------------------------
function assertClose(actual, expected, tol, msg) {
  const scale = Math.max(1, Math.abs(expected));
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tol * scale,
    `${msg || "assertClose"}: |${actual} - ${expected}| = ${diff} > tol*scale ${tol * scale}`
  );
}

// ---------------------------------------------------------------------------
//  SALIENT_DEFAULTS — single source of truth for the analytic-salient fixture.
//
//  Geometry (real iron ↔ air-gap ↔ iron machine):
//   - Nr = 40, dr = (rOuter−rInner)/Nr = 0.0005 m.
//   - Air-gap band [rGapInner, rGapOuter] = [0.048, 0.052] = 8 radial cells,
//     pure air at every θ-column; this is the Arkkio integration band.
//   - Rotor iron occupies [rInner, rGapInner); the salient rotor surface is
//     realized WITHIN that band by per-θ-column modulation of the rotor-iron
//     outer depth (air fills the rest of the band up to rGapInner), so the
//     rotor surface never enters the gap band.
//   - Stator iron occupies [rGapOuter, rOuter).
// ---------------------------------------------------------------------------
const SALIENT_DEFAULTS = {
  Nr: 40,
  Ntheta: 256,
  rInner: 0.04,
  rOuter: 0.06,
  ell: 1,
  rGapInner: 0.048,
  rGapOuter: 0.052,
  a0: 1.0,
  a2: 0.3,
  N: 100,
  current: 1.0,
};

// ---------------------------------------------------------------------------
//  buildSalient({ Nr, Ntheta, rInner, rOuter, ell, rGapInner, rGapOuter,
//                 a0, a2, N, current })
//  → { op, Jz, coilMasks, ironMask, sweepThetaR(thetaR) }
//
//  Real-iron salient machine:
//   - Rotor iron (ν = ν_iron) in [rInner, rGapInner) with a θ-modulated outer
//     surface r_surface(θ). A cell in that band is iron below the surface and
//     air (ν = ν₀) above it. The effective air gap g(θ) = rGapOuter − r_surface(θ)
//     is chosen so 1/g(θ) ∝ a0 + a2·cos2θ. The WHOLE rotor band is the rotor
//     region, so setRotorAngle(θr) rotates the iron/air saliency pattern.
//   - Air gap (ν = ν₀, never modulated) in [rGapInner, rGapOuter) — the Arkkio
//     band, registered via op.setGapBand.
//   - Stator iron (ν = ν_iron) in [rGapOuter, rOuter).
//   - Sinusoidal stator winding n(θ) = N·cosθ placed in the stator-iron band,
//     fed by `current`. coilMasks[0] is the signed turn-density mask used for
//     flux linkage; Jz is the current density (current already baked in).
//   - ironMask marks all iron cells (rotor + stator), used by the solver and
//     saturation-ceiling tests.
// ---------------------------------------------------------------------------
function buildSalient({
  Nr, Ntheta, rInner, rOuter, ell, rGapInner, rGapOuter, a0, a2, N, current,
}) {
  const MU0 = LIB.AirgapGrid.MU0;
  const nu0 = 1 / MU0;          // air reluctivity
  const muIron = 2000;          // relative permeability of iron
  const nuIron = nu0 / muIron;  // iron reluctivity (low ν ⇒ high permeability)

  const op = LIB.AirgapGrid.create({ Nr, Ntheta, rInner, rOuter, ell });
  const dr = op.dr;
  const dtheta = op.dtheta;
  const r = op.r;
  const totalCells = Nr * Ntheta;

  // Gap-band radial index range: boundary between cell i-1 and i sits at
  // rInner + i*dr, so iInner = round((rGapInner−rInner)/dr).
  const iGapInner = Math.round((rGapInner - rInner) / dr);
  const iGapOuter = Math.round((rGapOuter - rInner) / dr);
  op.setGapBand({ iInner: iGapInner, iOuter: iGapOuter });

  // Effective air gap g(θ) = G / (a0 + a2·cos2θ), so 1/g ∝ a0 + a2·cos2θ.
  // r_surface(θ) = rGapOuter − g(θ) must stay strictly inside [rInner, rGapInner].
  // g ranges over [G/(a0+a2), G/(a0−a2)]; pick G to keep the surface a little
  // below rGapInner at its deepest and well above rInner at its shallowest.
  const gMid = 0.65 * (rGapInner - rInner);   // ≈ 0.0052 for the defaults
  const G = gMid; // scale so r_surface ∈ (rInner, rGapInner)
  const surfaceAt = (theta) => {
    const g = G / (a0 + a2 * Math.cos(2 * theta));
    return rGapOuter - g;
  };

  // Base reluctivity (θr = 0): rotor band staircase iron, always-air gap,
  // stator iron. Stator/gap cells are NOT part of the rotor region; their ν
  // is fixed and untouched by setRotorAngle.
  const nuArr = new Float64Array(totalCells);
  for (let i = 0; i < Nr; i++) {
    for (let j = 0; j < Ntheta; j++) {
      const idx = i * Ntheta + j;
      if (i < iGapInner) {
        // Rotor band: iron below the salient surface, air above.
        const theta = j * dtheta;
        nuArr[idx] = (r[i] < surfaceAt(theta)) ? nuIron : nu0;
      } else if (i < iGapOuter) {
        // Always-air gap band.
        nuArr[idx] = nu0;
      } else {
        // Stator iron.
        nuArr[idx] = nuIron;
      }
    }
  }
  op.setMaterials({ nu: nuArr });

  // Rotor region = the entire rotor band [0, iGapInner). The iron/air staircase
  // within it encodes the saliency; setRotorAngle rotates the whole pattern.
  const rotorMaskArr = new Uint8Array(totalCells);
  for (let i = 0; i < iGapInner; i++) {
    for (let j = 0; j < Ntheta; j++) rotorMaskArr[i * Ntheta + j] = 1;
  }
  op.setRotorRegion({ rotorMask: rotorMaskArr });

  // Stator winding: sinusoidal turn density n(θ) = N·cosθ, placed in the
  // stator-iron band. Jz = current density driving the field; coilMasks[0] is
  // the signed turn-density mask for flux linkage. A current 1 A in the winding
  // gives Jz = N·cosθ·current spread over the stator-iron radial cells.
  const Jz = new Float64Array(totalCells);
  const coilMask0 = new Float64Array(totalCells);
  for (let i = iGapOuter; i < Nr; i++) {
    for (let j = 0; j < Ntheta; j++) {
      const idx = i * Ntheta + j;
      const theta = j * dtheta;
      const turns = N * Math.cos(theta);
      Jz[idx] = turns * current;
      coilMask0[idx] = turns;
    }
  }
  const coilMasks = [coilMask0];

  // ironMask: all iron cells (rotor staircase + stator). Used by solver/ceiling
  // tests. Computed from the θr=0 base material (iron ⇔ ν === nuIron).
  const ironMask = new Uint8Array(totalCells);
  for (let idx = 0; idx < totalCells; idx++) {
    if (nuArr[idx] === nuIron) ironMask[idx] = 1;
  }

  // sweepThetaR(thetaR): rotate the saliency, solve, return field + L11 + arkkio.
  function sweepThetaR(thetaR) {
    op.setRotorAngle(thetaR);
    const b = op.assembleRHS({ Jz });
    const { x: Az } = LIB.AirgapSolve.pcg(op, b, { tol: 1e-10, maxIter: 5000 });
    const { Br, Bt } = op.field(Az);
    const lams = op.fluxLinkage(Az, coilMasks);
    const L11 = lams[0] / current; // unit current baked into Jz
    const torqueArkkio = LIB.AirgapTorque.arkkio(op, Az);
    return { Az, Br, Bt, L11, torqueArkkio };
  }

  return { op, Jz, coilMasks, ironMask, sweepThetaR };
}

// ---------------------------------------------------------------------------
//  fitCos2(thetaRs, Ls) → { L0, L2, r2 }
//  Least-squares fit of L(θr) = L0 + L2·cos2θr.
//  Returns coefficient-of-determination r2.
// ---------------------------------------------------------------------------
function fitCos2(thetaRs, Ls) {
  const n = thetaRs.length;
  // Design matrix columns: [1, cos2θr]
  // Normal equations: [n, Σcos2θ; Σcos2θ, Σcos²2θ] [L0; L2] = [ΣL; Σcos2θ·L]
  let sumL = 0, sumC = 0, sumCC = 0, sumCL = 0;
  for (let k = 0; k < n; k++) {
    const c = Math.cos(2 * thetaRs[k]);
    const L = Ls[k];
    sumL  += L;
    sumC  += c;
    sumCC += c * c;
    sumCL += c * L;
  }
  // Solve 2x2 system
  const det = n * sumCC - sumC * sumC;
  const L0 = (sumL * sumCC - sumC * sumCL) / det;
  const L2 = (n * sumCL - sumC * sumL) / det;

  // Coefficient of determination
  const Lmean = sumL / n;
  let ssTot = 0, ssRes = 0;
  for (let k = 0; k < n; k++) {
    const c = Math.cos(2 * thetaRs[k]);
    const Lfit = L0 + L2 * c;
    ssTot += (Ls[k] - Lmean) ** 2;
    ssRes += (Ls[k] - Lfit) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return { L0, L2, r2 };
}

// ---------------------------------------------------------------------------
//  fitCos2Cos4(thetas, Ls) → { L0, L2, L4, r2 }
//  Two-harmonic least-squares fit of L(θ) on the supplied angle. Callers pass
//  the ELECTRICAL angle θ_e = (poles/2)·θ_mech so the saliency lands at the 2nd
//  and 4th electrical harmonics. The model fits each harmonic at FULL amplitude
//  AND phase:
//
//      L(θ) = L0 + a2c·cos2θ + a2s·sin2θ + a4c·cos4θ + a4s·sin4θ
//
//  and reports the harmonic AMPLITUDES L2 = hypot(a2c,a2s), L4 = hypot(a4c,a4s)
//  together with the coefficient-of-determination r2 of the combined model.
//
//  The phase terms are required: a saliency's harmonic phase is set purely by
//  where θ=0 sits relative to the winding, which is a coordinate convention with
//  no physical content. A concentrated single-coil winding (VR / switched-
//  reluctance) puts the inductance saliency at a non-zero harmonic phase, so a
//  cosine-only fit would spuriously fail even though the energy is entirely at
//  electrical harmonics 2 and 4. Including the sine terms makes the test an
//  origin-independent check that "the saliency lives at the electrical
//  harmonics" — which is exactly the physical claim. L2/L4 amplitudes are
//  phase-invariant, so max(|L2|,|L4|) > 1e-9 remains a clean saliency probe.
//
//  Additive helper — does not replace the cosine-only fitCos2.
// ---------------------------------------------------------------------------
function fitCos2Cos4(thetas, Ls) {
  const n = thetas.length;
  // Basis: [1, cos2θ, sin2θ, cos4θ, sin4θ]. Solve the 5×5 normal equations
  // AᵀA·β = Aᵀy by Gaussian elimination with partial pivoting.
  const NB = 5;
  const basis = (t) => [
    1,
    Math.cos(2 * t), Math.sin(2 * t),
    Math.cos(4 * t), Math.sin(4 * t),
  ];

  // Augmented Gram matrix [ AᵀA | Aᵀy ].
  const M = [];
  for (let i = 0; i < NB; i++) M.push(new Array(NB + 1).fill(0));
  for (let k = 0; k < n; k++) {
    const c = basis(thetas[k]);
    const L = Ls[k];
    for (let i = 0; i < NB; i++) {
      for (let j = 0; j < NB; j++) M[i][j] += c[i] * c[j];
      M[i][NB] += c[i] * L;
    }
  }

  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < NB; col++) {
    let pivot = col;
    for (let row = col + 1; row < NB; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    const tmp = M[col]; M[col] = M[pivot]; M[pivot] = tmp;
    const diag = M[col][col];
    for (let row = 0; row < NB; row++) {
      if (row === col) continue;
      const factor = M[row][col] / diag;
      for (let cc = col; cc <= NB; cc++) M[row][cc] -= factor * M[col][cc];
    }
  }
  const beta = new Array(NB);
  for (let i = 0; i < NB; i++) beta[i] = M[i][NB] / M[i][i];

  const L0 = beta[0];
  const L2 = Math.hypot(beta[1], beta[2]);  // electrical-2 amplitude
  const L4 = Math.hypot(beta[3], beta[4]);  // electrical-4 amplitude

  // Coefficient of determination of the combined two-harmonic model.
  let sumL = 0;
  for (let k = 0; k < n; k++) sumL += Ls[k];
  const Lmean = sumL / n;
  let ssTot = 0, ssRes = 0;
  for (let k = 0; k < n; k++) {
    const c = basis(thetas[k]);
    let Lfit = 0;
    for (let i = 0; i < NB; i++) Lfit += beta[i] * c[i];
    ssTot += (Ls[k] - Lmean) ** 2;
    ssRes += (Ls[k] - Lfit) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 1;

  return { L0, L2, L4, r2 };
}

module.exports = { assertClose, SALIENT_DEFAULTS, buildSalient, fitCos2, fitCos2Cos4 };
