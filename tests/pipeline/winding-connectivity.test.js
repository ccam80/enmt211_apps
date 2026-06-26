"use strict";

// =============================================================================
//  expand() propagates true winding connectivity for the 3-D end caps.
//
//  The field model collapses each coil into per-slot net turns, but the renderer
//  needs the real slotGo→slotReturn wiring to draw physical end turns. expand()
//  attaches that as `expanded.windings` (absolute circuit indices) plus a global
//  `endCapAlpha`. These guard the contract the renderer relies on.
// =============================================================================

const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
const ROOT = path.resolve(__dirname, "../..");
function guardedRequire(rel) {
  try { require(path.join(ROOT, rel)); }
  catch (err) { if (err.code !== "MODULE_NOT_FOUND") throw err; }
}
guardedRequire("lib/util.js");
guardedRequire("lib/winding-model.js");
require(path.join(ROOT, "lessons/unified_motor/config-schema.js"));
require(path.join(ROOT, "lessons/unified_motor/machines/pmsm.js"));
require(path.join(ROOT, "lessons/unified_motor/machines/bldc.js"));
require(path.join(ROOT, "lessons/unified_motor/machines/induction-3ph.js"));

const UM = window.UnifiedMotor;
function cfg(id) {
  return JSON.parse(JSON.stringify(UM.MACHINES.find(function (m) { return m.id === id; }).config));
}

test("distributed winding propagates true coil pairing (slotReturn = slotGo + coilPitch)", function () {
  const c = cfg("pmsm");                       // m=3, p=8, Q=48, coilPitch=6
  const w = c.rings.find(function (r) { return r.member === "outer"; })
    .components.find(function (x) { return x.kind === "distributed-winding"; }).winding.standard;
  const e = UM.ConfigSchema.expand(c);

  assert.strictEqual(e.windings.length, 1, "one wound component");
  const wnd = e.windings[0];
  assert.strictEqual(wnd.kind, "distributed");
  assert.strictEqual(wnd.coils.length, w.Q, "one coil per slot");

  for (const coil of wnd.coils) {
    assert.strictEqual(coil.slotReturn, (coil.slotGo + w.coilPitch) % w.Q,
      "coil spans coilPitch slots — real lap connectivity, not a nearest-angle guess");
    assert.ok(coil.circuit >= 0 && coil.circuit < w.m, "phase circuit in [0, m)");
  }
});

test("absolute circuit indices survive expansion order (stator after rotor cage)", function () {
  // induction-3ph: rotor cage circuits come first, then the stator winding —
  // the winding's coils must reference the OFFSET (absolute) circuit indices.
  const e = UM.ConfigSchema.expand(cfg("induction-3ph"));
  const wnd = e.windings.find(function (x) { return x.kind === "distributed"; });
  const maxCircuit = Math.max.apply(null, wnd.coils.map(function (k) { return k.circuit; }));
  const minCircuit = Math.min.apply(null, wnd.coils.map(function (k) { return k.circuit; }));
  assert.ok(minCircuit > 0, "stator phases are offset past the cage bar circuits");
  assert.ok(maxCircuit < e.nCircuits, "circuit indices stay within the global circuit count");
});

test("concentrated winding is tagged for the helical wrap", function () {
  const e = UM.ConfigSchema.expand(cfg("bldc"));
  assert.ok(e.windings.length >= 1);
  assert.ok(e.windings.every(function (w) { return w.kind === "concentrated"; }),
    "bldc windings drive the concentrated tooth helix");
});

test("endCapAlpha defaults to 1 and passes through from config", function () {
  assert.strictEqual(UM.ConfigSchema.expand(cfg("pmsm")).endCapAlpha, 1, "default opaque");

  const c = cfg("pmsm");
  c.endCapAlpha = 0.25;
  const e = UM.ConfigSchema.expand(c);
  assert.strictEqual(e.endCapAlpha, 0.25, "panel-set end-cap alpha reaches the renderer");
  assert.ok(UM.ConfigSchema.validate(c).ok, "endCapAlpha does not break validation");
});
