"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  crossCheck,
  avgTorqueAtSpeed,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("induction-3ph");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
  const { expanded } = build("induction-3ph");
  assert.strictEqual(expanded.nCircuits, byId["induction-3ph"].config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        "feature.kind must be conductor, magnet, or iron; got: " + feature.kind
      );
    }
  }
});

test("rotor cage carries induced current under slip", { timeout: 25000 }, function () {
  const { runtime } = build("induction-3ph");
  runtime.reset();
  runtime.state.omega = 0;
  var dt = 1 / 240;
  for (var k = 0; k < 120; k++) {
    runtime.step(dt);
    runtime.state.omega = 0;
  }
  var i = runtime.state.i;
  // cage circuits are indices 0, 1, 2
  var maxCage = Math.max(Math.abs(i[0]), Math.abs(i[1]), Math.abs(i[2]));
  assert.ok(
    maxCage > 1e-4,
    "cage current too small under slip; max |i_cage| = " + maxCage
  );
});

test("torque is ~zero at synchronous speed vs the running slip torque", { timeout: 90000 }, function () {
  const poles = byId["induction-3ph"].config.poles;
  const omega_s = 2 * Math.PI * 50 / (poles / 2);

  // Induction torque vanishes at TRUE synchronous speed (slip=0 → the stator field
  // is stationary in the rotor frame → cage flux is DC → no induced cage current →
  // no torque). The engine reproduces this exactly (verified: with the cage open
  // the sync torque is ~0, and the stator-only cage flux is DC to within 2-5%).
  //
  // BUT the AC transformer/motional cancellation that zeroes it is numerically
  // delicate and requires (a) enough timesteps per electrical cycle to resolve the
  // 50 Hz dynamics and (b) a settle window so the startup transient is excluded.
  // The default dt=1/240 (~5 steps/cycle, averaged from rest) leaves a pure
  // TIMESTEP artifact ~90% of the slip torque; refining to 48 steps/cycle and
  // settling drives T(sync) -> ~0. Measured convergence: T(sync) = 4.9e-3 (5 spc)
  // -> 3.7e-4 (19 spc) -> 3.5e-5 (48 spc). This is a numerical resolution issue,
  // NOT an engine/model limitation (first-principles analysis 2026-05-25).
  function settledTorque(runtime, omega) {
    const dt  = 1 / 2400;                 // 48 timesteps per 50 Hz electrical cycle
    const spc = Math.round((1 / 50) / dt);
    runtime.reset();
    runtime.state.omega = omega;
    for (let s = 0; s < 6 * spc; s++) {   // settle 6 cycles — exclude startup transient
      runtime.step(dt);
      runtime.state.omega = omega;
    }
    let sum = 0, n = 0;
    for (let s = 0; s < 2 * spc; s++) {    // average over 2 steady-state cycles
      runtime.step(dt);
      runtime.state.omega = omega;
      sum += runtime.lastSolve.torque;
      n++;
    }
    return sum / n;
  }

  const Ts    = settledTorque(build("induction-3ph").runtime, omega_s);
  const Tslip = settledTorque(build("induction-3ph").runtime, 0.5 * omega_s);

  assert.ok(Math.abs(Tslip) > 1e-5, "running slip torque too small: " + Tslip);
  assert.ok(
    Math.abs(Ts) <= 0.05 * Math.abs(Tslip),
    "synchronous torque not ~zero: Ts=" + Ts + ", 5% of Tslip=" + (0.05 * Math.abs(Tslip))
  );
});

test("slip torque sign drives the rotor toward synchronism", { timeout: 25000 }, function () {
  const poles = byId["induction-3ph"].config.poles;
  const omega_s = 2 * Math.PI * 50 / (poles / 2);

  const { runtime } = build("induction-3ph");
  const Tslip = avgTorqueAtSpeed(runtime, 0.5 * omega_s, 3, 50);

  assert.ok(
    Math.sign(Tslip) === Math.sign(omega_s),
    "sub-synchronous torque sign wrong: Tslip=" + Tslip + " omega_s=" + omega_s
  );
});

test("Maxwell vs co-energy within 5%", { timeout: 25000 }, function () {
  const { stack } = build("induction-3ph");
  // cage currents zeroed, stator energized at theta=0.4 where torque exceeds 1e-5
  const result = crossCheck(stack, 0.4, new Float64Array([0, 0, 0, 24, -12, -12]));
  assert.ok(result.ok, "crossCheck failed: arkkio=" + result.arkkio + " coe=" + result.coe + " rel=" + result.rel);
});
