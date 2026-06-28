"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepTorque, ripple, dftAmp,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("pm-stepper");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to sections with matching circuit count", { timeout: TIMEOUT }, function () {
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

  // Detent is the magnet<->stator-slot cogging at the genuine slot-passing order
  // LCM(Q, 2p) = LCM(48, 24) = 48 for this 48-slot / 24-pole machine: a single
  // high spatial order carrying NO net or low-order torque at zero current. A DFT
  // isolates the cogging order from the high-frequency mesh ripple that a raw
  // sign-change count cannot.
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

test("holding torque dominates the detent when a phase is energized", function () {
  const { stack } = build("pm-stepper");
  // Static θ-sweep with winding 0 energized: the holding (energized restoring) torque
  // must dwarf the zero-current detent — the defining property of a working PM
  // stepper. Field solves only, no time-stepping / no ω-θ pinning. Swept across one
  // pole-pitch centred on θ=0, traversing the φ=0 gap node-coincidence. A winding
  // whose pole-count does not match the rotor links no magnet flux and gives ~0 here.
  const I = 1.5, N = 64, pitch = 2 * Math.PI / 24, thetas = [];
  for (let k = 0; k < N; k++) thetas.push(-pitch / 2 + pitch * k / (N - 1));  // through θ=0
  const Thold = sweepTorque(stack, new Float64Array([I, 0]), thetas);
  const Tdet  = sweepTorque(stack, new Float64Array([0, 0]), thetas);
  const peak = (a) => Math.max.apply(null, a.map(Math.abs));
  const holding = peak(Thold.map((v, i) => v - Tdet[i]));   // pure energization torque
  const detent = peak(Tdet);
  assert.ok(holding > 50 * detent,
    `holding torque ${holding.toExponential(2)} must dominate the detent ${detent.toExponential(2)} ` +
    `(got ${(holding / detent).toFixed(0)}x)`);
});
