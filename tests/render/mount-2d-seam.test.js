"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Ensure window exists before requiring mount.js (which reads window.UnifiedMotor).
require("./_fixtures.js");

const MOUNT_PATH = path.resolve(__dirname, "../../lessons/unified_motor/mount.js");

// Fresh-require mount.js with a clean UnifiedMotor namespace each time.
function freshMount() {
  delete window.UnifiedMotor;
  delete require.cache[MOUNT_PATH];
  require(MOUNT_PATH);
  return window.UnifiedMotor;
}

describe("mount.js 2-D-render seam", () => {
  it("mount.js exposes UM.CROSS_SECTION_2D and registerCrossSection2D", () => {
    const UM = freshMount();
    assert.strictEqual(UM.CROSS_SECTION_2D, null);
    assert.strictEqual(typeof UM.registerCrossSection2D, "function");
  });

  it("registerCrossSection2D stores the entry", () => {
    const UM = freshMount();
    UM.registerCrossSection2D({ paint: () => {} });
    assert.ok(UM.CROSS_SECTION_2D && typeof UM.CROSS_SECTION_2D.paint === "function");
  });

  it("UM.fieldViz initialized at mount.js load", () => {
    const UM = freshMount();
    assert.deepStrictEqual(UM.fieldViz, {
      fluxLines: true,
      modulusB: false,
      saturation: false,
      magnetization: false,
      currentDensity: false,
      gapLoop: false,
    });
  });

  it("the four legacy seams remain", () => {
    const UM = freshMount();
    assert.ok(Array.isArray(UM.PANELS));
    assert.ok(Array.isArray(UM.TOOLS));
    assert.ok(Array.isArray(UM.HEADER_CONTROLS));
    assert.strictEqual(UM.RENDER3D, null);
    assert.strictEqual(typeof UM.registerRender3D, "function");
  });

  it("mount.js no longer references the deleted built-in helpers", () => {
    const fs = require("fs");
    const text = fs.readFileSync(MOUNT_PATH, "utf8");
    const banned = [
      "featureColor", "fillSector2D", "drawFeatureSectors2D",
      "drawFeatureSectors3D", "fillSector3D", "drawSlotConductors3D",
      "drawRing3D", "ringPoints", "KIND_COLORS", "smoothedMagScale",
      "sliceGrid", ".perSliceField[", "field.Br", "field.Bt", "drawGapField",
    ];
    for (const sym of banned) {
      assert.strictEqual(text.indexOf(sym), -1, `mount.js still references '${sym}'`);
    }
  });
});
