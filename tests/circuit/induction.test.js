"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose, mutual2 } = require("./_fixtures.js");

const MC = LIB.MotorCircuit;

// ---------------------------------------------------------------------------
//  Shorted secondary carries induced (Lenz-opposing) current
// ---------------------------------------------------------------------------
describe("shorted secondary carries induced (Lenz-opposing) current", () => {
  it("first step has nonzero Lenz-opposing secondary current; it decays as primary settles", () => {
    const coeffs = mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 });
    const R = new Float64Array([1, 1]);
    const V = new Float64Array([1, 0]);
    const terminalStates = ["DC", "SHORT"];
    const dt = 1e-3;
    const omega = 0;

    let i = new Float64Array([0, 0]);

    // First step
    let result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });
    i = result.i;

    assert.ok(
      Math.abs(i[1]) > 1e-4,
      `secondary current should be induced on first step, got ${i[1]}`
    );
    assert.ok(
      Math.sign(i[1]) !== Math.sign(i[0]),
      `secondary current should oppose primary (Lenz), i[0]=${i[0]}, i[1]=${i[1]}`
    );

    // Run 400 steps total (already did 1); primary settles, di/dt → 0
    for (let step = 1; step < 400; step++) {
      result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });
      i = result.i;
    }

    assertClose(i[1], 0, 1e-4, "induced secondary current should decay to ~0 at steady state");
  });
});
