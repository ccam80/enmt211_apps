"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, runFromRest,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("synchronous-reluctance");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("synchronous-reluctance");
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

test("self-starts under electronic-sine commutation", { timeout: TIMEOUT }, function () {
  // Clears 1e-3 within ~3 steps; 20 gives a wide margin while bounding the
  // no-load free-spin and its per-step cache misses (FIX 8 trim).
  const { runtime } = build("synchronous-reluctance");
  const state = runFromRest(runtime, 20);
  assert.ok(Math.abs(state.theta) > 1e-3, `theta=${state.theta} not > 1e-3 (did not start)`);
});
