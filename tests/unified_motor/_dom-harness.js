"use strict";

// =============================================================================
//  Headless DOM harness for the unified-motor mount path.
//
//  The engine fixtures exercise MotorRun/solve but never call
//  UnifiedMotor.mount(host) — so the entire UI build + render loop ran only in
//  a real browser and shipped untested. This harness installs a minimal DOM +
//  window shim (createElement, classList, canvas 2-D context, rAF, localStorage,
//  getComputedStyle) sufficient to boot mount(host) and tick render frames, so
//  mount-time and first-frame JavaScript errors surface under `node --test`.
//
//  It does NOT validate pixels — visual correctness still needs a browser. It
//  catches the class of defect that produces a black screen: ReferenceError /
//  TypeError thrown during mount() or the first render frames.
// =============================================================================

const path = require("path");

// ---------------------------------------------------------------------------
//  Recording 2-D context — every draw method is a no-op that does not throw.
// ---------------------------------------------------------------------------
function makeCtx(canvas) {
  const ctx = { canvas: canvas };
  const METHODS = [
    "beginPath", "moveTo", "lineTo", "closePath", "fill", "stroke", "arc",
    "arcTo", "rect", "fillRect", "clearRect", "strokeRect", "save", "restore",
    "setTransform", "resetTransform", "transform", "translate", "scale", "rotate",
    "fillText", "strokeText", "bezierCurveTo", "quadraticCurveTo", "ellipse",
    "clip", "setLineDash", "getLineDash", "drawImage", "putImageData",
  ];
  for (const m of METHODS) ctx[m] = function () {};
  ctx.measureText = function () { return { width: 0 }; };
  ctx.getTransform = function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
  ctx.createLinearGradient = function () { return { addColorStop: function () {} }; };
  ctx.createRadialGradient = function () { return { addColorStop: function () {} }; };
  ctx.createImageData = function (w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; };
  ctx.getImageData = function (x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; };
  return ctx;
}

// ---------------------------------------------------------------------------
//  Element — plain tree node with the surface mount.js / app.js touch.
// ---------------------------------------------------------------------------
function makeClassList(el) {
  const set = new Set();
  const sync = function () { el._className = Array.from(set).join(" "); };
  return {
    add() { for (const c of arguments) set.add(c); sync(); },
    remove() { for (const c of arguments) set.delete(c); sync(); },
    toggle(c, force) {
      const want = force === undefined ? !set.has(c) : !!force;
      if (want) set.add(c); else set.delete(c);
      sync();
      return want;
    },
    contains(c) { return set.has(c); },
    _set: set,
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    children: [],
    dataset: {},
    _listeners: {},
    _className: "",
    parentNode: null,
    type: "",
    checked: false,
    value: "",
    min: "", max: "", step: "",
    textContent: "",
    innerHTML: "",
    // Bitmap-attribute size (what fitCanvas writes). Distinct from clientWidth/
    // clientHeight (the CSS layout size), modelled as getters below.
    width: 600, height: 600,
    _layoutW: 600, _layoutH: 600,
  };
  // Model the layout coupling that bites the render loop: a flex item canvas
  // takes its min-content size on its parent's MAIN axis from its bitmap
  // attribute, so fitCanvas's `canvas.{width,height} = client*dpr` feeds back
  // and that dimension grows every frame — unless the item has a definite size
  // or min-(main):0 on that axis. On the CROSS axis the default align-items
  // stretch makes it container-sized, so no feedback there. A definite px/%
  // size or min-*:0 constrains the main axis.
  function parentMainIsWidth(node) {
    const p = node.parentNode;
    const dir = (p && p.style && p.style.flexDirection) || "row";
    return dir.indexOf("column") !== 0;  // row / row-reverse / unset → width is main
  }
  function isDefinite(v) { return typeof v === "string" && (/px$/.test(v) || /%$/.test(v)); }
  Object.defineProperty(el, "clientWidth", {
    get() {
      if (el.tagName === "CANVAS" && parentMainIsWidth(el)) {
        const s = el.style || {};
        const constrained = s.minWidth === "0" || isDefinite(s.width);
        if (!constrained) return Math.max(el._layoutW, el.width || 0);
      }
      return el._layoutW;
    },
  });
  Object.defineProperty(el, "clientHeight", {
    get() {
      if (el.tagName === "CANVAS" && !parentMainIsWidth(el)) {
        const s = el.style || {};
        const constrained = s.minHeight === "0" || isDefinite(s.height);
        if (!constrained) return Math.max(el._layoutH, el.height || 0);
      }
      return el._layoutH;
    },
  });
  el.classList = makeClassList(el);
  Object.defineProperty(el, "className", {
    get() { return el._className; },
    set(v) {
      el._className = v == null ? "" : String(v);
      el.classList._set.clear();
      for (const c of el._className.split(/\s+/)) if (c) el.classList._set.add(c);
    },
  });
  el.appendChild = function (c) { el.children.push(c); c.parentNode = el; return c; };
  el.append = function () { for (const c of arguments) el.appendChild(c); };
  el.removeChild = function (c) {
    const i = el.children.indexOf(c);
    if (i >= 0) el.children.splice(i, 1);
    c.parentNode = null;
    return c;
  };
  el.insertBefore = function (c, ref) {
    const i = ref ? el.children.indexOf(ref) : -1;
    if (i >= 0) el.children.splice(i, 0, c); else el.children.push(c);
    c.parentNode = el;
    return c;
  };
  el.remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  el.replaceChildren = function () { el.children.length = 0; for (const c of arguments) el.appendChild(c); };
  el.addEventListener = function (t, fn) { (el._listeners[t] || (el._listeners[t] = [])).push(fn); };
  el.removeEventListener = function (t, fn) {
    const a = el._listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  el.dispatch = function (type, ev) { for (const fn of (el._listeners[type] || []).slice()) fn(ev || { target: el }); };
  el.setAttribute = function (k, v) { el[k] = v; };
  el.getAttribute = function (k) { return el[k]; };
  el.removeAttribute = function (k) { delete el[k]; };
  el.setPointerCapture = function () {};
  el.releasePointerCapture = function () {};
  el.focus = function () {};
  el.click = function () { el.dispatch("click"); };
  el.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight, x: 0, y: 0 };
  };
  el.querySelector = function () { return null; };
  el.querySelectorAll = function () { return []; };
  el.getContext = function () { return el._ctx || (el._ctx = makeCtx(el)); };
  return el;
}

// ---------------------------------------------------------------------------
//  installShims() — install window/document/globals; returns a controller with
//  flushFrames(n) and uninstall().
// ---------------------------------------------------------------------------
function installShims() {
  const prev = {
    window: globalThis.window,
    document: globalThis.document,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    gcs: globalThis.getComputedStyle,
    dpr: Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio"),
    ls: globalThis.localStorage,
  };

  if (!globalThis.window) globalThis.window = globalThis;

  const documentElement = makeEl("html");
  const body = makeEl("body");
  globalThis.document = {
    documentElement: documentElement,
    body: body,
    createElement: function (tag) { return makeEl(tag); },
    createTextNode: function (text) { return { nodeType: 3, textContent: text, parentNode: null }; },
    getElementById: function () { return null; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    removeEventListener: function () {},
  };

  globalThis.getComputedStyle = function () {
    return { getPropertyValue: function () { return ""; } };
  };

  Object.defineProperty(globalThis, "devicePixelRatio", { value: 1, configurable: true, writable: true });
  globalThis.window.devicePixelRatio = 1;
  globalThis.window.innerWidth = 1280;
  globalThis.window.innerHeight = 900;

  const store = {};
  globalThis.localStorage = {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    clear: function () { for (const k of Object.keys(store)) delete store[k]; },
  };

  let queue = [];
  let nextId = 1;
  globalThis.requestAnimationFrame = function (fn) { const id = nextId++; queue.push({ id: id, fn: fn }); return id; };
  globalThis.cancelAnimationFrame = function (id) { queue = queue.filter(function (q) { return q.id !== id; }); };
  globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  if (!globalThis.window.addEventListener) globalThis.window.addEventListener = function () {};
  if (!globalThis.window.removeEventListener) globalThis.window.removeEventListener = function () {};

  // Run up to `n` animation frames. Each frame drains the frames queued at its
  // start; callbacks that re-queue (the render loop does) are run on the next
  // frame. A throwing callback propagates so the smoke test sees it.
  function flushFrames(n, tBase) {
    for (let i = 0; i < n; i++) {
      const batch = queue;
      queue = [];
      const t = (tBase || 0) + (i + 1) * 16;
      for (const item of batch) item.fn(t);
    }
  }

  function uninstall() {
    if (prev.window === undefined) delete globalThis.window; else globalThis.window = prev.window;
    if (prev.document === undefined) delete globalThis.document; else globalThis.document = prev.document;
    globalThis.requestAnimationFrame = prev.raf;
    globalThis.cancelAnimationFrame = prev.caf;
    globalThis.getComputedStyle = prev.gcs;
    if (prev.dpr) Object.defineProperty(globalThis, "devicePixelRatio", prev.dpr); else delete globalThis.devicePixelRatio;
    globalThis.localStorage = prev.ls;
  }

  // Set the simulated device-pixel-ratio. The canvas-growth feedback only
  // manifests at dpr > 1 (at dpr 1, clientWidth*1 == width, no growth), so the
  // growth regression test raises it.
  function setDpr(v) {
    Object.defineProperty(globalThis, "devicePixelRatio", { value: v, configurable: true, writable: true });
    globalThis.window.devicePixelRatio = v;
  }

  return { document: globalThis.document, body: body, makeEl: makeEl, flushFrames: flushFrames, setDpr: setDpr, uninstall: uninstall };
}

// ---------------------------------------------------------------------------
//  loadApp() — require every script index.html loads, in the same order, using
//  the Node solver path. Returns { LIB, UnifiedMotor, machineIds }.
//  Must be called AFTER installShims() so module-load DOM guards see the shim.
// ---------------------------------------------------------------------------
function loadApp() {
  const root = path.resolve(__dirname, "../..");
  const lib = function (p) { return require(path.join(root, "lib", p)); };
  const lesson = function (p) { return require(path.join(root, "lessons/unified_motor", p)); };

  lib("util.js");
  lib("canvas-type.js");
  lib("registry.js");
  lib("plot.js");
  lib("integrate.js");
  lib("draw.js");
  lib("layout3d.js");
  lib("em-physics.js");
  lib("field-render.js");
  lib("coil-render.js");
  lib("app.js");
  lib("winding-model.js");
  lib("excitation.js");
  lib("motor-circuit.js");
  lesson("config-schema.js");

  process.env.FEA_SOLVER_MJS_PATH = path.join(root, "lib", "solver.mjs");
  lib("fea-solver.js");
  lib("motor-mesh.js");
  lib("motor-mesh-view.js");
  lib("cross-section-sprite.js");
  lib("airgap-mortar.js");
  lib("gap-eval.js");
  lib("bdf-integrator.js");
  lib("motor-slice.js");
  lib("motor-stack.js");
  lib("motor-run.js");
  lib("snapshot-buffer.js");
  lib("sim-source.js");
  lesson("mount.js");
  lesson("cross-section-render.js");
  lesson("render3d.js");
  lesson("machine-picker.js");
  lesson("geometry-panel.js");

  const machinesDir = path.join(root, "lessons/unified_motor/machines");
  const fs = require("fs");
  const machineIds = [];
  for (const f of fs.readdirSync(machinesDir)) {
    if (f.endsWith(".js")) { require(path.join(machinesDir, f)); machineIds.push(f.replace(/\.js$/, "")); }
  }

  return { LIB: window.LIB, UnifiedMotor: window.UnifiedMotor, machineIds: machineIds };
}

module.exports = { installShims: installShims, loadApp: loadApp, makeEl: makeEl };
