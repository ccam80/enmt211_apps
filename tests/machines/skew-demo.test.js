"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, crossCheck, assertClose, ripple, mean,
  LIB, UnifiedMotor,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("skew-demo");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("skew-demo");
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

test("skew reduces torque ripple versus an unskewed stack", { timeout: TIMEOUT }, function () {
  const { stack: skewStack, config } = build("skew-demo");
  const poles = 4;
  const period = 2 * Math.PI / (poles / 2);
  const N = 64;
  const thetas = [];
  for (let k = 0; k < N; k++) {
    thetas.push((k / N) * period);
  }
  const cur = new Float64Array([24, -12, -12]);

  // Build unskewed stack: same config with all sliceOffsets = 0
  const cloned = JSON.parse(JSON.stringify(config));
  cloned.stack.sliceOffsets = [0, 0, 0, 0];
  const expandedFlat = UnifiedMotor.ConfigSchema.expand(cloned);
  const unskewStack = LIB.MotorStack.create(expandedFlat);

  const rSkew = ripple(sweepTorque(skewStack, cur, thetas));
  const rFlat = ripple(sweepTorque(unskewStack, cur, thetas));

  assert.ok(rFlat > 1e-6, `unskewed ripple=${rFlat} not > 1e-6`);
  assert.ok(rSkew <= 0.8 * rFlat,
    `skewed ripple=${rSkew} not <= 0.8 * unskewed ripple=${rFlat}`);
});

test("skew preserves mean torque within 5%", { timeout: TIMEOUT }, function () {
  const { stack: skewStack, config } = build("skew-demo");
  const poles = 4;
  const period = 2 * Math.PI / (poles / 2);
  const N = 64;
  const thetas = [];
  for (let k = 0; k < N; k++) {
    thetas.push((k / N) * period);
  }
  const cur = new Float64Array([24, -12, -12]);

  const cloned = JSON.parse(JSON.stringify(config));
  cloned.stack.sliceOffsets = [0, 0, 0, 0];
  const expandedFlat = UnifiedMotor.ConfigSchema.expand(cloned);
  const unskewStack = LIB.MotorStack.create(expandedFlat);

  const skewedTorques = sweepTorque(skewStack, cur, thetas);
  const unskewedTorques = sweepTorque(unskewStack, cur, thetas);

  const meanSkewed = mean(skewedTorques);
  const meanUnskewed = mean(unskewedTorques);

  assertClose(
    meanSkewed,
    meanUnskewed,
    0.05 * Math.abs(meanUnskewed) + 1e-6
  );
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("skew-demo");
  const result = crossCheck(stack, 0.2, new Float64Array([24, -12, -12]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
