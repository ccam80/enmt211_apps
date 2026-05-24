"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  assertClose,
  tinySection,
} = require("./_fixtures.js");

describe("motor-slice", function () {
  // -------------------------------------------------------------------------
  it("solve returns finite torque + flux of length nCircuits", function () {
    const slice = LIB.MotorSlice.create(tinySection({ withIron: true }));
    const currents = new Float64Array([5]);
    const r = slice.solve(0, currents);

    assert.ok(Number.isFinite(r.torque), "torque must be finite");
    assert.strictEqual(
      r.fluxLinkages.length,
      slice.nCircuits,
      "fluxLinkages.length must equal nCircuits"
    );
    assert.strictEqual(
      r.field.Br.length,
      6 * 24,
      "field.Br.length must equal Nr*Ntheta = 6*24"
    );
    assert.ok(
      Number.isFinite(r.field.satScale),
      "field.satScale must be finite (confirms solveSaturated path, not pcg)"
    );
  });

  // -------------------------------------------------------------------------
  it("field changes with rotor angle", function () {
    const slice = LIB.MotorSlice.create(tinySection({ withIron: true }));
    const currents = new Float64Array([5]);

    const r0 = slice.solve(0, currents);
    const r1 = slice.solve(0.3, currents);

    let diffFound = false;
    for (let i = 0; i < r0.field.Br.length; i++) {
      if (Math.abs(r0.field.Br[i] - r1.field.Br[i]) > 1e-12) {
        diffFound = true;
        break;
      }
    }
    assert.ok(diffFound, "Br must differ in at least one entry when rotor angle changes by 0.3 rad");
  });

  // -------------------------------------------------------------------------
  it("magnet-free section => zero lambda_pm", function () {
    const slice = LIB.MotorSlice.create(tinySection({ withMagnet: false }));
    const coeffs = slice.extractCoeffs(0);

    assert.strictEqual(coeffs.lambdaPm[0], 0, "lambdaPm[0] must be exactly 0 for magnet-free section");
    assert.strictEqual(coeffs.dLambdaPmdth[0], 0, "dLambdaPmdth[0] must be exactly 0 for magnet-free section");
  });

  // -------------------------------------------------------------------------
  it("honors a custom SolveBackend", function () {
    // Build a spy backend that wraps the coarse backend and counts calls.
    const coarseSliceRef = LIB.MotorSlice.create(tinySection({ withIron: true }));

    // Reconstruct the coarse backend by rebuilding it independently
    const spyCounts = { prepare: 0, solveSaturated: 0, linearSolve: 0 };

    const spyBackend = {
      _inner: null,

      prepare(section) {
        spyCounts.prepare++;
        const op = LIB.AirgapGrid.create(section.grid);
        const compiled = LIB.MotorCompile.compile(section);
        op.setMaterials({ nu: compiled.nu });
        op.setRotorRegion({
          rotorMask: compiled.rotorMask,
          magnetization: compiled.magnetization,
        });
        op.setGapBand(section.gapBand);
        this._op = op;
        this._compiled = compiled;
        return { op, compiled };
      },

      solveSaturated(op, b, opts) {
        spyCounts.solveSaturated++;
        return LIB.AirgapSolve.solveSaturated(op, b, opts);
      },

      linearSolve(op, b, opts) {
        spyCounts.linearSolve++;
        return LIB.AirgapSolve.pcg(op, b, opts);
      },
    };

    const section = tinySection({ withIron: true });
    const spySlice = LIB.MotorSlice.create(section, { backend: spyBackend });

    // Run solve
    const currents = new Float64Array([5]);
    const spyResult = spySlice.solve(0, currents);

    // Run extractCoeffs
    spySlice.extractCoeffs(0);

    // Assert spy was called correctly
    assert.strictEqual(spyCounts.prepare, 1, "spy.prepare must be called exactly once");
    assert.ok(spyCounts.solveSaturated >= 1, "spy.solveSaturated must be called >= 1 time");
    assert.ok(spyCounts.linearSolve >= 1, "spy.linearSolve must be called >= 1 time");

    // Spy changes no result: torque must equal the default-backend slice's torque
    const defaultSlice = LIB.MotorSlice.create(section);
    const defaultResult = defaultSlice.solve(0, currents);

    assertClose(
      spyResult.torque,
      defaultResult.torque,
      1e-9,
      "spy-backend torque must equal default-backend torque to 1e-9 relative"
    );
  });
});
