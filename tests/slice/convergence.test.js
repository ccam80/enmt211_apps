"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  initSolver,
  sectionFromConfig,
  polesFromConfig,
  pmConfig,
} = require("./_fixtures.js");

const SQRT2 = Math.SQRT2;

function makeSlice(cfg, refine) {
  return LIB.MotorSlice.create(
    sectionFromConfig(cfg),
    {
      poles: polesFromConfig(cfg),
      saturation: { enabled: false },
      mesh: { refine: refine },
    }
  );
}

describe("MotorSlice mesh-refinement convergence", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("static-rotor torque convergent under mesh refinement (currents=[5])", function () {
    // The currents=[0] pure-cogging point convergence is covered by the
    // harmonic-gap k=0 / magnet-source discretization-artifact diagnostics.
    // This test verifies the loaded currents=[5] case.
    const cfg = pmConfig();
    const levels = [1.0, SQRT2, 2.0];
    const torquesFive = new Array(levels.length);

    for (let i = 0; i < levels.length; i++) {
      const slice = makeSlice(cfg, levels[i]);
      const m = slice.nCircuits;
      const five = new Float64Array(m);
      five[0] = 5;
      torquesFive[i] = slice.solve(0.0, five).torque;
    }

    const T = torquesFive;
    const d1 = Math.abs(T[1] - T[0]) / Math.max(Math.abs(T[0]), Math.abs(T[1]), 1e-30);
    const d2 = Math.abs(T[2] - T[1]) / Math.max(Math.abs(T[1]), Math.abs(T[2]), 1e-30);
    assert.ok(d1 < 0.01,
      `currents=[5] convergence refine 1→√2: rel diff=${d1} must be < 1%. ` +
      `T=${JSON.stringify(T)}`);
    assert.ok(d2 < 0.01,
      `currents=[5] convergence refine √2→2: rel diff=${d2} must be < 1%. ` +
      `T=${JSON.stringify(T)}`);
  });

  // -----------------------------------------------------------------------
  it("cogging amplitude convergent under refinement (pmConfig)", function () {
    const cfg = pmConfig();
    const poles = polesFromConfig(cfg);
    const levels = [1.0, SQRT2, 2.0];
    // Sweep 8 angles over one cogging period; cogging has period 2π/(N_lcm)
    // — for these PM fixtures the dominant cogging period is 2π/poles. The
    // peak-to-valley test only needs enough angle samples to bracket the
    // amplitude; 8 across [0, π/poles] is sufficient.
    const N_ang = 8;
    const dTheta = Math.PI / (poles * (N_ang - 1));
    const amps = new Array(levels.length);

    for (let i = 0; i < levels.length; i++) {
      const slice = makeSlice(cfg, levels[i]);
      let tMin =  Infinity, tMax = -Infinity;
      for (let j = 0; j < N_ang; j++) {
        const th = j * dTheta;
        const T = slice.coggingTorque(th);
        assert.ok(Number.isFinite(T), `coggingTorque(${th}) must be finite at refine=${levels[i]}`);
        if (T < tMin) tMin = T;
        if (T > tMax) tMax = T;
      }
      amps[i] = tMax - tMin;
      assert.ok(amps[i] > 0,
        `cogging amplitude at refine=${levels[i]} must be > 0; got ${amps[i]}`);
    }

    const a1 = Math.abs(amps[1] - amps[0]) / amps[1];
    const a2 = Math.abs(amps[2] - amps[1]) / amps[2];
    assert.ok(a1 < 0.02,
      `cogging amp convergence refine 1→√2: rel diff=${a1} must be < 2%. amps=${JSON.stringify(amps)}`);
    assert.ok(a2 < 0.02,
      `cogging amp convergence refine √2→2: rel diff=${a2} must be < 2%. amps=${JSON.stringify(amps)}`);
  });

  // -----------------------------------------------------------------------
  it("refinement increases mesh DOF count", function () {
    const cfg = pmConfig();
    const sliceCoarse = makeSlice(cfg, 1.0);
    const sliceFine   = makeSlice(cfg, 2.0);
    const nCoarse = sliceCoarse.__internals.globalLayout.n;
    const nFine   = sliceFine.__internals.globalLayout.n;
    assert.ok(nFine > nCoarse,
      `refine=2 (n=${nFine}) must produce more DOFs than refine=1 (n=${nCoarse})`);
  });
});
