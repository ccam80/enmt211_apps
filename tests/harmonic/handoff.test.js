"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  AH,
  uniformCircle,
  manufactured,
  relErrInf,
  loadFixture,
  gapLoopsFromConfig,
} = require("./_fixtures.js");

const TWO_PI = 2 * Math.PI;

describe("consumes a real mesher gapLoop (pmsm)", function () {
  it("gapTheta is uniform, rotorGap.gapR < statorGap.gapR, build and round-trip succeed", function () {
    const { config } = loadFixture("pmsm");
    const { rotorGap, statorGap, slots, poles } = gapLoopsFromConfig(config);

    // Check uniformity of gapTheta on rotor circle
    const rTheta = rotorGap.gapTheta;
    const sTheta = statorGap.gapTheta;
    const Ngr = rTheta.length;
    const Ngs = sTheta.length;

    assert.ok(Ngr > 0, "rotorGap.gapTheta is empty");
    assert.ok(Ngs > 0, "statorGap.gapTheta is empty");

    // Successive diffs should be equal within 1e-9 and span [0, 2π)
    if (Ngr > 1) {
      const dthR = rTheta[1] - rTheta[0];
      for (let i = 1; i < Ngr; i++) {
        const d = rTheta[i] - rTheta[i - 1];
        assert.ok(Math.abs(d - dthR) < 1e-9, `rotor gapTheta not uniform at i=${i}: d=${d}, expected=${dthR}`);
      }
      assert.ok(Math.abs(rTheta[0]) < 1e-9, `rotor gapTheta[0]=${rTheta[0]} not ≈ 0`);
      assert.ok(Math.abs(rTheta[Ngr - 1] - (TWO_PI * (Ngr - 1) / Ngr)) < 1e-9,
                `rotor gapTheta last entry not ≈ 2π*(N-1)/N`);
    }

    if (Ngs > 1) {
      const dthS = sTheta[1] - sTheta[0];
      for (let i = 1; i < Ngs; i++) {
        const d = sTheta[i] - sTheta[i - 1];
        assert.ok(Math.abs(d - dthS) < 1e-9, `stator gapTheta not uniform at i=${i}: d=${d}, expected=${dthS}`);
      }
      assert.ok(Math.abs(sTheta[0]) < 1e-9, `stator gapTheta[0]=${sTheta[0]} not ≈ 0`);
    }

    // Rotor gapR < stator gapR
    assert.ok(rotorGap.gapR < statorGap.gapR,
              `rotorGap.gapR=${rotorGap.gapR} not < statorGap.gapR=${statorGap.gapR}`);

    // Choose K conservatively from actual gap-node count
    const K = Math.max(1, Math.floor(Math.min(Ngr, Ngs) / 4));

    // Build should succeed
    let hg;
    assert.doesNotThrow(function () {
      hg = AH.build(rotorGap, statorGap, { K, ell: 0.10 });
    });

    // Round-trip a band-limited field on the rotor circle
    const field = manufactured({
      a0: 1.0, b0: 0,
      ac: [0, 0.5, 0.2],
      bc: [0, 0, 0],
      as: [0, 0.3, -0.1],
      bs: [0, 0, 0],
    });
    const Anodal = field.sample(rotorGap.gapR, rTheta);
    const { a, b } = hg.project(rTheta, Anodal);
    const Arecon  = hg.reconstruct({ a, b }, rTheta);
    const err = relErrInf(Arecon, Anodal);
    assert.ok(err < 1e-8, `round-trip relErrInf=${err} >= 1e-8`);
  });
});

describe("stamp and torque run on the real gapLoop", function () {
  it("stamp(0.3) returns finite I/J/V of equal length; torque returns finite number", function () {
    const { config } = loadFixture("pmsm");
    const { rotorGap, statorGap } = gapLoopsFromConfig(config);
    const Ngr = rotorGap.gapTheta.length;
    const Ngs = statorGap.gapTheta.length;
    const K = Math.max(1, Math.floor(Math.min(Ngr, Ngs) / 4));

    const hg = AH.build(rotorGap, statorGap, { K, ell: 0.10 });

    // stamp(0.3)
    const { n, I, J, V } = hg.stamp(0.3);
    assert.strictEqual(I.length, J.length);
    assert.strictEqual(I.length, V.length);
    assert.ok(I.length > 0, "stamp returned empty triplets");

    // All I, J within [0, n)
    for (let t = 0; t < I.length; t++) {
      assert.ok(I[t] >= 0 && I[t] < n, `I[${t}]=${I[t]} out of [0,${n})`);
      assert.ok(J[t] >= 0 && J[t] < n, `J[${t}]=${J[t]} out of [0,${n})`);
      assert.ok(isFinite(V[t]), `V[${t}]=${V[t]} is not finite`);
    }

    // torque with synthetic nodal values
    const field = manufactured({
      a0: 1.0, b0: 0,
      ac: [0, 0.5, 0.2],
      bc: [0, 0, 0],
      as: [0, 0.3, -0.1],
      bs: [0, 0, 0],
    });
    const Arotor  = field.sample(rotorGap.gapR,  rotorGap.gapTheta);
    const Astator = field.sample(statorGap.gapR, statorGap.gapTheta);
    const T = hg.torque(Arotor, Astator, 0.3);
    assert.ok(isFinite(T), `torque=${T} is not finite`);
  });
});
