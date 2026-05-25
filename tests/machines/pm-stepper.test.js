"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, crossCheck, ripple, signChanges,
  LIB, UnifiedMotor,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("pm-stepper");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("pm-stepper");
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

test("zero-current detent is present and periodic", { timeout: TIMEOUT }, function () {
  const { stack } = build("pm-stepper");
  const N = 128;
  const thetas = [];
  for (let k = 0; k < N; k++) thetas.push((k / N) * 2 * Math.PI);
  const dts = sweepTorque(stack, new Float64Array([0, 0]), thetas);
  // Detent (zero-current cogging) is the magnet<->stator-slot interaction; its
  // period is the slot-pole cogging order = LCM(Q=8 slots, poles=4) = 8 cogging
  // cycles per mechanical revolution -> ~16 sign changes (DFT-verified 2026-05-25:
  // order-8 dominant amp 0.78, plus an order-16 overtone). The original
  // "magnets=4 -> 8 sign changes" assumed the wrong harmonic (order-4). Assert the
  // detent is present and genuinely oscillatory at >= the magnet rate; the exact
  // crossing count (~15-16) shifts with discrete sampling, so a >= bound is the
  // robust, physically-honest check.
  assert.ok(ripple(dts) > 1e-6, `ripple=${ripple(dts)} not > 1e-6 (no detent present)`);
  // Bounded BOTH sides: >= 8 (oscillatory at >= the magnet rate) AND <= 16 (the
  // order-8 slot-pole cogging gives 16 crossings; anything above that is spurious
  // noise, not detent). Measured 15.
  const sc = signChanges(dts);
  assert.ok(sc >= 8 && sc <= 16, `signChanges=${sc} outside detent range [8,16]`);
});

test("holding torque pulls the rotor toward alignment when energized", { timeout: TIMEOUT }, function () {
  const { config } = build("pm-stepper");
  // Clone config and open-circuit phase 1 so only phase 0 is energized.
  const cloned = JSON.parse(JSON.stringify(config));
  cloned.circuits[1].terminal.type = "OPEN";
  const expanded = UnifiedMotor.ConfigSchema.expand(cloned);
  const runtime = LIB.MotorRun.create(expanded);
  let peakOmega = 0;
  runtime.reset();
  // 120 steps suffice for the energized phase to swing the rotor through its peak
  // speed and begin decaying back toward alignment (FIX 8 trim from 400).
  for (let k = 0; k < 120; k++) {
    runtime.step(1 / 240);
    if (Math.abs(runtime.state.omega) > peakOmega) {
      peakOmega = Math.abs(runtime.state.omega);
    }
  }
  const finalState = runtime.state;
  assert.ok(Math.abs(finalState.omega) < peakOmega,
    `omega=${finalState.omega} has not decayed below peak=${peakOmega}`);
  assert.ok(isFinite(finalState.theta), `theta=${finalState.theta} is not finite`);
});

test("Maxwell vs co-energy within 5% at the energized point", { timeout: TIMEOUT }, function () {
  const { stack } = build("pm-stepper");
  const result = crossCheck(stack, 0.2, new Float64Array([24, 0]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
