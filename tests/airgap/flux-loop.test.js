"use strict";

// =============================================================================
//  Axial flux-loop coupling gate (P2) — solveCoupled with a multi-slice circuit.
//
//  Two slices coupled by one axial flux loop (σ=[+1,−1]) in series with a lumped
//  axial reluctance R_axial and PM MMF F_pm. The loop KVL condenses (mirroring the
//  θ-column Schur in solveCoupled) to Φ = F_pm/(R_field,0 + R_field,1 + R_axial).
//  For two identical all-air slices R_field,s = (1/μ0/2π)·ln(rOut/rIn) = Rf, so
//  Φ = F_pm/(2·Rf + R_axial). This is the mechanism a uniform axial PM (hybrid,
//  claw-pole) needs: net radial flux out one cup, back through the other.
//
//  With no axial loop, the slices are independent (L=0) — covered bit-identically by
//  the machine suites.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert");
const F = require("../machines/_fixtures.js");

const LIB = F.LIB, CS = F.UnifiedMotor.ConfigSchema;
const MU0 = 4e-7 * Math.PI;
const rIn = 0.020, rOut = 0.040;

function twoSliceConfig() {
  return {
    grid: { Nr: 24, Ntheta: 256, rInner: rIn, rOuter: rOut, ell: 0.05 },
    poles: 2,
    mechanical: { J: 1e-4, damping: 0, loadTorque: 0 },
    rings: [
      { member: "rotor",  element: "I", rRange: [0.020, 0.028], teeth: 1, theta0: 0, spanFraction: 1.0, muR: 1 },
      { member: "stator", element: "I", rRange: [0.032, 0.040], teeth: 1, theta0: 0, spanFraction: 1.0, muR: 1 },
    ],
    circuits: [],
    stack: { slices: 2, sliceOffsets: [0, 0] },
  };
}

function solveLoop(Rax, Fpm) {
  const expanded = CS.expand(twoSliceConfig());
  expanded.axial = { loops: [ { slices: [{ s: 0, sign: 1 }, { s: 1, sign: -1 }], Raxial: Rax, Fpm: Fpm } ] };
  const stack = LIB.MotorStack.create(expanded);
  const hist = new Float64Array(2); hist[0] = 1.0;   // histω → non-degenerate mechanical row
  return stack.solveCoupled({
    ag0: 1.0, hist: hist, cond: [], R: new Float64Array(0),
    J: 1, damping: 1, loadTorque: 0, frictionTorque: 0, maxIter: 40, relTol: 1e-9,
  });
}

test("flux loop: two coupled slices reproduce the series-reluctance flux split", () => {
  const Rf = (1 / MU0 / (2 * Math.PI)) * Math.log(rOut / rIn);
  for (const Rax of [0, Rf, 5 * Rf]) {
    const res = solveLoop(Rax, 100);
    const expect = 100 / (2 * Rf + Rax);
    assert.ok(res.converged, `coupled solve did not converge (Raxial=${Rax.toExponential(2)}, iters=${res.iters})`);
    const rel = Math.abs(res.Phi[0] / expect - 1);
    assert.ok(rel < 5e-3, `Raxial=${Rax.toExponential(2)}: Φ=${res.Phi[0].toExponential(5)} expect ${expect.toExponential(5)} (rel ${rel.toExponential(2)})`);
  }
});

test("flux loop: open axial path (R_axial→∞) chokes the flux", () => {
  const Rf = (1 / MU0 / (2 * Math.PI)) * Math.log(rOut / rIn);
  const open = solveLoop(1e8 * Rf, 100);
  const closed = solveLoop(0, 100);
  assert.ok(Math.abs(open.Phi[0]) < 1e-6 * Math.abs(closed.Phi[0]),
    `open Φ ${open.Phi[0].toExponential(3)} should be ≪ closed Φ ${closed.Phi[0].toExponential(3)}`);
});
