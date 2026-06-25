"use strict";

// =============================================================================
//  A settled machine must still honor a drive change.
//
//  Regression guard for the steady-state freeze: with an unbounded adaptive step,
//  the LTE estimate → 0 at steady state and the BDF step grows without bound,
//  racing integ.t past float64 resolution (integ.t + dt == integ.t). The advance
//  loop in MotorRun.step() then stops firing stepSolve and the sim goes inert —
//  silently dropping every drive change (commandStep, Drive toggle). The fix is a
//  finite dtMax backstop plus a commutation breakpoint that restarts the integrator
//  at the event. This test settles a stepper well past the freeze threshold, then
//  commands a step and asserts the rotor actually advances.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const F = require("./_fixtures.js");
const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;

before(async () => { await F.initSolver(); });

test("a settled rotor still honors a step command", () => {
  // 12/8 reluctance stepper on the commutation-table drive, damped enough to settle.
  const c = JSON.parse(JSON.stringify(F.byId["vr-stepper"].config));
  const rotorSide = c.motion.inner === "rotating" ? "inner" : "outer";
  const statorSide = rotorSide === "inner" ? "outer" : "inner";
  const rotorRing = c.rings.find((r) => r.member === rotorSide);
  const statorRing = c.rings.find((r) => r.member === statorSide);
  rotorRing.components.find((k) => k.kind === "iron").teeth = 8;
  statorRing.components.find((k) => /winding$/.test(k.kind)).winding.standard = { m: 3, p: 8, Q: 12, coilPitch: 1, turns: 120 };
  const pat = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  c.circuits.forEach((ci, k) => { ci.terminal = { type: "STEP", amp: 24 }; ci.commutation = { mode: "sequencer", pattern: pat[k] }; });
  c.mechanical.damping = 1.3e-3; c.mechanical.frictionTorque = 3e-4;

  const rt = LIB.MotorRun.create(CS.expand(c));
  rt.reset();

  // Settle, and keep running long past the point where an unbounded step would have
  // frozen the loop. At steady state each accepted solve advances ~dtMax (1e-2 s),
  // so 1.5 s of settled sim is ~150 solves — well past the ~100 at which an uncapped
  // step would have doubled dt to the float64 wall (integ.t + dt == integ.t).
  rt.step(1.5);
  assert.ok(Math.abs(rt.state.omega) < 0.5, `rotor did not settle: ω=${rt.state.omega}`);
  const settledTheta = rt.state.theta;

  // Command one step. A frozen sim leaves the rotor exactly where it was.
  rt.commandStep(1);
  rt.step(0.8);
  const moved = rt.state.theta - settledTheta;
  const stepAngle = 2 * Math.PI / 24;   // 12/8, 3-phase, one-phase-on → 15°
  assert.ok(Math.abs(moved) > 0.3 * stepAngle,
    `settled rotor ignored the step command: Δθ=${moved.toExponential(2)} (a frozen sim leaves it at 0)`);
  assert.ok(Math.abs(moved) < 2 * stepAngle,
    `commanded one step but moved ${(moved / stepAngle).toFixed(1)} steps (Δθ=${moved.toFixed(3)})`);
});
