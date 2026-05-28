"use strict";

// =============================================================================
//  LIB.MotorStack — FEA-native pipeline tests (Wave 5.3 rewrite).
//
//  Drives LIB.MotorStack exclusively through CS.expand(woundConfig | pmConfig |
//  salientConfig | skewN2Config) + feaOpts(); no grid-only tinySection /
//  makeExpanded / MotorCompile.compile scaffold. Every slice construction goes
//  through the real FEA path, so initSolver() must resolve before the first
//  stack is built.
// =============================================================================

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const {
  LIB,
  CS,
  initSolver,
  feaOpts,
  woundConfig,
} = require("./_fixtures.js");

describe("motor-stack", function () {
  before(async function () {
    await initSolver();
  });

  // -------------------------------------------------------------------------
  it("N=1 stack equals its single slice", function () {
    const cfg = woundConfig({ stack: { slices: 1 } });
    const expanded = CS.expand(cfg);
    const stack = LIB.MotorStack.create(expanded, feaOpts());

    const stackResult = stack.solve(0.2, new Float64Array([5]));

    // Single independent slice built from the same expanded section + poles.
    const refSlice = LIB.MotorSlice.create(
      expanded.slices[0].section,
      feaOpts({ poles: expanded.poles })
    );
    const refResult = refSlice.solve(0.2, new Float64Array([5]));

    assert.ok(Number.isFinite(stackResult.torque), "stack torque must be finite");
    const denom = Math.max(Math.abs(stackResult.torque), Math.abs(refResult.torque), 1e-30);
    const rel = Math.abs(stackResult.torque - refResult.torque) / denom;
    assert.ok(
      rel < 1e-9,
      "N=1 stack torque must equal single slice torque within 1e-9 relative; got rel=" +
        rel + " (stack=" + stackResult.torque + ", slice=" + refResult.torque + ")"
    );
  });

  // -------------------------------------------------------------------------
  it("N=2 zero-offset sums torque and flux", function () {
    const stack_n1 = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 1 } })),
      feaOpts()
    );
    const stack_n2 = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 2, sliceOffsets: [0, 0] } })),
      feaOpts()
    );

    const r1 = stack_n1.solve(0.2, new Float64Array([5]));
    const r2 = stack_n2.solve(0.2, new Float64Array([5]));

    const tDenom = Math.max(Math.abs(r2.torque), Math.abs(2 * r1.torque), 1e-30);
    const tRel = Math.abs(r2.torque - 2 * r1.torque) / tDenom;
    assert.ok(
      tRel < 1e-9,
      "N=2 zero-offset torque must equal 2× single-slice torque within 1e-9 relative; got rel=" +
        tRel + " (r2=" + r2.torque + ", 2·r1=" + 2 * r1.torque + ")"
    );

    const fDenom = Math.max(Math.abs(r2.fluxLinkages[0]), Math.abs(2 * r1.fluxLinkages[0]), 1e-30);
    const fRel = Math.abs(r2.fluxLinkages[0] - 2 * r1.fluxLinkages[0]) / fDenom;
    assert.ok(
      fRel < 1e-9,
      "N=2 zero-offset fluxLinkages[0] must equal 2× single-slice value within 1e-9 relative; got rel=" +
        fRel + " (r2=" + r2.fluxLinkages[0] + ", 2·r1=" + 2 * r1.fluxLinkages[0] + ")"
    );
  });

  // -------------------------------------------------------------------------
  it("non-zero slice offset produces a different torque", function () {
    // woundConfig has a salient 2-tooth rotor: the field is angularly
    // asymmetric, so a rotor-angle offset shifts the second slice's torque.
    const stackZero = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 2, sliceOffsets: [0, 0] } })),
      feaOpts()
    );
    const stackOff = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 2, sliceOffsets: [0, 0.4] } })),
      feaOpts()
    );

    const rZero = stackZero.solve(0.2, new Float64Array([5]));
    const rOff = stackOff.solve(0.2, new Float64Array([5]));

    assert.ok(
      Math.abs(rOff.torque - rZero.torque) > 1e-9,
      "non-zero slice offset must produce a different torque (offset is applied); " +
        "zero=" + rZero.torque + " off=" + rOff.torque
    );
  });

  // -------------------------------------------------------------------------
  it("perSliceField length equals nSlices", function () {
    for (const N of [1, 2, 3]) {
      const offsets = new Array(N).fill(0);
      const stack = LIB.MotorStack.create(
        CS.expand(woundConfig({ stack: { slices: N, sliceOffsets: offsets } })),
        feaOpts()
      );
      const r = stack.solve(0.0, new Float64Array([5]));
      assert.strictEqual(
        r.perSliceField.length,
        N,
        "perSliceField.length must equal nSlices=" + N
      );
      assert.strictEqual(stack.nSlices, N, "stack.nSlices must equal " + N);
    }
  });

  // -------------------------------------------------------------------------
  it("coenergyTorque returns finite parts", function () {
    const stack = LIB.MotorStack.create(CS.expand(woundConfig()), feaOpts());

    const coe = stack.coenergyTorque(0.2, new Float64Array([5]));

    assert.ok(Number.isFinite(coe.reluctance), "coe.reluctance must be finite");
    assert.ok(Number.isFinite(coe.pm), "coe.pm must be finite");
    assert.ok(Number.isFinite(coe.mutual), "coe.mutual must be finite");
    assert.ok(Number.isFinite(coe.cogging), "coe.cogging must be finite");
    assert.ok(Number.isFinite(coe.total), "coe.total must be finite");

    const sum = coe.reluctance + coe.mutual + coe.pm + coe.cogging;
    assert.ok(
      Math.abs(coe.total - sum) < 1e-12,
      "total must equal reluctance + mutual + pm + cogging within 1e-12; total=" +
        coe.total + " sum=" + sum
    );
  });

  // -------------------------------------------------------------------------
  it("extractCoeffs returns correct-length arrays all finite", function () {
    const expanded = CS.expand(woundConfig());
    const m = expanded.nCircuits;
    const stack = LIB.MotorStack.create(expanded, feaOpts());

    const coeffs = stack.extractCoeffs(0.2);

    assert.strictEqual(coeffs.L.length, m * m, "L length must be nCircuits²");
    assert.strictEqual(coeffs.dLdth.length, m * m, "dLdth length must be nCircuits²");
    assert.strictEqual(coeffs.lambdaPm.length, m, "lambdaPm length must be nCircuits");
    assert.strictEqual(coeffs.dLambdaPmdth.length, m, "dLambdaPmdth length must be nCircuits");

    for (let i = 0; i < m * m; i++) {
      assert.ok(Number.isFinite(coeffs.L[i]), "L[" + i + "] must be finite");
      assert.ok(Number.isFinite(coeffs.dLdth[i]), "dLdth[" + i + "] must be finite");
    }
    for (let k = 0; k < m; k++) {
      assert.ok(Number.isFinite(coeffs.lambdaPm[k]), "lambdaPm[" + k + "] must be finite");
      assert.ok(Number.isFinite(coeffs.dLambdaPmdth[k]), "dLambdaPmdth[" + k + "] must be finite");
    }
  });

  // -------------------------------------------------------------------------
  it("module loads under require with no DOM access", function () {
    assert.ok(LIB.MotorStack, "LIB.MotorStack must exist");
    assert.strictEqual(typeof LIB.MotorStack.create, "function", "create must be a function");

    const stack = LIB.MotorStack.create(CS.expand(woundConfig()), feaOpts());

    assert.strictEqual(typeof stack.solve, "function");
    assert.strictEqual(typeof stack.extractCoeffs, "function");
    assert.strictEqual(typeof stack.coenergyTorque, "function");
    assert.strictEqual(typeof stack.sliceMesh, "function");
    assert.strictEqual(typeof stack.clearWarmStart, "function");
    assert.strictEqual(typeof stack.sliceGrid, "undefined", "sliceGrid must no longer exist");
    assert.ok(typeof stack.nCircuits === "number");
    assert.ok(typeof stack.nSlices === "number");
  });

  // -------------------------------------------------------------------------
  it("nCircuits mismatch throws descriptive error", function () {
    // woundConfig produces a single-circuit section. Force the expanded
    // object's global nCircuits to 2 while every slice's section still
    // produces nCircuits=1 — the global-index guarantee is violated.
    const expanded = CS.expand(woundConfig({ stack: { slices: 1 } }));
    const badExpanded = Object.assign({}, expanded, { nCircuits: 2 });

    assert.throws(
      function () { LIB.MotorStack.create(badExpanded, feaOpts()); },
      /nCircuits/,
      "create must throw when slice nCircuits mismatches global nCircuits"
    );
  });

  // -------------------------------------------------------------------------
  it("clearWarmStart resets all slices without error", function () {
    const stack = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 2, sliceOffsets: [0, 0] } })),
      feaOpts()
    );

    // Populate the warm-start cache with one solve.
    stack.solve(0.2, new Float64Array([5]));
    assert.doesNotThrow(function () { stack.clearWarmStart(); });

    // Solve again after clear — still works.
    const r = stack.solve(0.2, new Float64Array([5]));
    assert.ok(Number.isFinite(r.torque), "torque must be finite after clearWarmStart");
  });

  // -------------------------------------------------------------------------
  it("sliceMesh returns rotor and stator BodyMeshes for each slice", function () {
    const stack = LIB.MotorStack.create(
      CS.expand(woundConfig({ stack: { slices: 2, sliceOffsets: [0, 0.1] } })),
      feaOpts()
    );

    for (let k = 0; k < 2; k++) {
      const m = stack.sliceMesh(k);
      assert.ok(m && typeof m === "object", "sliceMesh(" + k + ") must return an object");
      for (const role of ["rotor", "stator"]) {
        const body = m[role];
        assert.ok(body && typeof body === "object",
          "sliceMesh(" + k + ")." + role + " must be a BodyMesh object");
        // Phase-2 BodyMesh contract fields.
        assert.ok(body.nodes instanceof Float64Array,
          role + " nodes must be a Float64Array");
        assert.ok(body.elems instanceof Int32Array,
          role + " elems must be an Int32Array");
        assert.ok(body.matId instanceof Int32Array,
          role + " matId must be an Int32Array");
        assert.ok(body.srcId instanceof Int32Array,
          role + " srcId must be an Int32Array");
        assert.ok(body.turns instanceof Float64Array,
          role + " turns must be a Float64Array");
        assert.ok(body.magDir instanceof Float64Array,
          role + " magDir must be a Float64Array");
        assert.ok(Array.isArray(body.materials),
          role + " materials must be an Array");
        assert.ok(body.gapLoop instanceof Int32Array,
          role + " gapLoop must be an Int32Array");
        assert.ok(body.gapTheta instanceof Float64Array,
          role + " gapTheta must be a Float64Array");
        assert.strictEqual(typeof body.gapR, "number",
          role + " gapR must be a number");
        assert.strictEqual(typeof body.sig, "string",
          role + " sig must be a string");
      }
    }
  });
});
