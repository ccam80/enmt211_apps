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

test("self-starts under electronic-trap commutation", function () {
  const { runtime } = build("bldc");
  // Self-start = the rotor leaves rest (|theta| > 1e-3). The predicate trips in
  // the first few steps; stopping there keeps the sim out of the high-ω regime
  // where late-step solves cost seconds, with no loss of coverage.
  const r = runUntil(runtime, (s) => Math.abs(s.theta) > 1e-3, { maxSteps: 60 });
  assert.ok(
    r.hit,
    "rotor did not leave rest within " + r.steps + " steps; |theta| = " + Math.abs(r.state.theta)
  );
});

