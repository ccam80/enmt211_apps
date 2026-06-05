"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, ripple, dftAmp,
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

test("zero-current detent is a single high-order cogging harmonic with no net torque", { timeout: TIMEOUT }, function () {
  const { stack } = build("pm-stepper");
  const N = 128;
  const thetas = [];
  for (let k = 0; k < N; k++) thetas.push((k / N) * 2 * Math.PI);
  const dts = sweepTorque(stack, new Float64Array([0, 0]), thetas);

  // Detent is the magnet<->stator-slot cogging: a single high spatial order
  // (order 48 = 2·poles for this 24-pole / 12-slot machine) carrying NO net or
  // low-order torque at zero current. A DFT isolates the cogging order from the
  // high-frequency mesh ripple that a raw sign-change count cannot.
  const COG_ORDER = 48;
  assert.ok(ripple(dts) > 1e-6, `ripple=${ripple(dts)} not > 1e-6 (no detent present)`);

  let dom = 1, domAmp = 0;
  for (let o = 1; o <= 64; o++) {
    const a = dftAmp(dts, o);
    if (a > domAmp) { domAmp = a; dom = o; }
  }
  assert.equal(dom, COG_ORDER,
    `detent dominant order = ${dom}, expected cogging order ${COG_ORDER}`);

  // Zero current ⇒ no net/low-order torque: every order below the cogging order
  // is < 0.1% of the cogging amplitude.
  const cog = dftAmp(dts, COG_ORDER);
  for (let o = 1; o <= 12; o++) {
    assert.ok(dftAmp(dts, o) < 1e-3 * cog,
      `low order ${o} amp ${dftAmp(dts, o).toExponential(2)} not << cogging amp ${cog.toExponential(2)}`);
  }
});

test("holding torque pulls the rotor toward alignment when energized", function () {
  const { config } = build("pm-stepper");
  // Clone config and open-circuit phase 1 so only phase 0 is energized.
  const cloned = JSON.parse(JSON.stringify(config));
  cloned.circuits[1].terminal.type = "OPEN";
  const expanded = UnifiedMotor.ConfigSchema.expand(cloned);
  const runtime = LIB.MotorRun.create(expanded);
  runtime.reset();
  // The energized phase swings the rotor toward alignment: ω rises to a peak then
  // decays as the restoring torque decelerates it. That rise-then-fall IS the
  // pull-toward-alignment signature — stop at the first post-peak decrease rather
  // than running a fixed step count.
  let peakOmega = 0, dropped = false;
  for (let k = 0; k < 120 && !dropped; k++) {
    runtime.step(1 / 240);
    const w = Math.abs(runtime.state.omega);
    if (w > peakOmega) peakOmega = w;
    else if (peakOmega > 0 && w < peakOmega) dropped = true;
  }
  assert.ok(dropped, `omega did not rise to a peak and decay (peak=${peakOmega})`);
  assert.ok(isFinite(runtime.state.theta), `theta=${runtime.state.theta} is not finite`);
});
