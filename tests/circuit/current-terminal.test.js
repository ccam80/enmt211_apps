"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
require(path.join(__dirname, "..", "..", "lib", "motor-circuit.js"));

const MC = window.LIB.MotorCircuit;

// Helper: build a 2-circuit mutual inductance coeffs object
function mutual2({ L0, L1, M }) {
  return {
    L: new Float64Array([L0, M, M, L1]),
    dLdth: new Float64Array(4),
    lambdaPm: new Float64Array(2),
    dLambdaPmdth: new Float64Array(2),
  };
}

// Helper: build a 3-circuit mutual inductance coeffs object (diagonal + off-diagonal)
function mutual3({ diag, offDiag }) {
  const L = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      L[i * 3 + j] = (i === j) ? diag : offDiag;
    }
  }
  return {
    L,
    dLdth: new Float64Array(9),
    lambdaPm: new Float64Array(3),
    dLambdaPmdth: new Float64Array(3),
  };
}

test("CURRENT pins the circuit current exactly", () => {
  const coeffs = mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 });
  const terminalStates = ["CURRENT", "DC"];
  const Iimp = new Float64Array([7, 0]);
  const V = new Float64Array([0, 5]);
  const R = new Float64Array([1, 1]);
  const dt = 1e-3;
  const omega = 0;

  let i = new Float64Array(2);
  for (let step = 0; step < 50; step++) {
    const result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp });
    i = result.i;
    assert.strictEqual(i[0], 7, `i[0] must be exactly 7 at step ${step}`);
  }
  // After 50 steps i[1] should have converged close to V[1]/R[1] = 5
  assert.ok(Math.abs(i[1] - 5) < 0.1,
    `i[1] should be near 5 after 50 steps; got ${i[1]}`);
});

test("a CURRENT-pinned field develops no induced current where a voltage field would", () => {
  const coeffs = mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 });
  const R = new Float64Array([1, 1]);
  const dt = 1e-3;
  const omega = 0;

  // Sub-case A: voltage field — grounded circuit 0 with V=0; mutual coupling drives transient i[0]
  {
    const terminalStates = ["DC", "DC"];
    const V = new Float64Array([0, 5]);
    let i = new Float64Array(2);
    let maxAbsI0 = 0;
    for (let step = 0; step < 30; step++) {
      const result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates });
      i = result.i;
      if (Math.abs(i[0]) > maxAbsI0) maxAbsI0 = Math.abs(i[0]);
    }
    assert.ok(maxAbsI0 > 1e-3,
      `voltage-field sub-case: expected |i[0]| > 1e-3 during transient; got max ${maxAbsI0}`);
  }

  // Sub-case B: current-pinned field — i[0] is locked to 2 exactly at every step
  {
    const terminalStates = ["CURRENT", "DC"];
    const Iimp = new Float64Array([2, 0]);
    const V = new Float64Array([0, 5]);
    let i = new Float64Array(2);
    for (let step = 0; step < 50; step++) {
      const result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp });
      i = result.i;
      assert.strictEqual(i[0], 2, `i[0] must be exactly 2 at step ${step}`);
    }
    assert.ok(Math.abs(i[1] - 5) < 0.1,
      `pinning field current must not corrupt stator solve; i[1]=${i[1]}`);
  }
});

test("all-CURRENT circuits are pinned with no solve", () => {
  const coeffs = mutual2({ L0: 1e-3, L1: 1e-3, M: 0.8e-3 });
  const terminalStates = ["CURRENT", "CURRENT"];
  const Iimp = new Float64Array([3, 4]);
  const V = new Float64Array([0, 0]);
  const R = new Float64Array([1, 1]);
  const dt = 1e-3;
  const omega = 0;

  const i = new Float64Array(2);
  let threw = false;
  let result;
  try {
    result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp });
  } catch (err) {
    threw = true;
  }
  assert.ok(!threw, "all-CURRENT advance must not throw");
  assert.strictEqual(result.i[0], 3);
  assert.strictEqual(result.i[1], 4);
});

test("OPEN coexists with CURRENT and still exposes induced voltage", () => {
  const coeffs = mutual3({ diag: 1e-3, offDiag: 0.5e-3 });
  const terminalStates = ["CURRENT", "DC", "OPEN"];
  const Iimp = new Float64Array([5, 0, 0]);
  const V = new Float64Array([0, 5, 0]);
  const R = new Float64Array([1, 1, 1]);
  const dt = 1e-3;
  const omega = 0;

  const i = new Float64Array(3);
  const result = MC.advance(coeffs, { R, V, i, omega, dt, terminalStates, Iimp });

  assert.strictEqual(result.i[0], 5, "i[0] must be pinned to 5");
  assert.strictEqual(result.i[2], 0, "i[2] must be 0 (OPEN)");
  assert.ok(Math.abs(result.vOpen[2]) > 1e-4,
    `OPEN branch must see induced voltage from driven+pinned currents; got vOpen[2]=${result.vOpen[2]}`);
});
