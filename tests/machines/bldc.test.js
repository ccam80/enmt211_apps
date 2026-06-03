"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  runFromRest,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("bldc");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
  const { expanded } = build("bldc");
  assert.strictEqual(expanded.nCircuits, byId["bldc"].config.circuits.length);
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

test("self-starts under electronic-trap commutation", { timeout: 25000 }, function () {
  const { runtime } = build("bldc");
  // Self-start only needs the rotor to leave rest (|theta| > 1e-3), reached well
  // under 150 coarse steps; a longer free-spin only lets the no-load rotor climb
  // to a high ω where late-step solves are expensive without adding coverage.
  const state = runFromRest(runtime, 150);
  assert.ok(
    Math.abs(state.theta) > 1e-3,
    "rotor did not move from rest; |theta| = " + Math.abs(state.theta)
  );
});

