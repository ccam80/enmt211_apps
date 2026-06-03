"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, crossCheck, LIB,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("vr-stepper");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("vr-stepper");
  assert.equal(expanded.nCircuits, config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        `unexpected feature kind: ${feature.kind}`
      );
    }
  }
});

test("reluctance torque is proportional to i^2 below the iron knee", { timeout: TIMEOUT }, function () {
  // The "i^2 below the knee" law is a LINEAR-regime claim; the saturation
  // ceiling is, by construction, the nonlinearity that breaks it. Evaluate it
  // on the ceiling-disabled (linear) stack — the same linear-operating-point
  // methodology crossCheck uses for Maxwell-vs-co-energy.
  const { expanded } = build("vr-stepper");
  const stackLin = LIB.MotorStack.create(expanded, { saturation: { enabled: false } });
  const theta = 0.3;
  const t1 = stackLin.solve(theta, new Float64Array([8, 0, 0])).torque;
  const t2 = stackLin.solve(theta, new Float64Array([16, 0, 0])).torque;
  assert.ok(Math.abs(t1) > 1e-5, `|t1|=${Math.abs(t1)} not > 1e-5`);
  const ratio = t2 / t1;
  assert.ok(Math.abs(ratio - 4) <= 0.05 * 4,
    `t2/t1=${ratio} not within 4 +/- 0.2 (reluctance torque not proportional to i^2)`);
});

test("lambda_pm is identically zero (no magnet, zero-not-skip)", { timeout: TIMEOUT }, function () {
  const { stack } = build("vr-stepper");
  const co = stack.extractCoeffs(0.3);
  for (let k = 0; k < co.lambdaPm.length; k++) {
    assert.equal(co.lambdaPm[k], 0, `lambdaPm[${k}] !== 0`);
    assert.equal(co.dLambdaPmdth[k], 0, `dLambdaPmdth[${k}] !== 0`);
  }
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("vr-stepper");
  const result = crossCheck(stack, 0.3, new Float64Array([10, 0, 0]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
