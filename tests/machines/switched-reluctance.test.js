"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, runFromRest, LIB,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("switched-reluctance");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("switched-reluctance");
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
  // Linear-regime law — evaluate on the ceiling-disabled (linear) stack, the
  // same linear-operating-point methodology crossCheck uses.
  const { expanded } = build("switched-reluctance");
  const stackLin = LIB.MotorStack.create(expanded, { saturation: { enabled: false } });
  const theta = 0.3;
  const t1 = stackLin.solve(theta, new Float64Array([8, 0, 0])).torque;
  const t2 = stackLin.solve(theta, new Float64Array([16, 0, 0])).torque;
  assert.ok(Math.abs(t1) > 1e-5, `|t1|=${Math.abs(t1)} not > 1e-5`);
  const ratio = t2 / t1;
  assert.ok(Math.abs(ratio - 4) <= 0.05 * 4,
    `t2/t1=${ratio} not within 4 +/- 0.2 (reluctance torque not proportional to i^2)`);
});

test("self-starts under electronic-trap commutation", { timeout: TIMEOUT }, function () {
  // The rotor clears 1e-3 within ~3 steps; 20 gives a ~500x margin while keeping
  // the no-load free-spin (and its per-step cache misses) bounded (FIX 8 trim).
  const { runtime } = build("switched-reluctance");
  const state = runFromRest(runtime, 20);
  assert.ok(Math.abs(state.theta) > 1e-3, `theta=${state.theta} not > 1e-3 (did not start)`);
});
