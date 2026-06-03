"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
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

test("capacitor-shifted auxiliary gives starting torque; main winding alone does not", { timeout: 360000 }, function () {
  // A capacitor-start single-phase induction motor develops STARTING torque at
  // standstill ONLY because the cap-shifted auxiliary winding (≈90° in space AND
  // ≈90° in time) makes a rotating field; the main winding alone makes a purely
  // pulsating field whose forward and backward components produce NO NET starting
  // torque. This emerges from the time-domain field+circuit simulation.
  //
  // "No net starting torque" is a quantity AVERAGED OVER ROTOR POSITION. At any
  // FIXED rotor angle the main-alone winding still exerts a sizeable POSITION-
  // DEPENDENT torque: with the geometry-derived cage (28 bars) the discrete bars
  // break the forward/backward cancellation at that instant, so the standstill
  // torque oscillates at the BAR PITCH (360/28 = 12.86°). This is a DETENT that
  // would merely settle the rotor to an equilibrium, NOT a torque that accelerates
  // it from rest — its average over one bar pitch is ~zero.
  //   Measured (θ-swept, 2026-06-02, lib/motor-run Δθ-substep runtime):
  //     main-alone T(θ) ∈ [-0.45, +0.30] N·m, period = bar pitch, θ-avg ≈ -0.03;
  //     cap-start Tboth ≈ -6.1 N·m.  The winding itself is symmetric (no sub-
  //     harmonic / homopolar — verified); the oscillation is the cage/slot detent.
  //   The net starting torque is therefore measured as the standstill torque
  //   AVERAGED OVER ONE BAR PITCH. (A single-angle measurement formerly passed
  //   only because the runtime advanced θ even while ω was pinned to 0, smearing
  //   the measurement over position incidentally; the Δθ-substep runtime correctly
  //   holds true standstill, so the average must now be taken EXPLICITLY. See
  //   spec/adaptive-stepper-design.md.)
  const BARS = byId["induction-1ph"].config.rings[0].cage.bars;  // 28

  function standstillTorque(runtime, theta0) {
    const dt  = 1 / 2400;                   // 48 timesteps per 50 Hz electrical cycle
    const spc = Math.round((1 / 50) / dt);
    runtime.reset();
    runtime.state.theta = theta0;           // fixed rotor position
    runtime.state.omega = 0;                // true standstill — the starting condition
    for (let s = 0; s < spc; s++) {          // settle (cage AC response converges within ~1 cyc at slip=1)
      runtime.step(dt);
      runtime.state.omega = 0;
      runtime.state.theta = theta0;
    }
    let sum = 0, n = 0;
    for (let s = 0; s < spc; s++) {           // average over 1 electrical cycle (2 torque-pulsation periods)
      runtime.step(dt);
      runtime.state.omega = 0;
      runtime.state.theta = theta0;
      sum += runtime.lastSolve.torque;
      n++;
    }
    return sum / n;
  }

  // NET starting torque = standstill torque averaged over one rotor bar pitch,
  // which averages out the position-dependent detent (the physical "does it
  // self-start from an arbitrary rest position?").
  function netStartingTorque(runtime) {
    const nPos = 6, barPitch = (2 * Math.PI) / BARS;
    let sum = 0;
    for (let k = 0; k < nPos; k++) sum += standstillTorque(runtime, (k / nPos) * barPitch);
    return sum / nPos;
  }

  // Full config (main + capacitor-shifted aux, aux phaseOffset = PI/2): a real
  // net starting torque from the rotating field (position-independent in the mean).
  const Tboth = netStartingTorque(build("induction-1ph").runtime);
  assert.ok(Math.abs(Tboth) > 1e-2, "cap-start net starting torque with aux too small: " + Tboth);

  // Open the auxiliary circuit → main winding alone. The circuits array is
  // [28 cage bars (0..27), main (28), aux (29)], so the auxiliary is the LAST
  // circuit. (Previously hard-coded index 4 — a cage bar — which left the aux
  // energized; the now-physical cage made that mis-index visible.)
  const origConfig = byId["induction-1ph"].config;
  const auxIndex = origConfig.circuits.length - 1;
  const clonedCircuits = origConfig.circuits.map(function (c, idx) {
    if (idx === auxIndex) {
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
  const Tmain = netStartingTorque(rtMain);

  assert.ok(
    Math.abs(Tmain) <= 0.05 * Math.abs(Tboth),
    "main-winding-alone NET starting torque (θ-averaged over one bar pitch) not ~zero: " +
    "Tmain=" + Tmain + ", 5% of Tboth=" + (0.05 * Math.abs(Tboth))
  );
});
