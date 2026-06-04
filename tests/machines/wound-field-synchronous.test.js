"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, runFromRest, avgTorqueAtSpeed, signChanges,
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

test("does not self-start from rest on AC-none",
  { timeout: TIMEOUT },
  function () {
    // A line-fed synchronous machine (no damper cage) started from rest develops
    // a torque that alternates at slip frequency and averages to zero, so the
    // rotor oscillates about standstill rather than accelerating to synchronism.
    // The physical signature of "no self-start" is no SUSTAINED rotation: the mean
    // speed over the window stays far below synchronous. It is NOT "theta ≈ 0" —
    // the startup flux transient gives a finite one-off kick of a few tenths of a
    // radian even when the machine never pulls in. Pull-in, by contrast, drives
    // the mean speed all the way to the synchronous value.
    const { runtime } = build("wound-field-synchronous");
    const state = runFromRest(runtime, 150);
    const meanOmega = state.theta / state.t;     // net rotation / elapsed time
    const omegaSync = 2 * Math.PI * 50 / 4;      // 8 poles → 4 pole-pairs at 50 Hz
    assert.ok(Math.abs(meanOmega) < 0.1 * omegaSync,
      `mean speed ${meanOmega.toFixed(3)} rad/s must stay « synchronous ` +
      `${omegaSync.toFixed(2)} rad/s (no self-start / pull-in)`);
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
