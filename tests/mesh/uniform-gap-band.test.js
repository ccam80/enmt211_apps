"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadAllFixtures,
  meshFromConfig,
  syntheticPhysics,
  singleAnnulusSection,
  ringStackSection,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  All 15 fixtures: gap-adjacent band has uniform Δθ
//
//  The gap-adjacent band uses Ntheta_gap = poles × round(2.4 × nuMaxSlice)
//  columns, uniformly spaced. This test verifies:
//  1. gapTheta is perfectly uniform (spacing constant within 1e-12 rad)
//  2. gapLoop.length === poles × round(2.4 × nuMaxSlice) exactly
//  3. No inverted elements in either body
// ---------------------------------------------------------------------------

describe("All 15 fixtures: gap-adjacent band uniform Δθ", () => {
  it("every body's gapTheta is perfectly uniform (within 1e-12 rad)", () => {
    const machines = loadAllFixtures();
    assert.ok(machines.length >= 15, `expected >= 15 fixtures, got ${machines.length}`);

    for (const m of machines) {
      const mesh = meshFromConfig(m.config);

      for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
        const N = body.gapLoop.length;
        assert.ok(N >= 2, `${m.id} ${label}: gapLoop.length=${N} should be >= 2`);

        const expectedStep = TWO_PI / N;

        // Check uniformity of gapTheta
        for (let k = 1; k < N; k++) {
          const diff = body.gapTheta[k] - body.gapTheta[k - 1];
          assert.ok(
            Math.abs(diff - expectedStep) < 1e-12,
            `${m.id} ${label}: gapTheta not uniform at k=${k}: diff=${diff}, expected=${expectedStep}`
          );
        }

        // Check gapTheta starts at 0 and ends at (N-1)/N * 2π
        assert.ok(
          Math.abs(body.gapTheta[0]) < 1e-12,
          `${m.id} ${label}: gapTheta[0]=${body.gapTheta[0]} should be 0`
        );
        assert.ok(
          Math.abs(body.gapTheta[N - 1] - (N - 1) * expectedStep) < 1e-12,
          `${m.id} ${label}: gapTheta[${N-1}]=${body.gapTheta[N-1]} should be ${(N-1)*expectedStep}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  All 15 fixtures: gapLoop.length matches physics formula
// ---------------------------------------------------------------------------

describe("All 15 fixtures: gapLoop.length === poles × round(2.4 × nuMaxSlice)", () => {
  it("every fixture body gapLoop length matches the physics formula", () => {
    const machines = loadAllFixtures();

    for (const m of machines) {
      const physics = MotorMesh.physicsFromConfig(m.config);
      const poles = m.config.poles;
      const { nuMaxSlice } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });
      const expectedN = poles * Math.round(2.4 * nuMaxSlice);

      const mesh = meshFromConfig(m.config);

      assert.strictEqual(mesh.rotor.gapLoop.length, expectedN,
        `${m.id} rotor: gapLoop.length=${mesh.rotor.gapLoop.length} !== ${expectedN}`);
      assert.strictEqual(mesh.stator.gapLoop.length, expectedN,
        `${m.id} stator: gapLoop.length=${mesh.stator.gapLoop.length} !== ${expectedN}`);
    }
  });
});

// ---------------------------------------------------------------------------
//  gapMinNodes floor is satisfied when passed explicitly.
//
//  The harmonic gap requires N_gap >= 4K where K = 3 × max(slots, poles).
//  The mesher enforces this only when the caller passes gapMinNodes explicitly
//  (the mesher is machine-agnostic and does not compute K internally).
//  This test verifies that passing gapMinNodes raises N_gap to at least that value.
// ---------------------------------------------------------------------------

describe("gapMinNodes floor is enforced when explicitly passed", () => {
  it("passing gapMinNodes=4*3*max(slots,poles) produces gapLoop.length >= floor for PMSM", () => {
    const machines = loadAllFixtures();
    const pmsm = machines.find(m => m.id === "pmsm");
    assert.ok(pmsm, "pmsm fixture must be present");

    const physics = MotorMesh.physicsFromConfig(pmsm.config);
    const poles = pmsm.config.poles; // 8

    // Compute floor: K = 3 * max(slots=48, poles=8) = 144, floor = 4*144 = 576
    const maxSlots = 48;
    const K = 3 * Math.max(maxSlots, poles);
    const floor = 4 * K;

    // Build with explicit gapMinNodes
    const expanded = window.UnifiedMotor.ConfigSchema.expand(pmsm.config);
    const section = expanded.slices[0].section;
    const mesh = MotorMesh.build(section, { physics, gapMinNodes: floor });

    assert.ok(
      mesh.rotor.gapLoop.length >= floor,
      `PMSM rotor gapLoop.length=${mesh.rotor.gapLoop.length} < Phase4 floor=${floor} (K=${K})`
    );
    assert.ok(
      mesh.stator.gapLoop.length >= floor,
      `PMSM stator gapLoop.length=${mesh.stator.gapLoop.length} < Phase4 floor=${floor} (K=${K})`
    );

    // gapTheta must still be uniform after gapMinNodes override
    for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
      const N = body.gapLoop.length;
      const expectedStep = TWO_PI / N;
      for (let k = 1; k < N; k++) {
        const diff = body.gapTheta[k] - body.gapTheta[k - 1];
        assert.ok(
          Math.abs(diff - expectedStep) < 1e-12,
          `PMSM ${label}: gapTheta not uniform at k=${k} after gapMinNodes`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  Single annulus: gap band uniform even without feature boundaries
// ---------------------------------------------------------------------------

describe("Single annulus: gap-adjacent band is uniform", () => {
  it("singleAnnulusSection gap band: gapTheta uniform within 1e-12", () => {
    const section = singleAnnulusSection();
    const physics = syntheticPhysics();
    const mesh = MotorMesh.build(section, { physics });

    for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
      const N = body.gapLoop.length;
      assert.ok(N >= 2, `${label}: gapLoop.length=${N} should be >= 2`);

      const expectedStep = TWO_PI / N;
      for (let k = 1; k < N; k++) {
        const diff = body.gapTheta[k] - body.gapTheta[k - 1];
        assert.ok(
          Math.abs(diff - expectedStep) < 1e-12,
          `${label}: gapTheta not uniform at k=${k}: diff=${diff}, expected=${expectedStep}`
        );
      }

      // Quality checks
      const q = MotorMesh.quality(body);
      assert.strictEqual(q.nInverted, 0, `${label}: nInverted=${q.nInverted}`);
      assert.strictEqual(q.nDegenerate, 0, `${label}: nDegenerate=${q.nDegenerate}`);
    }
  });
});

// ---------------------------------------------------------------------------
//  Ring stack: gap band uniform, no inverted elements
// ---------------------------------------------------------------------------

describe("Ring stack: gap-adjacent band uniform, no inverted", () => {
  it("ringStackSection gap band: gapTheta uniform; no inverted or degenerate", () => {
    const section = ringStackSection();
    const physics = syntheticPhysics();
    const mesh = MotorMesh.build(section, { physics });

    for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
      const N = body.gapLoop.length;
      assert.ok(N >= 2, `${label}: gapLoop.length=${N} should be >= 2`);

      const expectedStep = TWO_PI / N;
      for (let k = 1; k < N; k++) {
        const diff = body.gapTheta[k] - body.gapTheta[k - 1];
        assert.ok(
          Math.abs(diff - expectedStep) < 1e-12,
          `${label}: gapTheta not uniform at k=${k}: diff=${diff}, expected=${expectedStep}`
        );
      }

      const q = MotorMesh.quality(body);
      assert.strictEqual(q.nInverted, 0, `${label}: nInverted=${q.nInverted}`);
    }
  });
});

// ---------------------------------------------------------------------------
//  Gap-band columns are strictly uniform: no feature-boundary extras
//  The gap-adjacent band does NOT get per-feature extras in current arch.
//  Verify: all N_gap column spacings are equal (max deviation < 1e-12 of span).
// ---------------------------------------------------------------------------

describe("Gap band: all angular spacings are strictly equal (no per-feature extras)", () => {
  it("gapTheta spacing max deviation < 1e-12 * 2pi for all 15 fixtures", () => {
    const machines = loadAllFixtures();

    for (const m of machines) {
      const mesh = meshFromConfig(m.config);

      for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
        const { gapTheta } = body;
        const N = gapTheta.length;
        if (N < 2) continue;

        const step0 = gapTheta[1] - gapTheta[0];
        let maxDev = 0;
        for (let k = 1; k < N; k++) {
          const step = gapTheta[k] - gapTheta[k - 1];
          const dev = Math.abs(step - step0);
          if (dev > maxDev) maxDev = dev;
        }

        assert.ok(
          maxDev < 1e-12,
          `${m.id} ${label}: gap band max angular step deviation ${maxDev} >= 1e-12 (not strictly uniform)`
        );
      }
    }
  });
});
