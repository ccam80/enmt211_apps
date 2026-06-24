"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, mean, ripple,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("pole-mismatch-demo");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("pole-mismatch-demo");
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

test("net torque over a mechanical revolution is ~zero", { timeout: TIMEOUT }, function () {
  const { stack } = build("pole-mismatch-demo");
  const N = 96;
  const thetas = [];
  for (let k = 0; k < N; k++) {
    thetas.push((k / N) * 2 * Math.PI);
  }
  const cur = new Float64Array([24, -12, -12]);
  const ts = sweepTorque(stack, cur, thetas);
  const r = ripple(ts);
  const m = mean(ts);
  assert.ok(
    Math.abs(m) <= 0.05 * (r / 2),
    `|mean|=${Math.abs(m)} > 0.05 * ripple/2=${0.05 * r / 2} (unexpected net torque)`
  );
});

test("instantaneous torque ripple is non-zero", { timeout: TIMEOUT }, function () {
  const { stack } = build("pole-mismatch-demo");
  const N = 96;
  const thetas = [];
  for (let k = 0; k < N; k++) {
    thetas.push((k / N) * 2 * Math.PI);
  }
  const cur = new Float64Array([24, -12, -12]);
  const ts = sweepTorque(stack, cur, thetas);
  assert.ok(ripple(ts) > 1e-6, `ripple=${ripple(ts)} not > 1e-6 (fields do not interact)`);
});
