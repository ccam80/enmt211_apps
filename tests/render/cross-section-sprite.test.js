"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LIB,
  CS,
  loadMachine,
  recordingCtx,
} = require("./_fixtures.js");

// Load the sprite lib (not loaded by _fixtures.js yet).
require("../../lib/cross-section-sprite.js");

const CSP = LIB.CrossSectionSprite;

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

// Extract features by member + kind from an expanded section.
function featuresOf(section, member, kind) {
  return section.features.filter(function (f) {
    return f.member === member && f.kind === kind;
  });
}

// Build a synthetic conductor feature for winding tests.
function syntheticConductor(turns, circuit, rRange, thetaRange) {
  rRange    = rRange    || [0.030, 0.050];
  thetaRange = thetaRange || [0, Math.PI / 8];
  circuit   = circuit   != null ? circuit : 0;
  return { kind: "conductor", member: "stator", rRange, thetaRange, circuit, turns };
}

// ---------------------------------------------------------------------------
//  Task T3.1.1: Sprite geometry tests
// ---------------------------------------------------------------------------

describe("cross-section-sprite geometry", function () {

  it("drawIron draws one closed sector per tooth", function () {
    loadMachine("vr-stepper");
    const expanded = CS.expand(loadMachine("vr-stepper"));
    const section  = expanded.slices[0].section;
    const ironFeats = featuresOf(section, "rotor", "iron");

    // VR stepper rotor has teeth:8, so 8 iron features.
    assert.strictEqual(ironFeats.length, 8,
      "expected 8 rotor iron features from vr-stepper (teeth:8)");

    const { ctx, log } = recordingCtx();
    CSP.drawIron(ctx, ironFeats, { gapEdge: "outer" });

    const closePaths = log.filter(function (e) { return e.op === "closePath"; });
    assert.strictEqual(closePaths.length, ironFeats.length,
      "expected one closePath per iron feature");
  });

  it("a full-annulus iron feature draws a ring, not a flared tooth", function () {
    const TWO_PI = 2 * Math.PI;
    const feat = {
      kind: "iron", member: "rotor",
      rRange: [0.02, 0.035],
      thetaRange: [0, TWO_PI],
    };

    const { ctx, log } = recordingCtx();
    CSP.drawIron(ctx, [feat], { gapEdge: "outer" });

    const closePaths = log.filter(function (e) { return e.op === "closePath"; });
    assert.strictEqual(closePaths.length, 1, "expected exactly one closePath for full-annulus");

    const arcs = log.filter(function (e) { return e.op === "arc"; });
    assert.ok(arcs.length >= 2, "expected at least two arc ops (outer + inner ring)");

    // Neither arc should use lineTo before the closePath for vertex flare.
    // A plain ring has exactly 2 arcs and no lineTo ops inside the path.
    const lineTos = log.filter(function (e) { return e.op === "lineTo"; });
    assert.strictEqual(lineTos.length, 0,
      "full-annulus ring must not have extra angular lineTo vertices (no flare)");
  });

  it("drawMagnet shades N and S poles distinctly", function () {
    const cfg      = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const section  = expanded.slices[0].section;
    const magFeats = featuresOf(section, "rotor", "magnet");

    // pmsm has 8 magnets (alternating Mr sign).
    assert.ok(magFeats.length > 0, "expected magnet features from pmsm");

    // Disable labels so only disc fills appear.
    const { ctx, log } = recordingCtx();
    CSP.drawMagnet(ctx, magFeats, { label: false });

    const fillStyles = log
      .filter(function (e) { return e.op === "set" && e.key === "fillStyle"; })
      .map(function (e) { return e.value; });

    const distinct = new Set(fillStyles);
    assert.strictEqual(distinct.size, 2,
      "expected exactly two distinct fillStyle values (N fill + S fill)");

    // Each magnet gets exactly one fill call.
    const fills = log.filter(function (e) { return e.op === "fill"; });
    assert.strictEqual(fills.length, magFeats.length,
      "expected one fill per magnet feature");
  });

  it("drawMagnetArrows emits one arrow per magnet", function () {
    const cfg      = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const section  = expanded.slices[0].section;
    const magFeats = featuresOf(section, "rotor", "magnet");

    const magnetCount = magFeats.length;
    assert.ok(magnetCount > 0, "expected magnet features from pmsm");

    const { ctx, log } = recordingCtx();
    CSP.drawMagnetArrows(ctx, magFeats, {});

    const lineTos = log.filter(function (e) { return e.op === "lineTo"; });
    // Each arrow: shaft + two head segments = 3 lineTo ops minimum per magnet.
    assert.ok(lineTos.length >= magnetCount * 3,
      "expected >= magnetCount * 3 lineTo ops (shaft + two head segments per arrow); " +
      "got " + lineTos.length + " for " + magnetCount + " magnets");
  });

  it("drawShaftAndGap draws a shaft disc and a gap ring", function () {
    const { ctx, log } = recordingCtx();
    CSP.drawShaftAndGap(ctx,
      { shaftR: 0.02, gapInnerR: 0.042, gapOuterR: 0.044 },
      {});

    // At least one fill (shaft disc) and at least one stroke (gap ring arcs).
    const fills   = log.filter(function (e) { return e.op === "fill"; });
    const strokes = log.filter(function (e) { return e.op === "stroke"; });
    assert.ok(fills.length >= 1,  "expected at least one fill for the shaft disc");
    assert.ok(strokes.length >= 1, "expected at least one stroke for the gap ring");

    // The arc radii must include 0.02 and either 0.042 or 0.044.
    const arcRadii = log
      .filter(function (e) { return e.op === "arc"; })
      .map(function (e) { return e.args[2]; });

    assert.ok(arcRadii.some(function (r) { return Math.abs(r - 0.02) < 1e-9; }),
      "expected arc radius 0.02 (shaft)");
    assert.ok(
      arcRadii.some(function (r) { return Math.abs(r - 0.042) < 1e-9; }) ||
      arcRadii.some(function (r) { return Math.abs(r - 0.044) < 1e-9; }),
      "expected arc radius 0.042 or 0.044 (gap ring)"
    );
  });

  it("is machine-agnostic and DOM-free", function () {
    const SPRITE_PATH = path.resolve(__dirname, "../../lib/cross-section-sprite.js");
    const text = fs.readFileSync(SPRITE_PATH, "utf8").toLowerCase();

    const MACHINE_NAMES = [
      "bldc", "pmsm", "srm", "squirrel", "stepper",
      "brushed", "universal-motor", "wound-field",
    ];
    for (const name of MACHINE_NAMES) {
      assert.strictEqual(text.indexOf(name), -1,
        "cross-section-sprite.js must not reference machine name '" + name + "'");
    }
    assert.strictEqual(text.indexOf("document."), -1,
      "cross-section-sprite.js must not access document");
  });

});

// ---------------------------------------------------------------------------
//  Task T3.1.2: Sprite winding tests
// ---------------------------------------------------------------------------

describe("cross-section-sprite windings", function () {

  it("distributed slot draws up to Ndist discrete wires", function () {
    const cfg      = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const section  = expanded.slices[0].section;
    // Stator W conductors (element W = distributed).
    const condFeats = featuresOf(section, "stator", "conductor");
    assert.ok(condFeats.length > 0, "expected stator conductor features from pmsm");

    const Ndist = 8;
    const { ctx, log } = recordingCtx();
    CSP.drawWinding(ctx, condFeats, "distributed", { Ndist });

    // Each slot should draw exactly Ndist disc arcs (turns:20 >= 8).
    const arcOps = log.filter(function (e) { return e.op === "arc"; });
    assert.strictEqual(arcOps.length, condFeats.length * Ndist,
      "expected condFeats.length * Ndist arc ops total");
  });

  it("distributed wire count tracks small turn counts", function () {
    const feat = syntheticConductor(3, 0);
    const { ctx, log } = recordingCtx();
    CSP.drawWinding(ctx, [feat], "distributed", { Ndist: 8 });

    const arcOps = log.filter(function (e) { return e.op === "arc"; });
    assert.strictEqual(arcOps.length, 3,
      "expected exactly 3 disc arc ops for turns:3");
  });

  it("concentrated coil draws a widening bundle", function () {
    const feat = syntheticConductor(11, 0);
    const Nconc = 10;
    const { ctx, log } = recordingCtx();
    CSP.drawWinding(ctx, [feat], "concentrated", { Nconc, showCurrentGlyph: false });

    // 10 disc arcs (cap at Nconc).
    const arcOps = log.filter(function (e) { return e.op === "arc"; });
    assert.strictEqual(arcOps.length, Nconc,
      "expected exactly Nconc=10 disc arc ops");

    // Collect the wire radius argument (3rd arg of arc).
    const radii = arcOps.map(function (e) { return e.args[2]; });

    // Radii must be non-decreasing (outer wires are wider).
    for (let i = 1; i < radii.length; i++) {
      assert.ok(radii[i] >= radii[i - 1] - 1e-12,
        "radii must be non-decreasing; got " + radii[i - 1] + " then " + radii[i]);
    }

    // At least two distinct radii (9 base + 1 wider).
    const distinct = new Set(radii.map(function (r) { return r.toFixed(10); }));
    assert.ok(distinct.size >= 2,
      "expected at least two distinct wire radii (9 base + 1 wider)");
  });

  it("wire polarity glyph flips with sign", function () {
    const posFeature = syntheticConductor(+5, 0);
    const negFeature = syntheticConductor(-5, 0);

    function glyphKind(feat) {
      const { ctx, log } = recordingCtx();
      CSP.drawWinding(ctx, [feat], "distributed", { Ndist: 1 });
      // For a single disc: look for fillRect (dot) or lineTo (cross) after the arc.
      const hasFillRect = log.some(function (e) { return e.op === "fillRect"; });
      const hasLineTo   = log.some(function (e) { return e.op === "lineTo"; });
      return hasFillRect ? "dot" : (hasLineTo ? "cross" : "none");
    }

    const posKind = glyphKind(posFeature);
    const negKind = glyphKind(negFeature);

    assert.notStrictEqual(posKind, "none", "positive turns should produce a glyph");
    assert.notStrictEqual(negKind, "none", "negative turns should produce a glyph");
    assert.notStrictEqual(posKind, negKind,
      "glyph kind must differ between positive and negative turns; got " +
      posKind + " and " + negKind);
  });

  it("current sign drives the live glyph when showCurrentGlyph", function () {
    // turns:+5, current:-1 => net negative => into-page glyph (cross).
    const feat = syntheticConductor(+5, 0);
    const { ctx, log } = recordingCtx();
    CSP.drawWinding(ctx, [feat], "distributed",
      { Ndist: 1, showCurrentGlyph: true, currents: [-1] });

    const hasFillRect = log.some(function (e) { return e.op === "fillRect"; });
    const hasLineTo   = log.some(function (e) { return e.op === "lineTo"; });

    // Net sign: turns * current = +5 * -1 = -5 < 0 => cross (into page).
    assert.ok(hasLineTo && !hasFillRect,
      "expected cross glyph (into page) when turns>0 and current<0");
  });

  it("phase color cycles by circuit index", function () {
    const feat0 = syntheticConductor(1, 0);
    const feat1 = syntheticConductor(1, 1);

    const { ctx, log } = recordingCtx();
    // Use Ndist:1 to draw one wire per feature for clarity.
    CSP.drawWinding(ctx, [feat0, feat1], "distributed", { Ndist: 1 });

    // Collect fillStyle values set before each arc (disc fill).
    const fillStyles = log
      .filter(function (e) { return e.op === "set" && e.key === "fillStyle"; })
      .map(function (e) { return e.value; });

    // Must have at least two distinct colors (one per circuit).
    assert.ok(fillStyles.length >= 2, "expected at least two fillStyle assignments");
    assert.notStrictEqual(fillStyles[0], fillStyles[fillStyles.length - 1],
      "circuit 0 and circuit 1 should use different palette colors");
  });

});
