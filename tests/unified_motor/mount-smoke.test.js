"use strict";

// =============================================================================
//  Mount smoke test — boots UnifiedMotor.mount(host) headlessly and ticks the
//  render loop. Guards the boot path the engine fixtures never touch: a
//  ReferenceError/TypeError thrown during mount() or the first frames (the
//  black-screen class of bug) fails here instead of only in a browser.
//
//  Mirrors the script load order and the await-init-then-mount sequence of
//  lessons/unified_motor/index.html. Does not validate pixels — visual
//  correctness still needs a browser; this catches JavaScript errors only.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { installShims, loadApp } = require("./_dom-harness.js");

function findCanvas(node) {
  if (!node) return null;
  if (node.tagName === "CANVAS") return node;
  for (const c of node.children || []) {
    const hit = findCanvas(c);
    if (hit) return hit;
  }
  return null;
}

function allCanvases(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.tagName === "CANVAS") out.push(node);
  for (const c of node.children || []) allCanvases(c, out);
  return out;
}

function findByTag(node, tag) {
  if (!node) return null;
  if (node.tagName === tag) return node;
  for (const c of node.children || []) { const h = findByTag(c, tag); if (h) return h; }
  return null;
}

// Mount, tick frames, unmount — returns the host so callers can assert on it.
function mountAndTick(UM, shim, frames) {
  const host = shim.makeEl("div");
  const unmount = UM.mount(host);
  shim.flushFrames(frames == null ? 6 : frames);
  if (typeof unmount === "function") unmount();
  return host;
}

test("default machine mounts, builds a canvas, and ticks render frames", async () => {
  const shim = installShims();
  try {
    const { LIB, UnifiedMotor } = loadApp();
    assert.ok(UnifiedMotor && typeof UnifiedMotor.mount === "function", "UnifiedMotor.mount must be a function");
    await LIB.FeaSolver.init();

    const host = shim.makeEl("div");
    let unmount;
    assert.doesNotThrow(() => { unmount = UnifiedMotor.mount(host); }, "mount(host) must not throw");
    assert.ok(findCanvas(host), "mount must build at least one canvas in the host tree");
    assert.doesNotThrow(() => { shim.flushFrames(8); }, "render frames must not throw");
    if (typeof unmount === "function") assert.doesNotThrow(() => unmount(), "unmount must not throw");
  } finally {
    shim.uninstall();
  }
});

test("every registered machine mounts and ticks without throwing", async () => {
  const shim = installShims();
  try {
    const { LIB, UnifiedMotor } = loadApp();
    await LIB.FeaSolver.init();

    const machines = UnifiedMotor.MACHINES || [];
    assert.ok(machines.length >= 15, `expected >= 15 registered machines, got ${machines.length}`);

    const prevDefault = UnifiedMotor.defaultConfig;
    try {
      for (const entry of machines) {
        UnifiedMotor.defaultConfig = entry.config;
        assert.doesNotThrow(
          () => mountAndTick(UnifiedMotor, shim, 5),
          `machine '${entry.id}' must mount and tick without throwing`
        );
      }
    } finally {
      UnifiedMotor.defaultConfig = prevDefault;
    }
  } finally {
    shim.uninstall();
  }
});

test("canvases stay bounded across frames at dpr > 1 (no fitCanvas feedback growth)", async () => {
  const shim = installShims();
  try {
    const { LIB, UnifiedMotor } = loadApp();
    await LIB.FeaSolver.init();
    shim.setDpr(1.5);   // the growth only manifests when dpr != 1

    const host = shim.makeEl("div");
    const unmount = UnifiedMotor.mount(host);

    shim.flushFrames(3);
    const before = allCanvases(host).map((c) => ({ w: c.width, h: c.height, cls: c.className }));
    shim.flushFrames(6);
    const after = allCanvases(host).map((c) => ({ w: c.width, h: c.height }));

    assert.ok(before.length > 0, "expected canvases in the mount");
    for (let i = 0; i < before.length; i++) {
      assert.ok(
        after[i].w <= before[i].w + 1,
        `canvas '${before[i].cls}' bitmap WIDTH grew ${before[i].w}→${after[i].w} across frames — unbounded fitCanvas feedback (missing min-width:0 / definite width)`
      );
      assert.ok(
        after[i].h <= before[i].h + 1,
        `canvas '${before[i].cls}' bitmap HEIGHT grew ${before[i].h}→${after[i].h} across frames — unbounded fitCanvas feedback (missing min-height:0 / definite height)`
      );
    }
    if (typeof unmount === "function") unmount();
  } finally {
    shim.uninstall();
  }
});

test("each field overlay renders without throwing", async () => {
  const shim = installShims();
  try {
    const { LIB, UnifiedMotor } = loadApp();
    await LIB.FeaSolver.init();

    const keys = ["fluxLines", "modulusB", "saturation", "magnetization", "currentDensity", "gapLoop", "currentDots"];
    const prev = Object.assign({}, UnifiedMotor.fieldViz);
    try {
      for (const k of keys) {
        for (const kk of keys) UnifiedMotor.fieldViz[kk] = (kk === k);
        assert.doesNotThrow(
          () => mountAndTick(UnifiedMotor, shim, 5),
          `overlay '${k}' must render without throwing`
        );
      }
    } finally {
      Object.assign(UnifiedMotor.fieldViz, prev);
    }
  } finally {
    shim.uninstall();
  }
});

test("switching machines via the picker rebuilds without throwing", async () => {
  const shim = installShims();
  try {
    const { LIB, UnifiedMotor } = loadApp();
    await LIB.FeaSolver.init();

    const host = shim.makeEl("div");
    const unmount = UnifiedMotor.mount(host);
    shim.flushFrames(4);

    const select = findByTag(host, "SELECT");
    assert.ok(select, "machine-picker <select> present in the mount");

    // The picker's change handler runs the structural rebuild path that
    // machine-switching depends on: normalize (consolidate) → expand → fresh
    // runtime → readout rebuild → panel refresh. A ReferenceError/TypeError in
    // that plumbing (the bug class this file guards) fails here.
    const ids = ["pmsm", "switched-reluctance", "induction-3ph", "bldc"]
      .filter((id) => (UnifiedMotor.MACHINES || []).some((m) => m.id === id));
    assert.ok(ids.length >= 2, "expected several known machines to switch between");
    for (const id of ids) {
      select.value = id;
      assert.doesNotThrow(() => select.dispatch("change"), `switch to '${id}' must not throw`);
      assert.doesNotThrow(() => shim.flushFrames(3), `frames after '${id}' must not throw`);
    }
    if (typeof unmount === "function") unmount();
  } finally {
    shim.uninstall();
  }
});
