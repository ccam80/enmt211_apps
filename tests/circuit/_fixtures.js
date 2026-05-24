"use strict";

// =============================================================================
//  Shared fixtures and helpers for circuit tests.
//  Not a test file — no .test.js suffix.
//
//  Loads the window global and the Phase-1 lib modules individually, then
//  requires motor-circuit.js so LIB.MotorCircuit is attached.
//  Does NOT require("../_shim.js").
// =============================================================================

if (!globalThis.window) globalThis.window = globalThis;

require("../../lib/util.js");
require("../../lib/integrate.js");
require("../../lib/airgap-grid.js");
require("../../lib/airgap-solve.js");
require("../../lib/motor-circuit.js");

const { assertClose, buildSalient, fitCos2, SALIENT_DEFAULTS } =
  require("../engine/_fixtures.js");

const LIB = globalThis.window.LIB;

// ---------------------------------------------------------------------------
//  rl1({ L, R }) → coeffs
//  Single-circuit (m=1) constant coeffs object with no saliency or PM.
// ---------------------------------------------------------------------------
function rl1({ L, R }) {
  return {
    L:              new Float64Array([L]),
    dLdth:          new Float64Array([0]),
    lambdaPm:       new Float64Array([0]),
    dLambdaPmdth:   new Float64Array([0]),
    _R:             new Float64Array([R]),
  };
}

// ---------------------------------------------------------------------------
//  mutual2({ L0, L1, M }) → coeffs
//  Two-circuit (m=2) constant-mutual coeffs with no saliency or PM.
//  L = [L0, M, M, L1] (row-major).
// ---------------------------------------------------------------------------
function mutual2({ L0, L1, M }) {
  return {
    L:              new Float64Array([L0, M, M, L1]),
    dLdth:          new Float64Array(4),
    lambdaPm:       new Float64Array(2),
    dLambdaPmdth:   new Float64Array(2),
  };
}

module.exports = { LIB, assertClose, buildSalient, fitCos2, SALIENT_DEFAULTS, rl1, mutual2 };
