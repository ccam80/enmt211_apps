"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LIB,
  CS,
  MACHINE_NAMES,
  initSolver,
  feaOpts,
  woundConfig,
  pmConfig,
  salientConfig,
  skewN2Config,
} = require("./_fixtures.js");

describe("agnostic-pipeline", function () {
  before(async function () {
    await initSolver();
  });

  // -------------------------------------------------------------------------
  it("all configs run the identical MotorRun path and the rotor turns", function () {
    const configs = [woundConfig(), pmConfig(), salientConfig(), skewN2Config()];
    const dt = 1 / 240;

    for (const cfg of configs) {
      const rt = LIB.MotorRun.create(CS.expand(cfg), feaOpts());

      // Byte-identical loop body across all four configs (the agnostic claim).
      // The rotor-turns predicate trips in the first few steps; stop there rather
      // than spinning each config into the costly high-ω regime.
      let moved = false;
      for (let step = 0; step < 200 && !moved; step++) {
        rt.step(dt);
        if (Math.abs(rt.state.theta) > 1e-4) moved = true;
      }

      assert.ok(
        Number.isFinite(rt.state.theta),
        "state.theta must be finite"
      );
      assert.ok(
        moved,
        "rotor must have moved: |state.theta| > 1e-4 (got " + rt.state.theta + ")"
      );
    }
  });

  // -------------------------------------------------------------------------
  it("N=2 config drives two slices", function () {
    const rt = LIB.MotorRun.create(CS.expand(skewN2Config()), feaOpts());
    assert.strictEqual(rt.stack.nSlices, 2, "skewN2Config must produce nSlices === 2");
  });

  // -------------------------------------------------------------------------
  it("unified-motor lib + mount.js are free of machine names", function () {
    // Per spec/manifest.json Check 1, these pre-existing non-unified-motor files
    // are excluded from the scan — they contain sanctioned token sites that are
    // not unified-motor violations:
    const CARVE_OUTS = new Set([
      "app.js",
      "registry.js",
      "header-buttons.js",
      "stepper-drive.js",
      "three-phase.js",
    ]);

    const libDir = path.resolve(__dirname, "../../lib");
    const mountPath = path.resolve(__dirname, "../../lessons/unified_motor/mount.js");

    // Collect all *.js files in lib/ excluding carve-out sites.
    const libFiles = fs.readdirSync(libDir)
      .filter(function (f) { return f.endsWith(".js") && !CARVE_OUTS.has(f); })
      .map(function (f) { return path.join(libDir, f); });

    const filesToCheck = libFiles.concat([mountPath]);

    for (const filePath of filesToCheck) {
      const src = fs.readFileSync(filePath, "utf8").toLowerCase();
      const shortName = path.relative(path.resolve(__dirname, "../../"), filePath);

      for (const name of MACHINE_NAMES) {
        assert.ok(
          !src.includes(name.toLowerCase()),
          shortName + " must not contain machine name: " + name
        );
      }
    }
  });
});
