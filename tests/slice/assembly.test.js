"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  CS,
  initSolver,
  sectionFromConfig,
  polesFromConfig,
  feaOpts,
  woundConfig,
  pmConfig,
  salientConfig,
} = require("./_fixtures.js");

const MU0 = 4 * Math.PI * 1e-7;

describe("MotorSlice assembly + Brauer fit (Wave 5.1)", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("prepare returns the documented global layout", function () {
    const cfg = woundConfig();
    const section = sectionFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      section,
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const layout = slice.__internals.globalLayout;
    assert.ok(typeof layout.Nn_rotor_free === "number");
    assert.ok(typeof layout.Nn_stator_free === "number");
    assert.ok(typeof layout.nHarmonicDofs === "number");
    assert.ok(typeof layout.n === "number");
    assert.strictEqual(
      layout.n,
      layout.Nn_rotor_free + layout.Nn_stator_free + layout.nHarmonicDofs,
      "n must equal the sum of the three free-DOF counts"
    );
    // The gap coupling is stamped into the body DOFs — no harmonic DOFs.
    assert.strictEqual(layout.nHarmonicDofs, 0);
  });

  // -----------------------------------------------------------------------
  it("slice.nCircuits matches CS.expand for woundConfig", function () {
    const cfg = woundConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    assert.strictEqual(slice.nCircuits, CS.expand(cfg).nCircuits);
  });

  it("slice.nCircuits matches CS.expand for pmConfig", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    assert.strictEqual(slice.nCircuits, CS.expand(cfg).nCircuits);
  });

  it("slice.nCircuits matches CS.expand for salientConfig", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    assert.strictEqual(slice.nCircuits, CS.expand(cfg).nCircuits);
  });

  // -----------------------------------------------------------------------
  it("combined pattern is symmetric", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const trip = slice.__internals.assembleCombinedTriplets(
      sectionFromConfig(cfg), feaOpts(), 0
    );
    // Sum duplicate entries per (i,j) coord first.
    const sum = new Map();
    function key(i, j) { return i + "," + j; }
    for (let t = 0; t < trip.I.length; t++) {
      const k = key(trip.I[t], trip.J[t]);
      sum.set(k, (sum.get(k) || 0) + trip.V[t]);
    }
    // Walk every (i,j) and check (j,i) matches.
    for (const [k, v] of sum.entries()) {
      const parts = k.split(",");
      const i = parseInt(parts[0], 10);
      const j = parseInt(parts[1], 10);
      const rev = sum.get(key(j, i)) || 0;
      assert.ok(
        Math.abs(v - rev) < 1e-12 * Math.max(1, Math.abs(v)),
        `asymmetry at (${i},${j}): ${v} vs (${j},${i}): ${rev}`
      );
    }
  });

  // -----------------------------------------------------------------------
  it("outer-stator Dirichlet pin removes the expected DOFs", function () {
    const cfg = pmConfig();
    const section = sectionFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      section,
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const statorMesh = slice.__internals.bodies.stator;
    const rOuter = section.grid.rOuter;
    let expectedPinCount = 0;
    const NnS = statorMesh.nodes.length / 2;
    for (let i = 0; i < NnS; i++) {
      const x = statorMesh.nodes[2*i];
      const y = statorMesh.nodes[2*i + 1];
      const r = Math.hypot(x, y);
      if (Math.abs(r - rOuter) < 1e-9) expectedPinCount++;
    }
    const pinInfo = slice.__internals.eliminateOuterStatorPin(
      slice.__internals.bodies.rotor,
      statorMesh,
      rOuter
    );
    assert.strictEqual(
      pinInfo.pinned.length,
      expectedPinCount,
      `expected ${expectedPinCount} stator nodes at r=${rOuter}; pinned ${pinInfo.pinned.length}`
    );
    assert.ok(expectedPinCount > 0, "fixture must have at least one outer-stator node");
  });

  // -----------------------------------------------------------------------
  it("linear-material assembly factorizes SPD (magnet-only residual < 1e-9)", function () {
    const cfg = pmConfig();
    const section = sectionFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      section,
      feaOpts({ poles: polesFromConfig(cfg) })
    );

    // The slice was created with saturation:{enabled:false}. Drive
    // solveStaticRotor at θ=0 with zero currents → pure magnet excitation.
    const m = slice.nCircuits;
    const currents = new Float64Array(m);
    const r = slice.__internals.solveStaticRotor(0, currents);
    assert.ok(Number.isFinite(r.residual), "residual must be finite");
    assert.ok(
      r.residual < 1e-9,
      `magnet-only residual ${r.residual} must be < 1e-9 on linear material`
    );
  });

  // -----------------------------------------------------------------------
  describe("Brauer ν(B²) per-material fit (D5)", function () {
    // Use a stand-alone slice's __internals.brauerNu shim — it forwards to
    // the module-level brauerNu so we don't need a slice to test the fit.
    let nu;
    before(function () {
      const cfg = pmConfig();
      const slice = LIB.MotorSlice.create(
        sectionFromConfig(cfg),
        feaOpts({ poles: polesFromConfig(cfg) })
      );
      nu = slice.__internals.brauerNu;
    });

    it("Brauer per-material k1/k2/k3 fit gives linear ν at B=0 and 2·k1 at Bknee", function () {
      const mat = { kind: "iron", muR: 1000, mrMag: 0, Bknee: 1.6 };
      const k1 = 1 / (MU0 * 1000);
      const r0 = nu(0, mat, 1.6);
      assert.ok(
        Math.abs(r0.ν - k1) < 1e-15 * k1 + 1e-9,
        `ν(0) for muR=1000: expected ~${k1}, got ${r0.ν}`
      );
      const rKnee = nu(1.6 * 1.6, mat, 1.6);
      assert.ok(
        Math.abs(rKnee.ν - 2 * k1) / (2 * k1) < 1e-9,
        `ν(Bknee²) must be 2·k1; got ${rKnee.ν} vs ${2*k1}`
      );
    });

    it("explicit k1/k2/k3 override wins over Bknee", function () {
      const mat = { kind: "iron", muR: 1000, Bknee: 1.6, k1: 1e5, k2: 1e3, k3: 0.5 };
      const r = nu(0.5, mat, 1.6);
      const expected = 1e5 + 1e3 * Math.exp(0.5 * 0.5);
      assert.ok(
        Math.abs(r.ν - expected) / expected < 1e-9,
        `override formula: expected ${expected}, got ${r.ν}`
      );
    });

    it("BkneeDefault applies when material.Bknee is null", function () {
      const mat = { kind: "iron", muR: 1000, Bknee: null };
      const k1 = 1 / (MU0 * 1000);
      const r = nu(1.4 * 1.4, mat, 1.4);
      assert.ok(
        Math.abs(r.ν - 2 * k1) / (2 * k1) < 1e-9,
        `BkneeDefault=1.4 should give 2·k1 at B²=1.96; got ${r.ν}`
      );
    });

    it("two iron materials with different Bknee stay distinct (lower-knee saturates earlier)", function () {
      // Build a section with two iron features at distinct Bknee on the same
      // ring band. The mesher creates ONE element per feature instance.
      // Geometry: rotor ring at [0.04, 0.043], gap at [0.043, 0.047], stator
      // ring at [0.047, 0.06]. The half-circle iron features carry the
      // distinct Bknee values; the rest of the rotor band is air.
      const TWO_PI = 2 * Math.PI;
      const section = {
        grid: { Nr: 12, Ntheta: 24, rInner: 0.04, rOuter: 0.06, ell: 0.1 },
        features: [
          { kind: "iron",      member: "rotor",
            rRange: [0.04, 0.043], thetaRange: [0, Math.PI],
            muR: 1000, Bknee: 1.4 },
          { kind: "iron",      member: "rotor",
            rRange: [0.04, 0.043], thetaRange: [Math.PI, TWO_PI],
            muR: 1000, Bknee: 1.8 },
          { kind: "conductor", member: "stator",
            rRange: [0.047, 0.06], thetaRange: [0, TWO_PI / 6],
            circuit: 0, turns: 1 },
          { kind: "iron",      member: "stator",
            rRange: [0.047, 0.06], thetaRange: [0, TWO_PI],
            muR: 1000, Bknee: 1.6 },
        ],
      };
      // The slice constructor needs poles too.
      const slice = LIB.MotorSlice.create(
        section,
        feaOpts({ poles: 2 })
      );
      const rotorMats = slice.__internals.bodies.rotor.materials
        .filter(function (m) { return m.kind === "iron"; });
      // Phase-2 dedup keys on (kind, muR, mrMag, Bknee) so two irons with
      // different Bknee must dedup to two distinct entries.
      assert.strictEqual(rotorMats.length, 2,
        "two distinct iron materials with different Bknee must dedup separately");
      const lowKnee  = rotorMats.find(function (m) { return m.Bknee === 1.4; });
      const highKnee = rotorMats.find(function (m) { return m.Bknee === 1.8; });
      assert.ok(lowKnee && highKnee);
      const lowν  = slice.__internals.brauerNu(1.6 * 1.6, lowKnee,  1.6).ν;
      const highν = slice.__internals.brauerNu(1.6 * 1.6, highKnee, 1.6).ν;
      // Lower-knee iron saturates earlier → larger ν at B² = 1.6².
      assert.ok(lowν > highν,
        `lower-Bknee iron must have larger ν above its knee: lowν=${lowν}, highν=${highν}`);
    });
  });
});
