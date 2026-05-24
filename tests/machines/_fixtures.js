"use strict";

// =============================================================================
//  Shared loader and measurement helpers for Phase-6 machine validation tests.
//  Not a test file — no .test.js suffix. Required by Wave-6.3 test files.
//
//  Loads the Phase-5 pipeline loader (read-only), which installs window + all
//  engine/pipeline libs and exposes LIB, UnifiedMotor, assertClose, fitCos2.
//  Requires all 15 machine fixtures so they register on UnifiedMotor.MACHINES.
//  Exports the agnostic-pipeline drivers and analytic/cross-check helpers.
// =============================================================================

const fs = require("fs");
const path = require("path");

// Phase-5 pipeline loader — installs window + engine/pipeline libs.
const P = require("../pipeline/_fixtures.js");

const LIB        = P.LIB;
const UnifiedMotor = P.UnifiedMotor;
const assertClose = P.assertClose;
const fitCos2    = P.fitCos2;

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
function build(id) {
  var config   = byId[id].config;
  var expanded = UnifiedMotor.ConfigSchema.expand(config);
  var stack    = LIB.MotorStack.create(expanded);
  var runtime  = LIB.MotorRun.create(expanded);
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
//  ok === true when:
//    max(|arkkio|, |coe|) <= 1e-5   (near-zero — guard clause)
//    OR  rel <= XC_TOL * max(|arkkio|, |coe|) + XC_FLOOR
// ---------------------------------------------------------------------------
function crossCheck(stack, theta, currents) {
  var arkkio = stack.solve(theta, currents).torque;
  var coe    = stack.coenergyTorque(theta, currents).total;
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
