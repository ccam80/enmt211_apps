"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, assertClose,
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

test("self-steps under the commutation table", { timeout: 120000 }, function () {
  // Genuine stepping: each commandStep must advance the rotor by one full step
  // in a single consistent direction and settle. This currently FAILS — and is
  // meant to: the 50-tooth rotor has no matching stator teeth to vernier against
  // (a 16-slot distributed winding), so the energized field holds only at a
  // coarse ~3-well/rev scale and commanded steps rock about it with net ≈ 0
  // rather than advancing 1.8°. The fix is a toothed-stator-pole redesign; until
  // then this asserts the real specification rather than masking it with a
  // "did it twitch" check.
  const { runtime } = build("hybrid-stepper");
  runtime.reset();
  for (let s = 0; s < 60; s++) runtime.step(1 / 240);   // settle at rest first
  const start = runtime.state.theta;
  const N = 5, stepAngle = 2 * Math.PI / 200;            // 1.8° per step (200 steps/rev)
  for (let cmd = 0; cmd < N; cmd++) {
    runtime.commandStep(1);
    for (let s = 0; s < 60; s++) runtime.step(1 / 240);
  }
  const net = Math.abs(runtime.state.theta - start);
  assert.ok(net > 0.7 * N * stepAngle && net < 1.3 * N * stepAngle,
    `net advance ${net.toFixed(4)} not within ±30% of ${(N * stepAngle).toFixed(4)} (N×1.8°) — hybrid does not fine-step`);
  assert.ok(Math.abs(runtime.state.omega) < 0.5,
    `rotor not settled after stepping: omega=${runtime.state.omega.toFixed(3)}`);
});
