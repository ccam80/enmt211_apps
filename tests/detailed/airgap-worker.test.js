"use strict";

// =============================================================================
//  tests/detailed/airgap-worker.test.js
//
//  Headless tests for lib/airgap-worker.js.
//  Exercises compute (sweep + fieldMap), createSession, selectBackend.
//  Worker bootstrap (importScripts / onmessage) is browser-verified in T8.3.1.
// =============================================================================

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  LIB,
  UnifiedMotor,
  MACHINE_NAMES,
  woundConfig,
  refinedStack,
} = require("./_fixtures.js");

const AirgapWorker = LIB.AirgapWorker;

// ---------------------------------------------------------------------------
//  sweep round-trips a torque-vs-angle table
// ---------------------------------------------------------------------------

test("sweep round-trips a torque-vs-angle table", function () {
  const cfg      = woundConfig();
  const expanded = UnifiedMotor.ConfigSchema.expand(cfg);
  const currents = new Float64Array(expanded.nCircuits);
  currents[0] = 5;

  // 24 uniform samples over [0, π)
  const n = 24;
  const thetas = [];
  for (let k = 0; k < n; k++) thetas.push(k * Math.PI / n);

  const res = AirgapWorker.compute({
    kind:     "sweep",
    expanded,
    currents: Array.from(currents),
    thetas,
  });

  assert.strictEqual(res.kind, "sweepResult",
    "compute sweep must return kind:'sweepResult'");
  assert.strictEqual(res.torques.length, res.thetas.length,
    "torques.length must equal thetas.length");
  assert.strictEqual(res.torques.length, n,
    "torques.length must equal n=" + n);

  // All entries finite
  for (let k = 0; k < n; k++) {
    assert.ok(Number.isFinite(res.torques[k]),
      "torque[" + k + "] must be finite, got " + res.torques[k]);
  }

  // Each entry equals the reference stack solve within 1e-9 relative
  const refStack = refinedStack(cfg, 3);
  for (let k = 0; k < n; k++) {
    refStack.clearWarmStart && refStack.clearWarmStart();
    const refTorque = refStack.solve(thetas[k], currents).torque;
    if (!Number.isFinite(refTorque)) continue; // skip degenerate angles

    const abs = Math.abs(res.torques[k] - refTorque);
    const rel = Math.abs(refTorque) > 1e-12 ? abs / Math.abs(refTorque) : abs;
    assert.ok(rel < 1e-9,
      "torque[" + k + "] must match reference within 1e-9 relative, " +
      "worker=" + res.torques[k] + " ref=" + refTorque + " rel=" + rel);
  }
});

// ---------------------------------------------------------------------------
//  fieldMap returns refined-length field arrays
// ---------------------------------------------------------------------------

test("fieldMap returns refined-length field arrays", function () {
  const cfg      = woundConfig();
  const expanded = UnifiedMotor.ConfigSchema.expand(cfg);
  const currents = new Array(expanded.nCircuits).fill(0);
  currents[0] = 5;

  const res = AirgapWorker.compute({
    kind:     "fieldMap",
    expanded,
    theta:    0.2,
    currents,
  });

  assert.strictEqual(res.kind, "fieldMap",
    "compute fieldMap must return kind:'fieldMap'");

  const expectedLen = res.grid.Nr * res.grid.Ntheta;
  assert.strictEqual(res.Br.length, expectedLen,
    "Br.length must equal grid.Nr * grid.Ntheta");
  assert.strictEqual(res.Bt.length, expectedLen,
    "Bt.length must equal grid.Nr * grid.Ntheta");

  // Ntheta must be the refined (factor*3) value
  const origNtheta = woundConfig().grid.Ntheta;
  assert.strictEqual(res.grid.Ntheta, origNtheta * 3,
    "grid.Ntheta must equal original * 3, got " + res.grid.Ntheta);

  // All entries finite
  for (let k = 0; k < expectedLen; k++) {
    assert.ok(Number.isFinite(res.Br[k]),
      "Br[" + k + "] must be finite");
    assert.ok(Number.isFinite(res.Bt[k]),
      "Bt[" + k + "] must be finite");
  }
});

// ---------------------------------------------------------------------------
//  response is structured-clone-safe
// ---------------------------------------------------------------------------

test("response is structured-clone-safe", function () {
  const cfg      = woundConfig();
  const expanded = UnifiedMotor.ConfigSchema.expand(cfg);
  const currents = new Array(expanded.nCircuits).fill(0);

  const res = AirgapWorker.compute({
    kind:     "sweep",
    expanded,
    currents,
    thetas:   [0, 0.5, 1.0],
  });

  // No functions, no undefined leaves on numeric projection
  function checkLeaves(obj, path) {
    if (obj === null || obj === undefined) {
      // null is ok; undefined would be a problem only if a value field
      return;
    }
    if (typeof obj === "function") {
      assert.fail("structured-clone-safe: function found at " + path);
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        checkLeaves(obj[i], path + "[" + i + "]");
      }
    } else if (typeof obj === "object") {
      for (const key of Object.keys(obj)) {
        checkLeaves(obj[key], path + "." + key);
      }
    }
    // number, string, boolean are fine
  }
  checkLeaves(res, "res");

  // JSON round-trip must succeed and preserve torques
  let jsonStr;
  assert.doesNotThrow(() => { jsonStr = JSON.stringify(res); },
    "JSON.stringify must not throw");
  const parsed = JSON.parse(jsonStr);
  assert.deepStrictEqual(parsed.torques, res.torques,
    "JSON round-trip must preserve torques");
});

// ---------------------------------------------------------------------------
//  createSession runs the refined time-domain sim and turns the rotor
// ---------------------------------------------------------------------------

test("createSession runs the refined time-domain sim and turns the rotor", function () {
  this.timeout && this.timeout(180000); // allow up to 3 min (refined backend is slow)

  const cfg      = woundConfig();
  const expanded = UnifiedMotor.ConfigSchema.expand(cfg);

  const session = AirgapWorker.createSession({
    expanded,
    backendOpts: { factor: 2 },
  });

  const dt = 1 / 240;
  const steps = 300;
  for (let n = 0; n < steps; n++) {
    session.step(dt);
  }

  const theta = session.runtime.state.theta;
  assert.ok(Number.isFinite(theta),
    "session.runtime.state.theta must be finite after " + steps + " steps, got " + theta);
  assert.ok(Math.abs(theta) > 1e-3,
    "rotor must turn by > 1e-3 rad, got theta=" + theta);
});

// ---------------------------------------------------------------------------
//  createSession seeds from stateSeed
// ---------------------------------------------------------------------------

test("createSession seeds from stateSeed", function () {
  const cfg      = woundConfig();
  const expanded = UnifiedMotor.ConfigSchema.expand(cfg);

  const seed = {
    theta:     0.5,
    omega:     2,
    t:         0.1,
    stepIndex: 1,
    i:         new Array(expanded.nCircuits).fill(0),
  };

  const session = AirgapWorker.createSession({
    expanded,
    stateSeed: seed,
  });

  assert.strictEqual(session.runtime.state.theta,     0.5,  "theta must be seeded");
  assert.strictEqual(session.runtime.state.omega,     2,    "omega must be seeded");
  assert.strictEqual(session.runtime.state.t,         0.1,  "t must be seeded");
  assert.strictEqual(session.runtime.state.stepIndex, 1,    "stepIndex must be seeded");
});

// ---------------------------------------------------------------------------
//  selectBackend defaults to refined and guards the nonlinear tier
// ---------------------------------------------------------------------------

test("selectBackend defaults to refined and guards the nonlinear tier", function () {
  // Default (undefined) → refined backend
  const b1 = AirgapWorker.selectBackend(undefined);
  assert.ok(b1 && typeof b1.prepare         === "function", "default backend must have prepare");
  assert.ok(b1 && typeof b1.solveSaturated  === "function", "default backend must have solveSaturated");
  assert.ok(b1 && typeof b1.linearSolve     === "function", "default backend must have linearSolve");

  // { tier: "refined" } → refined backend
  const b2 = AirgapWorker.selectBackend({ tier: "refined" });
  assert.ok(b2 && typeof b2.prepare         === "function", "refined tier backend must have prepare");
  assert.ok(b2 && typeof b2.solveSaturated  === "function", "refined tier backend must have solveSaturated");
  assert.ok(b2 && typeof b2.linearSolve     === "function", "refined tier backend must have linearSolve");

  // { tier: "nonlinear" } → throws when LIB.AirgapNonlinear is absent (Phase-8 time)
  assert.ok(!LIB.AirgapNonlinear,
    "LIB.AirgapNonlinear must be absent in the Phase-8 test suite");
  assert.throws(
    () => AirgapWorker.selectBackend({ tier: "nonlinear" }),
    /nonlinear backend not loaded/i,
    "selectBackend({tier:'nonlinear'}) must throw when AirgapNonlinear absent"
  );
});

// ---------------------------------------------------------------------------
//  worker imports no app-layer config-schema and no machine name
// ---------------------------------------------------------------------------

test("worker imports no app-layer config-schema and no machine name", function () {
  const fs   = require("node:fs");
  const path = require("node:path");
  const src  = fs.readFileSync(
    path.join(__dirname, "../../lib/airgap-worker.js"),
    "utf8"
  );
  const srcLower = src.toLowerCase();

  assert.ok(
    !srcLower.includes("config-schema"),
    "airgap-worker.js must not reference config-schema"
  );

  for (const name of MACHINE_NAMES) {
    assert.ok(
      !srcLower.includes(name.toLowerCase()),
      "airgap-worker.js source must not contain machine name: " + name
    );
  }
});
