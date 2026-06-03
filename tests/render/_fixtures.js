"use strict";

// =============================================================================
//  Shared fixtures for Phase 6 render tests (Waves 6.1 / 6.2).
//  Not a test file — no .test.js suffix. Required by the render test files.
//
//  Loads the engine shim (window + engine libs), then directly requires the
//  Phase-2/3/4/5 modules plus the new Phase-6 render libs and the live panel
//  modules, mirroring tests/slice/_fixtures.js.
// =============================================================================

if (!globalThis.window) globalThis.window = globalThis;

const path = require("path");

require("../_shim.js");

require("../../lib/util.js");
require("../../lib/winding-model.js");
require("../../lib/excitation.js");
require("../../lib/motor-circuit.js");
require("../../lib/motor-mesh.js");
require("../../lib/motor-mesh-view.js");
require("../../lib/airgap-mortar.js");

// gap-eval.js is created in Wave 6.2. Wave-6.1 tests run before it exists, so
// the require is guarded — the render code guards LIB.GapEval the same way.
try { require("../../lib/gap-eval.js"); } catch (e) { /* Wave 6.2 not landed */ }

// Point fea-solver at the absolute mjs path BEFORE requiring it.
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/motor-slice.js");
require("../../lib/motor-stack.js");
require("../../lib/bdf-integrator.js");   // motor-run's adaptive stepper needs LIB.BDF
require("../../lib/motor-run.js");

require("../../lessons/unified_motor/config-schema.js");

// mount.js installs the registration seams (PANELS / TOOLS / HEADER_CONTROLS /
// RENDER3D / CROSS_SECTION_2D + their register* functions). The panels register
// against these, so it must load first. mount.js does no DOM access at load.
require("../../lessons/unified_motor/mount.js");

// The live panels + renderers register against the UnifiedMotor seams. Some are
// created in later waves; gate behind RENDER_TESTS_HEADLESS_ONLY and guard each
// require so a wave that has not landed yet does not break the suite.
if (!process.env.RENDER_TESTS_HEADLESS_ONLY) {
  for (const rel of [
    "../../lessons/unified_motor/cross-section-render.js",
    "../../lessons/unified_motor/render3d.js",
    "../../lessons/unified_motor/matrix-panel.js",
    "../../lessons/unified_motor/machine-picker.js",
  ]) {
    try { require(rel); } catch (e) { /* later-wave module not landed */ }
  }
}

const LIB          = window.LIB;
const UnifiedMotor = window.UnifiedMotor;
const CS           = UnifiedMotor.ConfigSchema;

const { assertClose } = require("../_assert.js");

// ---------------------------------------------------------------------------
//  initSolver() → Promise<void> (memoized)
// ---------------------------------------------------------------------------
let _initPromise = null;
function initSolver() {
  if (!_initPromise) _initPromise = LIB.FeaSolver.init();
  return _initPromise;
}

// ---------------------------------------------------------------------------
//  loadMachine(id) → config
// ---------------------------------------------------------------------------
function loadMachine(id) {
  require("../../lessons/unified_motor/machines/" + id + ".js");
  const entry = UnifiedMotor.MACHINES.find(function (m) { return m.id === id; });
  if (!entry) throw new Error("loadMachine: machine id '" + id + "' not found");
  return entry.config;
}

// ---------------------------------------------------------------------------
//  sectionFromConfig / polesFromConfig
// ---------------------------------------------------------------------------
function sectionFromConfig(config) {
  return CS.expand(config).slices[0].section;
}
function polesFromConfig(config) {
  return CS.expand(config).poles;
}

// ---------------------------------------------------------------------------
//  feaOpts(extra) — base linear-mode coarse-mesh opts merged with extras.
// ---------------------------------------------------------------------------
function feaOpts(extra) {
  return Object.assign(
    { saturation: { enabled: false }, mesh: { refine: 0.5 } },
    extra || {}
  );
}

// ---------------------------------------------------------------------------
//  recordingCtx() → { ctx, log }
//
//  A 2-D context mock that records every method call (with arguments) and every
//  state-property assignment into `log` in order. Drawing methods are no-ops.
//  ctx.canvas = { width, height }.
// ---------------------------------------------------------------------------
function recordingCtx(width, height) {
  const log = [];
  const STATE_KEYS = [
    "fillStyle", "strokeStyle", "globalAlpha", "lineWidth",
    "font", "textAlign", "textBaseline", "lineCap", "globalCompositeOperation",
  ];

  const target = {
    canvas: { width: width != null ? width : 600, height: height != null ? height : 600 },
  };

  const METHODS = [
    "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc",
    "rect", "fillRect", "clearRect", "strokeRect", "save", "restore",
    "setTransform", "transform", "translate", "scale", "rotate", "fillText",
    "strokeText", "bezierCurveTo", "quadraticCurveTo", "ellipse", "clip",
    "setLineDash", "createLinearGradient", "createRadialGradient", "measureText",
  ];
  for (const m of METHODS) {
    target[m] = function () {
      log.push({ op: m, args: Array.prototype.slice.call(arguments) });
      if (m === "measureText") return { width: 0 };
      if (m === "createLinearGradient" || m === "createRadialGradient") {
        return { addColorStop: function () {} };
      }
    };
  }
  target.getTransform = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };

  // Wrap with a proxy so state-property writes get logged.
  const ctx = new Proxy(target, {
    set(obj, key, value) {
      if (STATE_KEYS.indexOf(key) >= 0) {
        log.push({ op: "set", key: key, value: value });
      }
      obj[key] = value;
      return true;
    },
    get(obj, key) {
      return obj[key];
    },
  });

  return { ctx, log };
}

// ---------------------------------------------------------------------------
//  recordingCanvas(w, h) → { canvas, ctx, log }
//
//  A canvas mock whose getContext("2d") returns a recording context. Carries
//  clientWidth/clientHeight so the DPR-fit path reports a stable CSS size and
//  does not resize (devicePixelRatio is undefined under Node → dpr=1).
// ---------------------------------------------------------------------------
function recordingCanvas(w, h) {
  const W = w != null ? w : 600;
  const H = h != null ? h : 600;
  const rec = recordingCtx(W, H);
  const canvas = {
    width: W,
    height: H,
    clientWidth: W,
    clientHeight: H,
    getContext() { return rec.ctx; },
  };
  rec.ctx.canvas = canvas;
  return { canvas, ctx: rec.ctx, log: rec.log };
}

// ---------------------------------------------------------------------------
//  installDomShim() → uninstall()
//
//  Installs a minimal `document.createElement` so header-control build(host)
//  paths run headless. Elements are plain trees with appendChild/removeChild/
//  addEventListener; enough for the field-view toggles. Returns a function that
//  removes the shim so the "no DOM access at module load" test can run clean.
// ---------------------------------------------------------------------------
function makeEl(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    style: {},
    children: [],
    _listeners: {},
    parentNode: null,
    type: "",
    checked: false,
    value: "",
    textContent: "",
    innerHTML: "",
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    addEventListener(type, fn) { (this._listeners[type] || (this._listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = this._listeners[type];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k]; },
  };
}

function installDomShim() {
  const prev = globalThis.document;
  globalThis.document = {
    createElement: makeEl,
    createTextNode(text) { return { nodeType: 3, textContent: text, parentNode: null }; },
  };
  return function uninstall() { globalThis.document = prev; };
}

// findFirst(root, predicate) — depth-first search over the shim tree.
function findFirst(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  const kids = root.children || [];
  for (const c of kids) {
    const hit = findFirst(c, predicate);
    if (hit) return hit;
  }
  return null;
}

// dispatch(el, type) — invoke the listeners registered for `type` on el.
function dispatch(el, type) {
  const a = (el._listeners && el._listeners[type]) || [];
  for (const fn of a.slice()) fn({ target: el });
}

// ---------------------------------------------------------------------------
//  dummyMountCtx(runtime, config) → mountCtx
// ---------------------------------------------------------------------------
function dummyMountCtx(runtime, config) {
  return {
    runtime: runtime,
    config: config,
    view: { yaw: 0, pitch: 0, dist: 0.25 },
    requestRebuild: function () {},
  };
}

// ---------------------------------------------------------------------------
//  dummyRctx(runtime, expanded, W, H) → rctx
// ---------------------------------------------------------------------------
function dummyRctx(runtime, expanded, W, H) {
  return {
    runtime: runtime,
    config: expanded.config != null ? expanded.config : expanded,
    expanded: expanded,
    W: W != null ? W : 600,
    H: H != null ? H : 600,
  };
}

// ---------------------------------------------------------------------------
//  solveOnce(slice, theta, currents) — populate lastSolve before render.
// ---------------------------------------------------------------------------
async function solveOnce(slice, theta, currents) {
  await initSolver();
  return slice.solve(theta, currents);
}

// ---------------------------------------------------------------------------
//  relErrInf(x, ref) → number
// ---------------------------------------------------------------------------
function relErrInf(x, ref) {
  let maxErr = 0, maxRef = 0;
  const n = Math.min(x.length, ref.length);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(x[i] - ref[i]);
    if (e > maxErr) maxErr = e;
    const r = Math.abs(ref[i]);
    if (r > maxRef) maxRef = r;
  }
  return maxErr / Math.max(1, maxRef);
}

module.exports = {
  LIB,
  UnifiedMotor,
  CS,
  loadMachine,
  sectionFromConfig,
  polesFromConfig,
  feaOpts,
  initSolver,
  assertClose,
  relErrInf,
  recordingCtx,
  recordingCanvas,
  installDomShim,
  findFirst,
  dispatch,
  dummyMountCtx,
  dummyRctx,
  solveOnce,
};
