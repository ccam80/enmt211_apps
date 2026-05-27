"use strict";

// =============================================================================
//  rotation.test.js — Wave 4.2 G3
//
//  φ-invariance of (I,J) pattern, value variation with φ, periodicity,
//  and the equivalence "applying phase φ to the coupling ≡ physically rotating
//  the rotor boundary by +φ".
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  AH,
  uniformCircle,
  manufactured,
  annulusOracle,
  relErrInf,
  patternKeys,
} = require("./_fixtures.js");

const TWO_PI = 2 * Math.PI;
const MU0 = 4 * Math.PI * 1e-7;

// Standard test harness mirroring admittance.test.js
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

// Manufactured field with mixed harmonics for both cos and sin channels
const MFD_COEFFS = {
  a0: 0.5,
  b0: 0.0,
  ac: [0, 1.2,  0.4, -0.3],
  bc: [0, 0.3,  0.8,  0.2],
  as: [0, 0.7, -0.5,  0.15],
  bs: [0, 0.2,  0.3, -0.1],
};

describe("sparsity pattern is φ-invariant", function () {
  it("patternKeys(stamp(φ)) are equal as sets for φ ∈ {0, 0.31, 1.07, 2.5}", function () {
    const hg = buildTestGap();
    const phis = [0, 0.31, 1.07, 2.5];
    const keySets = phis.map(function (phi) { return patternKeys(hg.stamp(phi)); });

    // All sets must be pairwise equal (same size + same membership)
    const ref = keySets[0];
    for (let i = 1; i < keySets.length; i++) {
      const s = keySets[i];
      assert.strictEqual(s.size, ref.size,
        `pattern size differs at φ=${phis[i]}: ${s.size} vs ${ref.size}`);
      // Subset check both ways
      ref.forEach(function (key) {
        assert.ok(s.has(key),
          `pattern key ${key} present at φ=0 but missing at φ=${phis[i]}`);
      });
      s.forEach(function (key) {
        assert.ok(ref.has(key),
          `pattern key ${key} present at φ=${phis[i]} but missing at φ=0`);
      });
    }
  });
});

describe("values change with φ", function () {
  it("V differs from stamp(0) for φ=1.07; stamp(2π) ≈ stamp(0)", function () {
    const hg = buildTestGap();
    const s0   = hg.stamp(0);
    const sPhi = hg.stamp(1.07);
    const s2pi = hg.stamp(TWO_PI);

    // s0 and sPhi must have identical (I,J) order (since the pattern is
    // φ-invariant AND the stamp is deterministic in its iteration order).
    // At least one V entry differs by > 1e-9.
    assert.strictEqual(sPhi.V.length, s0.V.length);
    let maxDiff = 0;
    for (let t = 0; t < s0.V.length; t++) {
      const d = Math.abs(sPhi.V[t] - s0.V[t]);
      if (d > maxDiff) maxDiff = d;
    }
    assert.ok(maxDiff > 1e-9,
      `stamp(1.07) V should differ from stamp(0) V; max diff=${maxDiff}`);

    // 2π-periodicity: stamp(2π) agrees with stamp(0) within 1e-9.
    assert.strictEqual(s2pi.V.length, s0.V.length);
    for (let t = 0; t < s0.V.length; t++) {
      const d = Math.abs(s2pi.V[t] - s0.V[t]);
      assert.ok(d < 1e-9,
        `stamp(2π) entry ${t} differs from stamp(0) by ${d} >= 1e-9`);
    }
  });
});

describe("phase φ equals physically rotating the rotor boundary", function () {
  it("surfaceFlux(Arotor, Astator, φ).stator == surfaceFlux(Arotor_rot, Astator, 0).stator within 1e-6", function () {
    const hg = buildTestGap();
    const field = manufactured(MFD_COEFFS);

    const rotorTheta  = uniformCircle(NGR, R_MR).gapTheta;
    const statorTheta = uniformCircle(NGS, R_MS).gapTheta;

    const Astator = field.sample(R_MS, statorTheta);
    const Arotor  = field.sample(R_MR, rotorTheta);

    const phi = 0.37;

    // Physical rotation of the rotor source by +φ:
    //   A_rot(θ) = A(θ - φ)
    // Sampling the same manufactured field at (θ - φ) on the rotor circle.
    const rotorThetaShifted = new Float64Array(NGR);
    for (let i = 0; i < NGR; i++) {
      rotorThetaShifted[i] = rotorTheta[i] - phi;
    }
    const Arotor_rot = field.sample(R_MR, rotorThetaShifted);

    const fluxWithPhi   = hg.surfaceFlux(Arotor,     Astator, phi).stator;
    const fluxWithRotat = hg.surfaceFlux(Arotor_rot, Astator, 0).stator;

    const err = relErrInf(fluxWithPhi, fluxWithRotat);
    assert.ok(err < 1e-6,
      `phase-vs-rotation stator-flux relErrInf=${err} >= 1e-6`);
  });
});

describe("field rotates correctly vs a remeshed-at-φ annulus", function () {
  it("surfaceFlux(Arotor, Astator, φ).stator matches the annulus oracle's stator flux with rotated rotor Dirichlet within 2e-2", function () {
    // Use a tighter oracle mesh (nTheta=64, nRad=12) to keep below the
    // 2% cross-method bar (per the 2026-05-27 phase-spec amendment).
    const NTH = 64;
    const NRD = 12;

    const rotor  = uniformCircle(NTH, R_MR);
    const stator = uniformCircle(NTH, R_MS);
    const hg = AH.build(rotor, stator, { K: K_TEST, ell: ELL });

    const field = manufactured(MFD_COEFFS);
    const rotorTheta  = rotor.gapTheta;
    const statorTheta = stator.gapTheta;

    const Arotor  = field.sample(R_MR, rotorTheta);
    const Astator = field.sample(R_MS, statorTheta);

    const phi = 0.42;

    // Harmonic-gap stator flux with phase φ applied:
    const fluxHG = hg.surfaceFlux(Arotor, Astator, phi).stator;

    // Oracle: solve the dense annulus with the rotor Dirichlet rotated by +φ,
    // i.e., the rotor nodal data A(θ - φ).
    const rotorThetaShifted = new Float64Array(NTH);
    for (let i = 0; i < NTH; i++) {
      rotorThetaShifted[i] = rotorTheta[i] - phi;
    }
    const Arotor_rot = field.sample(R_MR, rotorThetaShifted);

    const oracle = annulusOracle({
      rIn: R_MR, rOut: R_MS,
      nTheta: NTH, nRad: NRD,
      ell: ELL, mu0: MU0,
    });
    const { fluxOuter } = oracle.solve(Arotor_rot, Astator);

    const err = relErrInf(fluxHG, fluxOuter);
    assert.ok(err < 2e-2,
      `harmonic-vs-remeshed-annulus stator-flux relErrInf=${err} >= 2e-2`);
  });
});
