"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  syntheticPhysics,
  singleAnnulusSection,
  recordingCtx,
} = require("./_fixtures.js");

const { MotorMesh, MotorMeshView } = LIB;

// ---------------------------------------------------------------------------
//  colorFor: distinct per kind
// ---------------------------------------------------------------------------

describe("colorFor distinct per kind", () => {
  it("returns four pairwise-distinct colors for air/iron/magnet/conductor", () => {
    const materials = [
      { kind: "air",       muR: 1,    mrMag: 0,   Bknee: null },
      { kind: "iron",      muR: 1000, mrMag: 0,   Bknee: null },
      { kind: "magnet",    muR: 1,    mrMag: 9e5,  Bknee: null },
      { kind: "conductor", muR: 1,    mrMag: 0,   Bknee: null },
    ];

    const colors = materials.map((_, idx) => MotorMeshView.colorFor(idx, materials));

    // All four must be non-empty strings
    for (const c of colors) {
      assert.strictEqual(typeof c, "string");
      assert.ok(c.length > 0, "color must be non-empty");
    }

    // All four must be pairwise distinct
    const colorSet = new Set(colors);
    assert.strictEqual(colorSet.size, 4, `Expected 4 distinct colors, got: ${JSON.stringify(colors)}`);
  });
});

// ---------------------------------------------------------------------------
//  draw: emits one polygon per element
// ---------------------------------------------------------------------------

describe("draw emits one polygon per element", () => {
  it("fill called exactly Ne times and beginPath at least Ne times with showGapLoop:false", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });

    const Ne = rotor.elems.length / 4;
    assert.ok(Ne > 0, "need at least one element");

    const ctx = recordingCtx();
    MotorMeshView.draw(ctx, rotor, { showGapLoop: false });

    assert.strictEqual(ctx._counts.fill, Ne, `fill called ${ctx._counts.fill} times, expected ${Ne}`);
    assert.ok(ctx._counts.beginPath >= Ne, `beginPath called ${ctx._counts.beginPath} times, expected >= ${Ne}`);
  });
});

// ---------------------------------------------------------------------------
//  draw: overlays gapLoop
// ---------------------------------------------------------------------------

describe("draw overlays gapLoop", () => {
  it("showGapLoop:true issues strictly more path operations than showGapLoop:false", () => {
    const section = singleAnnulusSection();
    const { rotor } = MotorMesh.build(section, { physics: syntheticPhysics() });

    const ctxNo = recordingCtx();
    MotorMeshView.draw(ctxNo, rotor, { showGapLoop: false });
    const totalNo = Object.values(ctxNo._counts).reduce((a, b) => a + b, 0);

    const ctxYes = recordingCtx();
    MotorMeshView.draw(ctxYes, rotor, { showGapLoop: true });
    const totalYes = Object.values(ctxYes._counts).reduce((a, b) => a + b, 0);

    assert.ok(totalYes > totalNo,
      `showGapLoop:true (${totalYes} ops) should emit more ops than showGapLoop:false (${totalNo} ops)`);
  });
});
