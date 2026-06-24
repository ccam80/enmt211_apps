"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  settledRuntime,
  avgTorqueWindow,
  avgTorqueAtSpeed,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("induction-3ph");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to sections with matching circuit count", function () {
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

test("rotor cage carries induced current under slip", function () {
  const { runtime } = build("induction-3ph");
  runtime.reset();
  runtime.state.omega = 0;                 // slip = 1: the stator AC induces cage
  var dt = 1 / 240;                        // current within the first electrical cycle
  for (var k = 0; k < 24; k++) {           // a few cycles is ample to read the response
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

test("torque is ~zero at synchronous speed vs the running slip torque", function () {
  const poles = byId["induction-3ph"].config.poles;
  const omega_s = 2 * Math.PI * 50 / (poles / 2);
  const dt = 1 / 2400, freq = 50;   // 48 timesteps per 50 Hz electrical cycle

  // At true synchronous speed (slip 0) the stator fundamental is stationary in the
  // rotor frame, so the cage flux is DC and the mean torque is zero; under slip the
  // cage carries induced current and develops torque. Both are STEADY properties:
  // seed the captured settled orbit (_snapshots/induction-3ph-{sync,slip}.json) and
  // average one steady window, rather than spinning up inside the test. Seeding a
  // cold cage instead of the settled orbit is NOT valid here — the stator-field
  // turn-on transient gives a large spurious torque (~4 N·m) that takes cycles to
  // decay. Regenerate the snapshots with SPINUP=1 after a model/integrator change.
  function settledTorque(key, omega) {
    const { runtime } = build("induction-3ph");
    settledRuntime(runtime, key, { omega, dt, settleCycles: 6, freq });
    return avgTorqueWindow(runtime, { omega, dt, cycles: 2, freq });
  }

  const Ts    = settledTorque("induction-3ph-sync", omega_s);
  const Tslip = settledTorque("induction-3ph-slip", 0.5 * omega_s);

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
