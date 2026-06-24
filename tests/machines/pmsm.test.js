"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  UnifiedMotor,
  byId,
  MACHINE_IDS,
  build,
  validate,
  runUntil,
  readIndexHtml,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("pmsm");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to sections with matching circuit count", function () {
  const { expanded } = build("pmsm");
  assert.strictEqual(expanded.nCircuits, byId["pmsm"].config.circuits.length);
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

test("registry is complete and index.html lists every fixture", function () {
  assert.strictEqual(MACHINE_IDS.length, 15);
  for (const id of MACHINE_IDS) {
    assert.ok(
      UnifiedMotor.MACHINES.some(function (m) { return m.id === id; }),
      "MACHINES missing id: " + id
    );
  }
  const html = readIndexHtml();
  for (const id of MACHINE_IDS) {
    assert.ok(
      html.includes("./machines/" + id + ".js"),
      "index.html missing script tag for: " + id
    );
  }
});

test("self-starts under electronic-sine commutation", function () {
  const { runtime } = build("pmsm");
  // Self-start = the rotor leaves rest (|theta| > 1e-3); the predicate trips in
  // the first few steps, before the no-load rotor climbs to the costly high-ω
  // regime. Stopping there adds no coverage.
  const r = runUntil(runtime, (s) => Math.abs(s.theta) > 1e-3, { maxSteps: 60 });
  assert.ok(
    r.hit,
    "rotor did not leave rest within " + r.steps + " steps; |theta| = " + Math.abs(r.state.theta)
  );
});

