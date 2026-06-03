"use strict";

// =============================================================================
//  tests/slice/pmsm-finite.test.js — Defect B regression gate.
//
//  Defect B (computeMk float64 overflow): for the pmsm fixture the harmonic
//  air-gap order reaches K = 144, at which Math.pow(r, k) of either gap radius
//  underflows to 0. The old computeMk k≥1 branch formed E = b²−a² directly, so
//  E→0 and c = k/(mu0·E)→Infinity, NaN-poisoning the entire solve. The fix
//  reformulates that branch in the bounded ratio rho = (r1/r2)^k ∈ (0,1).
//
//  This test loads the real pmsm machine fixture, builds the slice at
//  realistic DOF (no mesh.refine reduction, so the genuine high-K gap loop is
//  exercised), and asserts that every entry produced by solve(0, zeros) is
//  finite. Before the fix every one of these was NaN.
// =============================================================================

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const F = require("./_fixtures.js");
const LIB = F.LIB;
const initSolver = F.initSolver;
const loadMachine = F.loadMachine;
const CS = F.CS;

describe("MotorSlice pmsm finiteness (Defect B regression)", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("pmsm solve(0, zeros) is entirely finite", function () {
    const cfg = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const poles = expanded.poles;
    const section = expanded.slices[0].section;

    // Realistic DOF — no mesh.refine reduction, so the gap loop runs at the
    // full K that triggered the Defect B overflow.
    const slice = LIB.MotorSlice.create(section, {
      poles: poles,
      saturation: { enabled: false },
    });
    const m = slice.nCircuits;

    // ---- solve(0, zeros): torque, fluxLinkages, field arrays ----
    const zeros = new Float64Array(m);
    const r = slice.solve(0, zeros);

    assert.ok(Number.isFinite(r.torque),
      `solve torque=${r.torque} must be finite`);
    for (let i = 0; i < r.fluxLinkages.length; i++) {
      assert.ok(Number.isFinite(r.fluxLinkages[i]),
        `solve fluxLinkages[${i}]=${r.fluxLinkages[i]} must be finite`);
    }

    const rotorA = r.field.rotor.Anode;
    for (let i = 0; i < rotorA.length; i++) {
      assert.ok(Number.isFinite(rotorA[i]),
        `solve field.rotor.Anode[${i}]=${rotorA[i]} must be finite`);
    }
    const rotorBmag = r.field.rotor.Belem.mag;
    for (let i = 0; i < rotorBmag.length; i++) {
      assert.ok(Number.isFinite(rotorBmag[i]),
        `solve field.rotor.Belem.mag[${i}]=${rotorBmag[i]} must be finite`);
    }
  });
});
