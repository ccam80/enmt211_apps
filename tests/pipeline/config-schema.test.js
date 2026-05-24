"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LIB,
  UnifiedMotor,
  MACHINE_NAMES,
  woundConfig,
  pmConfig,
  salientConfig,
  skewN2Config,
} = require("./_fixtures.js");

const CS = UnifiedMotor.ConfigSchema;

describe("config-schema", function () {
  // -------------------------------------------------------------------------
  it("expand produces Phase-2 sections", function () {
    const expanded = CS.expand(woundConfig());
    assert.ok(Array.isArray(expanded.slices), "slices must be an array");
    assert.ok(expanded.slices.length >= 1, "slices must be non-empty");

    const section = expanded.slices[0].section;

    // Every feature must have kind in {conductor, magnet, iron}
    assert.ok(Array.isArray(section.features), "features must be an array");
    const validKinds = new Set(["conductor", "magnet", "iron"]);
    for (const f of section.features) {
      assert.ok(validKinds.has(f.kind), "feature.kind must be conductor|magnet|iron, got: " + f.kind);
      assert.ok("member" in f, "feature must have member");
      assert.ok(Array.isArray(f.rRange) && f.rRange.length === 2, "feature must have rRange [r0, r1]");
      assert.ok(Array.isArray(f.thetaRange) && f.thetaRange.length === 2, "feature must have thetaRange [t0, t1]");
    }

    // compile() must run without throwing
    assert.doesNotThrow(function () {
      LIB.MotorCompile.compile(section);
    }, "MotorCompile.compile must succeed on the expanded section");
  });

  // -------------------------------------------------------------------------
  it("nCircuits matches circuits length", function () {
    const cfg = woundConfig();
    const expanded = CS.expand(cfg);
    assert.strictEqual(
      expanded.nCircuits,
      cfg.circuits.length,
      "expanded.nCircuits must equal cfg.circuits.length"
    );
  });

  // -------------------------------------------------------------------------
  it("no magnet => no magnet feature (zero-not-skip)", function () {
    // salientConfig is magnet-free (I rotor + C stator)
    const expanded = CS.expand(salientConfig());
    const section = expanded.slices[0].section;

    const magnetFeatures = section.features.filter(function (f) { return f.kind === "magnet"; });
    assert.strictEqual(magnetFeatures.length, 0, "magnet-free config must produce zero magnet features");

    // After compile, magnetization must be all-zero (zero, not skip)
    const compiled = LIB.MotorCompile.compile(section);
    let allZeroMr = true;
    let allZeroMtheta = true;
    for (let i = 0; i < compiled.magnetization.Mr.length; i++) {
      if (compiled.magnetization.Mr[i] !== 0) { allZeroMr = false; break; }
    }
    for (let i = 0; i < compiled.magnetization.Mtheta.length; i++) {
      if (compiled.magnetization.Mtheta[i] !== 0) { allZeroMtheta = false; break; }
    }
    assert.ok(allZeroMr, "compiled.magnetization.Mr must be all-zero for magnet-free config");
    assert.ok(allZeroMtheta, "compiled.magnetization.Mtheta must be all-zero for magnet-free config");
  });

  // -------------------------------------------------------------------------
  it("N=1 default and N=2 stack", function () {
    const exp1 = CS.expand(woundConfig());
    assert.strictEqual(exp1.slices.length, 1, "woundConfig must produce slices.length === 1");

    const exp2 = CS.expand(skewN2Config());
    assert.strictEqual(exp2.slices.length, 2, "skewN2Config must produce slices.length === 2");
    assert.strictEqual(exp2.slices[1].offset, 0.05, "slices[1].offset must be 0.05");
  });

  // -------------------------------------------------------------------------
  it("flux-source sign flips magnet per slice", function () {
    // Build a 2-slice config with an M ring and a fluxSources entry sliceSigns:[+1, -1]
    const cfg = {
      grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
      gapBand: { iInner: 4, iOuter: 8 },
      poles: 2,
      rings: [
        {
          member: "rotor",
          element: "M",
          rRange: [0.04, 0.047],
          magnets: 2,
          Mr: 8e5,
        },
        {
          member: "stator",
          element: "W",
          rRange: [0.053, 0.06],
          winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
          muR: 1000,
        },
      ],
      circuits: [
        { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
      ],
      stack: {
        slices: 2,
        sliceOffsets: [0, 0.05],
        fluxSources: [
          { ringRef: 0, sliceSigns: [1, -1] },
        ],
      },
      mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    };

    const expanded = CS.expand(cfg);
    assert.strictEqual(expanded.slices.length, 2, "must produce 2 slices");

    const getMagnetFeatures = function (section) {
      return section.features.filter(function (f) { return f.kind === "magnet"; });
    };

    const mags0 = getMagnetFeatures(expanded.slices[0].section);
    const mags1 = getMagnetFeatures(expanded.slices[1].section);

    assert.ok(mags0.length > 0, "slice 0 must have magnet features");
    assert.ok(mags1.length > 0, "slice 1 must have magnet features");
    assert.strictEqual(mags0.length, mags1.length, "both slices must have same magnet feature count");

    // Each corresponding pair must have exact negation of Mr
    for (let i = 0; i < mags0.length; i++) {
      assert.strictEqual(
        mags1[i].Mr,
        -mags0[i].Mr,
        "slice-1 magnet[" + i + "].Mr must be exact negative of slice-0 magnet[" + i + "].Mr"
      );
    }
  });

  // -------------------------------------------------------------------------
  it("validate rejects bad config", function () {
    // Build a config where circuits.length mismatches resolved circuit count
    const cfg = woundConfig();
    // The winding resolves to 1 circuit, but we declare 2 in circuits[]
    cfg.circuits = [
      { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
      { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
    ];

    const result = CS.validate(cfg);
    assert.strictEqual(result.ok, false, "validate must return ok:false for mismatched circuit count");
    assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "validate must return non-empty errors array");
  });

  // -------------------------------------------------------------------------
  it("no machine-name string in source", function () {
    const srcPath = path.resolve(__dirname, "../../lessons/unified_motor/config-schema.js");
    const src = fs.readFileSync(srcPath, "utf8").toLowerCase();

    for (const name of MACHINE_NAMES) {
      assert.ok(
        !src.includes(name.toLowerCase()),
        "config-schema.js must not contain machine name: " + name
      );
    }
  });
});
