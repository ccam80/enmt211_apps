"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  crossCheck,
  mean,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("universal");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
  const { expanded } = build("universal");
  assert.strictEqual(expanded.nCircuits, byId["universal"].config.circuits.length);
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

test("mean torque over an AC cycle is unidirectional (series, proportional to i squared)", { timeout: 25000 }, function () {
  const { stack } = build("universal");
  const N = 48;
  const t = [];
  for (var k = 0; k < N; k++) {
    var psi = (2 * Math.PI * k) / N;
    var cur = 12 * Math.cos(psi);
    // Series connection → identical current in both circuits.
    t.push(stack.solve(0.2, new Float64Array([cur, cur])).torque);
  }
  // The SIGN of torque is a winding-phase wiring convention; the physical
  // invariant is non-zero magnitude + one-sidedness (the torque does not reverse
  // with supply polarity — the defining universal-motor property). FIX 1 gives a
  // strong unidirectional torque here (m ≈ −0.60 N·m).
  const m = mean(t);
  assert.ok(Math.abs(m) > 1e-5, "mean torque magnitude too small (series motor): " + m);
  assert.ok(
    t.every(function (v) { return v * m >= -0.05 * m * m; }),
    "torque reverses sign over the AC cycle (not unidirectional): mean=" + m +
      ", min(v·m)=" + Math.min.apply(null, t.map(function (v) { return v * m; }))
  );
});

test("Maxwell vs co-energy within 5%", { timeout: 25000 }, function () {
  const { stack } = build("universal");
  const result = crossCheck(stack, 0.2, new Float64Array([12, 12]));
  assert.ok(result.ok, "crossCheck failed: arkkio=" + result.arkkio + " coe=" + result.coe + " rel=" + result.rel);
});
