"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const F = require("./_fixtures.js");
const LIB = F.LIB;
const initSolver = F.initSolver;
const sectionFromConfig = F.sectionFromConfig;
const polesFromConfig = F.polesFromConfig;
const feaOpts = F.feaOpts;
const woundConfig = F.woundConfig;
const pmConfig = F.pmConfig;
const salientConfig = F.salientConfig;

// 3-phase wound config used by symmetry + self-inductance tests.
function woundConfig3ph() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    rings: [
      {
        member: "stator",
        element: "W",
        rRange: [0.052, 0.06],
        winding: { standard: { m: 3, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: [0.04, 0.048],
        teeth: 2,
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
      { terminal: { type: "DC", amp: 0.0 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

describe("MotorSlice extractCoeffs (Wave 5.3)", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("extractCoeffs shape: L, dLdth length m*m; lambdaPm, dLambdaPmdth length m; all finite", function () {
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    assert.strictEqual(coeffs.L.length, m * m,
      `L.length must be m*m=${m * m}; got ${coeffs.L.length}`);
    assert.strictEqual(coeffs.dLdth.length, m * m,
      `dLdth.length must be m*m=${m * m}`);
    assert.strictEqual(coeffs.lambdaPm.length, m,
      `lambdaPm.length must be m=${m}`);
    assert.strictEqual(coeffs.dLambdaPmdth.length, m,
      `dLambdaPmdth.length must be m=${m}`);
    for (let i = 0; i < m * m; i++) {
      assert.ok(Number.isFinite(coeffs.L[i]),
        `L[${i}]=${coeffs.L[i]} must be finite`);
      assert.ok(Number.isFinite(coeffs.dLdth[i]),
        `dLdth[${i}]=${coeffs.dLdth[i]} must be finite`);
    }
    for (let i = 0; i < m; i++) {
      assert.ok(Number.isFinite(coeffs.lambdaPm[i]),
        `lambdaPm[${i}]=${coeffs.lambdaPm[i]} must be finite`);
      assert.ok(Number.isFinite(coeffs.dLambdaPmdth[i]),
        `dLambdaPmdth[${i}]=${coeffs.dLambdaPmdth[i]} must be finite`);
    }
  });

  // -----------------------------------------------------------------------
  it("L is symmetric (reciprocity, linear material)", function () {
    const cfg = woundConfig3ph();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < m; j++) {
        const Lij = coeffs.L[i * m + j];
        const Lji = coeffs.L[j * m + i];
        const denom = Math.max(Math.abs(Lij), Math.abs(Lji), 1e-30);
        const rel = Math.abs(Lij - Lji) / denom;
        assert.ok(rel < 1e-6,
          `L[${i}][${j}]=${Lij} vs L[${j}][${i}]=${Lji}; rel diff=${rel} must be < 1e-6`);
      }
    }
  });

  // -----------------------------------------------------------------------
  it("L_self > 0 for every circuit (3-phase config)", function () {
    const cfg = woundConfig3ph();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let k = 0; k < m; k++) {
      const Lkk = coeffs.L[k * m + k];
      assert.ok(Lkk > 0,
        `L_self for circuit ${k}: ${Lkk} must be > 0`);
    }
  });

  // -----------------------------------------------------------------------
  it("magnet-free section → lambdaPm and dLambdaPmdth are strictly 0 (zero-not-skip)", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const coeffs = slice.extractCoeffs(0.2);
    for (let k = 0; k < m; k++) {
      assert.strictEqual(coeffs.lambdaPm[k], 0,
        `magnet-free section: lambdaPm[${k}] must be exactly 0; got ${coeffs.lambdaPm[k]}`);
      assert.strictEqual(coeffs.dLambdaPmdth[k], 0,
        `magnet-free section: dLambdaPmdth[${k}] must be exactly 0; got ${coeffs.dLambdaPmdth[k]}`);
    }
  });

  // -----------------------------------------------------------------------
  it("PM section → lambdaPm changes with θ", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const lam0 = slice.extractCoeffs(0.0).lambdaPm;
    const lam5 = slice.extractCoeffs(0.5).lambdaPm;
    let maxDiff = 0;
    for (let k = 0; k < lam0.length; k++) {
      const d = Math.abs(lam0[k] - lam5[k]);
      if (d > maxDiff) maxDiff = d;
    }
    assert.ok(maxDiff > 1e-9,
      `lambdaPm must change with θ on PM section; maxDiff=${maxDiff}`);
  });

  // -----------------------------------------------------------------------
  it("dLdth from extract matches central-difference of L from independent recomputation", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const h = Math.PI / 180;
    const theta = 0.3;

    // The extract call at θ=0.3 with default derivStep=π/180 internally
    // computes plus@0.3+h, center@0.3, minus@0.3-h. We verify by calling
    // extract three independent times at offset angles and reconstructing
    // central difference from their CENTER values.
    const coeffsCenter = slice.extractCoeffs(theta);
    const cPlus  = slice.extractCoeffs(theta + h);
    const cMinus = slice.extractCoeffs(theta - h);

    for (let k = 0; k < m * m; k++) {
      const dLdth_recompute = (cPlus.L[k] - cMinus.L[k]) / (2 * h);
      const dLdth_extract   = coeffsCenter.dLdth[k];
      const denom = Math.max(Math.abs(dLdth_extract), Math.abs(dLdth_recompute), 1e-30);
      const rel = Math.abs(dLdth_extract - dLdth_recompute) / denom;
      assert.ok(rel < 1e-6,
        `central-difference of L vs dLdth from extract at index ${k}: ` +
        `recompute=${dLdth_recompute} extract=${dLdth_extract} rel=${rel} must be < 1e-6`);
    }
  });

  // -----------------------------------------------------------------------
  it("Schur path handles all three probe angles (3 dense Schur factors per extract, (m+1) RHS each)", function () {
    // Wave 5.4 C: extractCoeffs now goes through the Lagrange-augmented
    // Schur path. K_b' is factored ONCE at create-time (not per phi); per
    // phi we factor only the small dense -S(phi). Per phi we solve (m+1)
    // RHS — one magnetization-only + m unit-current — all reusing the same
    // K_b' factor and the same -S(phi) factor.
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const internals = slice.__internals;

    const prepBefore  = internals.schurPrepCount;
    const solveBefore = internals.schurSolveCount;
    slice.extractCoeffs(0.2);
    const prepDelta  = internals.schurPrepCount  - prepBefore;
    const solveDelta = internals.schurSolveCount - solveBefore;

    assert.strictEqual(prepDelta, 3,
      `extractCoeffs must prepare the dense Schur factor 3 times (one per angle); got ${prepDelta}`);
    assert.strictEqual(solveDelta, 3 * (m + 1),
      `extractCoeffs must call linearSchurSolve 3*(m+1)=${3 * (m + 1)} times; got ${solveDelta}`);
  });

  // -----------------------------------------------------------------------
  it("derivStep override is honored at the unit level (gapStampLog records actual angles)", function () {
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const internals = slice.__internals;
    const gapStampLog = internals.gapStampLog;

    // Override derivStep = Math.PI/360 at θ=0.3
    const prepBefore1 = internals.schurPrepCount;
    slice.extractCoeffs(0.3, { derivStep: Math.PI / 360 });
    const prepDelta1 = internals.schurPrepCount - prepBefore1;
    assert.strictEqual(gapStampLog.length, 3,
      `gapStampLog must record exactly 3 angles; got ${gapStampLog.length}: ${gapStampLog}`);
    const expectedOverride = [0.3 - Math.PI / 360, 0.3, 0.3 + Math.PI / 360];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(gapStampLog[i] - expectedOverride[i]) < 1e-12,
        `gapStampLog[${i}]=${gapStampLog[i]} must equal ${expectedOverride[i]}`);
    }
    assert.strictEqual(prepDelta1, 3,
      `Schur factor must be prepared exactly 3 times for the override extract; got ${prepDelta1}`);

    // Default derivStep — extract clears gapStampLog at the start of each call.
    const prepBefore2 = internals.schurPrepCount;
    slice.extractCoeffs(0.3);
    const prepDelta2 = internals.schurPrepCount - prepBefore2;
    assert.strictEqual(gapStampLog.length, 3,
      `gapStampLog must record exactly 3 angles in the default extract; got ${gapStampLog.length}: ${gapStampLog}`);
    const expectedDefault = [0.3 - Math.PI / 180, 0.3, 0.3 + Math.PI / 180];
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(gapStampLog[i] - expectedDefault[i]) < 1e-12,
        `gapStampLog[${i}]=${gapStampLog[i]} must equal default ${expectedDefault[i]}`);
    }
    assert.strictEqual(prepDelta2, 3,
      `Schur factor must be prepared exactly 3 times for the default extract; got ${prepDelta2}`);
  });
});

