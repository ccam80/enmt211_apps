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

      // Run 200 steps — byte-identical loop body across all four configs.
      for (let step = 0; step < 200; step++) {
        rt.step(dt);
      }

      assert.ok(
        Number.isFinite(rt.state.theta),
        "state.theta must be finite after 200 steps"
      );
      assert.ok(
        Math.abs(rt.state.theta) > 1e-4,
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
  it("Maxwell agrees with co-energy within 10% (linear operating point)", function () {
    // The comparison MUST be made with saturation DISABLED on both sides. A
    // saturated Arkkio and the linear co-energy extractCoeffs cannot agree
    // because the saturated material is non-conservative. This is evaluated at
    // a consistent linear operating point (saturation: {enabled:false}).

    const linearOpts = feaOpts({ saturation: { enabled: false } });
    const configs = [woundConfig(), pmConfig(), salientConfig(), skewN2Config()];
    const theta = 0.2;
    const current = 5.0;

    for (const cfg of configs) {
      const expanded = CS.expand(cfg);
      const nC = expanded.nCircuits;

      // Build a saturation-disabled stack for the comparison (not the live MotorRun).
      const stack = LIB.MotorStack.create(expanded, linearOpts);

      const currents = new Float64Array(nC);
      for (let k = 0; k < nC; k++) { currents[k] = current; }

      const arkkio = stack.solve(theta, currents).torque;
      const coe = stack.coenergyTorque(theta, currents).total;

      // Only assert for configs with non-trivial torque magnitude. The
      // single-circuit reluctance configs (wound / salient / skewN2) produce
      // O(1e-6) N·m at this angle — at or below the coarse-mesh FEA torque
      // noise floor — so the relative cross-check is meaningless there. The
      // floor matches the Phase-6 crossCheck near-zero guard (1e-5); only the
      // PM config carries a meaningful torque (~29 N·m, agrees to rel 3e-4).
      const torqueMag = Math.max(Math.abs(arkkio), Math.abs(coe));
      if (torqueMag <= 1e-5) {
        // Trivial torque — skip comparison (floor condition).
        continue;
      }

      const relErr = Math.abs(arkkio - coe) / torqueMag;
      assert.ok(
        relErr <= 0.10,
        "Maxwell-vs-co-energy relative error must be <= 10% at linear operating point" +
        " (saturation disabled). Got relErr=" + relErr.toFixed(4) +
        ", arkkio=" + arkkio + ", coe=" + coe
      );
    }
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
