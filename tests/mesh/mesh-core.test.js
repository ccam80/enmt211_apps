"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  syntheticPhysics,
  singleAnnulusSection,
  ringStackSection,
  signedAreaOf,
  annulusArea,
  interiorEdgeSharing,
  assertClose,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  M0: struct shape
// ---------------------------------------------------------------------------

describe("M0 struct shape", () => {
  it("typed arrays have correct sizes and materials[0] is air", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });

    const Ne = rotor.elems.length / 4;
    const Nn = rotor.nodes.length / 2;

    assert.ok(Ne > 0, "should have elements");
    assert.ok(Nn > 0, "should have nodes");

    assert.strictEqual(rotor.nodes.length, 2 * Nn, "nodes.length === 2*Nn");
    assert.strictEqual(rotor.elems.length, 4 * Ne, "elems.length === 4*Ne");
    assert.strictEqual(rotor.matId.length,  Ne,    "matId.length === Ne");
    assert.strictEqual(rotor.srcId.length,  Ne,    "srcId.length === Ne");
    assert.strictEqual(rotor.turns.length,  Ne,    "turns.length === Ne");
    assert.strictEqual(rotor.magDir.length, 2 * Ne, "magDir.length === 2*Ne");

    // materials[0] is air
    assert.deepStrictEqual(rotor.materials[0], { kind: "air", muR: 1, mrMag: 0, Bknee: null });

    // Every material entry has a Bknee field
    for (const m of rotor.materials) {
      assert.ok("Bknee" in m, `material ${m.kind} is missing Bknee field`);
    }

    // sig is a non-empty string
    assert.strictEqual(typeof rotor.sig, "string");
    assert.ok(rotor.sig.length > 0, "sig must be non-empty");
  });
});

// ---------------------------------------------------------------------------
//  Bknee distinguishes otherwise-identical iron materials
// ---------------------------------------------------------------------------

describe("Bknee distinguishes otherwise-identical iron materials", () => {
  it("two iron features with same muR but different Bknee → two distinct materials", () => {
    const section = {
      features: [
        {
          kind: "iron",
          member: "rotor",
          rRange: [0.030, 0.037],
          thetaRange: [0, TWO_PI],
          muR: 1000,
          Bknee: 1.4,
        },
        {
          kind: "iron",
          member: "rotor",
          rRange: [0.037, 0.043],
          thetaRange: [0, TWO_PI],
          muR: 1000,
          Bknee: 1.8,
        },
        // Stator iron so gap geometry works
        {
          kind: "iron",
          member: "stator",
          rRange: [0.050, 0.060],
          thetaRange: [0, TWO_PI],
          muR: 500,
          Bknee: null,
        },
      ],
    };

    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });
    const ironMats = rotor.materials.filter(m => m.kind === "iron");
    assert.strictEqual(ironMats.length, 2, "two iron entries in materials[]");

    const bknees = ironMats.map(m => m.Bknee).sort((a, b) => a - b);
    assert.strictEqual(bknees[0], 1.4);
    assert.strictEqual(bknees[1], 1.8);
  });
});

// ---------------------------------------------------------------------------
//  M1: no inverted or degenerate elements
// ---------------------------------------------------------------------------

describe("M1 no inverted or degenerate elements", () => {
  it("single iron annulus has zero inverted and degenerate elements", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });
    const q = MotorMesh.quality(rotor);
    assert.strictEqual(q.nInverted, 0, `nInverted: ${q.nInverted}`);
    assert.strictEqual(q.nDegenerate, 0, `nDegenerate: ${q.nDegenerate}`);
  });
});

// ---------------------------------------------------------------------------
//  M1: total area equals annulus
// ---------------------------------------------------------------------------

describe("M1 total area equals annulus", () => {
  it("areaError < 1e-2 for single iron annulus", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });
    const q = MotorMesh.quality(rotor);
    assert.ok(q.areaError < 1e-2, `areaError ${q.areaError} >= 1e-2`);
  });
});

// ---------------------------------------------------------------------------
//  M1: near-90 degree quads
// ---------------------------------------------------------------------------

describe("M1 near-90 degree quads", () => {
  it("minAngle > 20 and maxAngle < 160 for single iron annulus", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { gapLayers: 3, physics: syntheticPhysics() });
    const q = MotorMesh.quality(rotor);
    assert.ok(q.minAngle > 20, `minAngle ${q.minAngle} <= 20`);
    assert.ok(q.maxAngle < 160, `maxAngle ${q.maxAngle} >= 160`);
  });
});

// ---------------------------------------------------------------------------
//  M2: rotor and stator nodes are disjoint
// ---------------------------------------------------------------------------

describe("M2 rotor and stator nodes are disjoint", () => {
  it("no (x,y) coordinate appears in both bodies", () => {
    const section = ringStackSection();
    const { rotor, stator } = MotorMesh.build(section, { physics: syntheticPhysics() });

    const rotorCoords = new Set();
    const Nn_r = rotor.nodes.length / 2;
    for (let n = 0; n < Nn_r; n++) {
      const x = rotor.nodes[2*n].toFixed(12);
      const y = rotor.nodes[2*n+1].toFixed(12);
      rotorCoords.add(`${x},${y}`);
    }

    const Nn_s = stator.nodes.length / 2;
    let sharedCount = 0;
    for (let n = 0; n < Nn_s; n++) {
      const x = stator.nodes[2*n].toFixed(12);
      const y = stator.nodes[2*n+1].toFixed(12);
      if (rotorCoords.has(`${x},${y}`)) sharedCount++;
    }

    assert.strictEqual(sharedCount, 0, `${sharedCount} shared nodes found between rotor and stator`);
  });
});

// ---------------------------------------------------------------------------
//  M2: conforming interfaces
//
//  Under the two-band architecture (inner per-feature section + gap-adjacent
//  uniform section), hanging nodes exist at the band transition by design.
//  Those hanging nodes are described by body.constraints.  Every other
//  interior edge must be shared by exactly two elements (i.e. no spurious
//  gaps or T-junctions outside the intentional constraint transition).
//
//  The principled test: any "bad edge" (interior edge referenced only once)
//  must involve at least one node that is a declared slave in body.constraints.
// ---------------------------------------------------------------------------

// Helper: set of slave node indices from body.constraints
function slaveSet(body) {
  if (!body.constraints || !body.constraints.slaves) return new Set();
  const s = new Set();
  for (let k = 0; k < body.constraints.slaves.length; k++) {
    s.add(body.constraints.slaves[k]);
  }
  return s;
}

describe("M2 conforming interfaces", () => {
  it("every bad interior edge involves a declared constraint slave (rotor, single annulus)", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });
    const result = interiorEdgeSharing(rotor);
    if (result.ok) return; // no bad edges — perfect conformity

    // Every bad edge must involve at least one slave node
    const slaves = slaveSet(rotor);
    for (const [a, b] of result.badEdges) {
      assert.ok(
        slaves.has(a) || slaves.has(b),
        `bad edge [${a},${b}] involves neither slave; non-constraint topology gap`
      );
    }
  });

  it("every bad interior edge involves a declared constraint slave (stator, ring stack)", () => {
    const section = ringStackSection();
    const { stator } = MotorMesh.build(section, { physics: syntheticPhysics() });
    const result = interiorEdgeSharing(stator);
    if (result.ok) return;

    const slaves = slaveSet(stator);
    for (const [a, b] of result.badEdges) {
      assert.ok(
        slaves.has(a) || slaves.has(b),
        `bad edge [${a},${b}] involves neither slave; non-constraint topology gap`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  M2: radial grading toward the gap
// ---------------------------------------------------------------------------

describe("M2 radial grading toward the gap", () => {
  it("layer adjacent to gap is finer than mid-yoke for rotor", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { gapLayers: 4, physics: syntheticPhysics() });

    // Collect unique radii
    const Nn = rotor.nodes.length / 2;
    const rSet = new Set();
    for (let n = 0; n < Nn; n++) {
      const r = Math.hypot(rotor.nodes[2*n], rotor.nodes[2*n+1]);
      rSet.add(Math.round(r * 1e10) / 1e10);
    }
    const rArr = Array.from(rSet).sort((a, b) => a - b);

    assert.ok(rArr.length >= 3, "need at least 3 radial lines for grading check");

    // Gap-adjacent spacing (last gap)
    const spaceNearGap = rArr[rArr.length - 1] - rArr[rArr.length - 2];
    // Mid-yoke spacing (first gap)
    const spaceMidYoke = rArr[1] - rArr[0];

    assert.ok(spaceNearGap < spaceMidYoke,
      `gap-adjacent spacing ${spaceNearGap} should be < mid-yoke spacing ${spaceMidYoke}`);
  });

  it("layer adjacent to gap is finer than mid-yoke for stator", () => {
    const section = singleAnnulusSection();
    const { stator } = MotorMesh.build(section, { gapLayers: 4, physics: syntheticPhysics() });

    const Nn = stator.nodes.length / 2;
    const rSet = new Set();
    for (let n = 0; n < Nn; n++) {
      const r = Math.hypot(stator.nodes[2*n], stator.nodes[2*n+1]);
      rSet.add(Math.round(r * 1e10) / 1e10);
    }
    const rArr = Array.from(rSet).sort((a, b) => a - b);

    assert.ok(rArr.length >= 3, "need at least 3 radial lines for grading check");

    // Stator: gap is at rMin side (inner bore), so gap-adjacent = first spacing
    const spaceNearGap = rArr[1] - rArr[0];
    // Mid-yoke = last spacing
    const spaceMidYoke = rArr[rArr.length - 1] - rArr[rArr.length - 2];

    assert.ok(spaceNearGap < spaceMidYoke,
      `gap-adjacent spacing ${spaceNearGap} should be < mid-yoke spacing ${spaceMidYoke}`);
  });
});
