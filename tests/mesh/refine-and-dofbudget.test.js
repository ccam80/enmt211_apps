"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  singleAnnulusSection,
  ringStackSection,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;

// ---------------------------------------------------------------------------
//  refine:0.5 roughly halves element count vs refine:1
// ---------------------------------------------------------------------------

describe("refine:0.5 halves element count", () => {
  it("rotor element count at refine:0.5 is <= 0.75x count at refine:1", () => {
    const section = ringStackSection();
    const { rotor: r1 } = MotorMesh.build(section, { refine: 1 });
    const { rotor: r05 } = MotorMesh.build(section, { refine: 0.5 });
    const ne1  = r1.elems.length / 4;
    const ne05 = r05.elems.length / 4;
    assert.ok(
      ne05 <= ne1 * 0.75,
      `refine:0.5 ne=${ne05} not <= 0.75 * refine:1 ne=${ne1}`
    );
    // Both must be valid meshes
    const q = MotorMesh.quality(r05);
    assert.strictEqual(q.nInverted,   0, `refine:0.5 rotor nInverted=${q.nInverted}`);
    assert.strictEqual(q.nDegenerate, 0, `refine:0.5 rotor nDegenerate=${q.nDegenerate}`);
  });
});

// ---------------------------------------------------------------------------
//  refine:2 roughly doubles element count vs refine:1
// ---------------------------------------------------------------------------

describe("refine:2 increases element count", () => {
  it("rotor element count at refine:2 is >= 1.5x count at refine:1", () => {
    const section = ringStackSection();
    const { rotor: r1 } = MotorMesh.build(section, { refine: 1 });
    const { rotor: r2 } = MotorMesh.build(section, { refine: 2 });
    const ne1 = r1.elems.length / 4;
    const ne2 = r2.elems.length / 4;
    assert.ok(
      ne2 >= ne1 * 1.5,
      `refine:2 ne=${ne2} not >= 1.5 * refine:1 ne=${ne1}`
    );
    const q = MotorMesh.quality(r2);
    assert.strictEqual(q.nInverted,   0, `refine:2 rotor nInverted=${q.nInverted}`);
    assert.strictEqual(q.nDegenerate, 0, `refine:2 rotor nDegenerate=${q.nDegenerate}`);
  });
});

// ---------------------------------------------------------------------------
//  refine clamped to [0.25, 4]: extreme values don't crash
// ---------------------------------------------------------------------------

describe("refine extremes are accepted without crash", () => {
  it("refine:0.1 (below floor) is treated as refine:0.25", () => {
    const section = singleAnnulusSection();
    // Should not throw
    const { rotor: rLow  } = MotorMesh.build(section, { refine: 0.1 });
    const { rotor: rFloor } = MotorMesh.build(section, { refine: 0.25 });
    const neLow   = rLow.elems.length / 4;
    const neFloor = rFloor.elems.length / 4;
    assert.strictEqual(neLow, neFloor,
      `refine:0.1 ne=${neLow} should equal refine:0.25 ne=${neFloor}`);
  });

  it("refine:10 (above ceiling) is treated as refine:4", () => {
    const section = singleAnnulusSection();
    const { rotor: rHigh }    = MotorMesh.build(section, { refine: 10 });
    const { rotor: rCeiling } = MotorMesh.build(section, { refine: 4 });
    const neHigh    = rHigh.elems.length / 4;
    const neCeiling = rCeiling.elems.length / 4;
    assert.strictEqual(neHigh, neCeiling,
      `refine:10 ne=${neHigh} should equal refine:4 ne=${neCeiling}`);
  });
});

// ---------------------------------------------------------------------------
//  dofBudget:2000 caps node count
// ---------------------------------------------------------------------------

describe("dofBudget:2000 caps node count", () => {
  it("Nn <= 2000 + P_body slack for both rotor and stator with ringStackSection", () => {
    const section = ringStackSection();
    const { rotor, stator } = MotorMesh.build(section, { dofBudget: 2000 });
    const rNn = rotor.nodes.length / 2;
    const sNn = stator.nodes.length / 2;

    // P_body for ringStackSection rotor = 4 (four magnets); stator = 4 (four conductors)
    // The dofBudget contract: Nn <= dofBudget + P_body
    const slack = 32; // generous: max P_body we'd expect for these fixtures
    assert.ok(
      rNn <= 2000 + slack,
      `rotor Nn=${rNn} exceeds dofBudget=2000 + slack=${slack}`
    );
    assert.ok(
      sNn <= 2000 + slack,
      `stator Nn=${sNn} exceeds dofBudget=2000 + slack=${slack}`
    );

    // Both meshes must still be valid
    const qr = MotorMesh.quality(rotor);
    const qs = MotorMesh.quality(stator);
    assert.strictEqual(qr.nInverted,   0, `rotor nInverted=${qr.nInverted}`);
    assert.strictEqual(qr.nDegenerate, 0, `rotor nDegenerate=${qr.nDegenerate}`);
    assert.strictEqual(qs.nInverted,   0, `stator nInverted=${qs.nInverted}`);
    assert.strictEqual(qs.nDegenerate, 0, `stator nDegenerate=${qs.nDegenerate}`);
  });

  it("budgeted mesh has fewer nodes than unbudgeted at refine:4", () => {
    // At refine:4 the unbudgeted mesh is large; dofBudget:2000 must reduce it.
    const section = ringStackSection();
    const { rotor: rFull } = MotorMesh.build(section, { refine: 4 });
    const { rotor: rBudg } = MotorMesh.build(section, { refine: 4, dofBudget: 2000 });
    const nnFull = rFull.nodes.length / 2;
    const nnBudg = rBudg.nodes.length / 2;
    assert.ok(
      nnFull > 2000,
      `unbudgeted Nn=${nnFull} must exceed 2000 for this test to be meaningful`
    );
    assert.ok(
      nnBudg < nnFull,
      `budgeted Nn=${nnBudg} not < unbudgeted Nn=${nnFull}`
    );
  });
});

// ---------------------------------------------------------------------------
//  dofBudget produces Ne <= 2000 (element count, not node count)
// ---------------------------------------------------------------------------

describe("dofBudget:2000 produces Ne <= 2000", () => {
  it("element count for both bodies <= 2000 with dofBudget:2000 on singleAnnulusSection", () => {
    const section = singleAnnulusSection();
    const { rotor, stator } = MotorMesh.build(section, { dofBudget: 2000 });
    const rNe = rotor.elems.length / 4;
    const sNe = stator.elems.length / 4;
    // The budget is on nodes (Nn), but Ne ~ Nn for quad meshes.
    // Nn <= 2000+slack means Ne <= ~2000+slack too.
    const slack = 64;
    assert.ok(
      rNe <= 2000 + slack,
      `rotor Ne=${rNe} exceeds 2000 + slack`
    );
    assert.ok(
      sNe <= 2000 + slack,
      `stator Ne=${sNe} exceeds 2000 + slack`
    );
  });
});
