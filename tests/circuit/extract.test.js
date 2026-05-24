"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose, buildSalient, fitCos2, SALIENT_DEFAULTS } = require("./_fixtures.js");

const MC = LIB.MotorCircuit;

// ---------------------------------------------------------------------------
//  extract recovers L11(θ) matching the analytic salient inductance
// ---------------------------------------------------------------------------
describe("extract recovers L11(θ) matching the analytic salient inductance", () => {
  // Build the salient fixture once — shared across sub-tests in this describe block
  const f = buildSalient({ ...SALIENT_DEFAULTS, current: 1 });
  const thetas = [];
  const nSamples = 16;
  for (let k = 0; k < nSamples; k++) {
    thetas.push((k / nSamples) * Math.PI);
  }

  // Extract L(θ) samples and reference sweepThetaR values
  const Ls = [];
  const L11refs = [];
  const coeffsAt = [];
  for (const theta of thetas) {
    const c = MC.extract(
      f.op,
      LIB.AirgapSolve.pcg,
      { jzBasis: [f.Jz], coilMasks: f.coilMasks, magnetization: null },
      theta
    );
    Ls.push(c.L[0]);
    coeffsAt.push(c);
    L11refs.push(f.sweepThetaR(theta).L11);
  }

  it("r2 > 0.999 for cos2θ fit", () => {
    const { r2 } = fitCos2(thetas, Ls);
    assert.ok(r2 > 0.999, `r2=${r2} should be > 0.999`);
  });

  it("each extracted L[0] matches sweepThetaR L11 within tolerance", () => {
    for (let k = 0; k < nSamples; k++) {
      assertClose(Ls[k], L11refs[k], 1e-6, `L[0] at theta=${thetas[k].toFixed(4)}`);
    }
  });

  // ---------------------------------------------------------------------------
  //  extract dL/dθ matches the analytic −2·L2·sin2θ
  // ---------------------------------------------------------------------------
  it("extract dL/dθ matches analytic −2·L2·sin2θ within 5% relative error", () => {
    const { L2 } = fitCos2(thetas, Ls);
    const checkAngles = [0.3, 0.8, 1.3];

    for (const theta of checkAngles) {
      const c = MC.extract(
        f.op,
        LIB.AirgapSolve.pcg,
        { jzBasis: [f.Jz], coilMasks: f.coilMasks, magnetization: null },
        theta
      );
      const analytic = -2 * L2 * Math.sin(2 * theta);
      const relErr = Math.abs(c.dLdth[0] - analytic) / Math.max(1, Math.abs(analytic));
      assert.ok(
        relErr < 0.05,
        `dL/dθ at theta=${theta}: got ${c.dLdth[0]}, analytic=${analytic}, relErr=${relErr}`
      );
    }
  });

  // ---------------------------------------------------------------------------
  //  λ_pm is zero for a magnet-free config (zero-not-skip)
  // ---------------------------------------------------------------------------
  it("lambdaPm and dLambdaPmdth are exactly zero for magnet-free config at theta=0", () => {
    const c = MC.extract(
      f.op,
      LIB.AirgapSolve.pcg,
      { jzBasis: [f.Jz], coilMasks: f.coilMasks, magnetization: null },
      0
    );
    assert.strictEqual(c.lambdaPm[0], 0, "lambdaPm[0] must be exactly 0 for magnet-free config");
    assert.strictEqual(c.dLambdaPmdth[0], 0, "dLambdaPmdth[0] must be exactly 0 for magnet-free config");
  });
});
