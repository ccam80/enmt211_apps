"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  AH,
  uniformCircle,
  manufactured,
  relErrInf,
} = require("./_fixtures.js");

const TWO_PI = 2 * Math.PI;

describe("defaultK is 3·max(slots,poles)", function () {
  it("defaultK(12, 4) === 36", function () {
    assert.strictEqual(AH.defaultK(12, 4), 36);
  });
  it("defaultK(4, 12) === 36", function () {
    assert.strictEqual(AH.defaultK(4, 12), 36);
  });
  it("defaultK(8, 8) === 24", function () {
    assert.strictEqual(AH.defaultK(8, 8), 24);
  });
});

describe("build requires N_gap >= 4K on each body", function () {
  const r_mr = 0.042;
  const r_ms = 0.044;
  const K = 10;

  it("succeeds when both circles have N=40 >= 4*10", function () {
    const rotor  = uniformCircle(40, r_mr);
    const stator = uniformCircle(40, r_ms);
    assert.doesNotThrow(function () {
      AH.build(rotor, stator, { K, ell: 0.10 });
    });
  });

  it("throws when rotor N=32 < 40 (4K), message contains N_gap and 4K or 40", function () {
    const rotor  = uniformCircle(32, r_mr);
    const stator = uniformCircle(40, r_ms);
    assert.throws(
      function () { AH.build(rotor, stator, { K, ell: 0.10 }); },
      function (err) {
        return err instanceof Error &&
               err.message.includes("N_gap") &&
               (err.message.includes("4K") || err.message.includes("40"));
      }
    );
  });

  it("throws when stator N=32 < 40, message contains N_gap and 4K or 40", function () {
    const rotor  = uniformCircle(40, r_mr);
    const stator = uniformCircle(32, r_ms);
    assert.throws(
      function () { AH.build(rotor, stator, { K, ell: 0.10 }); },
      function (err) {
        return err instanceof Error &&
               err.message.includes("N_gap") &&
               (err.message.includes("4K") || err.message.includes("40"));
      }
    );
  });
});

describe("build reports DOF layout", function () {
  it("nHarmonicDofs, dofMap for K=10", function () {
    const K = 10;
    const Ngr = 40;
    const Ngs = 40;
    const rotor  = uniformCircle(Ngr, 0.042);
    const stator = uniformCircle(Ngs, 0.044);
    const hg = AH.build(rotor, stator, { K, ell: 0.10 });

    assert.strictEqual(hg.nHarmonicDofs, 2 * (2 * K + 1));
    assert.strictEqual(hg.nHarmonicDofs, 42);
    assert.strictEqual(hg.dofMap.harmonics.perBody, 21);
    assert.strictEqual(hg.dofMap.gapRotor.base, 0);
    assert.strictEqual(hg.dofMap.gapStator.base, Ngr);
    assert.strictEqual(hg.dofMap.harmonics.base, Ngr + Ngs);
  });
});

describe("build accepts different rotor/stator N_gap", function () {
  it("rotor N=48, stator N=64, K=10 builds; nGapRotor=48, nGapStator=64", function () {
    const rotor  = uniformCircle(48, 0.042);
    const stator = uniformCircle(64, 0.044);
    const hg = AH.build(rotor, stator, { K: 10, ell: 0.10 });
    assert.strictEqual(hg.nGapRotor,  48);
    assert.strictEqual(hg.nGapStator, 64);
  });
});

describe("build rejects r_mr >= r_ms", function () {
  it("throws when rotor gapR=0.045 >= stator gapR=0.044", function () {
    const rotor  = uniformCircle(40, 0.045);
    const stator = uniformCircle(40, 0.044);
    assert.throws(
      function () { AH.build(rotor, stator, { K: 10, ell: 0.10 }); },
      Error
    );
  });
});

describe("project/reconstruct round-trips a band-limited field to < 1e-8", function () {
  it("band-limited field round-trips within relErrInf < 1e-8", function () {
    const K = 8;
    const N = 64;  // >= 4K = 32
    const r = 0.042;

    // Manufactured field with content only at k <= K
    const coeffs = {
      a0: 1.5, b0: 0,
      ac: [0, 0.8, 0, -0.4, 0, 0.2, 0, 0, 0.1],
      bc: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      as: [0, 0.6, 0, -0.3, 0, 0.15, 0, 0, 0.05],
      bs: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const field = manufactured(coeffs);
    const circle = uniformCircle(N, r);
    const Anodal = field.sample(r, circle.gapTheta);

    // We need a HarmonicGap object to call project/reconstruct
    // Build with a rotor circle and stator circle (slightly larger r)
    const rotorC  = uniformCircle(N, r);
    const statorC = uniformCircle(N, r + 0.002);
    const hg = AH.build(rotorC, statorC, { K, ell: 0.10 });

    const coeffsOut = hg.project(circle.gapTheta, Anodal);
    const Arecon    = hg.reconstruct(coeffsOut, circle.gapTheta);

    const err = relErrInf(Arecon, Anodal);
    assert.ok(err < 1e-8, `round-trip relErrInf = ${err} >= 1e-8`);
  });
});

describe("project recovers known cos/sin amplitudes", function () {
  it("A(θ)=3 + 2cos(2θ) - 5sin(3θ): a[0]≈3, a[2]≈2, b[3]≈-5, others ≈ 0", function () {
    const K = 5;
    const N = 64;
    const gapTheta = uniformCircle(N, 0.042).gapTheta;
    const Anodal = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const th = gapTheta[i];
      Anodal[i] = 3 + 2 * Math.cos(2 * th) - 5 * Math.sin(3 * th);
    }

    const rotor  = uniformCircle(N, 0.042);
    const stator = uniformCircle(N, 0.044);
    const hg = AH.build(rotor, stator, { K, ell: 0.10 });
    const { a, b } = hg.project(gapTheta, Anodal);

    assert.ok(Math.abs(a[0] - 3) < 1e-9, `a[0]=${a[0]} not ≈ 3`);
    assert.ok(Math.abs(a[2] - 2) < 1e-9, `a[2]=${a[2]} not ≈ 2`);
    assert.ok(Math.abs(b[3] - (-5)) < 1e-9, `b[3]=${b[3]} not ≈ -5`);

    // All other non-specified harmonics should be ≈ 0
    for (let k = 0; k <= K; k++) {
      if (k !== 0) {
        if (k !== 2) assert.ok(Math.abs(a[k]) < 1e-9, `a[${k}]=${a[k]} not ≈ 0`);
        if (k !== 3) assert.ok(Math.abs(b[k]) < 1e-9, `b[${k}]=${b[k]} not ≈ 0`);
      }
    }
    // b[0] === 0 always
    assert.strictEqual(b[0], 0);
  });
});
