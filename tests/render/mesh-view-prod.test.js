"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadMachine,
  sectionFromConfig,
  recordingCtx,
} = require("./_fixtures.js");

const MMV = LIB.MotorMeshView;
const MM = LIB.MotorMesh;

// Build a rotor/stator pair from a fixture config.
function meshOf(id, member) {
  const cfg = loadMachine(id);
  const section = sectionFromConfig(cfg);
  const physics = MM.physicsFromConfig(cfg);
  const built = MM.build(section, { physics });
  return built[member];
}

function ironElemCount(mesh) {
  let n = 0;
  for (let e = 0; e < mesh.elems.length / 4; e++) {
    if (mesh.materials[mesh.matId[e]].kind === "iron") n++;
  }
  return n;
}
function magnetElemCount(mesh) {
  let n = 0;
  for (let e = 0; e < mesh.elems.length / 4; e++) {
    if (mesh.materials[mesh.matId[e]].kind === "magnet") n++;
  }
  return n;
}
function conductorElemCount(mesh) {
  let n = 0;
  for (let e = 0; e < mesh.elems.length / 4; e++) {
    if (mesh.materials[mesh.matId[e]].kind === "conductor") n++;
  }
  return n;
}

describe("MotorMeshView production surface", () => {
  it("drawMaterial fills one polygon per element", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Ne = mesh.elems.length / 4;
    assert.ok(Ne > 0);
    const { ctx, log } = recordingCtx();
    MMV.drawMaterial(ctx, mesh, {});
    assert.strictEqual(log.filter(e => e.op === "fill").length, Ne);
  });

  it("drawFluxLines emits stroke calls proportional to levels", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Nn = mesh.nodes.length / 2;
    const Anode = new Float64Array(Nn);
    for (let n = 0; n < Nn; n++) {
      const x = mesh.nodes[2 * n], y = mesh.nodes[2 * n + 1];
      Anode[n] = Math.cos(2 * Math.atan2(y, x));
    }
    const levels = 8;
    const { ctx, log } = recordingCtx();
    MMV.drawFluxLines(ctx, mesh, Anode, { levels });
    const nStroke = log.filter(e => e.op === "stroke").length;
    assert.ok(nStroke >= levels - 1, `got ${nStroke} strokes, expected >= ${levels - 1}`);
    const Ne = mesh.elems.length / 4;
    assert.ok(nStroke <= levels * Ne, `got ${nStroke} strokes, expected <= ${levels * Ne}`);
  });

  it("drawFluxLines emits no strokes for a constant Anode", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Nn = mesh.nodes.length / 2;
    const Anode = new Float64Array(Nn).fill(1.0);
    const { ctx, log } = recordingCtx();
    MMV.drawFluxLines(ctx, mesh, Anode, { levels: 8 });
    assert.strictEqual(log.filter(e => e.op === "stroke").length, 0);
  });

  it("drawModulusB respects range:'auto' extent", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Ne = mesh.elems.length / 4;
    const mag = new Float64Array(Ne);
    for (let e = 0; e < Ne; e++) mag[e] = Ne > 1 ? e / (Ne - 1) : 0;
    const { ctx, log } = recordingCtx();
    MMV.drawModulusB(ctx, mesh, { mag }, { range: "auto" });
    const fills = log.filter(e => e.op === "set" && e.key === "fillStyle").map(e => e.value);
    const distinct = new Set(fills);
    assert.ok(distinct.size >= 2, `expected >= 2 distinct fillStyles, got ${distinct.size}`);
  });

  it("drawSaturation only shades iron elements", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Ne = mesh.elems.length / 4;
    const mag = new Float64Array(Ne).fill(1.0);
    const { ctx, log } = recordingCtx();
    MMV.drawSaturation(ctx, mesh, { mag }, {});
    const ironN = ironElemCount(mesh);
    assert.ok(ironN > 0, "pmsm rotor should have iron (back-iron)");
    assert.strictEqual(log.filter(e => e.op === "fill").length, ironN);
  });

  it("drawSaturation uses BkneeDefault when material.Bknee is null", () => {
    // Synthetic mesh whose only iron material has Bknee:null.
    const mesh = {
      member: "rotor",
      nodes: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]),
      elems: new Int32Array([0, 1, 2, 3]),
      matId: new Int32Array([1]),
      srcId: new Int32Array([-1]),
      turns: new Float64Array([0]),
      magDir: new Float64Array([0, 0]),
      materials: [
        { kind: "air", muR: 1, mrMag: 0, Bknee: null },
        { kind: "iron", muR: 1000, mrMag: 0, Bknee: null },
      ],
      gapLoop: new Int32Array(0),
      gapTheta: new Float64Array(0),
      gapR: 1,
    };
    const mag = new Float64Array([1.6]);
    const { ctx, log } = recordingCtx();
    MMV.drawSaturation(ctx, mesh, { mag }, {}); // BkneeDefault = 1.6 → ratio 1.0 → t 0.5
    const fills = log.filter(e => e.op === "set" && e.key === "fillStyle").map(e => e.value);
    assert.ok(fills.length >= 1);
    // mid-band viridis(0.5) === rgb(33,145,140)
    assert.strictEqual(fills[0], MMV.viridis(0.5));
    assert.strictEqual(fills[0], "rgb(33,145,140)");
  });

  it("drawMagnetization emits one arrow per magnet element", () => {
    const mesh = meshOf("pmsm", "rotor");
    const magN = magnetElemCount(mesh);
    assert.ok(magN > 0, "pmsm rotor should have magnet elements");
    const { ctx, log } = recordingCtx();
    MMV.drawMagnetization(ctx, mesh, {});
    const nLineTo = log.filter(e => e.op === "lineTo").length;
    assert.ok(nLineTo >= magN * 3, `got ${nLineTo} lineTo, expected >= ${magN * 3}`);
  });

  it("drawCurrentDensity emits one glyph per conductor element", () => {
    const mesh = meshOf("pmsm", "stator");
    const condN = conductorElemCount(mesh);
    assert.ok(condN > 0, "pmsm stator should have conductor elements");
    const currents = new Float64Array([5, -2.5, -2.5]);
    const { ctx, log } = recordingCtx();
    MMV.drawCurrentDensity(ctx, mesh, currents, {});
    assert.strictEqual(log.filter(e => e.op === "arc").length, condN);
  });

  it("drawCurrentDensity flips glyph with current sign", () => {
    const mesh = meshOf("pmsm", "stator");

    // The glyph for the first conductor element is the draw block immediately
    // following the first `arc` op (the disc). A dot is a `fillRect`; a cross
    // is `moveTo`/`lineTo` stroke segments. Capture that block for each sign.
    function firstGlyphKind(currents) {
      const { ctx, log } = recordingCtx();
      MMV.drawCurrentDensity(ctx, mesh, currents, {});
      // Find first arc (first conductor disc), then the block up to the next arc.
      let i0 = log.findIndex(e => e.op === "arc");
      assert.ok(i0 >= 0, "expected at least one conductor glyph");
      let i1 = log.findIndex((e, idx) => idx > i0 && e.op === "arc");
      if (i1 < 0) i1 = log.length;
      const block = log.slice(i0, i1);
      const hasFillRect = block.some(e => e.op === "fillRect");
      const hasLineTo   = block.some(e => e.op === "lineTo");
      return hasFillRect ? "dot" : (hasLineTo ? "cross" : "none");
    }

    // The first stator conductor element has a fixed turns sign; flipping the
    // current sign flips the net product sign and therefore the glyph.
    const kPos = firstGlyphKind(new Float64Array([5, 5, 5]));
    const kNeg = firstGlyphKind(new Float64Array([-5, -5, -5]));
    assert.notStrictEqual(kPos, "none");
    assert.notStrictEqual(kNeg, "none");
    assert.notStrictEqual(kPos, kNeg,
      `first-conductor glyph should flip with current sign (got ${kPos} vs ${kNeg})`);
  });
});
