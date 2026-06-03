"use strict";

// Unit tests for LIB.BDF — the variable-step BDF/trapezoidal integrator with
// LTE step control. Linear systems with closed-form solutions exercise the
// three properties the motor stepper relies on:
//   1. L-stability  — a stiff decay stays finite with dt ≫ 1/λ (Gear).
//   2. Convergence  — global error shrinks as rtol tightens (≈ order 2).
//   3. Energy       — Gear damps oscillators but the LTE bounds it to ~rtol;
//                     trapezoidal is energy-neutral. (Drives the motor's
//                     stiff-circuit-vs-mechanical-oscillation method choice.)

const test = require("node:test");
const assert = require("node:assert");

global.window = global;
require("../../lib/bdf-integrator.js");
const BDF = global.LIB.BDF;

// stepSolve for y' = A·y  ⇒  (A − ag0·I) y = histTerm.
function linSolver(A, n) {
  return function (t, dt, ag0, hist, yGuess, o) {
    if (n === 1) { o[0] = hist[0] / (A[0] - ag0); return; }
    const a = A[0], b = A[1], c = A[2], d = A[3];
    const det = (a - ag0) * (d - ag0) - b * c;
    o[0] = (hist[0] * (d - ag0) - b * hist[1]) / det;
    o[1] = ((a - ag0) * hist[1] - c * hist[0]) / det;
  };
}

test("L-stable: stiff decay stays finite and decays with dt ≫ 1/λ", () => {
  for (const lam of [1, 100, 1e4]) {
    const it = BDF.create({ n: 1, rtol: 1e-5, atol: 1e-9, dtMax: 0.1, dtStart: 1e-4 });
    it.setState([1], 0);
    it.advance(1, linSolver([-lam], 1));
    assert.ok(isFinite(it.y[0]), `λ=${lam} produced non-finite`);
    assert.ok(it.y[0] < (lam === 1 ? 0.4 : 1e-6) && it.y[0] >= 0,
      `λ=${lam}: y(1)=${it.y[0]} not a decayed value`);
  }
});

test("convergence: global error shrinks as rtol tightens", () => {
  const errs = [];
  for (const rtol of [1e-3, 1e-4, 1e-5, 1e-6]) {
    const it = BDF.create({ n: 1, rtol, atol: rtol * 1e-3, dtMax: 0.2, dtStart: 1e-3 });
    it.setState([1], 0);
    it.advance(1, linSolver([-1], 1));
    errs.push(Math.abs(it.y[0] - Math.exp(-1)));
  }
  for (let i = 1; i < errs.length; i++) {
    assert.ok(errs[i] < errs[i - 1], `error not monotonically decreasing: ${errs}`);
  }
  // tightest rtol should be near-exact
  assert.ok(errs[errs.length - 1] < 2e-4, `tight-rtol error too large: ${errs[errs.length - 1]}`);
});

test("energy: gear damps within rtol bound; trapezoidal is neutral (50 periods)", () => {
  const w = 2 * Math.PI, A = [0, 1, -w * w, 0];
  function driftPct(method, rtol) {
    const it = BDF.create({ n: 2, rtol, atol: rtol * 1e-4, method, dtMax: 0.05, dtStart: 1e-3 });
    it.setState([1, 0], 0);
    it.advance(50, linSolver(A, 2));
    const E = (0.5 * it.y[1] * it.y[1] + 0.5 * w * w * it.y[0] * it.y[0]) / (0.5 * w * w);
    return (E - 1) * 100;
  }
  // Gear: L-stable ⇒ numerical damping, but tight rtol bounds it.
  assert.ok(Math.abs(driftPct("gear", 1e-6)) < 1, "gear drift not bounded by tight rtol");
  // Trapezoidal: energy-neutral at any tolerance.
  assert.ok(Math.abs(driftPct("trapezoidal", 1e-4)) < 0.5, "trapezoidal not energy-neutral");
  assert.ok(Math.abs(driftPct("trapezoidal", 1e-6)) < 0.5, "trapezoidal not energy-neutral (tight)");
});
