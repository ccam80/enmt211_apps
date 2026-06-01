"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LIB,
  UnifiedMotor,
  CS,
  loadMachine,
  feaOpts,
  initSolver,
  recordingCanvas,
  installDomShim,
  findFirst,
  dummyMountCtx,
  dummyRctx,
} = require("./_fixtures.js");

const UM = UnifiedMotor;

// The cross-section-render module is required by _fixtures.js. Grab its export.
const CSR = UM.CrossSectionRender;

function meshElemTotal(runtime, k) {
  const m = runtime.stack.sliceMesh(k);
  return (m.rotor.elems.length + m.stator.elems.length) / 4;
}

async function makeRuntime(stepOnce) {
  await initSolver();
  const cfg = loadMachine("pmsm");
  const expanded = CS.expand(cfg);
  const runtime = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));
  if (stepOnce) runtime.step(1 / 240);
  return { cfg, expanded, runtime };
}

describe("cross-section-render 2-D seam", () => {
  it("register() installs the 2-D seam", () => {
    UM.CROSS_SECTION_2D = null;
    CSR.register(UM);
    assert.strictEqual(typeof UM.CROSS_SECTION_2D.paint, "function");
  });

  it("register() installs the field-view header control", () => {
    const uninstall = installDomShim();
    try {
      UM.HEADER_CONTROLS = [];
      delete UM.fieldViz;
      CSR.register(UM);
      const entries = UM.HEADER_CONTROLS.filter(e => e.id === "field-view");
      assert.strictEqual(entries.length, 1);

      const host = global.document.createElement("div");
      const unmount = entries[0].build(host, dummyMountCtx(null, {}));
      assert.strictEqual(typeof unmount, "function");
      assert.deepStrictEqual(UM.fieldViz, {
        fluxLines: true, modulusB: false, saturation: false,
        magnetization: false, currentDensity: false, gapLoop: false,
      });
      // The host got a checkbox subtree.
      const cb = findFirst(host, el => el.tagName === "INPUT" && el.type === "checkbox");
      assert.ok(cb, "expected at least one checkbox built");
      unmount();
    } finally {
      uninstall();
    }
  });

  it("paint clears and draws the rotor + stator on each canvas", async () => {
    UM.fieldViz = { fluxLines: true, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: true };
    const { cfg, expanded, runtime } = await makeRuntime(true);

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
      dummyRctx(runtime, expanded, 600, 600));

    // Background first: a clearRect/fillRect pair near the start of the log.
    const firstClear = a.log.findIndex(e => e.op === "clearRect");
    const firstFillRect = a.log.findIndex(e => e.op === "fillRect");
    assert.ok(firstClear >= 0 && firstFillRect >= 0, "expected background clear/fill");

    // At least one fill per element across both bodies in slice 0.
    const Ne = meshElemTotal(runtime, 0);
    const fills = a.log.filter(e => e.op === "fill").length;
    assert.ok(fills >= Ne, `got ${fills} fills, expected >= ${Ne}`);
  });

  it("paint dispatches each viz toggle (modulusB on, fluxLines off)", async () => {
    UM.fieldViz = { fluxLines: false, modulusB: true, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false };
    const { cfg, expanded, runtime } = await makeRuntime(true);

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
      dummyRctx(runtime, expanded, 600, 600));

    // modulusB uses the viridis colormap → rgb(...) fillStyles appear.
    const fillStyles = a.log.filter(e => e.op === "set" && e.key === "fillStyle").map(e => e.value);
    const hasViridis = fillStyles.some(v => typeof v === "string" && /^rgb\(/.test(v));
    assert.ok(hasViridis, "expected modulusB viridis fillStyle calls");
  });

  it("paint paints content when lastSolve is null (no field overlay)", async () => {
    UM.fieldViz = { fluxLines: true, modulusB: true, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false };
    await initSolver();
    const cfg = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const runtime = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));
    // No step → lastSolve is null.
    assert.strictEqual(runtime.lastSolve, null);

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    assert.doesNotThrow(() =>
      CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
        dummyRctx(runtime, expanded, 600, 600)));

    // Material layer still drawn (fills present), but no |B| colormap signature
    // because there's no field bundle.
    const fills = a.log.filter(e => e.op === "fill").length;
    assert.ok(fills > 0, "static material layer should still draw");
  });

  it("paint rotates the rotor mesh by gap.phi", async () => {
    UM.fieldViz = { fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false };
    const { cfg, expanded, runtime } = await makeRuntime(true);

    function firstRotorVertex() {
      const a = recordingCanvas(600, 600);
      CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, recordingCanvas(600, 600).canvas],
        dummyRctx(runtime, expanded, 600, 600));
      // First moveTo after the background = first rotor element's first vertex
      // (the material layer draws the rotor body first).
      const mv = a.log.find(e => e.op === "moveTo");
      return mv ? mv.args : null;
    }

    // paint reads field.gap.phi to rigidly rotate the rotor body for draw. Set
    // it directly to two distinct angles and confirm the projected rotor vertex
    // moves accordingly — the rotation lives in the draw transform, so the
    // recorded vertex coordinates change.
    runtime.lastSolve.perSliceField[0].gap.phi = 0.0;
    const v0 = firstRotorVertex();
    assert.ok(v0, "expected a rotor vertex");

    runtime.lastSolve.perSliceField[0].gap.phi = 0.6;
    const v1 = firstRotorVertex();
    const moved = Math.hypot(v1[0] - v0[0], v1[1] - v0[1]);
    assert.ok(moved > 1e-3, `rotor vertex should move with rotation, moved ${moved}`);
  });

  it("no DOM access at module load", () => {
    // Re-require with window=globalThis and NO document; register must NOT be
    // auto-called (the auto-call is guarded by `if (UM.registerHeaderControl)`,
    // which is absent on a fresh namespace).
    const CSR_PATH = path.resolve(__dirname, "../../lessons/unified_motor/cross-section-render.js");
    const prevDoc = global.document;
    delete global.document;
    const savedHeaderCtrls = UM.HEADER_CONTROLS;
    delete UM.registerHeaderControl;
    delete UM.registerCrossSection2D;
    UM.HEADER_CONTROLS = [];
    delete require.cache[CSR_PATH];
    try {
      assert.doesNotThrow(() => require(CSR_PATH));
      assert.strictEqual(typeof UM.CrossSectionRender.paint, "function");
      assert.strictEqual(typeof UM.CrossSectionRender.register, "function");
      assert.strictEqual(UM.HEADER_CONTROLS.length, 0, "register must not auto-run without seams");
    } finally {
      if (prevDoc) global.document = prevDoc;
      UM.HEADER_CONTROLS = savedHeaderCtrls;
    }
  });

  it("no machine names in the rewritten file", () => {
    const CSR_PATH = path.resolve(__dirname, "../../lessons/unified_motor/cross-section-render.js");
    const text = fs.readFileSync(CSR_PATH, "utf8").toLowerCase();
    const MACHINE_NAMES = [
      "bldc", "pmsm", "srm", "squirrel", "stepper",
      "brushed", "universal-motor", "wound-field",
    ];
    for (const name of MACHINE_NAMES) {
      assert.strictEqual(text.indexOf(name.toLowerCase()), -1,
        `cross-section-render.js contains machine name '${name}'`);
    }
  });
});
