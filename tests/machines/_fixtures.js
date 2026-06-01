"use strict";

// =============================================================================
//  Shared loader and measurement helpers for machine validation tests.
//  Not a test file — no .test.js suffix. Required by the machine test files.
//
//  Loads the pipeline loader (read-only), which installs window + all
//  engine/pipeline libs and exposes LIB, UnifiedMotor, assertClose, fitCos2.
//  Requires all 15 machine fixtures so they register on UnifiedMotor.MACHINES.
//  Exports the agnostic-pipeline drivers and analytic/cross-check helpers.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { before } = require("node:test");

// Pipeline loader — installs window + engine/pipeline libs.
const P = require("../pipeline/_fixtures.js");

// HarmonicSet (sparse-basis derivation) — not part of the pipeline loader; load
// it onto the shared window.LIB so the SPARSE_HARMONICS gate harness can use it.
require(path.join(__dirname, "..", "..", "lib", "harmonic-set.js"));

const LIB        = P.LIB;
const UnifiedMotor = P.UnifiedMotor;
const assertClose = P.assertClose;
const initSolver = P.initSolver;

// Every machine test builds a MotorStack/MotorSlice, which requires the WASM
// FEA solver to be loaded. init() is async (dynamic import + WASM instantiate),
// so it cannot be awaited at require-time; register it as the test runner's
// root before-hook. This module is required at the top of every machine
// *.test.js before any test() call, so the hook lands in that file's root
// suite and resolves before its first test runs.
before(async () => { await initSolver(); });
// fitCos2 lived in tests/engine/_fixtures.js in a prior project attempt;
// that whole tests/engine/ directory no longer exists. The function itself
// lives in tests/_assert.js — import directly to drop the dead indirection.
const fitCos2    = require("../_assert.js").fitCos2;

// ---------------------------------------------------------------------------
//  Load all 15 machine fixtures so they register on UnifiedMotor.MACHINES.
// ---------------------------------------------------------------------------
const MACHINES_DIR = path.join(__dirname, "../../lessons/unified_motor/machines");

const FIXTURE_FILES = [
  "pmsm.js",
  "brushed-dc-pm.js",
  "brushed-dc-wound.js",
  "universal.js",
  "bldc.js",
  "induction-3ph.js",
  "induction-1ph.js",
  "vr-stepper.js",
  "switched-reluctance.js",
  "pm-stepper.js",
  "hybrid-stepper.js",
  "synchronous-reluctance.js",
  "wound-field-synchronous.js",
  "skew-demo.js",
  "pole-mismatch-demo.js",
];

for (const file of FIXTURE_FILES) {
  require(path.join(MACHINES_DIR, file));
}

// ---------------------------------------------------------------------------
//  byId — quick lookup by machine id.
// ---------------------------------------------------------------------------
const byId = Object.fromEntries(
  UnifiedMotor.MACHINES.map(function (m) { return [m.id, m]; })
);

// ---------------------------------------------------------------------------
//  MACHINE_IDS — frozen array of all 15 ids, in fixture declaration order.
// ---------------------------------------------------------------------------
const MACHINE_IDS = Object.freeze([
  "pmsm",
  "brushed-dc-pm",
  "brushed-dc-wound",
  "universal",
  "bldc",
  "induction-3ph",
  "induction-1ph",
  "vr-stepper",
  "switched-reluctance",
  "pm-stepper",
  "hybrid-stepper",
  "synchronous-reluctance",
  "wound-field-synchronous",
  "skew-demo",
  "pole-mismatch-demo",
]);

// ---------------------------------------------------------------------------
//  Cross-check tolerance constants.
// ---------------------------------------------------------------------------
const XC_TOL   = 0.05;
const XC_FLOOR = 1e-6;

// ---------------------------------------------------------------------------
//  build(id) → { config, expanded, stack, runtime }
//
//  Expands the config schema, creates the MotorStack and MotorRun runtime.
// ---------------------------------------------------------------------------
// Gate harness: when SPARSE_HARMONICS is set, build every machine with the
// geometry-derived sparse harmonic basis (LIB.HarmonicSet) instead of the dense
// K=3·max(slots,poles) truncation, so the full machine suite becomes the
// definitive accuracy gate for the sparse basis vs the full-K baseline. The
// derived kList is cached per machine id (the derivation does ~nCircuits FE
// solves). opts.kList threads through to both the static stack and the runtime.
var _kListCache = {};
function deriveKList(id, expanded) {
  if (_kListCache[id] !== undefined) return _kListCache[id];
  var HS = global.window.LIB.HarmonicSet;
  var full = LIB.MotorStack.create(expanded);
  var cfg = byId[id].config, slots = [];
  for (var i = 0; i < cfg.rings.length; i++) {
    var r = cfg.rings[i];
    if (r.winding && r.winding.standard) slots.push(r.winding.standard.Q);
    if (r.cage) slots.push(r.cage.bars);
    if (r.teeth && r.teeth > 1) slots.push(r.teeth);
  }
  var res = HS.derive(HS.probeFromStack(full, slots), { epsilon: 0.01, angles: [0, 0.041] });
  _kListCache[id] = res.kList;
  return res.kList;
}

function build(id) {
  var config   = byId[id].config;
  var expanded = UnifiedMotor.ConfigSchema.expand(config);
  var opts = {};
  if (process.env.SPARSE_HARMONICS) opts.kList = deriveKList(id, expanded);
  // SCHUR_NEWTON gate: Schur-condense the saturated Newton inner solve. Exact
  // reduction of the same tangent, so the suite must reproduce the full-K
  // baseline pass/fail set (within solver tolerances).
  if (process.env.SCHUR_NEWTON) opts.schur = true;
  // GAP_METHOD=mortar → real-space FE air-gap band coupling instead of harmonic.
  if (process.env.GAP_METHOD) opts.gapMethod = process.env.GAP_METHOD;
  var stack    = LIB.MotorStack.create(expanded, opts);
  var runtime  = LIB.MotorRun.create(expanded, opts);
  return { config: config, expanded: expanded, stack: stack, runtime: runtime };
}


// ---------------------------------------------------------------------------
//  validate(id) → { ok, errors }
//
//  Runs ConfigSchema.validate on the fixture config.
// ---------------------------------------------------------------------------
function validate(id) {
  return UnifiedMotor.ConfigSchema.validate(byId[id].config);
}

// ---------------------------------------------------------------------------
//  sweepTorque(stack, currents, thetas) → number[]
//
//  For each θ in thetas: stack.solve(θ, currents).torque.
//  currents may be a Float64Array or a function θ → Float64Array.
// ---------------------------------------------------------------------------
function sweepTorque(stack, currents, thetas) {
  var results = [];
  for (var k = 0; k < thetas.length; k++) {
    var theta = thetas[k];
    var cur = (typeof currents === "function") ? currents(theta) : currents;
    results.push(stack.solve(theta, cur).torque);
  }
  return results;
}

// ---------------------------------------------------------------------------
//  sweepInductance(stack, thetas, kk) → number[]
//
//  For each θ: diagonal self-inductance of circuit kk.
//  Index into the L matrix: kk * nCircuits + kk.
// ---------------------------------------------------------------------------
function sweepInductance(stack, thetas, kk) {
  var m = stack.nCircuits;
  var results = [];
  for (var k = 0; k < thetas.length; k++) {
    var coeffs = stack.extractCoeffs(thetas[k]);
    results.push(coeffs.L[kk * m + kk]);
  }
  return results;
}

// ---------------------------------------------------------------------------
//  sweepLambdaPm(stack, thetas, k) → number[]
//
//  For each θ: lambdaPm[k] from extractCoeffs.
// ---------------------------------------------------------------------------
function sweepLambdaPm(stack, thetas, k) {
  var results = [];
  for (var n = 0; n < thetas.length; n++) {
    var coeffs = stack.extractCoeffs(thetas[n]);
    results.push(coeffs.lambdaPm[k]);
  }
  return results;
}

// ---------------------------------------------------------------------------
//  crossCheck(stack, theta, currents) → { arkkio, coe, rel, ok }
//
//  Maxwell (Arkkio) vs co-energy cross-check at a single operating point.
//  Maxwell-vs-co-energy is only defined where the iron is linear (the T5.5.1
//  methodology), so BOTH sides are evaluated on a ceiling-DISABLED stack rebuilt
//  from the same expanded config: the Arkkio solve and the co-energy extractor
//  see the identical linear material. (Resolution 2026-05-25 — previously the
//  Arkkio side used the caller's ceiling-ON stack while co-energy was the linear
//  extractor, the documented mismatch.)
//
//  ok === true when:
//    max(|arkkio|, |coe|) <= 1e-5   (near-zero — guard clause)
//    OR  rel <= XC_TOL * max(|arkkio|, |coe|) + XC_FLOOR
// ---------------------------------------------------------------------------
function crossCheck(stack, theta, currents) {
  var stackLin = LIB.MotorStack.create(stack.expanded, { saturation: { enabled: false } });
  var arkkio = stackLin.solve(theta, currents).torque;
  var coe    = stackLin.coenergyTorque(theta, currents).total;
  var rel    = Math.abs(arkkio - coe);
  var mag    = Math.max(Math.abs(arkkio), Math.abs(coe));
  var ok     = (mag <= 1e-5) || (rel <= XC_TOL * mag + XC_FLOOR);
  return { arkkio: arkkio, coe: coe, rel: rel, ok: ok };
}

// ---------------------------------------------------------------------------
//  runFromRest(runtime, steps = 400, dt = 1/240) → state
//
//  Resets the runtime then steps `steps` times at dt seconds per step.
//  Returns runtime.state after the last step.
// ---------------------------------------------------------------------------
function runFromRest(runtime, steps, dt) {
  if (steps === undefined) steps = 400;
  if (dt    === undefined) dt    = 1 / 240;
  runtime.reset();
  for (var k = 0; k < steps; k++) {
    runtime.step(dt);
  }
  return runtime.state;
}

// ---------------------------------------------------------------------------
//  avgTorqueAtSpeed(runtime, omega, cycles, freq, dt = 1/240) → number
//
//  Resets the runtime, pins the rotor at fixed omega after every step, and
//  accumulates the Arkkio torque over `cycles` electrical periods. Returns
//  the mean torque over those cycles.
//
//  period = 1 / max(freq, 1e-9); total steps = ceil(cycles * period / dt).
// ---------------------------------------------------------------------------
function avgTorqueAtSpeed(runtime, omega, cycles, freq, dt) {
  if (dt === undefined) dt = 1 / 240;
  runtime.reset();
  runtime.state.omega = omega;

  var period     = 1 / Math.max(freq, 1e-9);
  var totalTime  = cycles * period;
  var steps      = Math.ceil(totalTime / dt);
  var torqueSum  = 0;
  var count      = 0;

  for (var k = 0; k < steps; k++) {
    runtime.step(dt);
    // Re-pin rotor speed so the rotor advances at the prescribed omega.
    runtime.state.omega = omega;
    var lastSolve = runtime.lastSolve;
    if (lastSolve !== null) {
      torqueSum += lastSolve.torque;
      count++;
    }
  }

  return count > 0 ? torqueSum / count : 0;
}

// ---------------------------------------------------------------------------
//  dftAmp(values, order) → number
//
//  Discrete Fourier amplitude of harmonic `order` over uniformly-sampled
//  `values` (one period):
//    amp = 2/N * hypot(Σ vₙ cos(2π·order·n/N), Σ vₙ sin(2π·order·n/N))
// ---------------------------------------------------------------------------
function dftAmp(values, order) {
  var N = values.length;
  var re = 0;
  var im = 0;
  for (var n = 0; n < N; n++) {
    var angle = 2 * Math.PI * order * n / N;
    re += values[n] * Math.cos(angle);
    im += values[n] * Math.sin(angle);
  }
  return (2 / N) * Math.hypot(re, im);
}

// ---------------------------------------------------------------------------
//  signChanges(values) → int
//
//  Count of adjacent sign flips in `values` (periodicity probe for detent).
//  A sign flip occurs when consecutive nonzero values have opposite signs.
// ---------------------------------------------------------------------------
function signChanges(values) {
  var count = 0;
  var prevSign = 0;
  for (var k = 0; k < values.length; k++) {
    var s = Math.sign(values[k]);
    if (s !== 0) {
      if (prevSign !== 0 && s !== prevSign) {
        count++;
      }
      prevSign = s;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
//  ripple(values) → number
//
//  Peak-to-peak range: max - min.
// ---------------------------------------------------------------------------
function ripple(values) {
  var mn = values[0];
  var mx = values[0];
  for (var k = 1; k < values.length; k++) {
    if (values[k] < mn) mn = values[k];
    if (values[k] > mx) mx = values[k];
  }
  return mx - mn;
}

// ---------------------------------------------------------------------------
//  mean(values) → number
// ---------------------------------------------------------------------------
function mean(values) {
  var sum = 0;
  for (var k = 0; k < values.length; k++) {
    sum += values[k];
  }
  return sum / values.length;
}

// ---------------------------------------------------------------------------
//  readIndexHtml() → string
//
//  Reads the unified_motor index.html for script-tag presence checks.
// ---------------------------------------------------------------------------
function readIndexHtml() {
  var htmlPath = path.join(__dirname, "../../lessons/unified_motor/index.html");
  return fs.readFileSync(htmlPath, "utf8");
}

module.exports = {
  LIB:          LIB,
  UnifiedMotor: UnifiedMotor,
  byId:         byId,
  MACHINE_IDS:  MACHINE_IDS,
  assertClose:  assertClose,
  initSolver:   initSolver,
  fitCos2:      fitCos2,
  XC_TOL:       XC_TOL,
  XC_FLOOR:     XC_FLOOR,
  build:        build,
  validate:     validate,
  sweepTorque:      sweepTorque,
  sweepInductance:  sweepInductance,
  sweepLambdaPm:    sweepLambdaPm,
  crossCheck:       crossCheck,
  runFromRest:      runFromRest,
  avgTorqueAtSpeed: avgTorqueAtSpeed,
  dftAmp:       dftAmp,
  signChanges:  signChanges,
  ripple:       ripple,
  mean:         mean,
  readIndexHtml: readIndexHtml,
};
