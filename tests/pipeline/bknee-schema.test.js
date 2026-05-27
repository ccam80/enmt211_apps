"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
require(path.join(__dirname, "..", "..", "lib", "util.js"));
require(path.join(__dirname, "..", "..", "lib", "winding-model.js"));
require(path.join(__dirname, "..", "..", "lessons", "unified_motor", "config-schema.js"));

const CS = window.UnifiedMotor.ConfigSchema;

// Minimal valid config: I-rotor + W-stator, no Bknee
// grid: rInner=0.04, rOuter=0.06, Nr=12, Ntheta=24
// rotor I ring: rRange [0.04, 0.048], teeth=2
// stator W ring: rRange [0.052, 0.06], winding m=1 p=2 Q=6 coilPitch=3 turns=20
// Gap (pure air) between 0.048 and 0.052 — two cells at Nr=12 span ~0.00167 each
function makeBaseConfig(overrides) {
  const cfg = {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    rings: [
      {
        member: "rotor", element: "I", rRange: [0.04, 0.048], teeth: 2,
        muR: 1000,
      },
      {
        member: "stator", element: "W", rRange: [0.052, 0.06],
        winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 5 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
  if (overrides) {
    if (overrides.rotorRing) Object.assign(cfg.rings[0], overrides.rotorRing);
    if (overrides.statorRing) Object.assign(cfg.rings[1], overrides.statorRing);
    if (overrides.replaceRings) cfg.rings = overrides.replaceRings;
    if (overrides.circuits) cfg.circuits = overrides.circuits;
  }
  return cfg;
}

test("absent Bknee → iron features carry Bknee: null", () => {
  const cfg = makeBaseConfig();
  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;
  const ironFeatures = features.filter(f => f.kind === "iron");
  assert.ok(ironFeatures.length > 0, "expected at least one iron feature");
  for (const f of ironFeatures) {
    assert.strictEqual(f.Bknee, null,
      `iron feature from ring without Bknee must carry Bknee=null; got ${f.Bknee}`);
  }
});

test("ring.Bknee on an I rotor reaches every iron feature", () => {
  // I-rotor with Bknee:1.4, W-stator with no Bknee
  const cfg = makeBaseConfig({ rotorRing: { Bknee: 1.4 } });
  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;

  // I-ring features are built by buildIronFeatures — thetaRange is not [0,TWO_PI]
  const ironFeaturesFromRotor = features.filter(f =>
    f.kind === "iron" && f.member === "rotor"
  );
  assert.ok(ironFeaturesFromRotor.length > 0, "expected iron features from the I rotor");
  for (const f of ironFeaturesFromRotor) {
    assert.strictEqual(f.Bknee, 1.4,
      `rotor iron feature must carry Bknee=1.4; got ${f.Bknee}`);
  }

  // W-stator back-iron (no Bknee set) should carry null
  const ironFeaturesFromStator = features.filter(f =>
    f.kind === "iron" && f.member === "stator"
  );
  assert.ok(ironFeaturesFromStator.length > 0, "expected iron features from the W stator");
  for (const f of ironFeaturesFromStator) {
    assert.strictEqual(f.Bknee, null,
      `stator iron feature (no Bknee on ring) must carry Bknee=null; got ${f.Bknee}`);
  }
});

test("ring.Bknee on a W stator reaches both back-iron and (for C) salient teeth", () => {
  // Replace stator W ring with a C ring having Bknee:1.7
  // C ring needs its own valid winding. Use m=1 p=2 Q=6 coilPitch=3 turns=20
  // For a C ring, buildWoundFeatures is called with includeTeeth=true
  const cStatorRing = {
    member: "stator",
    element: "C",
    rRange: [0.052, 0.06],
    winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
    muR: 1000,
    Bknee: 1.7,
  };
  const cfg = makeBaseConfig();
  cfg.rings[1] = cStatorRing;

  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;
  const ironFeaturesFromStator = features.filter(f =>
    f.kind === "iron" && f.member === "stator"
  );
  assert.ok(ironFeaturesFromStator.length > 1,
    "C ring must emit back-iron + at least one salient tooth iron feature");
  for (const f of ironFeaturesFromStator) {
    assert.strictEqual(f.Bknee, 1.7,
      `stator iron feature (back-iron or tooth) must carry Bknee=1.7; got ${f.Bknee}`);
  }
});

test("ring.Bknee on an M ring reaches its back-iron feature only", () => {
  // M-rotor with backIron:true and Bknee:1.5; plus W-stator to provide gap
  // rRange for magnets: [0.040, 0.048]; backIronRRange: [0.040, 0.044]
  // Need enough space for gap — put stator at [0.052, 0.06]
  const mRotorRing = {
    member: "rotor",
    element: "M",
    rRange: [0.044, 0.048],
    magnets: 2,
    Mr: 1e6,
    backIron: true,
    backIronRRange: [0.040, 0.044],
    muR: 1000,
    Bknee: 1.5,
  };
  const cfg = makeBaseConfig();
  cfg.rings[0] = mRotorRing;

  const expanded = CS.expand(cfg);
  const features = expanded.slices[0].section.features;

  // Back-iron: kind="iron", member="rotor"
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
  const cfg = makeBaseConfig({ rotorRing: { Bknee: 1.6 } });
  const result = CS.validate(cfg);
  assert.strictEqual(result.ok, true, `expected ok=true; errors: ${JSON.stringify(result.errors)}`);
  assert.strictEqual(result.errors.length, 0);
});

test("validate rejects non-finite or non-positive Bknee", () => {
  for (const badVal of [0, -1.5, NaN, Infinity, "1.6"]) {
    const cfg = makeBaseConfig({ rotorRing: { Bknee: badVal } });
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
