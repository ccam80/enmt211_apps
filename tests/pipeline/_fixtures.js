"use strict";

// =============================================================================
//  Shared fixtures for Phase-5 pipeline tests.
//  Not a test file — no .test.js suffix. Required by test files.
//
//  Loads the engine shim (window + engine libs), then directly requires the
//  Phase-2/3/4/5 modules and the config-schema app module. Re-exports
//  assertClose from the engine fixtures. Exports the four named machine
//  configs, MACHINE_NAMES, LIB, UnifiedMotor, CS, initSolver, feaOpts.
// =============================================================================

const path = require("path");

// Engine shim installs globalThis.window and engine libs
const LIB = require("../_shim.js");

// Phase-2 modules
require("../../lib/winding-model.js");

// Phase-3 module
require("../../lib/excitation.js");

// Phase-4 module
require("../../lib/motor-circuit.js");

// Phase-2/5 mesh + air-gap + FEA modules
require("../../lib/motor-mesh.js");
require("../../lib/motor-mesh-view.js");
require("../../lib/airgap-mortar.js");

// Point fea-solver at the absolute mjs path BEFORE requiring it.
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/motor-slice.js");

// Phase-5 lib modules
require("../../lib/motor-stack.js");
require("../../lib/motor-run.js");

// Phase-5 app module (attaches window.UnifiedMotor.ConfigSchema)
require("../../lessons/unified_motor/config-schema.js");

const UnifiedMotor = window.UnifiedMotor;
const CS = UnifiedMotor.ConfigSchema;

const { assertClose } = require("../_assert.js");

// ---------------------------------------------------------------------------
//  MACHINE_NAMES — token list grepped for (case-insensitive) to assert that
//  lib/ modules and mount.js contain no machine-identity string literals.
//  Physics terms (reluctance, induction, synchronous, commutation) are
//  deliberately excluded — they name physics, not a machine identity.
// ---------------------------------------------------------------------------
const MACHINE_NAMES = Object.freeze([
  "bldc",
  "pmsm",
  "srm",
  "squirrel",
  "stepper",
  "brushed",
  "universal-motor",
  "wound-field",
]);

// ---------------------------------------------------------------------------
//  initSolver() — memoized Promise<void> for LIB.FeaSolver.init().
// ---------------------------------------------------------------------------
let _initPromise = null;
function initSolver() {
  if (!_initPromise) _initPromise = LIB.FeaSolver.init();
  return _initPromise;
}

// ---------------------------------------------------------------------------
//  feaOpts(extra) — base linear-mode coarse-mesh opts merged with extras.
// ---------------------------------------------------------------------------
function feaOpts(extra) {
  return Object.assign(
    { saturation: { enabled: false }, mesh: { refine: 0.5 } },
    extra || {}
  );
}

// ---------------------------------------------------------------------------
//  woundConfig() — current-fed wound machine
//
//  A single stator W ring (m=1 DC winding, Q=6, coilPitch=3, 20 turns)
//  on a small annulus, one DC circuit (commutation:none, finite R), a
//  salient I rotor (2 teeth) so reluctance torque is non-zero off alignment,
//  stack.slices:1, poles:2.
// ---------------------------------------------------------------------------
function woundConfig(overrides) {
  const cfg = {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    rings: [
      {
        member: "stator",
        element: "W",
        rRange: [0.052, 0.06],
        winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: [0.04, 0.048],
        teeth: 2,
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
  if (overrides) {
    if (overrides.stack) cfg.stack = Object.assign({}, cfg.stack, overrides.stack);
  }
  return cfg;
}

// ---------------------------------------------------------------------------
//  pmConfig() — PM machine
// ---------------------------------------------------------------------------
function pmConfig() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
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
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

// ---------------------------------------------------------------------------
//  salientConfig() — salient-iron reluctance machine
// ---------------------------------------------------------------------------
function salientConfig() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    poles: 2,
    rings: [
      {
        member: "rotor",
        element: "I",
        rRange: [0.04, 0.048],
        teeth: 2,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: [0.052, 0.06],
        winding: { standard: { m: 1, p: 2, Q: 6, coilPitch: 3, turns: 20 } },
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 5.0 }, commutation: { mode: "none" }, R: 1.0 },
    ],
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

// ---------------------------------------------------------------------------
//  skewN2Config() — the wound machine with 2 skew slices
// ---------------------------------------------------------------------------
function skewN2Config() {
  const cfg = woundConfig();
  cfg.stack = { slices: 2, sliceOffsets: [0, 0.05] };
  return cfg;
}

module.exports = {
  LIB,
  UnifiedMotor,
  CS,
  MACHINE_NAMES,
  assertClose,
  initSolver,
  feaOpts,
  woundConfig,
  pmConfig,
  salientConfig,
  skewN2Config,
};
