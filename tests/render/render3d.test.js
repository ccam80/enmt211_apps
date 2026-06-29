"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const fs   = require("fs");
const path = require("path");

const {
  LIB,
  UnifiedMotor,
  CS,
  loadMachine,
  feaOpts,
  initSolver,
  recordingCanvas,
  dummyMountCtx,
} = require("./_fixtures.js");

// Ensure Layout3D is loaded (required by render3d.js for projection).
try { require("../../lib/layout3d.js"); } catch (e) { /* may already be loaded */ }

// Ensure CrossSectionSprite is loaded (cross-section-sprite primitives).
try { require("../../lib/cross-section-sprite.js"); } catch (e) { /* may already be loaded */ }

// Ensure GapEval is loaded (gap-eval lib).
try { require("../../lib/gap-eval.js"); } catch (e) { /* may not be present */ }

// Load render3d.js (its require is guarded in _fixtures already; require again is idempotent).
try { require("../../lessons/unified_motor/render3d.js"); } catch (e) { /* already loaded */ }

const UM = UnifiedMotor;

// ---------------------------------------------------------------------------
//  make3dRctx — returns ONLY the rctx object; caller threads in canvas.
// ---------------------------------------------------------------------------
function make3dRctx(runtime, expanded, W, H) {
  return {
    runtime: runtime,
    config:  expanded,
    expanded: expanded,
    canvas:  null,   // caller sets this to a recordingCanvas().canvas
    W:       W != null ? W : 600,
    H:       H != null ? H : 600,
  };
}

// Build a standard L3 for tests.
function makeL3(W, H) {
  W = W != null ? W : 600;
  H = H != null ? H : 600;
  return LIB.Layout3D.orbital(W, H, { yaw: 0.4, pitch: 0.35, dist: 0.25 });
}

// ---------------------------------------------------------------------------
//  Spy helpers
// ---------------------------------------------------------------------------
function spy(obj, method) {
  const orig = obj[method];
  let count = 0;
  const calls = [];
  obj[method] = function () {
    count++;
    calls.push(Array.prototype.slice.call(arguments));
    return orig ? orig.apply(this, arguments) : undefined;
  };
  obj[method]._spyRestore = function () { obj[method] = orig; };
  obj[method]._count      = function () { return count; };
  obj[method]._calls      = function () { return calls; };
  return obj[method];
}

// ---------------------------------------------------------------------------
//  Shared step-once runtime for pmsm
// ---------------------------------------------------------------------------
let sharedPmsm = null;

async function getPmsm() {
  if (!sharedPmsm) {
    await initSolver();
    const cfg      = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const runtime  = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));
    runtime.step(1 / 240, 30);
    sharedPmsm = { cfg, expanded, runtime };
  }
  return sharedPmsm;
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("render3d", () => {

  it("registers exactly one 3-D renderer with a paint function", () => {
    assert.ok(UM.RENDER3D && typeof UM.RENDER3D === "object",
      "UM.RENDER3D should be an object");
    assert.strictEqual(typeof UM.RENDER3D.paint, "function",
      "UM.RENDER3D.paint should be a function");
    assert.ok(UM.Render3D && typeof UM.Render3D === "object",
      "UM.Render3D should be an object");
    assert.strictEqual(UM.Render3D.paint, UM.RENDER3D.paint,
      "UM.Render3D.paint should be the same function as UM.RENDER3D.paint");
  });

  it("sliceAxialBounds splits the stack into equal centered segments", () => {
    const b = [0, 1, 2, 3].map(function (k) {
      return UM.Render3D.sliceAxialBounds(k, 4, 0.08);
    });

    assert.ok(Math.abs(b[0].z0 - (-0.04)) < 1e-12,
      "b[0].z0 should be -0.04, got " + b[0].z0);
    assert.ok(Math.abs(b[3].z1 - 0.04) < 1e-12,
      "b[3].z1 should be +0.04, got " + b[3].z1);

    for (let k = 0; k < 4; k++) {
      const w = b[k].z1 - b[k].z0;
      assert.ok(Math.abs(w - 0.02) < 1e-12,
        "segment " + k + " width should be 0.02, got " + w);
    }

    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(b[k].z1 - b[k + 1].z0) < 1e-12,
        "b[" + k + "].z1 should equal b[" + (k + 1) + "].z0");
    }

    assert.ok(Math.abs(b[0].zc + b[3].zc) < 1e-12,
      "b[0].zc + b[3].zc should be 0 (symmetric)");

    // Single-slice case.
    const s = UM.Render3D.sliceAxialBounds(0, 1, 0.08);
    assert.ok(Math.abs(s.z0 - (-0.04)) < 1e-12, "single slice z0");
    assert.ok(Math.abs(s.z1 - 0.04) < 1e-12, "single slice z1");
    assert.ok(Math.abs(s.zc - 0) < 1e-12, "single slice zc");
  });

  it("faceAffine maps face-local metres to the projected z-plane pixels", () => {
    const L3 = LIB.Layout3D.orbital(600, 600, { yaw: 0.4, pitch: 0.35, dist: 0.25 });
    const A  = UM.Render3D.faceAffine(L3, 0.0, 0.05);

    function ap(u, v) {
      return { px: A.a * u + A.c * v + A.e, py: A.b * u + A.d * v + A.f };
    }

    const O  = L3.project({ x: 0,    y: 0,    z: 0 });
    const Pu = L3.project({ x: 0.05, y: 0,    z: 0 });
    const Pv = L3.project({ x: 0,    y: 0.05, z: 0 });

    const p00 = ap(0,    0   );
    const p10 = ap(0.05, 0   );
    const p01 = ap(0,    0.05);

    assert.ok(Math.abs(p00.px - O.px)  < 1e-9, "ap(0,0).px ≈ O.px");
    assert.ok(Math.abs(p00.py - O.py)  < 1e-9, "ap(0,0).py ≈ O.py");
    assert.ok(Math.abs(p10.px - Pu.px) < 1e-9, "ap(R,0).px ≈ Pu.px");
    assert.ok(Math.abs(p10.py - Pu.py) < 1e-9, "ap(R,0).py ≈ Pu.py");
    assert.ok(Math.abs(p01.px - Pv.px) < 1e-9, "ap(0,R).px ≈ Pv.px");
    assert.ok(Math.abs(p01.py - Pv.py) < 1e-9, "ap(0,R).py ≈ Pv.py");
  });

  it("endTurnArcs connects wire-by-wire along true coils, bulges past both ends, and tags the end", () => {
    const winding = {
      kind: "distributed", member: "stator",
      slotRRange: [0.05, 0.055], angularWidth: 0.05,
      slotTheta: [0, Math.PI / 4, Math.PI, Math.PI + Math.PI / 4],
      coils: [
        { circuit: 0, slotGo: 0, slotReturn: 1, turns: 4 },
        { circuit: 1, slotGo: 2, slotReturn: 3, turns: -4 },   // reverse-wound coil
      ],
    };

    const arcs = UM.Render3D.endTurnArcs(winding, { ell: 0.08, bulge: 0.01, samples: 8 });

    // 4 wires per coil (turns=±4) × 2 coils × 2 ends = 16 per-wire arcs.
    assert.strictEqual(arcs.length, 16, "one arc per wire per end, not per slot");
    const circuits = new Set(arcs.map(function (a) { return a.circuit; }));
    assert.ok(circuits.has(0) && circuits.has(1), "both circuits wired");

    // Each arc is tagged with the end it belongs to (for near/far paint layering).
    assert.strictEqual(arcs.filter(function (a) { return a.end === 1; }).length, 8, "8 arcs at the +z end");
    assert.strictEqual(arcs.filter(function (a) { return a.end === -1; }).length, 8, "8 arcs at the -z end");

    // Coil polarity is tagged so dot flow can reverse on a reverse-wound coil.
    assert.ok(arcs.filter(function (a) { return a.circuit === 0; }).every(function (a) { return a.turnsSign === 1; }),
      "forward coil tagged +1");
    assert.ok(arcs.filter(function (a) { return a.circuit === 1; }).every(function (a) { return a.turnsSign === -1; }),
      "reverse-wound coil tagged -1");

    let zmax = -Infinity, zmin = Infinity;
    for (const arc of arcs) {
      assert.strictEqual(arc.points.length, 8 * 3, "samples honoured (8*3)");
      for (let pi = 0; pi < arc.points.length / 3; pi++) {
        const z = arc.points[pi * 3 + 2];
        if (z > zmax) zmax = z;
        if (z < zmin) zmin = z;
      }
    }
    // ell/2 = 0.04, bulge 0.01 → turns rise past each end toward ±0.05.
    assert.ok(zmax > 0.048 && zmax <= 0.05 + 1e-9, "near-end turns bulge past +0.04 toward +0.05, got " + zmax);
    assert.ok(zmin < -0.048 && zmin >= -0.05 - 1e-9, "far-end turns bulge past -0.04 toward -0.05, got " + zmin);
  });

  it("concentrated coils route through the same end turns and never leave the slot band", () => {
    // Concentrated = the two slots flank one tooth; the end turn crosses over it.
    // The wire must stay within [slotInner, slotOuter] radially — it must not dip
    // toward the gap/rotor or rise into the yoke (the old radial helix bug).
    const winding = {
      kind: "concentrated", member: "stator",
      slotRRange: [0.05, 0.06], angularWidth: 0.2,
      slotTheta: [0, Math.PI / 6],
      coils: [{ circuit: 0, slotGo: 0, slotReturn: 1, turns: 5 }],
    };

    const arcs = UM.Render3D.endTurnArcs(winding, { ell: 0.08, bulge: 0.012 });
    // 5 wires (turns=5) × 2 ends = 10 per-wire end turns.
    assert.strictEqual(arcs.length, 10, "concentrated coils produce per-wire end turns, no helix");

    for (const arc of arcs) {
      for (let pi = 0; pi < arc.points.length / 3; pi++) {
        const r = Math.hypot(arc.points[pi * 3], arc.points[pi * 3 + 1]);
        assert.ok(r >= 0.05 - 1e-9 && r <= 0.06 + 1e-9,
          "wire stays in the slot band [0.05, 0.06], got r=" + r);
      }
    }
  });

  it("cageEndRing spans the bar band, and is null without a cage", () => {
    const ring = UM.Render3D.cageEndRing([
      { kind: "conductor", component: "cage", member: "rotor", rRange: [0.042, 0.054] },
      { kind: "conductor", component: "cage", member: "rotor", rRange: [0.042, 0.054] },
      { kind: "iron", member: "rotor", rRange: [0, 0.042] },
    ]);
    assert.deepStrictEqual(ring, { member: "rotor", rRange: [0.042, 0.054] });

    const none = UM.Render3D.cageEndRing([
      { kind: "conductor", component: "distributed-winding", member: "stator", rRange: [0.05, 0.055] },
    ]);
    assert.strictEqual(none, null, "no cage features → no ring");
  });

  it("paint draws the extruded cross-section through the sprite primitives", async () => {
    const { cfg, expanded, runtime } = await getPmsm();
    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };

    const CSP = LIB.CrossSectionSprite;
    const drawIronSpy    = spy(CSP, "drawIron");
    const drawWindingSpy = spy(CSP, "drawWinding");

    const L3  = makeL3(600, 600);
    const rec = recordingCanvas(600, 600);
    const rctx = make3dRctx(runtime, expanded, 600, 600);
    rctx.canvas = rec.canvas;

    try {
      assert.doesNotThrow(function () {
        UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx);
      });

      assert.ok(drawIronSpy._count() >= 1,
        "drawIron call count should be >= 1, got " + drawIronSpy._count());
      assert.ok(drawWindingSpy._count() >= 1,
        "drawWinding call count should be >= 1, got " + drawWindingSpy._count());

      const hasTransform = rec.log.some(function (e) { return e.op === "transform"; });
      assert.ok(hasTransform, "log should contain at least one transform op (face affine)");
    } finally {
      drawIronSpy._spyRestore();
      drawWindingSpy._spyRestore();
    }
  });

  it("paint renders every slice of a multi-slice stack (cups)", async () => {
    await initSolver();

    for (const id of ["hybrid-stepper", "skew-demo"]) {
      const cfg      = loadMachine(id);
      const expanded = CS.expand(cfg);
      const runtime  = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));
      runtime.step(1 / 240, 30);

      UM.fieldViz = {
        fluxLines: false, modulusB: false, saturation: false,
        magnetization: false, currentDensity: false, gapLoop: false,
      };

      const CSP         = LIB.CrossSectionSprite;
      const drawIronSpy = spy(CSP, "drawIron");

      const L3   = makeL3(600, 600);
      const rec  = recordingCanvas(600, 600);
      const rctx = make3dRctx(runtime, expanded, 600, 600);
      rctx.canvas = rec.canvas;

      try {
        UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx);
        const nSlices    = expanded.slices.length;
        const minExpected = 2 * nSlices;
        assert.ok(drawIronSpy._count() >= minExpected,
          id + ": drawIron count (" + drawIronSpy._count() +
          ") should be >= " + minExpected + " (2 caps × " + nSlices + " slices)");
      } finally {
        drawIronSpy._spyRestore();
      }
    }
  });

  it("paint rotates the rotor sprite by gap.phi", async () => {
    const { cfg, expanded, runtime } = await getPmsm();

    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };

    function paintAndGetRotates(phiValue) {
      runtime.lastSolve.perSliceField[0].gap.phi = phiValue;
      const L3  = makeL3(600, 600);
      const rec = recordingCanvas(600, 600);
      const rctx = make3dRctx(runtime, expanded, 600, 600);
      rctx.canvas = rec.canvas;
      UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx);
      return rec.log.filter(function (e) { return e.op === "rotate"; });
    }

    const rotates06 = paintAndGetRotates(0.6);
    const hasClose = rotates06.some(function (e) { return Math.abs(e.args[0] - 0.6) < 1e-9; });
    assert.ok(hasClose, "log should contain rotate(0.6) after setting gap.phi=0.6");

    const rotates00 = paintAndGetRotates(0.0);
    const hasNonZero = rotates00.some(function (e) { return Math.abs(e.args[0]) > 1e-9; });
    assert.ok(!hasNonZero, "log should not contain rotate with |arg| > 1e-9 when gap.phi=0");
  });

  it("paint is safe before the first solve", async () => {
    await initSolver();
    const cfg      = loadMachine("pmsm");
    const expanded = CS.expand(cfg);
    const runtime  = LIB.MotorRun.create(expanded, feaOpts({ poles: expanded.poles }));

    assert.strictEqual(runtime.lastSolve, null);

    UM.fieldViz = {
      fluxLines: false, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };

    const CSP         = LIB.CrossSectionSprite;
    const drawIronSpy = spy(CSP, "drawIron");

    const L3   = makeL3(600, 600);
    const rec  = recordingCanvas(600, 600);
    const rctx = make3dRctx(runtime, expanded, 600, 600);
    rctx.canvas = rec.canvas;

    try {
      assert.doesNotThrow(function () {
        UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx);
      });
      assert.ok(drawIronSpy._count() >= 1,
        "drawIron should be called even with no solve, got " + drawIronSpy._count());
    } finally {
      drawIronSpy._spyRestore();
    }
  });

  it("paint draws cap field overlays and cross-gap flux when fieldViz.fluxLines is on", async () => {
    const { cfg, expanded, runtime } = await getPmsm();

    UM.fieldViz = {
      fluxLines: true, modulusB: false, saturation: false,
      magnetization: false, currentDensity: false, gapLoop: false,
    };

    const MMV     = LIB.MotorMeshView;
    const GapEval = LIB.GapEval;

    const drawFluxSpy = spy(MMV, "drawFluxLines");

    let evalCalled = false;
    let evalArg0   = null;
    let evalArg1   = null;
    const origEval = GapEval ? GapEval.evalAOnGrid : null;

    if (GapEval) {
      GapEval.evalAOnGrid = function (descriptor, opts) {
        evalCalled = true;
        evalArg0   = descriptor;
        evalArg1   = opts;
        // Return a minimal valid grid.
        const Nr     = (opts && opts.Nr)     ? opts.Nr     : 2;
        const Ntheta = (opts && opts.Ntheta) ? opts.Ntheta : 4;
        const rs     = new Float64Array(Nr);
        const thetas = new Float64Array(Ntheta);
        const Az     = new Float64Array(Nr * Ntheta);
        for (let i = 0; i < Nr;     i++) rs[i]     = 0.042 + i * 0.001;
        for (let j = 0; j < Ntheta; j++) thetas[j] = j * 2 * Math.PI / Ntheta;
        return { rs, thetas, Az, Nr, Ntheta };
      };
    }

    const L3   = makeL3(600, 600);
    const rec  = recordingCanvas(600, 600);
    const rctx = make3dRctx(runtime, expanded, 600, 600);
    rctx.canvas = rec.canvas;

    try {
      UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx);

      assert.ok(drawFluxSpy._count() >= 1,
        "drawFluxLines should be called at least once when fluxLines is on");

      if (GapEval) {
        assert.ok(evalCalled, "GapEval.evalAOnGrid should have been called");
        assert.ok(evalArg0 !== null, "evalAOnGrid first arg should be set");

        // Must not be the legacy field.gap shape.
        assert.ok(!evalArg0.harmonics,
          "descriptor must not have a harmonics key");

        // Must have finite rotor/stator/phi values.
        assert.strictEqual(typeof evalArg0.phi, "number",
          "descriptor.phi should be a number");
        assert.ok(Number.isFinite(evalArg0.rotor.gapR),
          "descriptor.rotor.gapR should be finite");
        assert.ok(Number.isFinite(evalArg0.stator.gapR),
          "descriptor.stator.gapR should be finite");
        assert.ok(evalArg0.rotor.gapTheta instanceof Float64Array,
          "descriptor.rotor.gapTheta should be Float64Array");
        assert.ok(evalArg0.rotor.A instanceof Float64Array,
          "descriptor.rotor.A should be Float64Array");
        assert.ok(evalArg0.stator.gapTheta instanceof Float64Array,
          "descriptor.stator.gapTheta should be Float64Array");
        assert.ok(evalArg0.stator.A instanceof Float64Array,
          "descriptor.stator.A should be Float64Array");
        assert.strictEqual(evalArg0.rotor.gapTheta.length, evalArg0.rotor.A.length,
          "rotor gapTheta and A should have equal length");
        assert.strictEqual(evalArg0.stator.gapTheta.length, evalArg0.stator.A.length,
          "stator gapTheta and A should have equal length");

        // Second arg must have Nr and Ntheta.
        assert.ok(evalArg1 && typeof evalArg1.Nr === "number",
          "second arg should have Nr");
        assert.ok(evalArg1 && typeof evalArg1.Ntheta === "number",
          "second arg should have Ntheta");

        // Re-paint with fluxLines off — evalAOnGrid should not be called again.
        evalCalled = false;
        UM.fieldViz = {
          fluxLines: false, modulusB: false, saturation: false,
          magnetization: false, currentDensity: false, gapLoop: false,
        };
        const rec2  = recordingCanvas(600, 600);
        const rctx2 = make3dRctx(runtime, expanded, 600, 600);
        rctx2.canvas = rec2.canvas;
        UM.RENDER3D.paint(dummyMountCtx(runtime, cfg), L3, rctx2);
        assert.ok(!evalCalled, "evalAOnGrid should not be called when fluxLines is off");
      }
    } finally {
      drawFluxSpy._spyRestore();
      if (GapEval && origEval) GapEval.evalAOnGrid = origEval;
    }
  });

  it("paint returns without drawing when rctx.canvas is absent", async () => {
    const { cfg, expanded, runtime } = await getPmsm();

    const CSP         = LIB.CrossSectionSprite;
    const drawIronSpy = spy(CSP, "drawIron");

    const L3 = makeL3(600, 600);
    try {
      assert.doesNotThrow(function () {
        UM.RENDER3D.paint(
          dummyMountCtx(runtime, cfg),
          L3,
          { runtime: runtime, config: expanded, expanded: expanded, W: 600, H: 600 }
          // no canvas field
        );
      });
      assert.strictEqual(drawIronSpy._count(), 0,
        "drawIron should not be called when canvas is absent");
    } finally {
      drawIronSpy._spyRestore();
    }
  });

  it("mount.js passes the viewport canvas to the 3-D seam", () => {
    const mountPath = path.resolve(__dirname, "../../lessons/unified_motor/mount.js");
    const text      = fs.readFileSync(mountPath, "utf8");

    const idxCanvas = text.indexOf("canvas: viewport3D");
    assert.ok(idxCanvas >= 0, "mount.js should contain 'canvas: viewport3D'");

    const idxPaint  = text.indexOf("UM.RENDER3D.paint(");
    assert.ok(idxPaint  >= 0, "mount.js should contain 'UM.RENDER3D.paint('");

    assert.ok(idxCanvas < idxPaint,
      "'canvas: viewport3D' should appear before 'UM.RENDER3D.paint(' in mount.js");
  });

  it("no DOM access at module load", () => {
    const RENDER3D_PATH = path.resolve(__dirname, "../../lessons/unified_motor/render3d.js");

    // Save and remove require cache entry.
    const prevCache = require.cache[RENDER3D_PATH];
    delete require.cache[RENDER3D_PATH];

    // Ensure window = globalThis but document is undefined.
    globalThis.window   = globalThis;
    const prevDoc       = globalThis.document;
    globalThis.document = undefined;

    try {
      assert.doesNotThrow(function () {
        require(RENDER3D_PATH);
      });
    } finally {
      // Restore document and the require cache entry if it existed.
      if (prevDoc !== undefined) {
        globalThis.document = prevDoc;
      } else {
        delete globalThis.document;
      }
      if (prevCache) {
        require.cache[RENDER3D_PATH] = prevCache;
      }
    }
  });

  it("no machine names and no DOM in the file", () => {
    const RENDER3D_PATH = path.resolve(__dirname, "../../lessons/unified_motor/render3d.js");
    const text          = fs.readFileSync(RENDER3D_PATH, "utf8");
    const lower         = text.toLowerCase();

    const MACHINE_NAMES = [
      "bldc", "pmsm", "srm", "squirrel", "stepper",
      "brushed", "universal-motor", "wound-field",
    ];
    for (const name of MACHINE_NAMES) {
      assert.strictEqual(lower.indexOf(name), -1,
        "render3d.js should not contain machine name '" + name + "'");
    }

    assert.strictEqual(text.indexOf("document."), -1,
      "render3d.js should not contain 'document.'");
  });

});
