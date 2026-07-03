"use strict";

// =============================================================================
//  sim-worker.js — Web Worker host for the unified-motor numeric runtime.
//
//  Runs the SimSource engine (LIB.SimSource._createEngine) off the render
//  thread so an atomic 20-50 ms field-circuit-motion solve never hitches the
//  animation. The main thread's WorkerSimSource (lib/sim-source.js) speaks the
//  same command/snapshot/geometry protocol over postMessage.
//
//  Loading:
//   • The numeric libs address the global as `window` (window.LIB, …). A worker
//     has no `window`, so alias it to `self` before importScripts — the same
//     shim the node test harness uses (globalThis.window = globalThis). No
//     numeric-core change.
//   • FeaSolver resolves solver.mjs from process.env.FEA_SOLVER_MJS_PATH when
//     set (its documented Node override). A worker has no document.currentScript
//     to locate the lib dir, so point that env at the worker-relative solver.mjs
//     URL; `versions:{}` (no `.node`) keeps FeaSolver on its browser fetch/blob
//     path. This reuses the existing override rather than patching the loader.
//   • Only the DOM-free numeric chain is imported (the set the headless engine
//     tests load) — no render libs.
// =============================================================================

/* global self, importScripts */

// Report a stage-tagged failure to the main thread. WorkerSimSource turns a
// posted { type:"error" } into its self-healing in-process fallback AND surfaces
// `message` in a console.warn — so a worker load/init failure names itself
// instead of leaving a silent blank canvas.
function reportError(stage, err) {
  self.postMessage({ type: "error", message: stage + ": " + String((err && err.message) || err) });
}

let LIB, UM;
try {
  self.window = self;   // numeric libs read window.LIB / window.UnifiedMotor
  self.process = {
    env: { FEA_SOLVER_MJS_PATH: new URL("../../lib/solver.mjs", self.location.href).href },
    versions: {},       // no .node → FeaSolver takes the browser fetch/blob path
  };
  importScripts(
    "../../lib/util.js",
    "../../lib/integrate.js",
    "../../lib/winding-model.js",
    "../../lib/excitation.js",
    "../../lib/motor-circuit.js",
    "../../lib/motor-mesh.js",
    "../../lib/motor-mesh-view.js",
    "../../lib/airgap-mortar.js",
    "../../lib/fea-solver.js",
    "../../lib/motor-slice.js",
    "../../lib/motor-stack.js",
    "../../lib/bdf-integrator.js",
    "../../lib/motor-run.js",
    "./config-schema.js",
    "../../lib/sim-source.js"
  );
  LIB = self.LIB;
  UM = self.UnifiedMotor;
  if (!LIB || !LIB.SimSource || !LIB.MotorRun || !UM || !UM.ConfigSchema) {
    throw new Error("libs missing after importScripts (LIB.SimSource/MotorRun, UM.ConfigSchema)");
  }
} catch (err) {
  reportError("worker load", err);
  throw err;   // stop the worker; the main thread has already fallen back
}

// Per-solve wall budget: a pace command solves toward its target until this many
// ms elapse, then yields so a newer pace / other command can be processed. Keeps
// the worker's message loop responsive while the solver runs flat out.
const PACE_BUDGET_MS = 24;

const emit = {
  geometry: function (msg) { self.postMessage(msg); },
  snapshot: function (msg) { self.postMessage(msg); },
};

const engine = LIB.SimSource._createEngine(
  { MotorRun: LIB.MotorRun, expand: UM.ConfigSchema.expand.bind(UM.ConfigSchema) },
  emit
);

// Latest pace target — pace commands COALESCE (only the newest matters); the
// self-scheduled loop drives the solver toward it in budgeted chunks so the
// solve cadence is decoupled from message-arrival cadence.
let latestPace = null;
let running = false;

// Any command failure is reported to the main thread, which self-heals to the
// in-process source (WorkerSimSource fallback) — so a worker-side throw degrades
// gracefully instead of silently freezing the display.
function safeHandle(cmd) {
  try {
    engine.handle(cmd);
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
}

function onCommand(cmd) {
  if (!cmd) return;
  if (cmd.type === "pace") { latestPace = cmd; return; }
  safeHandle(cmd);
}

function loop() {
  if (!running) return;
  if (latestPace) safeHandle({
    type: "pace",
    simClock: latestPace.simClock,
    leadCap: latestPace.leadCap,
    paused: latestPace.paused,
    budgetMs: PACE_BUDGET_MS,
  });
  setTimeout(loop, 0);
}

// Queue commands that arrive before the WASM solver is ready, then replay them.
const preReady = [];
self.onmessage = function (ev) { preReady.push(ev.data); };

LIB.FeaSolver.init().then(function () {
  self.onmessage = function (ev) { onCommand(ev.data); };
  for (const cmd of preReady) onCommand(cmd);
  preReady.length = 0;
  running = true;
  loop();
  self.postMessage({ type: "ready" });
}).catch(function (err) {
  reportError("FeaSolver.init", err);
});
