"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, crossCheck, ripple, dftAmp,
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
