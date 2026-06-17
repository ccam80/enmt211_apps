"use strict";

// =============================================================================
//  tests/slice/perf.test.js — D1 embed-vs-Schur escalation diagnostic.
//
//  Times consecutive `solve(...)` calls on the largest realistic-DOF fixture
//  (`hybrid-stepper`, full-annulus zero-symmetry). console.log the per-θ-step
//  mean and max, then assert only that the measurement was captured (positive
//  finite number). The 16 ms threshold is the manual escalation gate: if the
//  log line shows mean or max > 16 ms, report the measurement — the test does
//  NOT fail at 16 ms.
// =============================================================================

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const F = require("./_fixtures.js");
const LIB = F.LIB;
const initSolver = F.initSolver;
const loadMachine = F.loadMachine;
const CS = F.CS;

describe("MotorSlice perf diagnostic", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("embed per-θ-step measurement logged at the realistic-DOF hybrid-stepper", { timeout: 600000 }, function () {
    // Load the hybrid-stepper fixture (full-annulus zero-symmetry, §11.4
    // stress case).
    const cfg = loadMachine("hybrid-stepper");
    const expanded = CS.expand(cfg);
    const poles = expanded.poles;
    const section = expanded.slices[0].section;

    // Build the slice at realistic-DOF: no mesh.refine reduction.
    // Saturation enabled to exercise the full Newton path.
    const slice = LIB.MotorSlice.create(section, {
      poles: poles,
      saturation: { enabled: true, BkneeDefault: 1.6 },
    });
    const m = slice.nCircuits;

    // Loaded current vector (small, just to exercise the conductor RHS path).
    const currents = new Float64Array(m);
    for (let k = 0; k < m; k++) currents[k] = 1.0;

    // Warm-up: one solve so analyze + first factorize don't taint the average.
    slice.solve(0, currents);

    // Time N = 5 consecutive solve(...) calls at small θ increments.
    const N = 5;
    const ts = new Array(N);
    for (let i = 0; i < N; i++) {
      const theta = (i + 1) * Math.PI / 180;
      const t0 = process.hrtime.bigint();
      slice.solve(theta, currents);
      const t1 = process.hrtime.bigint();
      ts[i] = Number(t1 - t0) / 1e6; // ns → ms
    }

    let sum = 0;
    let maxMs = -Infinity;
    for (let i = 0; i < N; i++) {
      sum += ts[i];
      if (ts[i] > maxMs) maxMs = ts[i];
    }
    const meanMs = sum / N;

    // Log the §11.4 line.
    // eslint-disable-next-line no-console
    console.log(
      "[perf] embed per-θ-step (hybrid-stepper, full annulus, full Newton): " +
      "mean=" + meanMs.toFixed(3) + "ms max=" + maxMs.toFixed(3) +
      "ms (§11.4 escalation gate: 16ms)"
    );

    // Sanity assertions — NOT the 16 ms gate.
    assert.ok(Number.isFinite(meanMs), `meanMs=${meanMs} must be finite`);
    assert.ok(meanMs > 0, `meanMs=${meanMs} must be > 0`);
    assert.ok(Number.isFinite(maxMs), `maxMs=${maxMs} must be finite`);
    assert.ok(maxMs >= meanMs, `maxMs=${maxMs} must be >= meanMs=${meanMs}`);
    assert.ok(meanMs < 500,
      `meanMs=${meanMs} must be < 500ms (catastrophic-regression guard; not §11.4 gate)`);
    assert.ok(maxMs < 500,
      `maxMs=${maxMs} must be < 500ms (catastrophic-regression guard; not §11.4 gate)`);
  });
});
