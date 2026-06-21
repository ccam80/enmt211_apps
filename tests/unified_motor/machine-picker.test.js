"use strict";

const fs = require("fs");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
//  Headless harness — no DOM required for pure-logic tests.
//  document access lives only inside build() callbacks, not tested here.
// ---------------------------------------------------------------------------

if (!globalThis.window) globalThis.window = globalThis;

// Load lib dependencies with guarded require (mirrors _shim.js pattern).
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

// Load all 15 machine fixtures so UM.MACHINES is fully populated.
const MACHINES_DIR = path.join(ROOT, "lessons/unified_motor/machines");
const machineFiles = fs.readdirSync(MACHINES_DIR)
  .filter(function (f) { return f.endsWith(".js"); })
  .sort();
for (const f of machineFiles) {
  require(path.join(MACHINES_DIR, f));
}

// Capture the header control registered by machine-picker.js.
let captured = null;
window.UnifiedMotor.registerHeaderControl = function (entry) {
  captured = entry;
};

require(path.join(ROOT, "lessons/unified_motor/machine-picker.js"));

const UM = window.UnifiedMotor;

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

test("registers exactly one header control with an id and a build function", function () {
  assert.ok(captured !== null && typeof captured === "object",
    "captured must be an object");
  assert.strictEqual(typeof captured.id, "string",
    "captured.id must be a string");
  assert.strictEqual(typeof captured.build, "function",
    "captured.build must be a function");
});

test("loadMachine replaces ctx.config contents in place and rebuilds", function () {
  let n = 0;
  const ctx = { config: { stale: 1, grid: {} }, requestRebuild() { n++; } };
  const ref = ctx.config;
  UM.MachinePicker.loadMachine(ctx, "pmsm");
  assert.strictEqual(ctx.config, ref, "ctx.config must be the same object reference");
  assert.strictEqual(ctx.config.stale, undefined, "stale key must be removed");
  assert.strictEqual(ctx.config.poles, 8, "poles must be 8");
  assert.strictEqual(ctx.config.rings.length, 2, "rings.length must be 2");
  assert.strictEqual(ctx.config.grid.Nr, 50, "grid.Nr must be 50");
  assert.strictEqual(n, 1, "requestRebuild must be called exactly once");
});

test("the loaded config is a deep copy of the fixture", function () {
  const ctx = { config: {}, requestRebuild() {} };
  UM.MachinePicker.loadMachine(ctx, "pmsm");
  const originalValue = ctx.config.rings[0].rRange[0];
  ctx.config.rings[0].rRange[0] = 0.999;
  const entry = UM.MACHINES.find(function (m) { return m.id === "pmsm"; });
  assert.notStrictEqual(entry.config.rings[0].rRange[0], 0.999,
    "mutating the loaded config must not affect the fixture");
});

test("label falls back to the MACHINES entry label when the config has none", function () {
  const ctx = { config: {}, requestRebuild() {} };
  UM.MachinePicker.loadMachine(ctx, "pmsm");
  assert.strictEqual(ctx.config.label, "PMSM 8p/48s (sinusoidal)",
    "label must fall back to the MACHINES entry label");
});

test("every one of the 15 fixtures loads into a config that validates and expands", function () {
  assert.strictEqual(UM.MACHINES.length, 15, "UM.MACHINES must have exactly 15 entries");
  for (const entry of UM.MACHINES) {
    const ctx = { config: {}, requestRebuild() {} };
    UM.MachinePicker.loadMachine(ctx, entry.id);
    const v = UM.ConfigSchema.validate(ctx.config);
    assert.strictEqual(v.ok, true,
      "validate must pass for fixture \"" + entry.id + "\": " + (v.errors || []).join("; "));
    assert.doesNotThrow(
      function () { UM.ConfigSchema.expand(ctx.config); },
      "expand must not throw for fixture \"" + entry.id + "\""
    );
  }
});

test("an unknown machine id throws", function () {
  assert.throws(
    function () {
      UM.MachinePicker.loadMachine({ config: {}, requestRebuild() {} }, "no-such-machine");
    },
    Error,
    "loadMachine must throw for an unknown id"
  );
});

test("is machine-agnostic (no hardcoded fixture ids)", function () {
  const src = fs.readFileSync(
    path.join(ROOT, "lessons/unified_motor/machine-picker.js"),
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
        "machine-picker.js must not contain hardcoded fixture id: " + q);
    }
  }
});
