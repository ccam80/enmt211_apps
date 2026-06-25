"use strict";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
//  Headless harness — no DOM required for pure-logic tests.
//  document access lives only inside build() callbacks, not tested here.
//  The panel edits the canonical component form, so every fixture is converted
//  via ConfigSchema.toComponentConfig first (what the panel does on load).
// ---------------------------------------------------------------------------

if (!globalThis.window) globalThis.window = globalThis;

const ROOT = path.resolve(__dirname, "../..");

function guardedRequire(rel) {
  try {
    require(path.join(ROOT, rel));
  } catch (err) {
    if (err.code !== "MODULE_NOT_FOUND") throw err;
  }
}

guardedRequire("lib/util.js");
guardedRequire("lib/winding-model.js");
require(path.join(ROOT, "lessons/unified_motor/config-schema.js"));

// Load the pmsm fixture so we have a real config to work with.
require(path.join(ROOT, "lessons/unified_motor/machines/pmsm.js"));

const UM = window.UnifiedMotor;

// Capture the panel registered by geometry-panel.js.
let capturedPanel = null;
UM.registerPanel = function (entry) {
  capturedPanel = entry;
};

require(path.join(ROOT, "lessons/unified_motor/geometry-panel.js"));

const { applyGapLength, setSlices, defaultAxial, commitEdit } = UM.GeometryPanel;

// Helper: the pmsm config in canonical component form (what the panel edits).
function pmsmConfig() {
  const entry = UM.MACHINES.find(function (m) { return m.id === "pmsm"; });
  return UM.ConfigSchema.toComponentConfig(JSON.parse(JSON.stringify(entry.config)));
}

// Locate a ring's component by kind.
function comp(ring, kind) {
  return ring.components.find(function (c) { return c.kind === kind; });
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

test("applyGapLength sets a symmetric gap on an inrunner (pmsm)", function () {
  const cfg = pmsmConfig();
  // pmsm: inner (rotor) magnet hi = 0.042, outer (stator) winding lo = 0.044
  // mid0 = 0.043, g0 = 0.002
  const mid0 = 0.043;

  const achieved = applyGapLength(cfg, 0.003);

  assert.ok(Math.abs(achieved - 0.003) < 1e-9,
    "returned gap must be 0.003 ±1e-9, got " + achieved);

  // Inner body gap-facing surface = the magnet component's outer radius
  const mag = comp(cfg.rings[0], "magnet");
  assert.ok(Math.abs(mag.rRange[1] - (mid0 - 0.0015)) < 1e-9,
    "inner magnet rRange[1] must be mid0 - 0.0015 = " + (mid0 - 0.0015) + ", got " + mag.rRange[1]);

  // Outer body gap-facing surface = the winding component's bore (rRange + slotRRange)
  const wnd = comp(cfg.rings[1], "distributed-winding");
  assert.ok(Math.abs(wnd.rRange[0] - (mid0 + 0.0015)) < 1e-9,
    "outer winding rRange[0] must be mid0 + 0.0015 = " + (mid0 + 0.0015) + ", got " + wnd.rRange[0]);
  assert.ok(Math.abs(wnd.slotRRange[0] - (mid0 + 0.0015)) < 1e-9,
    "outer winding slotRRange[0] must be mid0 + 0.0015 = " + (mid0 + 0.0015) + ", got " + wnd.slotRRange[0]);

  // Mid-gap is unchanged
  const newMid = (mag.rRange[1] + wnd.rRange[0]) / 2;
  assert.ok(Math.abs(newMid - mid0) < 1e-9,
    "midpoint must be unchanged at " + mid0 + ", got " + newMid);
});

test("applyGapLength keeps the config valid and expandable", function () {
  const cfg = pmsmConfig();
  applyGapLength(cfg, 0.003);

  const v = UM.ConfigSchema.validate(cfg);
  assert.strictEqual(v.ok, true,
    "config must validate after applyGapLength: " + (v.errors || []).join("; "));

  let expanded;
  assert.doesNotThrow(function () {
    expanded = UM.ConfigSchema.expand(cfg);
  }, "expand must not throw after applyGapLength");

  assert.ok(expanded.gapBand.iOuter - expanded.gapBand.iInner >= 2,
    "gapBand must span >= 2 cells after applyGapLength");
});

test("applyGapLength is topology-agnostic for an outrunner (stator inner, rotor outer)", function () {
  // Stator is radially inside the rotor — the inner group must be detected as
  // the radially-inner body regardless of which one rotates.
  const cfg = UM.ConfigSchema.toComponentConfig({
    grid: { Nr: 20, Ntheta: 64, rInner: 0.02, rOuter: 0.06, ell: 0.05 },
    poles: 4,
    mechanical: { J: 1e-4 },
    rings: [
      { member: "stator", element: "I", rRange: [0.02, 0.030] },
      { member: "rotor",  element: "I", rRange: [0.034, 0.060] },
    ],
    circuits: [],
  });
  // The rotor (outer) rotates — motion must reflect the outrunner topology.
  assert.strictEqual(cfg.motion.outer, "rotating", "outer (rotor) body must rotate");
  assert.strictEqual(cfg.motion.inner, "static", "inner (stator) body must be static");

  // mid0 = (0.030 + 0.034) / 2 = 0.032, g0 = 0.004
  const achieved = applyGapLength(cfg, 0.006);

  assert.ok(Math.abs(achieved - 0.006) < 1e-9,
    "returned gap must be 0.006 ±1e-9, got " + achieved);

  // Inner group (member inner); its upper surface should move to mid0 - 0.003 = 0.029
  const innerIron = comp(cfg.rings[0], "iron");
  assert.ok(Math.abs(innerIron.rRange[1] - 0.029) < 1e-9,
    "inner iron rRange[1] must be 0.029, got " + innerIron.rRange[1]);

  // Outer group (member outer); its lower surface should move to mid0 + 0.003 = 0.035
  const outerIron = comp(cfg.rings[1], "iron");
  assert.ok(Math.abs(outerIron.rRange[0] - 0.035) < 1e-9,
    "outer iron rRange[0] must be 0.035, got " + outerIron.rRange[0]);
});

test("applyGapLength clamps the gap to keep >= 2.5 grid cells", function () {
  const cfg = pmsmConfig();
  // dr = (0.066 - 0.020) / 50 = 9.2e-4; gMin = 2.5 * 9.2e-4 = 2.3e-3
  const dr = (cfg.grid.rOuter - cfg.grid.rInner) / cfg.grid.Nr;
  const gMin = 2.5 * dr;

  const achieved = applyGapLength(cfg, 0);

  assert.ok(achieved >= gMin - 1e-12,
    "clamped gap must be >= 2.5*dr = " + gMin + ", got " + achieved);
});

test("setSlices grows slices and pads sliceOffsets, installing a default axial", function () {
  const cfg = { stack: { slices: 1, sliceOffsets: [0] } };
  setSlices(cfg, 2);

  assert.strictEqual(cfg.stack.slices, 2, "slices must be 2");
  assert.strictEqual(cfg.stack.sliceOffsets.length, 2, "sliceOffsets.length must be 2");
  assert.strictEqual(cfg.stack.sliceOffsets[1], 0, "new sliceOffset entry must be 0");

  const expected = defaultAxial();
  assert.deepStrictEqual(cfg.stack.axial, expected,
    "stack.axial must deep-equal defaultAxial()");
});

test("a slices>1 config with the default axial validates", function () {
  const cfg = pmsmConfig();
  setSlices(cfg, 2);

  const v = UM.ConfigSchema.validate(cfg);
  assert.strictEqual(v.ok, true,
    "config must validate at slices=2: " + (v.errors || []).join("; "));
  assert.strictEqual(cfg.stack.axial.loops.length, 1,
    "defaultAxial must have exactly 1 loop");
});

test("setSlices back to 1 drops stack.axial (bit-identical reduction)", function () {
  const cfg = pmsmConfig();
  setSlices(cfg, 2);
  setSlices(cfg, 1);

  assert.strictEqual(cfg.stack.slices, 1, "slices must be 1");
  assert.strictEqual(cfg.stack.sliceOffsets.length, 1, "sliceOffsets.length must be 1");
  assert.strictEqual(cfg.stack.axial, undefined, "stack.axial must be undefined");

  let expanded;
  assert.doesNotThrow(function () {
    expanded = UM.ConfigSchema.expand(cfg);
  }, "expand must not throw after setSlices back to 1");
  assert.strictEqual(expanded.axial, null,
    "expanded.axial must be null when slices === 1 and no axial netlist");
});

test("commitEdit applies and keeps the config valid", function () {
  const cfg = pmsmConfig();
  const iron = comp(cfg.rings[0], "iron"); // rotor back-iron component
  const idx = cfg.rings[0].components.indexOf(iron);
  const r = commitEdit(cfg, function (c) { c.rings[0].components[idx].muR = 500; });

  assert.strictEqual(r.ok, true, "commitEdit must return ok:true for a valid edit");
  assert.strictEqual(cfg.rings[0].components[idx].muR, 500, "muR must be 500 after commit");
});

test("commitEdit reverts an invalid edit in place and reports errors", function () {
  const cfg = pmsmConfig();
  const before = JSON.stringify(cfg);
  const ref = cfg;

  // Q=12 violates coilPitch (6) <= Q/p = 12/8 = 1.5
  const wnd = comp(cfg.rings[1], "distributed-winding");
  const idx = cfg.rings[1].components.indexOf(wnd);
  const r = commitEdit(cfg, function (c) { c.rings[1].components[idx].winding.standard.Q = 12; });

  assert.strictEqual(r.ok, false, "commitEdit must return ok:false for an invalid edit");
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0,
    "errors must be a non-empty array");
  assert.strictEqual(cfg, ref, "config object identity must be preserved");
  assert.strictEqual(JSON.stringify(cfg), before,
    "config must be fully reverted to its pre-edit state");
});

test("editing Q within range does not change the resolved circuit count", function () {
  const cfg = pmsmConfig();
  // Q=72 is valid: coilPitch=6 <= Q/p = 72/8 = 9
  const wnd = comp(cfg.rings[1], "distributed-winding");
  const idx = cfg.rings[1].components.indexOf(wnd);
  const r = commitEdit(cfg, function (c) { c.rings[1].components[idx].winding.standard.Q = 72; });

  assert.strictEqual(r.ok, true, "commitEdit must return ok:true for Q=72");

  let expanded;
  assert.doesNotThrow(function () {
    expanded = UM.ConfigSchema.expand(cfg);
  });
  assert.strictEqual(expanded.nCircuits, 3,
    "nCircuits must remain 3 after Q=72 (m=3 phases)");
});

test("registers exactly one shelf panel", function () {
  assert.ok(capturedPanel !== null && typeof capturedPanel === "object",
    "capturedPanel must be an object");
  assert.strictEqual(capturedPanel.zone, "shelf",
    "zone must be \"shelf\"");
  assert.strictEqual(typeof capturedPanel.build, "function",
    "build must be a function");
});

test("is machine-agnostic (no fixture-id literals)", function () {
  const src = fs.readFileSync(
    path.join(ROOT, "lessons/unified_motor/geometry-panel.js"),
    "utf8"
  );
  const FIXTURE_IDS = [
    "pmsm",
    "brushed-dc-pm",
    "brushed-dc-wound",
    "universal",
    "bldc",
    "induction-3ph",
    "induction-1ph",
    "vr-stepper",
    "switched-reluctance",
    "pm-stepper",
    "hybrid-stepper",
    "synchronous-reluctance",
    "wound-field-synchronous",
    "skew-demo",
    "pole-mismatch-demo",
  ];
  for (const id of FIXTURE_IDS) {
    const quoted = ['"' + id + '"', "'" + id + "'"];
    for (const q of quoted) {
      assert.ok(!src.includes(q),
        "geometry-panel.js must not contain hardcoded fixture id: " + q);
    }
  }
});
