"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { initSolver, woundConfig, feaOpts, CS, LIB } = require("../pipeline/_fixtures.js");

test("default machine boots and steps: lastSolve finite, rotor turns", async () => {
  await initSolver();

  const cfg = woundConfig();
  cfg.mechanical = { J: 0.1, damping: 0.05, loadTorque: 0 };

  const runtime = LIB.MotorRun.create(CS.expand(cfg), feaOpts());

  runtime.state.theta = 0.05;

  for (let i = 0; i < 60; i++) {
    runtime.step(1 / 240, 30);
  }

  assert.notStrictEqual(runtime.lastSolve, null, "lastSolve must not be null after stepping");

  assert.ok(
    Number.isFinite(runtime.lastSolve.torque),
    `lastSolve.torque must be finite, got ${runtime.lastSolve.torque}`
  );

  const fluxLinkages = runtime.lastSolve.fluxLinkages;
  assert.ok(
    Array.isArray(fluxLinkages) || ArrayBuffer.isView(fluxLinkages),
    "lastSolve.fluxLinkages must be array-like"
  );
  for (let i = 0; i < fluxLinkages.length; i++) {
    assert.ok(
      Number.isFinite(fluxLinkages[i]),
      `lastSolve.fluxLinkages[${i}] must be finite, got ${fluxLinkages[i]}`
    );
  }

  assert.ok(
    Number.isFinite(runtime.state.theta),
    `runtime.state.theta must be finite, got ${runtime.state.theta}`
  );

  assert.ok(
    Math.abs(runtime.state.theta - 0.05) > 0,
    `rotor must have advanced from seeded start of 0.05, but theta is ${runtime.state.theta}`
  );
});
