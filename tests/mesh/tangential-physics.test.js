"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadAllFixtures,
  meshFromConfig,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  PMSM: slice-wide ν_max pulls rotor cells_per_pole up to ≥ 41
//
//  PMSM has:
//    - 8-pole, 48-slot, m=3 stator → nuMaxForWinding = 17 (distributed)
//    - nuMaxSlice = 17, cellsPerPole = round(2.4 × 17) = 41
//  Without slice-wide ν_max, the rotor body alone (magnets only, no winding)
//  would see nuMax = 1 giving cpp ≈ 2. Slice-wide pulls it to 41.
// ---------------------------------------------------------------------------

describe("PMSM rotor cells_per_pole >= 41 (slice-wide nu_max)", () => {
  it("PMSM rotor gap band has Ntheta_gap >= poles * 41", () => {
    const machines = loadAllFixtures();
    const pmsm = machines.find(m => m.id === "pmsm");
    assert.ok(pmsm, "pmsm fixture must be present");

    const physics = MotorMesh.physicsFromConfig(pmsm.config);
    const { nuMaxSlice, cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });

    // nuMaxSlice should be 17 (m=3 distributed winding)
    assert.ok(nuMaxSlice >= 17,
      `nuMaxSlice=${nuMaxSlice} should be >= 17 (m=3 distributed)`);

    // cellsPerPole = round(2.4 * nuMaxSlice) >= 41
    assert.ok(cellsPerPole >= 41,
      `cellsPerPole=${cellsPerPole} should be >= 41 for PMSM`);

    const mesh = meshFromConfig(pmsm.config);
    const poles = pmsm.config.poles; // 8
    const N_gap = mesh.rotor.gapLoop.length;

    assert.ok(N_gap >= poles * 41,
      `PMSM rotor gapLoop.length=${N_gap} should be >= poles(${poles}) * 41 = ${poles * 41}`);
  });
});

// ---------------------------------------------------------------------------
//  Universal motor: no LCM explosion; cells_per_pole ≤ 30
//
//  Universal has:
//    - 2-pole, m=1 rotor (24 slots) → nuMaxForWinding = 11
//    - 2-pole, m=1 stator (4 slots) → nuMaxForWinding = 11
//    - nuMaxSlice = 11, cellsPerPole = round(2.4 × 11) = 26 ≤ 30
//
//  Old LCM-based approach: 24-slot rotor with non-uniform feature angles
//  would produce LCM-driven cpp ≈ 204. New per-feature approach: 26.
// ---------------------------------------------------------------------------

describe("Universal rotor cells_per_pole <= 30 (no LCM explosion)", () => {
  it("Universal motor rotor gap band has Ntheta_gap <= poles * 30", () => {
    const machines = loadAllFixtures();
    const universal = machines.find(m => m.id === "universal");
    assert.ok(universal, "universal fixture must be present");

    const physics = MotorMesh.physicsFromConfig(universal.config);
    const { nuMaxSlice, cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });

    // nuMaxSlice = 11 (m=1 distributed)
    assert.ok(nuMaxSlice >= 11,
      `nuMaxSlice=${nuMaxSlice} should be >= 11 (m=1 distributed)`);

    // cellsPerPole ≤ 30
    assert.ok(cellsPerPole <= 30,
      `cellsPerPole=${cellsPerPole} should be <= 30 for Universal (was 204 with LCM approach)`);

    const mesh = meshFromConfig(universal.config);
    const poles = universal.config.poles; // 2
    const N_gap = mesh.rotor.gapLoop.length;

    assert.ok(N_gap <= poles * 30,
      `Universal rotor gapLoop.length=${N_gap} should be <= poles(${poles}) * 30 = ${poles * 30} (no LCM explosion)`);
  });
});

// ---------------------------------------------------------------------------
//  All 15 fixtures: cells_per_pole satisfies 2 * nuMax ≤ cpp ≤ 5 * nuMax
//  (physics-derived, neither under- nor over-meshed)
// ---------------------------------------------------------------------------

describe("All fixtures: cells_per_pole in physics-derived range", () => {
  it("every fixture has round(2.4 * nuMaxSlice) * poles gap-band columns", () => {
    const machines = loadAllFixtures();

    for (const m of machines) {
      const physics = MotorMesh.physicsFromConfig(m.config);
      const { nuMaxSlice, cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });

      // cellsPerPole = round(2.4 * nuMaxSlice)
      const expected = Math.round(2.4 * nuMaxSlice);
      assert.strictEqual(cellsPerPole, expected,
        `${m.id}: cellsPerPole=${cellsPerPole} should equal round(2.4*nuMaxSlice=${nuMaxSlice})=${expected}`);

      const mesh = meshFromConfig(m.config);
      const poles = m.config.poles;

      // Both rotor and stator gapLoop.length should equal poles * cellsPerPole
      // (unless gapMinNodes floor overrides, which it doesn't by default)
      const expectedN = poles * cellsPerPole;
      assert.strictEqual(mesh.rotor.gapLoop.length, expectedN,
        `${m.id} rotor gapLoop.length=${mesh.rotor.gapLoop.length} should be ${expectedN}`);
      assert.strictEqual(mesh.stator.gapLoop.length, expectedN,
        `${m.id} stator gapLoop.length=${mesh.stator.gapLoop.length} should be ${expectedN}`);
    }
  });
});
