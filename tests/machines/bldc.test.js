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

test("PM term dominates the co-energy decomposition", function () {
  const { stack } = build("bldc");
  const c = stack.coenergyTorque(0.2, new Float64Array([48, -24, -24]));
  assert.ok(
    Math.abs(c.pm) > Math.abs(c.reluctance),
    "PM co-energy torque (" + c.pm + ") does not dominate reluctance (" + c.reluctance + ")"
  );
  assert.ok(
    Math.abs(c.pm) > 1e-6,
    "PM co-energy torque too small: " + c.pm
  );
});

test("PM back-EMF is non-zero under motion", function () {
  const { stack } = build("bldc");
  const co = stack.extractCoeffs(0.2);
  const hasNonZero = co.dLambdaPmdth.some(function (v) { return Math.abs(v) > 1e-6; });
  assert.ok(hasNonZero, "all dLambdaPmdth values are ~zero (no back-EMF)");
});

test("Maxwell vs co-energy within 5%", { timeout: 25000 }, function () {
  const { stack } = build("bldc");
  const result = crossCheck(stack, 0.2, new Float64Array([48, -24, -24]));
  assert.ok(result.ok, "crossCheck failed: arkkio=" + result.arkkio + " coe=" + result.coe + " rel=" + result.rel);
});
