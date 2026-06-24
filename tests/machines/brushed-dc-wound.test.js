"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  runUntil,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("brushed-dc-wound");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to sections with matching circuit count", function () {
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

test("self-starts under mechanical commutation", function () {
  const { runtime } = build("brushed-dc-wound");
  // Self-start = the rotor leaves rest (|theta| > 1e-3); the predicate trips in
  // the first few steps, before the no-load rotor climbs to the costly high-ω
  // regime. Stopping there adds no coverage.
  const r = runUntil(runtime, (s) => Math.abs(s.theta) > 1e-3, { maxSteps: 60 });
  assert.ok(
    r.hit,
    "rotor did not leave rest within " + r.steps + " steps; |theta| = " + Math.abs(r.state.theta)
  );
});
