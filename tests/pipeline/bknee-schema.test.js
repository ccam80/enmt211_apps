"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
require(path.join(__dirname, "..", "..", "lib", "util.js"));
require(path.join(__dirname, "..", "..", "lib", "winding-model.js"));
require(path.join(__dirname, "..", "..", "lessons", "unified_motor", "config-schema.js"));

const CS = window.UnifiedMotor.ConfigSchema;

// Minimal valid config: a salient-iron (toothed) inner body + a wound outer body,
// no Bknee. The inner body rotates. Gap (pure air) between 0.048 and 0.052.
function makeBaseConfig() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    motion: { inner: "rotating", outer: "static" },
    rings: [
      { member: "inner", components: [
        { kind: "iron", rRange: [0.04, 0.048], teeth: 2, muR: 1000, alpha: 1 },
      ] },
      { member: "outer", components: [
        { kind: "iron", rRange: [0.052, 0.06], muR: 1000, alpha: 1 },
        { kind: "distributed-winding", rRange: [0.052, 0.06],
          winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } }, muR: 1000, alpha: 1 },
      ] },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 5 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

test("absent Bknee → iron features carry Bknee: null", () => {
  const cfg = makeBaseConfig();
  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;
  const ironFeatures = features.filter(f => f.kind === "iron");
  assert.ok(ironFeatures.length > 0, "expected at least one iron feature");
  for (const f of ironFeatures) {
    assert.strictEqual(f.Bknee, null,
      `iron feature from component without Bknee must carry Bknee=null; got ${f.Bknee}`);
  }
});

test("Bknee on the inner iron component reaches every rotor iron feature", () => {
  const cfg = makeBaseConfig();
  cfg.rings[0].components[0].Bknee = 1.4;
  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;

  const ironFeaturesFromRotor = features.filter(f =>
    f.kind === "iron" && f.member === "rotor"
  );
  assert.ok(ironFeaturesFromRotor.length > 0, "expected iron features from the rotor");
  for (const f of ironFeaturesFromRotor) {
    assert.strictEqual(f.Bknee, 1.4,
      `rotor iron feature must carry Bknee=1.4; got ${f.Bknee}`);
  }

  // Stator iron (no Bknee set) should carry null
  const ironFeaturesFromStator = features.filter(f =>
    f.kind === "iron" && f.member === "stator"
  );
  assert.ok(ironFeaturesFromStator.length > 0, "expected iron features from the stator");
  for (const f of ironFeaturesFromStator) {
    assert.strictEqual(f.Bknee, null,
      `stator iron feature (no Bknee on component) must carry Bknee=null; got ${f.Bknee}`);
  }
});

test("Bknee on a concentrated winding + its yoke reaches back-iron and salient teeth", () => {
  // Replace the outer body with a concentrated winding (salient teeth) + its yoke,
  // both carrying Bknee=1.7.
  const cfg = makeBaseConfig();
  cfg.rings[1] = { member: "outer", components: [
    { kind: "iron", rRange: [0.052, 0.06], muR: 1000, Bknee: 1.7, alpha: 1 },
    { kind: "concentrated-winding", rRange: [0.052, 0.06],
      winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } }, muR: 1000, Bknee: 1.7, alpha: 1 },
  ] };

  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;
  const ironFeaturesFromStator = features.filter(f =>
    f.kind === "iron" && f.member === "stator"
  );
  assert.ok(ironFeaturesFromStator.length > 1,
    "concentrated winding + yoke must emit back-iron + at least one salient tooth iron feature");
  for (const f of ironFeaturesFromStator) {
    assert.strictEqual(f.Bknee, 1.7,
      `stator iron feature (back-iron or tooth) must carry Bknee=1.7; got ${f.Bknee}`);
  }
});

test("Bknee on a magnet's yoke component reaches its back-iron feature only", () => {
  // Inner body: magnet + its own back-iron (Bknee=1.5). The magnet features carry
  // no Bknee; only the iron yoke component does.
  const cfg = makeBaseConfig();
  cfg.rings[0] = { member: "inner", components: [
    { kind: "magnet", rRange: [0.044, 0.048], poles: 2, Mr: 1e6, muR: 1000, Bknee: 1.5, alpha: 1 },
    { kind: "iron", rRange: [0.040, 0.044], muR: 1000, Bknee: 1.5, alpha: 1 },
  ] };

  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;

  const backIronFeatures = features.filter(f =>
    f.kind === "iron" && f.member === "rotor"
  );
  assert.ok(backIronFeatures.length > 0, "expected back-iron iron feature");
  for (const f of backIronFeatures) {
    assert.strictEqual(f.Bknee, 1.5,
      `back-iron feature must carry Bknee=1.5; got ${f.Bknee}`);
  }

  // Magnet features must NOT have a Bknee property
  const magnetFeatures = features.filter(f =>
    f.kind === "magnet" && f.member === "rotor"
  );
  assert.ok(magnetFeatures.length > 0, "expected magnet features");
  for (const f of magnetFeatures) {
    assert.strictEqual(f.Bknee, undefined,
      `magnet feature must not have Bknee property; got ${f.Bknee}`);
  }
});

test("validate accepts a finite positive Bknee", () => {
  const cfg = makeBaseConfig();
  cfg.rings[0].components[0].Bknee = 1.6;
  const result = CS.validate(cfg);
  assert.strictEqual(result.ok, true, `expected ok=true; errors: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.errors.length, 0);
});

test("validate rejects non-finite or non-positive Bknee", () => {
  for (const badVal of [0, -1.5, NaN, Infinity, "1.6"]) {
    const cfg = makeBaseConfig();
    cfg.rings[0].components[0].Bknee = badVal;
    const result = CS.validate(cfg);
    assert.strictEqual(result.ok, false,
      `expected ok=false for Bknee=${badVal}; got ok=true`);
    assert.ok(result.errors.some(e => e.includes("Bknee")),
      `expected error mentioning "Bknee" for Bknee=${badVal}; got: ${JSON.stringify(result.errors)}`);
  }
});

test("validate accepts a config with no Bknee anywhere", () => {
  const cfg = makeBaseConfig();
  const result = CS.validate(cfg);
  assert.strictEqual(result.ok, true, `expected ok=true; errors: ${JSON.stringify(result.errors)}`);
});
