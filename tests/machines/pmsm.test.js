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
  runFromRest,
  readIndexHtml,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("pmsm");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
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

test("self-starts under electronic-sine commutation", { timeout: 25000 }, function () {
  const { runtime } = build("pmsm");
  // Self-start only needs the rotor to leave rest (|theta| > 1e-3), reached well
  // under 150 coarse steps; a longer free-spin only adds cost, not coverage.
  const state = runFromRest(runtime, 150);
  assert.ok(
    Math.abs(state.theta) > 1e-3,
    "rotor did not move from rest; |theta| = " + Math.abs(state.theta)
  );
});

