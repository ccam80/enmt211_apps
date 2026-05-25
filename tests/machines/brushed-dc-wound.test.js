"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  crossCheck,
  runFromRest,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("brushed-dc-wound");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
  const { expanded } = build("brushed-dc-wound");
  assert.strictEqual(expanded.nCircuits, byId["brushed-dc-wound"].config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        "feature.kind must be conductor, magnet, or iron; got: " + feature.kind
      );
    }
  }
});

test("torque is bilinear in armature and field current", function () {
  const { stack } = build("brushed-dc-wound");
  const ia = 10;
  const iif = 8;

  function T(a, f) {
    return stack.solve(0.2, new Float64Array([a, f])).torque;
  }

  const Tbase = T(ia, iif);
  assert.ok(Math.abs(Tbase) > 1e-5, "base torque too small: " + Tbase);

  const ratioArmature = T(2 * ia, iif) / Tbase;
  assert.ok(
    Math.abs(ratioArmature - 2) <= 0.03 * 2,
    "armature current doubling ratio = " + ratioArmature + " deviates more than 3% from 2"
  );

  const ratioField = T(ia, 2 * iif) / Tbase;
  assert.ok(
    Math.abs(ratioField - 2) <= 0.03 * 2,
    "field current doubling ratio = " + ratioField + " deviates more than 3% from 2"
  );
});

test("self-starts under mechanical commutation", { timeout: 25000 }, function () {
  const { runtime } = build("brushed-dc-wound");
  // Self-start only needs the rotor to leave rest (|theta| > 1e-3), reached well
  // under 150 coarse steps; a longer free-spin only adds cost, not coverage.
  const state = runFromRest(runtime, 150);
  assert.ok(
    Math.abs(state.theta) > 1e-3,
    "rotor did not move from rest; |theta| = " + Math.abs(state.theta)
  );
});

test("Maxwell vs co-energy within 5%", { timeout: 25000 }, function () {
  const { stack } = build("brushed-dc-wound");
  const result = crossCheck(stack, 0.2, new Float64Array([10, 8]));
  assert.ok(result.ok, "crossCheck failed: arkkio=" + result.arkkio + " coe=" + result.coe + " rel=" + result.rel);
});
