"use strict";

// =============================================================================
//  tests/detailed/detailed-toggle.test.js
//
//  Headless tests for lessons/unified_motor/detailed-toggle.js.
//  Exercises all pure helpers; DOM/Worker/canvas paths are browser-verified
//  in Task 8.3.1.
// =============================================================================

const assert = require("node:assert/strict");
const test   = require("node:test");
const path   = require("node:fs");

const {
  LIB,
  UnifiedMotor,
  MACHINE_NAMES,
  woundConfig,
} = require("./_fixtures.js");

const DetailedToggle = UnifiedMotor.DetailedToggle;

// ---------------------------------------------------------------------------
//  thetaSweep
// ---------------------------------------------------------------------------

test("thetaSweep spans [0,2π) with cell-centre offset", function () {
  const n   = 180;
  const TWO_PI = 2 * Math.PI;
  const sw  = DetailedToggle.thetaSweep(n);

  assert.strictEqual(sw.constructor, Float64Array,
    "thetaSweep should return a Float64Array");
  assert.strictEqual(sw.length, n);

  const expected0 = 0.5 * TWO_PI / n;
  assert.ok(
    Math.abs(sw[0] - expected0) < 1e-12,
    "sw[0] should equal 0.5*2π/n, got " + sw[0] + " expected " + expected0
  );

  // Strictly increasing
  for (let k = 1; k < n; k++) {
    assert.ok(sw[k] > sw[k - 1],
      "thetaSweep should be strictly increasing at k=" + k);
  }

  // Last entry strictly less than 2π
  assert.ok(sw[n - 1] < TWO_PI,
    "thetaSweep last entry should be < 2π, got " + sw[n - 1]);
});

// ---------------------------------------------------------------------------
//  buildStartMessage
// ---------------------------------------------------------------------------

test("buildStartMessage expands config and serialises state", function () {
  const cfg = woundConfig();
  const n   = UnifiedMotor.ConfigSchema.expand(cfg).nCircuits;

  const stubState = {
    theta:     0.2,
    omega:     1,
    t:         0.05,
    stepIndex: 2,
    i:         new Float64Array(n),
  };

  const msg = DetailedToggle.buildStartMessage(cfg, stubState, {});

  assert.strictEqual(msg.kind, "start");
  assert.strictEqual(msg.expanded.nCircuits, n);
  assert.ok(Array.isArray(msg.stateSeed.i),
    "stateSeed.i must be a plain Array, not Float64Array");
  assert.strictEqual(msg.backendOpts.factor, 3);
  assert.ok(Math.abs(msg.dt - 1 / 240) < 1e-15,
    "dt should be 1/240");
  assert.strictEqual(msg.stepsPerMessage, 4);
});

// ---------------------------------------------------------------------------
//  buildSweepMessage
// ---------------------------------------------------------------------------

test("buildSweepMessage builds a zero-current table request", function () {
  const cfg = woundConfig();
  const n   = UnifiedMotor.ConfigSchema.expand(cfg).nCircuits;
  const zeros = new Float64Array(n);

  const msg = DetailedToggle.buildSweepMessage(cfg, zeros, 60);

  assert.strictEqual(msg.kind, "sweep");
  assert.ok(Array.isArray(msg.currents),
    "currents must be a plain Array");
  assert.strictEqual(msg.currents.length, n);
  assert.strictEqual(msg.thetas.length, 60);
});

// ---------------------------------------------------------------------------
//  applyFrame
// ---------------------------------------------------------------------------

test("applyFrame copies state into the render target", function () {
  const target = {};
  DetailedToggle.applyFrame(target, {
    state: { theta: 1, omega: 2, t: 3, stepIndex: 4, i: [1, 2] },
    torque: 0.5,
  });

  assert.strictEqual(target.theta,     1);
  assert.strictEqual(target.omega,     2);
  assert.strictEqual(target.t,         3);
  assert.strictEqual(target.stepIndex, 4);
  assert.deepStrictEqual(target.i,     [1, 2]);
  assert.strictEqual(target.torque,    0.5);
});

// ---------------------------------------------------------------------------
//  workerAvailable + register (guarded no-op under Node shim)
// ---------------------------------------------------------------------------

test("workerAvailable is false under the shim; register is a guarded no-op", function () {
  // Worker is not defined in the Node shim
  assert.strictEqual(DetailedToggle.workerAvailable(), false);

  // register(UM) with no seams present must not throw and must leave
  // UnifiedMotor.DetailedToggle defined
  const fakeUM = {};
  assert.doesNotThrow(function () {
    DetailedToggle.register(fakeUM);
  });

  assert.ok(UnifiedMotor.DetailedToggle !== undefined,
    "UnifiedMotor.DetailedToggle must be defined after module load");
});

// ---------------------------------------------------------------------------
//  buildStartMessage forwards backendOpts.tier
// ---------------------------------------------------------------------------

test("buildStartMessage forwards a supplied backendOpts.tier", function () {
  const cfg = woundConfig();
  const n   = UnifiedMotor.ConfigSchema.expand(cfg).nCircuits;

  const stubState = {
    theta:     0,
    omega:     0,
    t:         0,
    stepIndex: 0,
    i:         new Float64Array(n),
  };

  const msg = DetailedToggle.buildStartMessage(cfg, stubState, {
    backendOpts: { factor: 3, tier: "nonlinear" },
  });

  assert.strictEqual(msg.backendOpts.tier,   "nonlinear");
  assert.strictEqual(msg.backendOpts.factor, 3);
});

// ---------------------------------------------------------------------------
//  Machine-agnosticism: no machine-name string in source
// ---------------------------------------------------------------------------

test("no machine-name string in source", function () {
  const fs  = require("node:fs");
  const src = fs.readFileSync(
    require("node:path").join(__dirname, "../../lessons/unified_motor/detailed-toggle.js"),
    "utf8"
  ).toLowerCase();

  for (const name of MACHINE_NAMES) {
    assert.ok(
      !src.includes(name.toLowerCase()),
      "detailed-toggle.js source must not contain machine name: " + name
    );
  }
});
