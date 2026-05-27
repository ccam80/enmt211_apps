"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const {
  LIB,
  singleAnnulusSection,
  ringStackSection,
  meshFromConfig,
  coverageError,
  loadAllFixtures,
  readMsh,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// Representative section for convergence tests (rotor body)
function refSection() {
  return singleAnnulusSection();
}

// ---------------------------------------------------------------------------
//  area error converges under refinement
// ---------------------------------------------------------------------------

describe("area error converges under refinement", () => {
  it("areaError is non-increasing across refine={1,√2,2} and finest < 2e-3", () => {
    const section = refSection();
    const refines = [1, Math.sqrt(2), 2];
    const errors = [];

    for (const refine of refines) {
      const { rotor } = MotorMesh.build(section, { refine });
      const q = MotorMesh.quality(rotor);
      errors.push(q.areaError);
    }

    // Non-increasing
    for (let i = 1; i < errors.length; i++) {
      assert.ok(
        errors[i] <= errors[i - 1] + 1e-6,
        `areaError not non-increasing: errors[${i}]=${errors[i]} > errors[${i-1}]=${errors[i-1]}`
      );
    }

    // Finest level < 2e-3
    assert.ok(
      errors[errors.length - 1] < 2e-3,
      `finest areaError=${errors[errors.length-1]} not < 2e-3`
    );
  });
});

// ---------------------------------------------------------------------------
//  min-angle stays bounded under refinement
// ---------------------------------------------------------------------------

describe("min-angle stays bounded under refinement", () => {
  it("quality.minAngle > 20 at every refinement level", () => {
    const section = refSection();
    const refines = [1, Math.sqrt(2), 2];

    for (const refine of refines) {
      const { rotor } = MotorMesh.build(section, { refine });
      const q = MotorMesh.quality(rotor);
      assert.ok(
        q.minAngle > 20,
        `minAngle=${q.minAngle} not > 20 at refine=${refine}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  coverage error is zero at every level
// ---------------------------------------------------------------------------

describe("coverage error is zero at every level", () => {
  it("coverageError(section, mesh) < 1e-2 at every refinement level", () => {
    const section = refSection();
    const refines = [1, Math.sqrt(2), 2];

    for (const refine of refines) {
      const mesh = MotorMesh.build(section, { refine });
      const covErr = coverageError(section, mesh);
      assert.ok(
        covErr < 1e-2,
        `coverageError=${covErr} not < 1e-2 at refine=${refine}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  15-fixture regression sweep
// ---------------------------------------------------------------------------

describe("15-fixture regression sweep", () => {
  it("every machine fixture: nInverted=0, nDegenerate=0, coverageError<1e-2, gapLoop non-empty", () => {
    const machines = loadAllFixtures();
    assert.ok(machines.length >= 15, `expected >= 15 fixtures, got ${machines.length}`);

    for (const m of machines) {
      const expanded = window.UnifiedMotor.ConfigSchema.expand(m.config);
      const section = expanded.slices[0].section;
      const mesh = MotorMesh.build(section, {});

      const qr = MotorMesh.quality(mesh.rotor);
      const qs = MotorMesh.quality(mesh.stator);

      assert.strictEqual(qr.nInverted,   0, `${m.id} rotor nInverted=${qr.nInverted}`);
      assert.strictEqual(qr.nDegenerate, 0, `${m.id} rotor nDegenerate=${qr.nDegenerate}`);
      assert.strictEqual(qs.nInverted,   0, `${m.id} stator nInverted=${qs.nInverted}`);
      assert.strictEqual(qs.nDegenerate, 0, `${m.id} stator nDegenerate=${qs.nDegenerate}`);

      const covErr = coverageError(section, mesh);
      assert.ok(
        covErr < 1e-2,
        `${m.id} coverageError=${covErr} not < 1e-2`
      );

      assert.ok(
        mesh.rotor.gapLoop.length > 0,
        `${m.id} rotor gapLoop is empty`
      );
      assert.ok(
        mesh.stator.gapLoop.length > 0,
        `${m.id} stator gapLoop is empty`
      );

      // gapTheta is uniform for both bodies
      for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
        const N = body.gapLoop.length;
        if (N >= 2) {
          const expectedStep = TWO_PI / N;
          for (let k = 1; k < N; k++) {
            const diff = body.gapTheta[k] - body.gapTheta[k - 1];
            assert.ok(
              Math.abs(diff - expectedStep) < 1e-9,
              `${m.id} ${label} gapTheta not uniform at k=${k}`
            );
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  gmsh reference diff
// ---------------------------------------------------------------------------

describe("gmsh reference diff", () => {
  it("mesher element count within 2x of gmsh reference; minAngle within ±10°; gap_layers matches", () => {
    const fixturesDir = path.join(__dirname, "fixtures");
    let mshFiles = [];
    try {
      mshFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith(".msh"));
    } catch (e) {
      // fixtures dir does not exist
    }

    if (mshFiles.length === 0) {
      // Portability fallback: skip only when no .msh references are present
      // (e.g. sparse checkout without gen-mesh-refs.mjs having been run)
      return;
    }

    // Load all fixtures so we can find the right section by name
    const machines = loadAllFixtures();

    for (const mshFile of mshFiles) {
      const mshPath = path.join(fixturesDir, mshFile);
      const ref = readMsh(mshPath);
      if (!ref) {
        assert.fail(`Could not parse .msh file: ${mshFile}`);
      }

      // .msh file name encodes: <machine-id>-<member>-gapLayers<N>.msh
      // e.g. "pmsm-rotor-gapLayers3.msh"
      const nameMatch = mshFile.match(/^(.+)-(rotor|stator)-gapLayers(\d+)\.msh$/);
      if (!nameMatch) {
        assert.fail(`Unexpected .msh filename format: ${mshFile} (expected <id>-<member>-gapLayers<N>.msh)`);
      }
      const [, machineId, member, gapLayersStr] = nameMatch;
      const gapLayersExpected = parseInt(gapLayersStr, 10);

      // Find the machine config
      const machine = machines.find(m => m.id === machineId);
      if (!machine) {
        assert.fail(`Machine "${machineId}" from .msh filename not found in fixtures`);
      }

      const expanded = window.UnifiedMotor.ConfigSchema.expand(machine.config);
      const section = expanded.slices[0].section;
      const mesh = MotorMesh.build(section, { gapLayers: gapLayersExpected });
      const body = member === "rotor" ? mesh.rotor : mesh.stator;

      const mesherNe = body.elems.length / 4;
      const mesherMinAngle = MotorMesh.quality(body).minAngle;

      // Element count within 2x
      assert.ok(
        mesherNe <= ref.elemCount * 2 && ref.elemCount <= mesherNe * 2,
        `${mshFile}: mesher elemCount=${mesherNe} not within 2x of ref elemCount=${ref.elemCount}`
      );

      // minAngle within ±10° of ref
      assert.ok(
        Math.abs(mesherMinAngle - ref.minAngle) <= 10,
        `${mshFile}: mesher minAngle=${mesherMinAngle.toFixed(1)} not within ±10° of ref minAngle=${ref.minAngle}`
      );

      // gap_layers matches header comment (if present in ref)
      if (ref.gapLayers !== null) {
        assert.strictEqual(
          ref.gapLayers,
          gapLayersExpected,
          `${mshFile}: ref gap_layers=${ref.gapLayers} !== expected ${gapLayersExpected}`
        );
      }
    }
  });
});
