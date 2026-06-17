"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  initSolver,
  sectionFromConfig,
  polesFromConfig,
  feaOpts,
  salientConfig,
  pmConfig,
} = require("./_fixtures.js");

const MU0 = 4 * Math.PI * 1e-7;

describe("MotorSlice Newton driver", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("Newton converges within the §11.3 guards on a loaded operating point", function () {
    const cfg = salientConfig();
    const section = sectionFromConfig(cfg);
    const slice = LIB.MotorSlice.create(section, {
      poles: polesFromConfig(cfg),
      saturation: { enabled: true, BkneeDefault: 1.6 },
      mesh: { refine: 0.5 },
    });
    const currents = new Float64Array([10.0]);
    const r = slice.__internals.solveStaticRotor(0, currents);
    assert.ok(r.iters <= 8, `iters=${r.iters} must be <= 8`);
    assert.ok(
      Number.isFinite(r.residual),
      `residual must be finite, got ${r.residual}`
    );
    assert.ok(
      r.residual < 1e-9,
      `residual ${r.residual} must be < 1e-9 at convergence`
    );
    assert.ok(
      r.deltaNorm <= 1e-6 || r.converged,
      `deltaNorm ${r.deltaNorm} must satisfy tol=1e-6 at convergence`
    );
  });

  // -----------------------------------------------------------------------
  it("Newton tangent dν/dB² matches finite-difference dν/dB²", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const nu = slice.__internals.brauerNu;
    const mat = { kind: "iron", muR: 500, mrMag: 0, Bknee: 1.5 };
    const δ = 1e-5;
    const pts = [0.5*0.5, 1.5*1.5, 2.0*2.0];
    for (const B2 of pts) {
      const dν_an = nu(B2, mat, 1.5).dν_dB2;
      const νPlus  = nu(B2 + δ, mat, 1.5).ν;
      const νMinus = nu(B2 - δ, mat, 1.5).ν;
      const dν_fd = (νPlus - νMinus) / (2 * δ);
      const rel = Math.abs(dν_an - dν_fd) / Math.max(1, Math.abs(dν_an));
      assert.ok(
        rel < 1e-5,
        `dν/dB² at B²=${B2}: analytic=${dν_an}, FD=${dν_fd}, relErr=${rel}`
      );
    }
  });

  // -----------------------------------------------------------------------
  it("linear-mode bypass does exactly one factorize", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    // Wrap solverSat.factorize with a counter
    const solverSat = slice.__internals.solverSat;
    const origFactorize = solverSat.factorize;
    let count = 0;
    solverSat.factorize = function () {
      count++;
      return origFactorize.apply(this, arguments);
    };
    try {
      const m = slice.nCircuits;
      const currents = new Float64Array(m);
      currents[0] = 5;
      const r = slice.__internals.solveStaticRotor(0, currents);
      assert.strictEqual(count, 1, "linear-mode must factorize exactly once");
      assert.ok(r.residual < 1e-9, `residual ${r.residual} must be < 1e-9`);
    } finally {
      solverSat.factorize = origFactorize;
    }
  });

  // -----------------------------------------------------------------------
  it("linear and saturated agree at low excitation (pmConfig, currents=[0])", function () {
    // The Mr=8e5 pmConfig drives the iron deep into saturation even at
    // currents=[0] (PM alone gives B above the knee). Comparing sat vs lin
    // there tells you nothing about whether the saturated solver is sound
    // at low B — it just tells you saturation IS engaging, which is the
    // expected physics. To actually test the "low-B agreement" property,
    // weaken the magnet to where B stays well below Bknee.
    //
    // Compare on the BODY DOFs only. The bordered system has a small
    // null space in the harmonic block (k=0 row, by construction —
    // surfaceFlux's pseudoinverse), so the harmonic-DOF magnitudes that
    // both solves pick up are conditioning-dependent, not physical.
    // The body field is the physical quantity the slice produces.
    const cfg = pmConfig();
    cfg.rings[0].Mr = 8e-3;  // ~1000× weaker than pmConfig default → B ≪ Bknee
    const sectionLin = sectionFromConfig(cfg);
    const sectionSat = sectionFromConfig(cfg);
    const sliceLin = LIB.MotorSlice.create(sectionLin, {
      poles: polesFromConfig(cfg),
      saturation: { enabled: false },
      mesh: { refine: 0.5 },
    });
    const sliceSat = LIB.MotorSlice.create(sectionSat, {
      poles: polesFromConfig(cfg),
      saturation: { enabled: true, BkneeDefault: 1.6 },
      mesh: { refine: 0.5 },
    });
    const m = sliceLin.nCircuits;
    const currents = new Float64Array(m);
    const rLin = sliceLin.__internals.solveStaticRotor(0, currents);
    const rSat = sliceSat.__internals.solveStaticRotor(0, currents);
    const A_lin = rLin.A, A_sat = rSat.A;
    assert.strictEqual(A_lin.length, A_sat.length);

    // Explicit finiteness guard. The old loop used `if (e > maxErr)` only;
    // for non-finite e (NaN/Infinity) that comparison silently returns
    // false, so maxErr stayed at 0 and the relative-error assertion below
    // passed trivially even when one of the solves had diverged. This
    // exact failure mode masked the Brauer-overflow NaN bug for the
    // entire lifetime of the slice tests until 2026-05-29.
    const gl = sliceLin.__internals.globalLayout;
    const nBody = gl.Nn_rotor_free + gl.Nn_stator_free;
    for (let i = 0; i < A_lin.length; i++) {
      assert.ok(Number.isFinite(A_lin[i]),
        `A_lin[${i}] not finite (=${A_lin[i]}) — linear solve diverged`);
      assert.ok(Number.isFinite(A_sat[i]),
        `A_sat[${i}] not finite (=${A_sat[i]}) — saturated solve diverged`);
    }

    let maxErr = 0, maxLin = 0;
    for (let i = 0; i < nBody; i++) {
      const e = Math.abs(A_sat[i] - A_lin[i]);
      if (e > maxErr) maxErr = e;
      const a = Math.abs(A_lin[i]);
      if (a > maxLin) maxLin = a;
    }
    const rel = maxErr / (maxLin + 1e-30);
    assert.ok(
      rel < 5e-3,
      `low-B sat vs lin (body DOFs): relErrInf=${rel} must be < 5e-3 (maxErr=${maxErr}, maxLin=${maxLin})`
    );
  });

  // -----------------------------------------------------------------------
  it("warm-start cache is honored across consecutive static solves at same θ", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(sectionFromConfig(cfg), {
      poles: polesFromConfig(cfg),
      saturation: { enabled: true, BkneeDefault: 1.6 },
      mesh: { refine: 0.5 },
    });
    const currents = new Float64Array([10]);
    const r1 = slice.__internals.solveStaticRotor(0, currents);
    const r2 = slice.__internals.solveStaticRotor(0, currents);
    assert.ok(
      r2.iters <= r1.iters,
      `warm-start second solve iters=${r2.iters} must be <= first=${r1.iters}`
    );
  });

  // -----------------------------------------------------------------------
  it("clearWarmStart resets the cache (next solve runs >= 1 iter)", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(sectionFromConfig(cfg), {
      poles: polesFromConfig(cfg),
      saturation: { enabled: true, BkneeDefault: 1.6 },
      mesh: { refine: 0.5 },
    });
    const currents = new Float64Array([10]);
    slice.__internals.solveStaticRotor(0, currents);
    slice.clearWarmStart();
    const r = slice.__internals.solveStaticRotor(0, currents);
    assert.ok(r.iters >= 1, `after clearWarmStart iters=${r.iters} must be >= 1`);
  });
});
