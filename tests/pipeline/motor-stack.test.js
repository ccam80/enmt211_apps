"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  LIB,
  assertClose,
  tinySection,
  woundConfig,
  UnifiedMotor,
} = require("./_fixtures.js");

const CS = UnifiedMotor.ConfigSchema;

// ---------------------------------------------------------------------------
//  Helper: build a minimal expanded-style object with N slices of the same
//  section (no dependence on config-schema for unit tests).
// ---------------------------------------------------------------------------
function makeExpanded(section, nSlices, offsets) {
  offsets = offsets || new Array(nSlices).fill(0);
  const slices = offsets.map(function (off) {
    return { section: section, offset: off };
  });
  // Compile once to get nCircuits
  const compiled = LIB.MotorCompile.compile(section);
  return {
    nCircuits: compiled.nCircuits,
    slices: slices,
  };
}

describe("motor-stack", function () {
  // -------------------------------------------------------------------------
  it("N=1 stack equals its single slice", function () {
    const section = tinySection({ withIron: true });
    const expanded = makeExpanded(section, 1, [0]);
    const stack = LIB.MotorStack.create(expanded);

    const currents = new Float64Array([5]);
    const stackResult = stack.solve(0.2, currents);

    // Single independent slice for reference
    const refSlice = LIB.MotorSlice.create(section);
    const refResult = refSlice.solve(0.2, currents);

    assert.ok(
      Number.isFinite(stackResult.torque),
      "stack torque must be finite"
    );
    assertClose(
      stackResult.torque,
      refResult.torque,
      1e-9,
      "N=1 stack torque must equal single slice torque"
    );
  });

  // -------------------------------------------------------------------------
  it("N=2 zero-offset sums torque and flux", function () {
    const section = tinySection({ withIron: true });

    const singleExpanded = makeExpanded(section, 1, [0]);
    const doubleExpanded = makeExpanded(section, 2, [0, 0]);

    const stack1 = LIB.MotorStack.create(singleExpanded);
    const stack2 = LIB.MotorStack.create(doubleExpanded);

    const currents = new Float64Array([5]);
    const r1 = stack1.solve(0.2, currents);
    const r2 = stack2.solve(0.2, currents);

    assertClose(
      r2.torque,
      2 * r1.torque,
      1e-9,
      "N=2 zero-offset torque must equal 2× single-slice torque"
    );
    assertClose(
      r2.fluxLinkages[0],
      2 * r1.fluxLinkages[0],
      1e-9,
      "N=2 zero-offset fluxLinkages[0] must equal 2× single-slice value"
    );
  });

  // -------------------------------------------------------------------------
  it("offset changes torque", function () {
    // Use woundConfig (salient 2-tooth rotor) so the field is angularly
    // asymmetric and a rotor-angle offset produces a measurably different torque.
    const cfgZero = woundConfig();
    cfgZero.stack = { slices: 2, sliceOffsets: [0, 0] };
    const cfgOff = woundConfig();
    cfgOff.stack = { slices: 2, sliceOffsets: [0, 0.4] };

    const stackZero = LIB.MotorStack.create(CS.expand(cfgZero));
    const stackOff  = LIB.MotorStack.create(CS.expand(cfgOff));

    const currents = new Float64Array([5]);
    const rZero = stackZero.solve(0.2, currents);
    const rOff  = stackOff.solve(0.2, currents);

    assert.ok(
      Math.abs(rOff.torque - rZero.torque) > 1e-9,
      "non-zero slice offset must produce a different torque (offset is applied)"
    );
  });

  // -------------------------------------------------------------------------
  it("perSliceField length equals nSlices", function () {
    const section = tinySection({ withIron: true });

    for (const nSlices of [1, 2, 3]) {
      const expanded = makeExpanded(section, nSlices);
      const stack = LIB.MotorStack.create(expanded);
      const currents = new Float64Array([5]);
      const r = stack.solve(0.0, currents);
      assert.strictEqual(
        r.perSliceField.length,
        nSlices,
        "perSliceField.length must equal nSlices=" + nSlices
      );
      assert.strictEqual(stack.nSlices, nSlices, "stack.nSlices must equal " + nSlices);
    }
  });

  // -------------------------------------------------------------------------
  it("coenergyTorque returns finite parts", function () {
    const section = tinySection({ withIron: true });
    const expanded = makeExpanded(section, 1, [0]);
    const stack = LIB.MotorStack.create(expanded);

    const currents = new Float64Array([5]);
    const coe = stack.coenergyTorque(0.2, currents);

    assert.ok(Number.isFinite(coe.reluctance), "coe.reluctance must be finite");
    assert.ok(Number.isFinite(coe.pm), "coe.pm must be finite");
    assert.ok(Number.isFinite(coe.mutual), "coe.mutual must be finite");
    assert.ok(Number.isFinite(coe.cogging), "coe.cogging must be finite");
    assert.ok(Number.isFinite(coe.total), "coe.total must be finite");
    assertClose(
      coe.total,
      coe.reluctance + coe.mutual + coe.pm + coe.cogging,
      1e-12,
      "total must equal reluctance + mutual + pm + cogging"
    );
  });

  // -------------------------------------------------------------------------
  it("extractCoeffs returns correct-length arrays all finite", function () {
    const section = tinySection({ withIron: true });
    const compiled = LIB.MotorCompile.compile(section);
    const m = compiled.nCircuits;
    const expanded = makeExpanded(section, 1, [0]);
    const stack = LIB.MotorStack.create(expanded);

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
    // The module is already loaded; verify the API surface is present.
    assert.ok(LIB.MotorStack, "LIB.MotorStack must exist");
    assert.strictEqual(typeof LIB.MotorStack.create, "function", "create must be a function");

    const section = tinySection({ withIron: true });
    const expanded = makeExpanded(section, 1);
    const stack = LIB.MotorStack.create(expanded);

    assert.strictEqual(typeof stack.solve, "function");
    assert.strictEqual(typeof stack.extractCoeffs, "function");
    assert.strictEqual(typeof stack.coenergyTorque, "function");
    assert.strictEqual(typeof stack.sliceGrid, "function");
    assert.strictEqual(typeof stack.clearWarmStart, "function");
    assert.ok(typeof stack.nCircuits === "number");
    assert.ok(typeof stack.nSlices === "number");
  });

  // -------------------------------------------------------------------------
  it("nCircuits mismatch throws descriptive error", function () {
    // Build two sections with different nCircuits by using different turn counts
    const section1 = tinySection({ withIron: true, turns: 10 });

    // Build a second section with 2 circuits by adding a second conductor with circuit:1
    const section2 = JSON.parse(JSON.stringify(section1));
    section2.features.push({
      kind: "conductor",
      member: "stator",
      rRange: [0.047, 0.05],
      thetaRange: [Math.PI, Math.PI + Math.PI / 12],
      circuit: 1,
      turns: 10,
    });

    // Compile section2 to get its actual nCircuits
    const compiled2 = LIB.MotorCompile.compile(section2);
    assert.strictEqual(compiled2.nCircuits, 2, "section2 must have 2 circuits");

    // An expanded object claiming nCircuits=2 but using section1 (1 circuit) should throw
    const badExpanded = {
      nCircuits: 2,
      slices: [{ section: section1, offset: 0 }],
    };

    assert.throws(
      function () { LIB.MotorStack.create(badExpanded); },
      /nCircuits/,
      "create must throw when slice nCircuits mismatches global nCircuits"
    );
  });

  // -------------------------------------------------------------------------
  it("clearWarmStart resets all slices without error", function () {
    const section = tinySection({ withIron: true });
    const expanded = makeExpanded(section, 2, [0, 0]);
    const stack = LIB.MotorStack.create(expanded);

    const currents = new Float64Array([5]);
    // Populate warm-start cache with one solve
    stack.solve(0.2, currents);
    // Should not throw
    assert.doesNotThrow(function () { stack.clearWarmStart(); });
    // Solve again after clear — should still work
    const r = stack.solve(0.2, currents);
    assert.ok(Number.isFinite(r.torque), "torque must be finite after clearWarmStart");
  });

  // -------------------------------------------------------------------------
  it("sliceGrid returns correct grid fields for each slice", function () {
    const section = tinySection({ withIron: true });
    const expanded = makeExpanded(section, 2, [0, 0.1]);
    const stack = LIB.MotorStack.create(expanded);

    for (let k = 0; k < 2; k++) {
      const sg = stack.sliceGrid(k);
      assert.ok(typeof sg.Nr === "number" && sg.Nr > 0, "sliceGrid(" + k + ").Nr must be positive");
      assert.ok(typeof sg.Ntheta === "number" && sg.Ntheta > 0, "sliceGrid(" + k + ").Ntheta must be positive");
      assert.ok(typeof sg.rInner === "number", "sliceGrid(" + k + ").rInner must be a number");
      assert.ok(typeof sg.rOuter === "number", "sliceGrid(" + k + ").rOuter must be a number");
      assert.ok(sg.r instanceof Float64Array, "sliceGrid(" + k + ").r must be a Float64Array");
      assert.strictEqual(sg.r.length, sg.Nr, "sliceGrid(" + k + ").r.length must equal Nr");
    }
  });
});
