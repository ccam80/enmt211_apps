"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose, rl1, mutual2 } = require("./_fixtures.js");

const MC = LIB.MotorCircuit;

// ---------------------------------------------------------------------------
//  API surface
// ---------------------------------------------------------------------------
describe("LIB.MotorCircuit exposes the five primitives", () => {
  it("extract, makeCache, backEmf, stepCurrents, advance are all functions", () => {
    assert.strictEqual(typeof MC.extract,       "function");
    assert.strictEqual(typeof MC.makeCache,     "function");
    assert.strictEqual(typeof MC.backEmf,       "function");
    assert.strictEqual(typeof MC.stepCurrents,  "function");
    assert.strictEqual(typeof MC.advance,       "function");
  });
});

// ---------------------------------------------------------------------------
//  Implicit stability
// ---------------------------------------------------------------------------
describe("implicit step is stable where explicit diverges (dt > 2L/R)", () => {
  it("implicit stays bounded and converges to V/R; explicit diverges", () => {
    const L = 1e-3;
    const R = 1;
    const coeffs = rl1({ L, R });
    const V = new Float64Array([1]);
    const terminalStates = ["DC"];
    const dt = 5e-3; // > 2L/R = 2e-3
    const omega = 0;

    let iImplicit = new Float64Array([0]);
    let ie = 0; // explicit reference
    let explicitDiverged = false;

    for (let step = 0; step < 200; step++) {
      // Implicit advance
      const result = MC.advance(coeffs, {
        R: new Float64Array([R]),
        V,
        i: iImplicit,
        omega,
        dt,
        terminalStates,
      });
      iImplicit = result.i;
      assert.ok(
        Math.abs(iImplicit[0]) < 10,
        `implicit step diverged at step ${step}: i=${iImplicit[0]}`
      );

      // Explicit reference
      ie += dt * (V[0] - R * ie) / L;
      if (Math.abs(ie) > 1e3) explicitDiverged = true;
    }

    assert.ok(explicitDiverged, "explicit Euler should have diverged (|ie| > 1e3)");
    assertClose(iImplicit[0], 1, 1e-6, "implicit steady state should be V/R = 1");
  });
});

// ---------------------------------------------------------------------------
//  SHORT decays current to zero
// ---------------------------------------------------------------------------
describe("SHORT decays current to zero", () => {
  it("shorted circuit dissipates current to near-zero", () => {
    const L = 1e-3;
    const R = 1;
    const coeffs = rl1({ L, R });
    const terminalStates = ["SHORT"];
    const V = new Float64Array([5]);
    const dt = 1e-3;
    const omega = 0;

    let i = new Float64Array([1]);

    for (let step = 0; step < 200; step++) {
      const result = MC.advance(coeffs, {
        R: new Float64Array([R]),
        V,
        i,
        omega,
        dt,
        terminalStates,
      });
      i = result.i;
    }

    assert.ok(
      Math.abs(i[0]) < 1e-6,
      `shorted current should decay to ~0, got ${i[0]}`
    );
  });
});

// ---------------------------------------------------------------------------
//  OPEN pins current to zero and exposes induced voltage
// ---------------------------------------------------------------------------
describe("OPEN pins current to zero and exposes induced voltage", () => {
  it("OPEN circuit has zero current and nonzero induced voltage at first step; both settle", () => {
    const coeffs = mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 });
    const R = new Float64Array([1, 1]);
    const V = new Float64Array([1, 0]);
    const terminalStates = ["DC", "OPEN"];
    const dt = 1e-3;
    const omega = 0;

    let i = new Float64Array([0, 0]);

    // First step
    let result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });
    i = result.i;
    const vOpen1 = result.vOpen;

    assert.strictEqual(i[1], 0, "OPEN circuit current must be exactly 0 on first step");
    assert.ok(
      Math.abs(vOpen1[1]) > 1e-4,
      `induced vOpen[1] should be nonzero on first step (i[0] ramping), got ${vOpen1[1]}`
    );

    // Run 400 steps total (already did 1)
    for (let step = 1; step < 400; step++) {
      result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });
      i = result.i;
    }
    const vOpenFinal = result.vOpen;

    assert.strictEqual(i[1], 0, "OPEN circuit current must remain exactly 0 at steady state");
    assertClose(i[0], 1, 1e-6, "primary current should settle to V/R = 1");
    assertClose(vOpenFinal[1], 0, 1e-6, "induced voltage should be zero at steady state");
  });
});
