"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, crossCheck, assertClose,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("hybrid-stepper");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("hybrid-stepper");
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

test("the stack has two slices with a half-tooth offset", { timeout: TIMEOUT }, function () {
  const { expanded, stack } = build("hybrid-stepper");
  assert.equal(expanded.slices.length, 2);
  // Half a rotor-tooth pitch: tooth pitch = 2π/50, so the offset is π/50.
  assertClose(expanded.slices[1].offset, Math.PI / 50, 1e-12);
  assert.equal(stack.nSlices, 2);
});

test("the shared axial PM flips sign between slices", { timeout: TIMEOUT }, function () {
  const { expanded } = build("hybrid-stepper");
  // Ring 0 is the M ring (axial PM bias source). Find magnet features in each slice
  // that originate from ring 0. The fluxSources[0] has ringRef:0 and sliceSigns:[+1,-1]
  // so slice 0 has +Mr and slice 1 has -Mr.
  function getMagnetMr(slice) {
    for (const f of slice.section.features) {
      if (f.kind === "magnet") {
        return f.Mr;
      }
    }
    return null;
  }
  const mr0 = getMagnetMr(expanded.slices[0]);
  const mr1 = getMagnetMr(expanded.slices[1]);
  assert.ok(mr0 !== null, "slice 0 has no magnet feature");
  assert.ok(mr1 !== null, "slice 1 has no magnet feature");
  assertClose(mr1, -mr0, 1e-12);
});

test("self-steps under the sequencer", { timeout: TIMEOUT }, function () {
  const { runtime } = build("hybrid-stepper");
  runtime.reset();
  const theta0 = runtime.state.theta;
  runtime.commandStep(1);
  // The commanded step swings the rotor far past 1e-4 within a few dozen steps;
  // 40 keeps a wide margin while bounding the per-step cache misses (FIX 8 trim).
  for (let k = 0; k < 40; k++) {
    runtime.step(1 / 240);
  }
  assert.ok(
    Math.abs(runtime.state.theta - theta0) > 1e-4,
    `theta did not move: theta=${runtime.state.theta}, theta0=${theta0}`
  );
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("hybrid-stepper");
  const result = crossCheck(stack, 0.1, new Float64Array([24, 0]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
