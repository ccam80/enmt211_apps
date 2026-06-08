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

test("the axial PM drives opposite polarity in the two cups", { timeout: TIMEOUT }, function () {
  const { expanded } = build("hybrid-stepper");
  // The PM is axial: a flux loop (stack.axial) threads the two cups with opposite
  // sign, so cup 0 carries +Ψ (all-N teeth) and cup 1 −Ψ (all-S), closing through the
  // magnet MMF. (This replaces the in-plane sliceSigns magnet, which a 2-D slice
  // cannot host as a uniform per-cup bias.)
  assert.ok(expanded.axial && Array.isArray(expanded.axial.loops) && expanded.axial.loops.length === 1,
    "expected one axial flux loop");
  const loop = expanded.axial.loops[0];
  const signs = {};
  for (const e of loop.slices) signs[e.s] = e.sign;
  assert.equal(signs[0], 1, "cup 0 should carry +flux");
  assert.equal(signs[1], -1, "cup 1 should carry −flux (opposite polarity)");
  assert.ok(loop.Fpm > 0, `axial PM MMF should be positive; got ${loop.Fpm}`);
});

test("self-steps under the commutation table", { timeout: 300000 }, function () {
  // Genuine fine-stepping: each commandStep advances the rotor one full step
  // (a quarter rotor-tooth) in a consistent direction and settles. The axial-flux
  // PM bias (stack.axial), modulated by the 50 rotor teeth, couples to the grouped
  // stator pole teeth so the four full-step states sit a quarter tooth apart → 200
  // steps/rev. The half-tooth cup offset gives alternating sub-steps that average
  // to the step. (Heavy: 50 teeth → ~600 gap nodes × 2 slices × the flux loop.)
  const { runtime } = build("hybrid-stepper");
  runtime.reset();
  runtime.step(1.0);                                     // settle at rest first (1 s sim)
  const start = runtime.state.theta;
  const N = 5, stepAngle = 2 * Math.PI / 200;            // 1.8° per step (200 steps/rev)
  for (let cmd = 0; cmd < N; cmd++) {
    runtime.commandStep(1);
    runtime.step(0.6);                                   // 0.6 s sim — one quarter-tooth step settles in ~0.12 s
  }
  const net = Math.abs(runtime.state.theta - start);
  assert.ok(net > 0.7 * N * stepAngle && net < 1.3 * N * stepAngle,
    `net advance ${net.toFixed(4)} not within ±30% of ${(N * stepAngle).toFixed(4)} (N×1.8°) — hybrid does not fine-step`);
  assert.ok(Math.abs(runtime.state.omega) < 0.5,
    `rotor not settled after stepping: omega=${runtime.state.omega.toFixed(3)}`);
});
