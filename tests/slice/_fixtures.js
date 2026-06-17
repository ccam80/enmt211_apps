"use strict";

// =============================================================================
//  Shared fixtures for slice tests.
//  Not a test file — no .test.js suffix. Required by test files.
//
//  Loads the engine shim (window + engine libs), then directly requires the
//  engine modules and the config-schema app module.
// =============================================================================

if (!globalThis.window) globalThis.window = globalThis;

const path = require("path");

require("../_shim.js");

require("../../lib/winding-model.js");
require("../../lib/excitation.js");
require("../../lib/motor-circuit.js");
require("../../lib/motor-mesh.js");
require("../../lib/motor-mesh-view.js");
require("../../lib/airgap-mortar.js");

// Point fea-solver at the absolute mjs path BEFORE requiring it.
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/motor-slice.js");
require("../../lib/motor-stack.js");

require("../../lessons/unified_motor/config-schema.js");

const LIB           = window.LIB;
const UnifiedMotor  = window.UnifiedMotor;
const CS            = UnifiedMotor.ConfigSchema;

const { assertClose } = require("../_assert.js");

// ---------------------------------------------------------------------------
//  initSolver() → Promise<void>
//  Memoized init handle that every test awaits before constructing a slice.
// ---------------------------------------------------------------------------
let _initPromise = null;
function initSolver() {
  if (!_initPromise) _initPromise = LIB.FeaSolver.init();
  return _initPromise;
}

// ---------------------------------------------------------------------------
//  sectionFromConfig(config) → section
//  polesFromConfig(config)   → number
// ---------------------------------------------------------------------------
function sectionFromConfig(config) {
  return CS.expand(config).slices[0].section;
}

function polesFromConfig(config) {
  return CS.expand(config).poles;
}

// ---------------------------------------------------------------------------
//  loadMachine(id) → config
// ---------------------------------------------------------------------------
function loadMachine(id) {
  require("../../lessons/unified_motor/machines/" + id + ".js");
  const entry = UnifiedMotor.MACHINES.find(function (m) { return m.id === id; });
  if (!entry) throw new Error("loadMachine: machine id '" + id + "' not found");
  return entry.config;
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
//  Test machine configs (mirroring tests/pipeline/_fixtures.js)
// ---------------------------------------------------------------------------
function woundConfig() {
  return {
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
}

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
//  relErrInf(x, ref) → number
// ---------------------------------------------------------------------------
function relErrInf(x, ref) {
  let maxErr = 0;
  let maxRef = 0;
  const n = Math.min(x.length, ref.length);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(x[i] - ref[i]);
    if (e > maxErr) maxErr = e;
    const r = Math.abs(ref[i]);
    if (r > maxRef) maxRef = r;
  }
  return maxErr / Math.max(1, maxRef);
}

// ---------------------------------------------------------------------------
//  solveCombinedDense(n, I, J, V, b) → Float64Array
//  Small dense LDLT/Gauss solver for unit tests of assembled triplet systems.
//  Only used at small n.
// ---------------------------------------------------------------------------
function solveCombinedDense(n, I, J, V, b) {
  const A = new Float64Array(n * n);
  for (let t = 0; t < I.length; t++) {
    A[I[t] * n + J[t]] += V[t];
  }
  // Gaussian elimination with partial pivoting on [A|b].
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i*(n+1) + j] = A[i*n + j];
    M[i*(n+1) + n] = b[i];
  }
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(M[col*(n+1) + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row*(n+1) + col]);
      if (v > pivotVal) { pivotVal = v; pivotRow = row; }
    }
    if (pivotRow !== col) {
      for (let j = 0; j <= n; j++) {
        const tmp = M[col*(n+1) + j];
        M[col*(n+1) + j] = M[pivotRow*(n+1) + j];
        M[pivotRow*(n+1) + j] = tmp;
      }
    }
    const diag = M[col*(n+1) + col];
    if (Math.abs(diag) < 1e-30) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = M[row*(n+1) + col] / diag;
      for (let j = col; j <= n; j++) {
        M[row*(n+1) + j] -= factor * M[col*(n+1) + j];
      }
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i*(n+1) + n];
    for (let j = i + 1; j < n; j++) s -= M[i*(n+1) + j] * x[j];
    const diag = M[i*(n+1) + i];
    x[i] = Math.abs(diag) < 1e-30 ? 0 : s / diag;
  }
  return x;
}

module.exports = {
  LIB,
  UnifiedMotor,
  CS,
  initSolver,
  sectionFromConfig,
  polesFromConfig,
  loadMachine,
  feaOpts,
  assertClose,
  relErrInf,
  solveCombinedDense,
  woundConfig,
  pmConfig,
  salientConfig,
};
