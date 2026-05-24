"use strict";

// =============================================================================
//  tests/detailed/_fixtures.js — Phase-8 detailed-mode test fixtures
//
//  Not a test file (no .test.js suffix). Required by all tests/detailed/*.test.js.
//
//  On require:
//    1. Loads the full pipeline fixture (window shim + engine/pipeline libs +
//       UnifiedMotor.ConfigSchema + assertClose + sample configs + MACHINE_NAMES).
//    2. Directly requires the Phase-8 lib and app modules.
//    3. Exports everything downstream tests need.
// =============================================================================

// Phase-5 pipeline fixtures: installs window + engine libs + ConfigSchema
const P = require("../pipeline/_fixtures.js");

// Phase-8 lib modules
require("../../lib/airgap-refine.js");
require("../../lib/airgap-worker.js");

// Phase-8 app module
require("../../lessons/unified_motor/detailed-toggle.js");

// ---------------------------------------------------------------------------
//  Re-exports from the pipeline fixture
// ---------------------------------------------------------------------------
const LIB         = P.LIB;
const UnifiedMotor = P.UnifiedMotor;
const assertClose  = P.assertClose;
const MACHINE_NAMES = P.MACHINE_NAMES;

function woundConfig()   { return P.woundConfig();   }
function pmConfig()      { return P.pmConfig();      }
function salientConfig() { return P.salientConfig(); }

// ---------------------------------------------------------------------------
//  coggingConfig() — slotted-PM config that cogs at zero current
//
//  Uses a small grid so multigrid convergence tests stay fast.
//  grid: Nr:8, Ntheta:64, rInner:0.030, rOuter:0.055, ell:0.10
//  gapBand: iInner:4, iOuter:5  (1-cell gap band — correct for this geometry)
//  poles: 4
// ---------------------------------------------------------------------------
function coggingConfig() {
  return {
    grid: {
      Nr: 8, Ntheta: 64,
      rInner: 0.030, rOuter: 0.055, ell: 0.10,
    },
    gapBand: { iInner: 4, iOuter: 5 },
    poles: 4,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        magnets: 4,
        Mr: 8e5,
        backIron: true,
        backIronRRange: [0.030, 0.038],
        muR: 1000,
        rRange: [0.038, 0.043],
      },
      {
        member: "stator",
        element: "C",
        winding: { standard: { m: 3, p: 4, Q: 12, coilPitch: 1, turns: 40 } },
        rRange: [0.047, 0.051],
        slotRRange: [0.047, 0.051],
        slotFraction: 0.5,
        ironRRange: [0.051, 0.055],
        muR: 1000,
        spanFraction: 0.5,
      },
    ],
    circuits: [
      { terminal: { type: "DC", amp: 0 }, commutation: { mode: "none" }, R: 0.5 },
      { terminal: { type: "DC", amp: 0 }, commutation: { mode: "none" }, R: 0.5 },
      { terminal: { type: "DC", amp: 0 }, commutation: { mode: "none" }, R: 0.5 },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };
}

// ---------------------------------------------------------------------------
//  refinedStack(config, factor) → LIB.MotorStack instance
// ---------------------------------------------------------------------------
function refinedStack(config, factor) {
  return LIB.MotorStack.create(
    UnifiedMotor.ConfigSchema.expand(config),
    { backend: LIB.AirgapRefine.backend({ factor: factor }) }
  );
}

// ---------------------------------------------------------------------------
//  coarseStack(config) → LIB.MotorStack instance (Live / default backend)
// ---------------------------------------------------------------------------
function coarseStack(config) {
  return LIB.MotorStack.create(UnifiedMotor.ConfigSchema.expand(config));
}

// ---------------------------------------------------------------------------
//  sweepTorque(stack, currents, thetas) → number[]
// ---------------------------------------------------------------------------
function sweepTorque(stack, currents, thetas) {
  const out = [];
  for (let k = 0; k < thetas.length; k++) {
    out.push(stack.solve(thetas[k], currents).torque);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Waveform helpers
// ---------------------------------------------------------------------------
function ripple(values) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < values.length; k++) {
    if (values[k] < lo) lo = values[k];
    if (values[k] > hi) hi = values[k];
  }
  return hi - lo;
}

function mean(values) {
  let s = 0;
  for (let k = 0; k < values.length; k++) s += values[k];
  return s / values.length;
}

function signChanges(values) {
  let n = 0;
  for (let k = 1; k < values.length; k++) {
    if (values[k - 1] * values[k] < 0) n++;
  }
  return n;
}

function amp(values) {
  return ripple(values) / 2;
}

// ---------------------------------------------------------------------------
//  spyBackend(inner) → SolveBackend with call counters
// ---------------------------------------------------------------------------
function spyBackend(inner) {
  let prepareCalls       = 0;
  let solveSaturatedCalls = 0;
  let linearSolveCalls   = 0;

  return {
    get prepareCalls()        { return prepareCalls; },
    get solveSaturatedCalls() { return solveSaturatedCalls; },
    get linearSolveCalls()    { return linearSolveCalls; },

    prepare(section) {
      prepareCalls++;
      return inner.prepare(section);
    },
    solveSaturated(op, b, o) {
      solveSaturatedCalls++;
      return inner.solveSaturated(op, b, o);
    },
    linearSolve(op, b, o) {
      linearSolveCalls++;
      return inner.linearSolve(op, b, o);
    },
  };
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------
module.exports = {
  LIB,
  UnifiedMotor,
  assertClose,
  MACHINE_NAMES,
  woundConfig,
  pmConfig,
  salientConfig,
  coggingConfig,
  refinedStack,
  coarseStack,
  sweepTorque,
  ripple,
  mean,
  signChanges,
  amp,
  spyBackend,
};
