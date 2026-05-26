"use strict";

const assert = require("node:assert/strict");

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

module.exports = { assertClose, fitCos2, fitCos2Cos4 };
