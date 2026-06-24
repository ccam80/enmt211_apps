"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  LIB,
  UnifiedMotor,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("induction-1ph");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to sections with matching circuit count", function () {
  const { expanded } = build("induction-1ph");
  assert.strictEqual(expanded.nCircuits, byId["induction-1ph"].config.circuits.length);
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

test("capacitor-shifted auxiliary self-starts; main winding alone does not", function () {
  // A capacitor-start single-phase motor self-starts ONLY because the cap-shifted
  // auxiliary winding (≈90° in space AND time) makes a rotating field; the main
  // winding alone makes a purely pulsating field with no net starting torque, so
  // static friction holds it at rest. Tested as the physical OUTCOME — released
  // from rest, does the rotor build sustained rotation? — not as a clamped-rotor
  // torque: pinning ω/θ each step lets the implicit solve evaluate at a freely
  // drifted operating point. Released from rest, the windings separate cleanly:
  // cap-start breaks free toward sync; main-alone's sub-friction torque keeps it
  // stuck (it jiggles within the stick band but accumulates no rotation). The hold
  // needs the mechanical frictionTorque term — without it the unstable ω=0
  // equilibrium lets any tiny asymmetry run the rotor up.
  const dt = 1 / 240, theta0 = 0;
  const omegaSync = 2 * Math.PI * 50 / (byId["induction-1ph"].config.poles / 2);

  // Cap-start (main + cap-aux): rotating field → starting torque → the rotor leaves
  // rest and accelerates. Stop as soon as it is clearly rotating (mean speed past a
  // third of sync), before it climbs into the costly high-ω regime.
  const { runtime: rtBoth } = build("induction-1ph");
  rtBoth.reset();
  rtBoth.state.theta = theta0;
  let meanBoth = 0, started = false;
  for (let k = 0; k < 60 && !started; k++) {
    rtBoth.step(dt);
    meanBoth = (rtBoth.state.theta - theta0) / rtBoth.state.t;
    if (Math.abs(meanBoth) > 0.3 * omegaSync) started = true;
  }
  assert.ok(started,
    "cap-start did not self-start: mean speed " + meanBoth.toFixed(2) +
    " rad/s « " + (0.3 * omegaSync).toFixed(1));

  // Main winding alone (aux open → the LAST circuit; array is [28 cage bars, main,
  // aux]): pulsating field → no net starting torque → static friction holds it, so
  // the rotor only jiggles about rest and accumulates no net rotation.
  const origConfig = byId["induction-1ph"].config;
  const auxIndex = origConfig.circuits.length - 1;
  const clonedCircuits = origConfig.circuits.map(function (c, idx) {
    return idx === auxIndex
      ? { terminal: { type: "OPEN" }, commutation: c.commutation, R: c.R }
      : c;
  });
  const clonedConfig = {
    grid: origConfig.grid,
    poles: origConfig.poles,
    mechanical: origConfig.mechanical,
    rings: origConfig.rings,
    circuits: clonedCircuits,
    stack: origConfig.stack,
  };
  const rtMain = LIB.MotorRun.create(UnifiedMotor.ConfigSchema.expand(clonedConfig));
  rtMain.reset();
  rtMain.state.theta = theta0;
  for (let k = 0; k < 40; k++) rtMain.step(dt);
  const meanMain = (rtMain.state.theta - theta0) / rtMain.state.t;
  // Stuck → mean speed ~0; a broken/absent friction model lets it creep past this
  // within the window (it ran up to ~1 rad/s by step 40 before frictionTorque).
  assert.ok(Math.abs(meanMain) < 0.5,
    "main-winding-alone must stay stuck (static friction holds it): mean speed " +
    meanMain.toFixed(3) + " rad/s not ~0");
});
