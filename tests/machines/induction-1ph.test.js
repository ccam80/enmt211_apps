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
  const result = validate("induction-1ph");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
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

test("capacitor-shifted auxiliary gives starting torque; main winding alone does not", { timeout: 90000 }, function () {
  // A capacitor-start single-phase induction motor develops STARTING torque at
  // standstill ONLY because the cap-shifted auxiliary winding (≈90° in space AND
  // ≈90° in time) makes a rotating field; the main winding alone makes a purely
  // pulsating field whose forward and backward components cancel → zero net
  // standstill torque. This defining behavior EMERGES from the time-domain
  // field+circuit simulation (no forward/backward decomposition is needed — that's
  // an analysis device, not a modelling requirement). Measuring it just needs the
  // usual AC care: enough timesteps per cycle + a settle window (cf. induction-3ph).
  //
  // Generator fix 2026-05-25 (lib/winding-model.js): the even-m (m=2) belt winding
  // now produces a proper order-1 split-phase stator (main/aux in 90° quadrature)
  // that couples to the cage (M ≈ 3.6e-5, was ~7e-13) and forms the rotating field.
  // Measured: standstill Tboth ≈ -5.0e-3, Tmain(aux open) ≈ -9e-8. First-principles
  // root-cause + verification in spec/progress.md.
  function settledStandstillTorque(runtime) {
    const dt  = 1 / 2400;                   // 48 timesteps per 50 Hz electrical cycle
    const spc = Math.round((1 / 50) / dt);
    runtime.reset();
    runtime.state.omega = 0;                // true standstill — the starting condition
    for (let s = 0; s < 6 * spc; s++) {     // settle 6 cycles (exclude transient)
      runtime.step(dt);
      runtime.state.omega = 0;
    }
    let sum = 0, n = 0;
    for (let s = 0; s < 2 * spc; s++) {      // average over 2 steady-state cycles
      runtime.step(dt);
      runtime.state.omega = 0;
      sum += runtime.lastSolve.torque;
      n++;
    }
    return sum / n;
  }

  // Full config (main + capacitor-shifted aux, aux phaseOffset = PI/2):
  const Tboth = settledStandstillTorque(build("induction-1ph").runtime);
  assert.ok(Math.abs(Tboth) > 1e-5, "cap-start standstill torque with aux too small: " + Tboth);

  // Open the auxiliary circuit (index 4) → main winding alone:
  const origConfig = byId["induction-1ph"].config;
  const clonedCircuits = origConfig.circuits.map(function (c, idx) {
    if (idx === 4) {
      return { terminal: { type: "OPEN" }, commutation: c.commutation, R: c.R };
    }
    return c;
  });
  const clonedConfig = {
    grid: origConfig.grid,
    poles: origConfig.poles,
    mechanical: origConfig.mechanical,
    rings: origConfig.rings,
    circuits: clonedCircuits,
    stack: origConfig.stack,
  };
  const expandedMain = window.UnifiedMotor.ConfigSchema.expand(clonedConfig);
  const rtMain = window.LIB.MotorRun.create(expandedMain);
  const Tmain = settledStandstillTorque(rtMain);

  assert.ok(
    Math.abs(Tmain) <= 0.05 * Math.abs(Tboth),
    "main-winding-alone standstill torque not ~zero: Tmain=" + Tmain + ", 5% of Tboth=" + (0.05 * Math.abs(Tboth))
  );
});

test("Maxwell vs co-energy within 5%", { timeout: 25000 }, function () {
  const { stack } = build("induction-1ph");
  // 3 cage circuits zeroed, then main amp:24 and aux amp:24 energized; theta=0.4 rad
  const result = crossCheck(stack, 0.4, new Float64Array([0, 0, 0, 24, 24]));
  assert.ok(result.ok, "crossCheck failed: arkkio=" + result.arkkio + " coe=" + result.coe + " rel=" + result.rel);
});
