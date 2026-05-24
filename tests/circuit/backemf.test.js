"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIB, assertClose } = require("./_fixtures.js");

const MC = LIB.MotorCircuit;

// ---------------------------------------------------------------------------
//  backEmf computes ω·(dL/dθ·i + dλpm/dθ)
// ---------------------------------------------------------------------------
describe("backEmf computes ω·(dL/dθ·i + dλpm/dθ)", () => {
  it("two-circuit hand coeffs match expected formula", () => {
    const a = 2, b = 0.5, c = 3;
    const p = 0.1, q = -0.2;
    const i = new Float64Array([1.5, -0.4]);
    const omega = 30;

    const coeffs = {
      dLdth:          new Float64Array([a, b, b, c]),
      dLambdaPmdth:   new Float64Array([p, q]),
      L:              new Float64Array(4),
      lambdaPm:       new Float64Array(2),
    };

    const e = MC.backEmf(coeffs, i, omega);

    // e[0] = omega * (a*i[0] + b*i[1] + p)
    const expected0 = 30 * (2 * 1.5 + 0.5 * (-0.4) + 0.1);
    // e[1] = omega * (b*i[0] + c*i[1] + q)
    const expected1 = 30 * (0.5 * 1.5 + 3 * (-0.4) + (-0.2));

    assertClose(e[0], expected0, 1e-12, "e[0]");
    assertClose(e[1], expected1, 1e-12, "e[1]");
  });

  it("PM back-EMF appears at zero current under motion", () => {
    const coeffs = {
      dLambdaPmdth:   new Float64Array([0.05]),
      dLdth:          new Float64Array([0]),
      L:              new Float64Array([1e-3]),
      lambdaPm:       new Float64Array([0]),
    };
    const i = new Float64Array([0]);
    const omega = 100;

    const e = MC.backEmf(coeffs, i, omega);

    assertClose(e[0], 100 * 0.05, 1e-12, "PM back-EMF at zero current");
  });

  it("open-circuit terminal voltage equals motional EMF at zero current", () => {
    const coeffs = {
      L:              new Float64Array([1e-3]),
      dLdth:          new Float64Array([0]),
      lambdaPm:       new Float64Array([0]),
      dLambdaPmdth:   new Float64Array([0.05]),
    };
    const R = new Float64Array([1]);
    const V = new Float64Array([0]);
    const i = new Float64Array([0]);
    const omega = 100;
    const dt = 1e-3;
    const terminalStates = ["OPEN"];

    const result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });

    assert.strictEqual(result.i[0], 0, "OPEN circuit current must be exactly 0");
    assertClose(result.vOpen[0], 100 * 0.05, 1e-9, "open-circuit terminal voltage equals motional EMF");
  });
});
