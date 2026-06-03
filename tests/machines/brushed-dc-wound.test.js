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
