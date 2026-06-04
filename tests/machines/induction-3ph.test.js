"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
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

  // At TRUE synchronous speed (slip=0) the fundamental stator field is stationary in
  // the rotor frame, so the ideal cage flux is DC and the torque is zero. THE ENGINE
  // DOES NOT REPRODUCE THIS: at sync it holds a steady spurious cage current (~2.1 A)
  // and a residual torque ~1.5e-2 N·m, comparable to the half-sync slip torque.
  //
  // Measured 2026-06-04 — a REAL engine effect, not numerical:
  //   • independent of timestep — T(sync) plateaus ~1.51e-2 across 24→192 steps/cycle
  //     (the earlier "3.5e-5 at 48 spc / timestep artifact" claim does NOT reproduce);
  //   • independent of settle time — the cage current persists/rises over a 48-cycle
  //     settle ≫ cage L/R, so it is steady, not a decaying transient;
  //   • independent of gap-ring density — doubling gap nodes 432→864 leaves maxCage
  //     and T(sync) unchanged, so it is NOT the moving-band gap-coupling ripple.
  // The driver is structural and mesh-independent — under investigation as physical
  // stator-slot / cage-MMF space-harmonic parasitic current, compounded by an
  // anomalously weak fundamental torque (Tslip ~1.6e-2 N·m is very low for this
  // machine). See spec/correctness-sprint-2026-06-04.md (R2).
  // This is a TRUE failing signal, left failing on purpose — do not loosen it.
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
