"use strict";

// =============================================================================
//  LIB.SimSource.createInline — command/snapshot/geometry contract.
//
//  Driven against a STUB runtime (no FEA solver) so the dispatch, epoch, seed,
//  pacing, and mutation semantics are asserted precisely and fast. The real
//  snapshot-array shapes are covered where mount drives the real runtime
//  (mount-smoke).
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
require("../../lib/sim-source.js");
const SimSource = (globalThis.window.LIB || globalThis.LIB).SimSource;

// A stub MotorRun + expand. nSlices=1, nCircuits=2. `step` advances t/theta and
// installs a lastSolve; `solve` (used for the seed) returns a field bundle.
function makeStub() {
  const circuits = [
    { terminal: { amp: 0, freq: 0 } },
    { terminal: { amp: 0, freq: 0 } },
  ];
  const mechanical = { loadTorque: 0, damping: 0 };
  const state = { t: 0, theta: 0, omega: 0, i: new Float64Array(2) };
  let resetCount = 0;

  function field(tag) {
    const n = 3;
    const mk = () => Float64Array.from([tag, tag, tag]);
    return {
      rotor:  { mesh: { tag: "rmesh" }, Anode: mk(), Belem: { mag: mk(), Bx: mk(), By: mk() } },
      stator: { mesh: { tag: "smesh" }, Anode: mk(), Belem: { mag: mk(), Bx: mk(), By: mk() } },
      gap: { phi: state.theta },
    };
  }
  let lastSolve = null;
  const runtime = {
    state: state,
    circuits: circuits,
    mechanical: mechanical,
    get lastSolve() { return lastSolve; },
    stack: {
      nCircuits: 2,
      sliceMesh: (k) => ({ rotor: { tag: "rotor" + k }, stator: { tag: "stator" + k } }),
      solve: (theta) => ({ torque: 1.5, fluxLinkages: Float64Array.from([theta, -theta]), perSliceField: [field(0)] }),
    },
    step: (dt) => {
      state.t += dt; state.theta += dt; state.omega = 5; state.i[0] += 0.1;
      lastSolve = { torque: 2, fluxLinkages: Float64Array.from([state.theta, 0]), perSliceField: [field(state.t)] };
    },
    reset: () => { resetCount++; state.t = 0; state.theta = 0; state.omega = 0; state.i = new Float64Array(2); lastSolve = null; },
  };
  const deps = {
    MotorRun: { create: () => runtime },
    expand: (config) => ({ slices: [{}], nCircuits: 2, _config: config }),
  };
  return { deps, runtime, circuits, mechanical, state, getResetCount: () => resetCount };
}

function collect(src) {
  const geo = [], snaps = [];
  src.onGeometry((m) => geo.push(m));
  src.onSnapshot((s) => snaps.push(s));
  return { geo, snaps };
}

test("init ships geometry (epoch 0) then a seed snapshot at t=0", () => {
  const { deps } = makeStub();
  const src = SimSource.createInline(deps);
  const { geo, snaps } = collect(src);
  src.post({ type: "init", config: { label: "x" } });

  assert.equal(geo.length, 1);
  assert.equal(geo[0].type, "geometry");
  assert.equal(geo[0].epoch, 0);
  assert.equal(geo[0].nSlices, 1);
  assert.equal(geo[0].nCircuits, 2);
  assert.equal(geo[0].slices[0].rotor.tag, "rotor0");

  assert.equal(snaps.length, 1);
  const s = snaps[0];
  assert.equal(s.type, "snapshot");   // Worker→main router dispatches on this
  assert.equal(s.epoch, 0);
  assert.equal(s.t, 0);
  assert.equal(s.i.length, 2);
  assert.ok(s.i instanceof Float64Array);
  assert.equal(s.slices.length, 1);
  assert.equal(s.slices[0].AnodeR.length, 3);
  assert.equal(s.torque, 1.5);
});

test("drive + mechanical mutate the runtime", () => {
  const { deps, circuits, mechanical } = makeStub();
  const src = SimSource.createInline(deps);
  src.post({ type: "init", config: {} });
  src.post({ type: "drive", amp: 7, freq: 3 });
  for (const c of circuits) { assert.equal(c.terminal.amp, 7); assert.equal(c.terminal.freq, 3); }
  src.post({ type: "mechanical", loadTorque: 0.5, damping: 0.02 });
  assert.equal(mechanical.loadTorque, 0.5);
  assert.equal(mechanical.damping, 0.02);
});

test("pace free-runs to simClock+leadCap, one snapshot per solve", () => {
  const { deps, state } = makeStub();
  const src = SimSource.createInline(deps);
  const { snaps } = collect(src);
  src.post({ type: "init", config: {} });      // seed snapshot #0
  src.post({ type: "pace", simClock: 0.5, leadCap: 0.5, paused: false });
  // target = 1.0; stub steps land exactly on target in one solve here.
  const last = snaps[snaps.length - 1];
  assert.ok(last.t >= 1.0 - 1e-9, `t=${last.t}`);
  assert.ok(state.omega === 5);
  assert.ok(snaps.length >= 2);
});

test("pace while paused emits nothing", () => {
  const { deps } = makeStub();
  const src = SimSource.createInline(deps);
  src.post({ type: "init", config: {} });
  const { snaps } = collect(src);       // attach AFTER init/seed
  src.post({ type: "pace", simClock: 1, leadCap: 1, paused: true });
  assert.equal(snaps.length, 0);
});

test("reset re-seeds at t=0", () => {
  const { deps, getResetCount } = makeStub();
  const src = SimSource.createInline(deps);
  src.post({ type: "init", config: {} });
  src.post({ type: "pace", simClock: 0.2, leadCap: 0.2, paused: false });
  const { snaps } = collect(src);
  src.post({ type: "reset" });
  assert.equal(getResetCount(), 1);
  assert.equal(snaps.length, 1);        // one seed snapshot
  assert.equal(snaps[0].t, 0);
});

test("rebuild bumps epoch and re-ships geometry + seed", () => {
  const { deps } = makeStub();
  const src = SimSource.createInline(deps);
  const { geo, snaps } = collect(src);
  src.post({ type: "init", config: {} });
  src.post({ type: "rebuild", config: { label: "new" } });
  assert.equal(geo.length, 2);
  assert.equal(geo[1].epoch, 1);
  assert.equal(snaps[snaps.length - 1].epoch, 1);
});

test("unknown command throws", () => {
  const { deps } = makeStub();
  const src = SimSource.createInline(deps);
  assert.throws(() => src.post({ type: "nonsense" }), /unknown command/);
});

test("dispose stops delivery", () => {
  const { deps } = makeStub();
  const src = SimSource.createInline(deps);
  const { snaps } = collect(src);
  src.post({ type: "init", config: {} });
  const n = snaps.length;
  src.dispose();
  src.post({ type: "pace", simClock: 1, leadCap: 1, paused: false });
  assert.equal(snaps.length, n);
});
