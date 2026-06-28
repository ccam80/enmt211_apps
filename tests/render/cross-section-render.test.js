"use strict";

const { describe, it, before } = require("node:test");
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

// cross-section-sprite.js is needed by the rewritten render; load it here so
// LIB.CrossSectionSprite is present when cross-section-render.js runs.
try { require("../../lib/cross-section-sprite.js"); } catch (e) { /* may already be loaded */ }

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
  if (stepOnce) runtime.step(0.01);
  return { cfg, expanded, runtime };
}

describe("cross-section-render 2-D seam", () => {
  let shared;
  before(async () => { shared = await makeRuntime(true); });

  it("register installs the 2-D seam and field-view control", () => {
    // Seam.
    UM.CROSS_SECTION_2D = null;
    CSR.register(UM);
    assert.strictEqual(typeof UM.CROSS_SECTION_2D.paint, "function");

    // Header control + fieldViz defaults.
    const uninstall = installDomShim();
    try {
      UM.HEADER_CONTROLS = [];
      delete UM.fieldViz;
      CSR.register(UM);
      const entries = UM.HEADER_CONTROLS.filter(function (e) { return e.id === "field-view"; });
      assert.strictEqual(entries.length, 1);

      const host = global.document.createElement("div");
      const unmount = entries[0].build(host, dummyMountCtx(null, {}));
      assert.strictEqual(typeof unmount, "function");
      assert.deepStrictEqual(UM.fieldViz, {
        fluxLines: true, modulusB: false, saturation: false,
        magnetization: false, currentDensity: false, gapLoop: false,
        currentDots: false,
      });
      const cb = findFirst(host, function (el) { return el.tagName === "INPUT" && el.type === "checkbox"; });
      assert.ok(cb, "expected at least one checkbox built");
      unmount();
    } finally {
      uninstall();
    }
  });

  it("paint draws individual wires, not per-element material fills", async () => {
    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    const { cfg, expanded, runtime } = shared;

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
      dummyRctx(runtime, expanded, 600, 600));

    // Background present.
    const firstClear = a.log.findIndex(function (e) { return e.op === "clearRect"; });
    assert.ok(firstClear >= 0, "expected background clearRect");

    // Sprite render: far fewer fill ops than mesh elements (individual wires,
    // tooth outlines, magnets — not one fill per FE element).
    const Ne = meshElemTotal(runtime, 0);
    const fills = a.log.filter(function (e) { return e.op === "fill"; }).length;
    assert.ok(fills < 0.5 * Ne,
      "fills (" + fills + ") should be far below 0.5 * Ne (" + (0.5 * Ne) + ") for sprite render");

    // Arc ops (wire discs) must be present.
    const arcs = a.log.filter(function (e) { return e.op === "arc"; });
    assert.ok(arcs.length > 0, "expected disc arc ops for individual wire cross-sections");
  });

  it("paint dispatches modulusB (viridis blend) when toggled", async () => {
    UM.fieldViz = {
      fluxLines: false, modulusB: true, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    const { cfg, expanded, runtime } = shared;

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
      dummyRctx(runtime, expanded, 600, 600));

    // modulusB on: viridis rgb(...) fillStyle values appear.
    const fillStyles = a.log
      .filter(function (e) { return e.op === "set" && e.key === "fillStyle"; })
      .map(function (e) { return e.value; });
    const hasViridis = fillStyles.some(function (v) {
      return typeof v === "string" && /^rgb\(/.test(v);
    });
    assert.ok(hasViridis, "expected viridis rgb(...) fillStyle values when modulusB is on");

    // modulusB off: no viridis fillStyle values.
    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    const a2 = recordingCanvas(600, 600);
    CSR.paint(dummyMountCtx(runtime, cfg), [a2.canvas, recordingCanvas(600, 600).canvas],
      dummyRctx(runtime, expanded, 600, 600));
    const fillStyles2 = a2.log
      .filter(function (e) { return e.op === "set" && e.key === "fillStyle"; })
      .map(function (e) { return e.value; });
    const hasViridis2 = fillStyles2.some(function (v) {
      return typeof v === "string" && /^rgb\(/.test(v);
    });
    assert.ok(!hasViridis2, "expected no viridis fillStyle values when modulusB is off");
  });

  it("paint paints sprites when lastSolve is null", async () => {
    UM.fieldViz = {
      fluxLines: true, modulusB: true, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    await initSolver();
    const cfg = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const runtime = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));
    assert.strictEqual(runtime.lastSolve, null);

    const a = recordingCanvas(600, 600);
    const b = recordingCanvas(600, 600);
    assert.doesNotThrow(function () {
      CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, b.canvas],
        dummyRctx(runtime, expanded, 600, 600));
    });

    // Sprite geometry (arcs for wire discs, iron, magnets) still draws
    // without a solved field bundle.
    const arcs = a.log.filter(function (e) { return e.op === "arc"; });
    assert.ok(arcs.length > 0, "expected disc arc ops from sprite geometry without a field");
  });

  it("paint rotates the rotor sprite by gap.phi", async () => {
    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    const { cfg, expanded, runtime } = shared;

    function captureFirstRotate() {
      const a = recordingCanvas(600, 600);
      CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, recordingCanvas(600, 600).canvas],
        dummyRctx(runtime, expanded, 600, 600));
      // The rotor sprite is drawn inside ctx.save() / ctx.rotate(phi) / ctx.restore().
      // The first rotate op after the background clear is the rotor frame.
      const clearIdx = a.log.findIndex(function (e) { return e.op === "clearRect"; });
      const rotOp = a.log.slice(clearIdx + 1).find(function (e) { return e.op === "rotate"; });
      return rotOp ? rotOp.args[0] : null;
    }

    runtime.lastSolve.perSliceField[0].gap.phi = 0.0;
    const phi0 = captureFirstRotate();
    assert.ok(phi0 !== null, "expected a rotate op for the rotor frame");

    runtime.lastSolve.perSliceField[0].gap.phi = 0.6;
    const phi1 = captureFirstRotate();
    const delta = Math.abs(phi1 - phi0);
    assert.ok(delta > 1e-3,
      "rotor frame rotate arg should change with gap.phi; delta=" + delta);
  });

  it("cross-gap flux calls GapEval with a {rotor,stator,phi} descriptor", async () => {
    UM.fieldViz = {
      fluxLines: true, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };
    const { cfg, expanded, runtime } = shared;

    const GapEval = window.LIB.GapEval;
    if (!GapEval) {
      // Skip gracefully if GapEval was not loaded.
      return;
    }

    // Replace evalAOnGrid with a spy.
    const origEval = GapEval.evalAOnGrid;
    let spyArg0 = null, spyArg1 = null;
    GapEval.evalAOnGrid = function (descriptor, opts) {
      spyArg0 = descriptor;
      spyArg1 = opts;
      // Return a minimal valid grid to avoid downstream errors.
      const Nr = opts && opts.Nr ? opts.Nr : 2;
      const Ntheta = opts && opts.Ntheta ? opts.Ntheta : 4;
      const rs = new Float64Array(Nr);
      const thetas = new Float64Array(Ntheta);
      const Az = new Float64Array(Nr * Ntheta);
      for (let i = 0; i < Nr; i++) rs[i] = 0.042 + i * 0.001;
      for (let j = 0; j < Ntheta; j++) thetas[j] = j * 2 * Math.PI / Ntheta;
      return { rs, thetas, Az, Nr, Ntheta };
    };

    try {
      const a = recordingCanvas(600, 600);
      CSR.paint(dummyMountCtx(runtime, cfg), [a.canvas, recordingCanvas(600, 600).canvas],
        dummyRctx(runtime, expanded, 600, 600));
    } finally {
      GapEval.evalAOnGrid = origEval;
    }

    assert.ok(spyArg0 !== null, "GapEval.evalAOnGrid should have been called");

    // Descriptor must have {rotor, stator, phi} — not the legacy {harmonics, phi} shape.
    assert.ok(!spyArg0.harmonics,
      "descriptor must not be the legacy field.gap object (no harmonics key)");
    assert.strictEqual(typeof spyArg0.phi, "number",
      "descriptor.phi should be a number");
    assert.strictEqual(typeof spyArg0.rotor.gapR, "number",
      "descriptor.rotor.gapR should be a number");
    assert.strictEqual(typeof spyArg0.stator.gapR, "number",
      "descriptor.stator.gapR should be a number");
    assert.ok(spyArg0.rotor.gapTheta instanceof Float64Array,
      "descriptor.rotor.gapTheta should be Float64Array");
    assert.ok(spyArg0.rotor.A instanceof Float64Array,
      "descriptor.rotor.A should be Float64Array");
    assert.ok(spyArg0.stator.gapTheta instanceof Float64Array,
      "descriptor.stator.gapTheta should be Float64Array");
    assert.ok(spyArg0.stator.A instanceof Float64Array,
      "descriptor.stator.A should be Float64Array");
    assert.strictEqual(spyArg0.rotor.gapTheta.length, spyArg0.rotor.A.length,
      "rotor gapTheta and A should have equal length");
    assert.strictEqual(spyArg0.stator.gapTheta.length, spyArg0.stator.A.length,
      "stator gapTheta and A should have equal length");

    // Second argument must have Nr and Ntheta.
    assert.ok(spyArg1 && typeof spyArg1.Nr === "number",
      "second arg should be {Nr, Ntheta}");
    assert.ok(spyArg1 && typeof spyArg1.Ntheta === "number",
      "second arg should be {Nr, Ntheta}");
  });

  it("no DOM access at module load", () => {
    const CSR_PATH = path.resolve(__dirname, "../../lessons/unified_motor/cross-section-render.js");
    const prevDoc = global.document;
    delete global.document;
    const savedHeaderCtrls = UM.HEADER_CONTROLS;
    delete UM.registerHeaderControl;
    delete UM.registerCrossSection2D;
    UM.HEADER_CONTROLS = [];
    delete require.cache[CSR_PATH];
    try {
      assert.doesNotThrow(function () { require(CSR_PATH); });
      assert.strictEqual(typeof UM.CrossSectionRender.paint, "function");
      assert.strictEqual(typeof UM.CrossSectionRender.register, "function");
      assert.strictEqual(UM.HEADER_CONTROLS.length, 0, "register must not auto-run without seams");
    } finally {
      if (prevDoc) global.document = prevDoc;
      UM.HEADER_CONTROLS = savedHeaderCtrls;
    }
  });

  it("no machine names in the file", () => {
    const CSR_PATH = path.resolve(__dirname, "../../lessons/unified_motor/cross-section-render.js");
    const text = fs.readFileSync(CSR_PATH, "utf8").toLowerCase();
    const MACHINE_NAMES = [
      "bldc", "pmsm", "srm", "squirrel", "stepper",
      "brushed", "universal-motor", "wound-field",
    ];
    for (const name of MACHINE_NAMES) {
      assert.strictEqual(text.indexOf(name.toLowerCase()), -1,
        "cross-section-render.js contains machine name '" + name + "'");
    }
  });

  it("index.html loads gap-eval and cross-section-sprite in order", () => {
    const htmlPath = path.resolve(__dirname, "../../lessons/unified_motor/index.html");
    const html = fs.readFileSync(htmlPath, "utf8");

    assert.ok(html.indexOf("../../lib/gap-eval.js") >= 0,
      "index.html must contain gap-eval.js script tag");
    assert.ok(html.indexOf("../../lib/cross-section-sprite.js") >= 0,
      "index.html must contain cross-section-sprite.js script tag");

    const iFea    = html.indexOf("../../lib/fea-solver.js");
    const iGap    = html.indexOf("../../lib/gap-eval.js");
    const iStack  = html.indexOf("../../lib/motor-stack.js");
    const iSprite = html.indexOf("../../lib/cross-section-sprite.js");
    const iCSR    = html.indexOf("./cross-section-render.js");

    assert.ok(iFea < iGap,
      "fea-solver.js must appear before gap-eval.js");
    assert.ok(iGap < iStack,
      "gap-eval.js must appear before motor-stack.js");
    assert.ok(iSprite < iCSR,
      "cross-section-sprite.js must appear before cross-section-render.js");
  });
});
