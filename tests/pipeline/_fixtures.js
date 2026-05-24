"use strict";

// =============================================================================
//  Shared fixtures for Phase-5 pipeline tests.
//  Not a test file — no .test.js suffix. Required by test files.
//
//  Loads the engine shim (window + engine libs), then directly requires the
//  Phase-2/3/4/5 modules and the config-schema app module. Re-exports
//  assertClose from the engine fixtures. Exports the four named machine
//  configs, tinySection, MACHINE_NAMES, LIB, and UnifiedMotor.
// =============================================================================

// Engine shim installs globalThis.window and engine libs
const LIB = require("../_shim.js");

// Phase-2 modules
require("../../lib/motor-compile.js");
require("../../lib/winding-model.js");

// Phase-3 module
require("../../lib/excitation.js");

// Phase-4 module
require("../../lib/motor-circuit.js");

// Phase-5 lib modules
require("../../lib/motor-slice.js");
require("../../lib/motor-stack.js");

// Phase-5 app module (attaches window.UnifiedMotor.ConfigSchema)
require("../../lessons/unified_motor/config-schema.js");

// Re-export assertClose from the engine fixtures
const { assertClose } = require("../engine/_fixtures.js");

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
//  woundConfig() — current-fed wound machine
//
//  A single stator W ring (m=1 DC winding, Q=6, coilPitch=3, 20 turns)
//  on a small annulus, one DC circuit (commutation:none, finite R), a
//  salient I rotor (2 teeth) so reluctance torque is non-zero off alignment,
//  stack.slices:1, poles:2.
// ---------------------------------------------------------------------------
function woundConfig() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    gapBand: { iInner: 4, iOuter: 8 },
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
}

// ---------------------------------------------------------------------------
//  pmConfig() — PM machine
//
//  An M rotor (2 magnets), a current-fed stator W ring, one DC circuit,
//  stack.slices:1.
// ---------------------------------------------------------------------------
function pmConfig() {
  return {
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
    stack: { slices: 1 },
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
  };
}

// ---------------------------------------------------------------------------
//  salientConfig() — salient-iron reluctance machine
//
//  An I rotor (2 teeth) and a C stator (concentrated coils), one DC circuit,
//  stack.slices:1. No magnets → lambdaPm = 0 after expand.
// ---------------------------------------------------------------------------
function salientConfig() {
  return {
    grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
    gapBand: { iInner: 4, iOuter: 8 },
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
//
//  Same as woundConfig() with stack.slices:2, sliceOffsets:[0, 0.05].
//  One shared circuit threading both slices.
// ---------------------------------------------------------------------------
function skewN2Config() {
  const cfg = woundConfig();
  cfg.stack = { slices: 2, sliceOffsets: [0, 0.05] };
  return cfg;
}

// ---------------------------------------------------------------------------
//  tinySection({ withMagnet, withIron, turns }) → Phase-2 section
//
//  A hand-built Phase-2 section for motor-slice / motor-stack unit tests.
//  No dependence on config-schema.
//  grid: Nr:6, Ntheta:24, rInner:0.04, rOuter:0.05, ell:0.1
//  gapBand: { iInner:2, iOuter:4 }
//  Always includes one stator conductor circuit (circuit 0).
//  withIron:true → one iron feature in the rotor band.
//  withMagnet:true → one magnet feature in the rotor band.
// ---------------------------------------------------------------------------
function tinySection({ withMagnet, withIron, turns }) {
  turns = turns != null ? turns : 10;
  const TWO_PI = 2 * Math.PI;
  const features = [
    // Stator conductor occupying one slot sector
    {
      kind: "conductor",
      member: "stator",
      rRange: [0.047, 0.05],
      thetaRange: [0, TWO_PI / 12],
      circuit: 0,
      turns: turns,
    },
  ];
  if (withIron) {
    features.push({
      kind: "iron",
      member: "rotor",
      rRange: [0.04, 0.044],
      thetaRange: [0, TWO_PI],
      muR: 1000,
    });
  }
  if (withMagnet) {
    features.push({
      kind: "magnet",
      member: "rotor",
      rRange: [0.04, 0.044],
      thetaRange: [0, Math.PI],
      Mr: 8e5,
      Mtheta: 0,
    });
  }
  return {
    grid: { Nr: 6, Ntheta: 24, rInner: 0.04, rOuter: 0.05, ell: 0.1 },
    gapBand: { iInner: 2, iOuter: 4 },
    features,
  };
}

const UnifiedMotor = window.UnifiedMotor;

module.exports = {
  LIB,
  UnifiedMotor,
  MACHINE_NAMES,
  assertClose,
  woundConfig,
  pmConfig,
  salientConfig,
  skewN2Config,
  tinySection,
};
