"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, crossCheck, runFromRest, avgTorqueAtSpeed, signChanges,
} = require("./_fixtures.js");

const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("wound-field-synchronous");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("wound-field-synchronous");
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

// DEFERRED (user decision 2026-05-25): a true synchronous machine does not self-start
// because its field is CURRENT-regulated (exciter/AVR). The excitation model has only
// voltage/open/short terminal kinds — no current source — so the field can only be a
// DC VOLTAGE source, which at standstill is continuously excited by the rotating
// stator field (slip=1, sustained) and acts as an induction damper -> real line-start
// async torque (verified 1.44 N.m at fine dt; NOT a timestep/measurement artifact).
// The machine therefore line-starts. This assertion is deferred pending a
// current-source ("field regulator") terminal kind in the excitation layer; see
// spec/progress.md "INDUCTION/WFS RESOLUTION". The machine's SYNCHRONOUS behaviour is
// still validated by the static sin(delta) torque-angle test below.
test("does not self-start from rest on AC-none",
  { timeout: TIMEOUT, skip: "excitation model has no current-source (field-regulator) terminal; the voltage-fed field line-starts — deferred per user, see progress.md" },
  function () {
    const { runtime } = build("wound-field-synchronous");
    const state = runFromRest(runtime, 150);
    assert.ok(Math.abs(state.theta) < 1e-3,
      `theta=${state.theta} >= 1e-3 (unexpectedly self-started)`);
  });

test("develops synchronous torque whose sign follows the load angle", { timeout: TIMEOUT }, function () {
  // The synchronous torque-angle characteristic is a STATIC quantity: at a fixed
  // rotor position, T = Tmax*sin(delta), where delta is the load angle between the
  // rotor (DC-field) axis and the stator MMF. It MUST be measured statically (one
  // field solve per load angle), NOT by pinning omega in a dynamic run: with omega
  // pinned and no mechanical load there is nothing to sustain a load angle, so the
  // dynamic average torque relaxes to the no-load equilibrium (-> 0) for EVERY stator
  // phase (verified 2026-05-25: per-cycle torque at sync decays to ~0 over ~25
  // cycles, for all delta). Swept statically the machine gives the clean Tmax*sin
  // curve (amplitude ~6.2 N.m, single period) below. First-principles analysis in
  // spec/progress.md.
  const { stack } = build("wound-field-synchronous"); // circuits: 0=field(DC), 1,2,3=stator 3ph
  const thetaRotor = 0.2;
  const Ifield = 12, Iamp = 24;

  function torqueAtLoadAngle(phi) {
    const cur = new Float64Array([
      Ifield,
      Iamp * Math.cos(phi),
      Iamp * Math.cos(phi - 2 * Math.PI / 3),
      Iamp * Math.cos(phi - 4 * Math.PI / 3),
    ]);
    return stack.solve(thetaRotor, cur).torque;
  }

  const N = 24;
  const Ts = [];
  for (let k = 0; k < N; k++) Ts.push(torqueAtLoadAngle(2 * Math.PI * k / N));

  // Synchronous torque present and substantial, spanning both signs (sign follows
  // load angle: ahead of the equilibrium one way, behind it the other):
  const mx = Math.max(...Ts), mn = Math.min(...Ts);
  assert.ok(mx > 1 && mn < -1,
    `torque-angle must span both signs substantially; max=${mx} min=${mn}`);

  // A single sin(delta) period over 2*pi -> exactly two sign changes (one stable +
  // one unstable equilibrium); rules out a degenerate or multi-lobe curve.
  assert.equal(signChanges(Ts), 2,
    `torque-angle sign changes=${signChanges(Ts)} !== 2 (not a single sin(delta))`);
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("wound-field-synchronous");
  // field circuit index 0, then 3 stator circuits
  const result = crossCheck(stack, 0.2, new Float64Array([12, 24, -12, -12]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
