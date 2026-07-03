"use strict";

// =============================================================================
//  LIB.SimSource.createWorker — message-protocol glue, driven by a FAKE worker
//  (no real Worker / WASM). Verifies: pre-ready command queueing + flush on
//  "ready", snapshot/geometry dispatch, and the self-healing in-process fallback
//  on construct failure / worker error / ready timeout (with command replay).
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
require("../../lib/sim-source.js");
const SimSource = (globalThis.window.LIB || globalThis.LIB).SimSource;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeFakeWorker() {
  const w = {
    _posted: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    postMessage: function (m) { w._posted.push(m); },
    terminate: function () { w.terminated = true; },
    _recv: function (msg) { if (w.onmessage) w.onmessage({ data: msg }); },
  };
  return w;
}

// Minimal stub deps for the in-process fallback: init ships geometry + a seed.
function makeStubDeps() {
  const state = { t: 0, theta: 0, omega: 0, i: new Float64Array(1) };
  const field = () => ({
    rotor:  { mesh: {}, Anode: new Float64Array(1), Belem: { mag: new Float64Array(1), Bx: new Float64Array(1), By: new Float64Array(1) } },
    stator: { mesh: {}, Anode: new Float64Array(1), Belem: { mag: new Float64Array(1), Bx: new Float64Array(1), By: new Float64Array(1) } },
    gap: { phi: 0 },
  });
  const runtime = {
    state: state,
    circuits: [{ terminal: { amp: 0, freq: 0 } }],
    mechanical: { loadTorque: 0, damping: 0 },
    get lastSolve() { return null; },
    stack: {
      sliceMesh: () => ({ rotor: {}, stator: {} }),
      solve: () => ({ torque: 0, fluxLinkages: new Float64Array(1), perSliceField: [field()] }),
    },
    step: () => {},
    reset: () => {},
  };
  return { MotorRun: { create: () => runtime }, expand: () => ({ slices: [{}], nCircuits: 1 }) };
}

test("queues commands pre-ready, flushes in order on 'ready', then passes through", () => {
  const fake = makeFakeWorker();
  const src = SimSource.createWorker({ url: "x", fallbackDeps: makeStubDeps(), makeWorker: () => fake });
  src.post({ type: "init", config: {} });
  src.post({ type: "drive", amp: 5 });
  assert.equal(fake._posted.length, 0);            // nothing sent before ready
  fake._recv({ type: "ready" });
  assert.deepEqual(fake._posted.map((m) => m.type), ["init", "drive"]);
  src.post({ type: "pace", simClock: 0.1, leadCap: 0.1, paused: false });
  assert.equal(fake._posted.length, 3);            // now straight through
});

test("dispatches geometry and snapshot messages to callbacks", () => {
  const fake = makeFakeWorker();
  const src = SimSource.createWorker({ url: "x", fallbackDeps: makeStubDeps(), makeWorker: () => fake });
  const geo = [], snaps = [];
  src.onGeometry((m) => geo.push(m));
  src.onSnapshot((s) => snaps.push(s));
  fake._recv({ type: "ready" });
  fake._recv({ type: "geometry", epoch: 0, nSlices: 1, nCircuits: 1, slices: [] });
  fake._recv({ type: "snapshot", epoch: 0, t: 0 });
  assert.equal(geo.length, 1);
  assert.equal(snaps.length, 1);
});

test("falls back in-process on worker 'error', replaying queued commands", () => {
  const fake = makeFakeWorker();
  const src = SimSource.createWorker({ url: "x", fallbackDeps: makeStubDeps(), makeWorker: () => fake });
  const geo = [];
  src.onGeometry((m) => geo.push(m));
  src.post({ type: "init", config: {} });          // queued (not yet ready)
  fake._recv({ type: "error", message: "boom" });  // → fallback, replay init
  assert.ok(fake.terminated);
  assert.equal(geo.length, 1);                     // in-process engine shipped geometry
  assert.equal(geo[0].epoch, 0);
});

test("falls back immediately if the worker cannot be constructed", () => {
  const src = SimSource.createWorker({
    url: "x", fallbackDeps: makeStubDeps(),
    makeWorker: () => { throw new Error("no worker"); },
  });
  const geo = [];
  src.onGeometry((m) => geo.push(m));
  src.post({ type: "init", config: {} });          // straight to in-process
  assert.equal(geo.length, 1);
});

test("falls back on ready timeout", async () => {
  const fake = makeFakeWorker();
  const src = SimSource.createWorker({
    url: "x", fallbackDeps: makeStubDeps(), makeWorker: () => fake, readyTimeoutMs: 10,
  });
  const geo = [];
  src.onGeometry((m) => geo.push(m));
  src.post({ type: "init", config: {} });
  await delay(30);
  assert.ok(fake.terminated);
  assert.equal(geo.length, 1);
});

test("dispose terminates the worker", () => {
  const fake = makeFakeWorker();
  const src = SimSource.createWorker({ url: "x", fallbackDeps: makeStubDeps(), makeWorker: () => fake });
  src.dispose();
  assert.ok(fake.terminated);
});
