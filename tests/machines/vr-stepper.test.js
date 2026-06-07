"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, LIB,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("vr-stepper");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("vr-stepper");
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

test("reluctance torque is proportional to i^2 below the iron knee", { timeout: TIMEOUT }, function () {
  // The "i^2 below the knee" law is a LINEAR-regime claim; the saturation
  // ceiling is, by construction, the nonlinearity that breaks it. Evaluate it
  // on the ceiling-disabled (linear) stack — the same linear-operating-point
  // methodology crossCheck uses for Maxwell-vs-co-energy.
  const { expanded } = build("vr-stepper");
  const stackLin = LIB.MotorStack.create(expanded, { saturation: { enabled: false } });
  const theta = 0.3;
  const t1 = stackLin.solve(theta, new Float64Array([8, 0, 0])).torque;
  const t2 = stackLin.solve(theta, new Float64Array([16, 0, 0])).torque;
  assert.ok(Math.abs(t1) > 1e-5, `|t1|=${Math.abs(t1)} not > 1e-5`);
  const ratio = t2 / t1;
  assert.ok(Math.abs(ratio - 4) <= 0.05 * 4,
    `t2/t1=${ratio} not within 4 +/- 0.2 (reluctance torque not proportional to i^2)`);
});

test("self-steps under the commutation table", { timeout: 120000 }, function () {
  // Genuine stepping: each commandStep advances the rotor by one full step in a
  // single consistent direction and settles — NOT a twitch that rocks back. A
  // weak "did it move at all" check passes on rocking; this asserts net advance.
  const { runtime } = build("vr-stepper");
  runtime.reset();
  for (let s = 0; s < 60; s++) runtime.step(1 / 240);   // settle at rest first
  const start = runtime.state.theta;
  const N = 5, stepAngle = 2 * Math.PI / 24;             // 15° per step (24 steps/rev)
  for (let cmd = 0; cmd < N; cmd++) {
    runtime.commandStep(1);
    for (let s = 0; s < 60; s++) runtime.step(1 / 240);
  }
  const net = Math.abs(runtime.state.theta - start);
  assert.ok(net > 0.7 * N * stepAngle && net < 1.3 * N * stepAngle,
    `net advance ${net.toFixed(4)} not within ±30% of ${(N * stepAngle).toFixed(4)} (N×15°)`);
  assert.ok(Math.abs(runtime.state.omega) < 0.5,
    `rotor not settled after stepping: omega=${runtime.state.omega.toFixed(3)}`);
});

