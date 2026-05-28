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

describe("MotorSlice public solve / coggingTorque / clearWarmStart contract (Wave 5.2)", function () {
  before(async function () { await initSolver(); });

  // -----------------------------------------------------------------------
  it("solve returns finite torque + fluxLinkages of length nCircuits", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const currents = new Float64Array([5]);
    const r = slice.solve(0.0, currents);
    assert.ok(Number.isFinite(r.torque), `torque must be finite, got ${r.torque}`);
    assert.ok(r.fluxLinkages instanceof Float64Array, "fluxLinkages must be Float64Array");
    assert.strictEqual(r.fluxLinkages.length, slice.nCircuits,
      "fluxLinkages length must equal nCircuits");
    for (let i = 0; i < r.fluxLinkages.length; i++) {
      assert.ok(Number.isFinite(r.fluxLinkages[i]),
        `fluxLinkages[${i}]=${r.fluxLinkages[i]} must be finite`);
    }
  });

  // -----------------------------------------------------------------------
  it("field carries mesh-native rotor/stator/gap shape (D3)", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const r = slice.solve(0.0, new Float64Array([5]));
    const bodies = slice.__internals.bodies;

    assert.strictEqual(r.field.rotor.mesh, bodies.rotor,
      "field.rotor.mesh must be the body BodyMesh");
    assert.strictEqual(r.field.stator.mesh, bodies.stator,
      "field.stator.mesh must be the body BodyMesh");

    const NnR = bodies.rotor.nodes.length / 2;
    const NnS = bodies.stator.nodes.length / 2;
    const NeR = bodies.rotor.elems.length / 4;
    const NeS = bodies.stator.elems.length / 4;

    assert.strictEqual(r.field.rotor.Anode.length, NnR,
      "rotor.Anode length must equal nodes/2");
    assert.strictEqual(r.field.stator.Anode.length, NnS,
      "stator.Anode length must equal nodes/2");

    assert.strictEqual(r.field.rotor.Belem.mag.length, NeR);
    assert.strictEqual(r.field.rotor.Belem.Bx.length, NeR);
    assert.strictEqual(r.field.rotor.Belem.By.length, NeR);
    assert.strictEqual(r.field.stator.Belem.mag.length, NeS);
    assert.strictEqual(r.field.stator.Belem.Bx.length, NeS);
    assert.strictEqual(r.field.stator.Belem.By.length, NeS);

    assert.strictEqual(r.field.gap.phi, 0.0,
      "gap.phi must equal the thetaR passed to solve");

    const K = slice.__internals.K;
    assert.strictEqual(r.field.gap.harmonics.rotor.a.length, K + 1);
    assert.strictEqual(r.field.gap.harmonics.rotor.b.length, K + 1);
    assert.strictEqual(r.field.gap.harmonics.stator.a.length, K + 1);
    assert.strictEqual(r.field.gap.harmonics.stator.b.length, K + 1);
  });

  // -----------------------------------------------------------------------
  it("D6 pinned nodes report A = 0 in Anode", function () {
    const cfg = salientConfig();
    const section = sectionFromConfig(cfg);
    const slice = LIB.MotorSlice.create(
      section,
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const r = slice.solve(0.0, new Float64Array([5]));
    const pinInfo = slice.__internals.eliminateOuterStatorPin(
      slice.__internals.bodies.rotor,
      slice.__internals.bodies.stator,
      section.grid.rOuter
    );
    assert.ok(pinInfo.pinned.length > 0,
      "fixture must have at least one outer-stator pinned node");
    for (let k = 0; k < pinInfo.pinned.length; k++) {
      const idx = pinInfo.pinned[k];
      assert.strictEqual(r.field.stator.Anode[idx], 0,
        `pinned stator node ${idx} must have Anode === 0; got ${r.field.stator.Anode[idx]}`);
    }
  });

  // -----------------------------------------------------------------------
  it("Belem.mag equals hypot(Bx, By) for every element of both bodies", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const r = slice.solve(0.0, new Float64Array([5]));
    function check(label, B) {
      for (let e = 0; e < B.mag.length; e++) {
        const h = Math.hypot(B.Bx[e], B.By[e]);
        assert.ok(Math.abs(B.mag[e] - h) < 1e-12,
          `${label} elem ${e}: mag=${B.mag[e]} vs hypot=${h}`);
      }
    }
    check("rotor",  r.field.rotor.Belem);
    check("stator", r.field.stator.Belem);
  });

  // -----------------------------------------------------------------------
  it("field changes with rotor angle (Anode differs between θ=0 and θ=0.3)", function () {
    // slice.solve returns a result whose `field` arrays alias internal
    // scratch buffers — the caller must consume or snapshot them before
    // the next slice.solve call on the same instance. We snapshot Anode
    // here so we can compare across two solves on the same slice.
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const currents = new Float64Array([5]);
    const r0 = slice.solve(0.0, currents);
    const A0 = Float64Array.from(r0.field.rotor.Anode);
    const r03 = slice.solve(0.3, currents);
    const A03 = r03.field.rotor.Anode;
    let maxDiff = 0;
    for (let i = 0; i < A0.length; i++) {
      const d = Math.abs(A0[i] - A03[i]);
      if (d > maxDiff) maxDiff = d;
    }
    assert.ok(maxDiff > 1e-9,
      `rotor Anode must change with θ; maxDiff=${maxDiff}`);
  });

  // -----------------------------------------------------------------------
  it("torque is finite and changes with currents (pmConfig)", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const m = slice.nCircuits;
    const zero = new Float64Array(m);
    const five = new Float64Array(m);
    five[0] = 5;
    const t0 = slice.solve(0.0, zero).torque;
    const t5 = slice.solve(0.0, five).torque;
    assert.ok(Number.isFinite(t0), "torque @ 0 must be finite");
    assert.ok(Number.isFinite(t5), "torque @ 5 must be finite");
    assert.ok(Math.abs(t0 - t5) > 1e-9,
      `Jz must change the field: t0=${t0}, t5=${t5}`);
  });

  // -----------------------------------------------------------------------
  it("magnet-free section ⇒ coggingTorque is exactly 0 (salientConfig)", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const T = slice.coggingTorque(0.2);
    assert.strictEqual(T, 0,
      `magnet-free section must short-circuit to exactly 0; got ${T}`);
  });

  // -----------------------------------------------------------------------
  it("PM section ⇒ coggingTorque is finite and θ-dependent (pmConfig)", function () {
    const cfg = pmConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const T0 = slice.coggingTorque(0.0);
    const T1 = slice.coggingTorque(0.1);
    assert.ok(Number.isFinite(T0), `coggingTorque(0) must be finite; got ${T0}`);
    assert.ok(Number.isFinite(T1), `coggingTorque(0.1) must be finite; got ${T1}`);
    assert.ok(Math.abs(T0 - T1) > 1e-12,
      `coggingTorque must vary with θ: T0=${T0}, T1=${T1}`);
  });

  // -----------------------------------------------------------------------
  it("clearWarmStart does not throw, subsequent solve still produces a finite torque", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const currents = new Float64Array([5]);
    slice.solve(0.0, currents);
    slice.clearWarmStart();
    const r = slice.solve(0.0, currents);
    assert.ok(Number.isFinite(r.torque),
      `torque after clearWarmStart must be finite; got ${r.torque}`);
  });

  // -----------------------------------------------------------------------
  it("linear-mode solve matches saturated solve at very low excitation", function () {
    const cfg = salientConfig();
    const sliceLin = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      { poles: polesFromConfig(cfg),
        saturation: { enabled: false },
        mesh: { refine: 0.5 } }
    );
    const sliceSat = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      { poles: polesFromConfig(cfg),
        saturation: { enabled: true, BkneeDefault: 1.6 },
        mesh: { refine: 0.5 } }
    );
    const m = sliceLin.nCircuits;
    const currents = new Float64Array(m);
    currents[0] = 0.5;
    const tLin = sliceLin.solve(0.0, currents).torque;
    const tSat = sliceSat.solve(0.0, currents).torque;
    const denom = Math.max(Math.abs(tLin), Math.abs(tSat), 1e-30);
    const rel = Math.abs(tLin - tSat) / denom;
    assert.ok(rel < 5e-3,
      `low-excitation lin vs sat: tLin=${tLin}, tSat=${tSat}, rel=${rel} must be < 5e-3`);
  });

  // -----------------------------------------------------------------------
  it("harmonic torque sign convention matches motor convention (salientConfig)", function () {
    const cfg = salientConfig();
    const expanded = require("./_fixtures.js").CS.expand(cfg);
    const poles = expanded.poles;
    const slice = LIB.MotorSlice.create(
      expanded.slices[0].section,
      feaOpts({ poles: poles })
    );
    // Reluctance machines pull toward alignment. Pick θ_mech such that
    // θ_e = (poles/2)·θ_mech lands strictly between aligned (θ_e=0) and
    // unaligned (θ_e=π/2). Use θ_mech = π/(8·poles_per_pair) where
    // poles_per_pair = poles/2.
    const thetaR = Math.PI / (8 * (poles / 2));
    const theta_e = (poles / 2) * thetaR;
    const currents = new Float64Array([5]);
    const r = slice.solve(thetaR, currents);
    assert.ok(Number.isFinite(r.torque), `torque must be finite; got ${r.torque}`);
    assert.ok(Math.abs(r.torque) > 0,
      `torque at θ_mech=${thetaR} must be non-zero; got ${r.torque}`);
    const expectedSign = Math.sign(-Math.sin(2 * theta_e));
    const actualSign   = Math.sign(r.torque);
    assert.strictEqual(actualSign, expectedSign,
      `reluctance-machine torque sign at θ_e=${theta_e}: ` +
      `expected ${expectedSign} (= sign(-sin(2·θ_e))), got ${actualSign} (torque=${r.torque})`);
  });

  // -----------------------------------------------------------------------
  it("single FeaSolver instance per slice for the saturated path", function () {
    const cfg = salientConfig();
    const slice = LIB.MotorSlice.create(
      sectionFromConfig(cfg),
      feaOpts({ poles: polesFromConfig(cfg) })
    );
    const solverSat = slice.__internals.solverSat;
    const solverLin = slice.__internals.solverLin;
    assert.notStrictEqual(solverSat, solverLin,
      "solverSat and solverLin must be distinct FeaSolver instances");
    assert.ok(typeof solverSat.factorNnz === "function",
      "solverSat must be a FeaSolver handle");
    assert.ok(typeof solverLin.factorNnz === "function",
      "solverLin must be a FeaSolver handle");
    // Drive solve() once so solverSat has been factorized; factorNnz requires
    // a successful factorization.
    slice.solve(0.0, new Float64Array([5]));
    assert.ok(solverSat.factorNnz() > 0,
      `solverSat.factorNnz() must return positive; got ${solverSat.factorNnz()}`);
  });

  // -----------------------------------------------------------------------
  it("no DOM access on module load (LIB.MotorSlice surface present)", function () {
    assert.ok(LIB.MotorSlice, "LIB.MotorSlice must be defined");
    assert.strictEqual(typeof LIB.MotorSlice.create, "function",
      "LIB.MotorSlice.create must be a function");
  });
});
