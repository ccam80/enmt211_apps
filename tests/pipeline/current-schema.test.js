"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
require(path.join(__dirname, "..", "..", "lib", "util.js"));
require(path.join(__dirname, "..", "..", "lib", "winding-model.js"));
require(path.join(__dirname, "..", "..", "lessons", "unified_motor", "config-schema.js"));

const ConfigSchema = window.UnifiedMotor.ConfigSchema;

const cfg = {
  grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
  poles: 2,
  motion: { inner: "rotating", outer: "static" },
  rings: [
    { member: "outer", components: [
      { kind: "iron", rRange: [0.052, 0.06], muR: 1000, alpha: 1 },
      { kind: "distributed-winding", rRange: [0.052, 0.06],
        winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } }, muR: 1000, alpha: 1 },
    ] },
    { member: "inner", components: [
      { kind: "iron", rRange: [0.04, 0.048], teeth: 2, muR: 1000, alpha: 1 },
    ] },
  ],
  circuits: [
    { terminal: { type: "CURRENT", amp: 5 }, commutation: { mode: "none" }, R: 1.0 },
  ],
  stack: { slices: 1 },
  mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
};

test("a CURRENT circuit validates", () => {
  const result = ConfigSchema.validate(cfg);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("an unknown terminal type is still rejected", () => {
  const bad = JSON.parse(JSON.stringify(cfg));
  bad.circuits[0].terminal.type = "BOGUS";
  const result = ConfigSchema.validate(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.includes("terminal.type")),
    `expected an error mentioning terminal.type; got: ${JSON.stringify(result.errors)}`);
});
