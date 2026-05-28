"use strict";

// =============================================================================
//  reciprocity.test.js — surfaceFlux self-adjointness (reciprocity)
//
//  The discrete A↦flux operator implemented by surfaceFlux must be reciprocal
//  (self-adjoint) for ALL phase angles φ, not just φ=0. Concretely, for two
//  independent manufactured fields A1, A2:
//
//      ⟨q(A1), A2⟩ == ⟨q(A2), A1⟩
//
//  where q(A) = surfaceFlux(A_rotor, A_stator, φ) and the inner product sums
//  the rotor channel against the rotor field and the stator channel against
//  the stator field over their respective gap circles.
//
//  Bug history: the rotor flux was applied M_k in the COMMON frame but never
//  back-rotated by R_k(-φ) to the rotor frame before reconstruction. This made
//  the operator non-self-adjoint for φ≠0 (asymmetry O(1) at φ=0.31/1.07/2.5,
//  ~1e-15 only at φ=0). The fix back-rotates the rotor flux channel. This test
//  FAILS on the old code (φ≠0) and PASSES on the fixed code.
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  AH,
  uniformCircle,
  manufactured,
} = require("./_fixtures.js");

// Harness mirrors rotation.test.js / admittance.test.js
const K_TEST = 6;
const NGR    = 32;
const NGS    = 32;
const R_MR   = 0.040;
const R_MS   = 0.045;
const ELL    = 0.080;

function buildTestGap() {
  const rotor  = uniformCircle(NGR, R_MR);
  const stator = uniformCircle(NGS, R_MS);
  return AH.build(rotor, stator, { K: K_TEST, ell: ELL });
}

// Two independent manufactured fields with mixed cos/sin harmonics so that
// every harmonic channel (and both the rotor and stator boundaries) carry
// non-trivial content. Distinct coefficients ⇒ A1 ≠ A2.
const COEFFS_1 = {
  a0: 0.5, b0: 0.0,
  ac: [0,  1.2,  0.4, -0.3],
  bc: [0,  0.3,  0.8,  0.2],
  as: [0,  0.7, -0.5,  0.15],
  bs: [0,  0.2,  0.3, -0.1],
};
const COEFFS_2 = {
  a0: -0.2, b0: 0.0,
  ac: [0, -0.6,  0.9,  0.25],
  bc: [0,  0.5, -0.4,  0.1],
  as: [0,  0.35, 0.6, -0.2],
  bs: [0, -0.15, 0.45, 0.3],
};

const ROTOR_THETA  = uniformCircle(NGR, R_MR).gapTheta;
const STATOR_THETA = uniformCircle(NGS, R_MS).gapTheta;

// Sample a manufactured field onto the rotor + stator gap circles.
function sampleField(coeffs) {
  const f = manufactured(coeffs);
  return {
    rotor:  f.sample(R_MR, ROTOR_THETA),
    stator: f.sample(R_MS, STATOR_THETA),
  };
}

// Full inner product ⟨q, A⟩ = Σ_i q.rotor[i]·A.rotor[i] + Σ_j q.stator[j]·A.stator[j]
function innerProduct(q, A) {
  let s = 0;
  for (let i = 0; i < q.rotor.length;  i++) s += q.rotor[i]  * A.rotor[i];
  for (let j = 0; j < q.stator.length; j++) s += q.stator[j] * A.stator[j];
  return s;
}

describe("surfaceFlux is reciprocal (self-adjoint) at all φ", function () {
  const PHIS = [0, 0.31, 1.07, 2.5];

  PHIS.forEach(function (phi) {
    it(`⟨q(A1),A2⟩ == ⟨q(A2),A1⟩ at φ=${phi}`, function () {
      const hg = buildTestGap();

      const A1 = sampleField(COEFFS_1);
      const A2 = sampleField(COEFFS_2);

      const q1 = hg.surfaceFlux(A1.rotor, A1.stator, phi);
      const q2 = hg.surfaceFlux(A2.rotor, A2.stator, phi);

      const ip12 = innerProduct(q1, A2); // ⟨q(A1), A2⟩
      const ip21 = innerProduct(q2, A1); // ⟨q(A2), A1⟩

      const denom = Math.max(Math.abs(ip12), Math.abs(ip21), 1e-30);
      const asym  = Math.abs(ip12 - ip21) / denom;

      assert.ok(asym <= 1e-12,
        `reciprocity asymmetry at φ=${phi} is ${asym} > 1e-12 ` +
        `(⟨q(A1),A2⟩=${ip12}, ⟨q(A2),A1⟩=${ip21})`);
    });
  });
});

describe("φ=0 behavior is unchanged by the back-rotation", function () {
  it("rotor + stator channels at φ=0 equal the M_k·project reconstruction", function () {
    // At φ=0 the back-rotation is the identity (cos=1, sin=0), so surfaceFlux
    // must equal the plain M_k-per-harmonic reconstruction. Recompute that
    // reference independently from the public project/reconstruct + Mk surface
    // and assert exact agreement.
    const hg = buildTestGap();
    const A1 = sampleField(COEFFS_1);

    const got = hg.surfaceFlux(A1.rotor, A1.stator, 0);

    // Independent reference: project both circles, apply M_k per harmonic with
    // NO frame rotation (φ=0), reconstruct.
    const R = hg.project(ROTOR_THETA,  A1.rotor);
    const S = hg.project(STATOR_THETA, A1.stator);

    const K = K_TEST;
    const qRa = new Float64Array(K + 1);
    const qRb = new Float64Array(K + 1);
    const qSa = new Float64Array(K + 1);
    const qSb = new Float64Array(K + 1);

    // k=0
    {
      const M = hg._internals.Mk(0);
      qRa[0] = M[0][0] * R.a[0] + M[0][1] * S.a[0];
      qSa[0] = M[1][0] * R.a[0] + M[1][1] * S.a[0];
    }
    for (let k = 1; k <= K; k++) {
      const M = hg._internals.Mk(k);
      qRa[k] = M[0][0] * R.a[k] + M[0][1] * S.a[k];
      qSa[k] = M[1][0] * R.a[k] + M[1][1] * S.a[k];
      qRb[k] = M[0][0] * R.b[k] + M[0][1] * S.b[k];
      qSb[k] = M[1][0] * R.b[k] + M[1][1] * S.b[k];
    }
    const refRotor  = hg.reconstruct({ a: qRa, b: qRb }, ROTOR_THETA);
    const refStator = hg.reconstruct({ a: qSa, b: qSb }, STATOR_THETA);

    for (let i = 0; i < refRotor.length; i++) {
      assert.ok(Math.abs(got.rotor[i] - refRotor[i]) <= 1e-12,
        `φ=0 rotor flux mismatch at i=${i}: ${got.rotor[i]} vs ${refRotor[i]}`);
    }
    for (let j = 0; j < refStator.length; j++) {
      assert.ok(Math.abs(got.stator[j] - refStator[j]) <= 1e-12,
        `φ=0 stator flux mismatch at j=${j}: ${got.stator[j]} vs ${refStator[j]}`);
    }
  });
});
