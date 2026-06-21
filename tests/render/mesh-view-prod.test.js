"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  LIB,
  loadMachine,
  sectionFromConfig,
  recordingCtx,
} = require("./_fixtures.js");

const MMV = LIB.MotorMeshView;
const MM  = LIB.MotorMesh;

// Build a rotor/stator pair from a fixture config.
function meshOf(id, member) {
  const cfg = loadMachine(id);
  const section = sectionFromConfig(cfg);
  const physics = MM.physicsFromConfig(cfg);
  const built = MM.build(section, { physics });
  return built[member];
}

// Synthetic polar grid filled with cos(2θ) for a given radial range.
function makeCosGrid(Nr, Ntheta, rMin, rMax) {
  rMin = rMin != null ? rMin : 0.01;
  rMax = rMax != null ? rMax : 0.05;
  const rs     = new Float64Array(Nr);
  const thetas = new Float64Array(Ntheta);
  for (let i = 0; i < Nr; i++)     rs[i]     = rMin + (rMax - rMin) * (i + 0.5) / Nr;
  for (let j = 0; j < Ntheta; j++) thetas[j] = 2 * Math.PI * j / Ntheta;
  const Az = new Float64Array(Nr * Ntheta);
  for (let i = 0; i < Nr; i++) {
    for (let j = 0; j < Ntheta; j++) {
      Az[i * Ntheta + j] = Math.cos(2 * thetas[j]);
    }
  }
  return { rs, thetas, Az, Nr, Ntheta };
}

describe("MotorMeshView overlays surface", () => {

  it("resampleField interpolates a nodal field off the mesh", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Nn = mesh.nodes.length / 2;
    const Anode = new Float64Array(Nn);
    for (let n = 0; n < Nn; n++) {
      const x = mesh.nodes[2 * n], y = mesh.nodes[2 * n + 1];
      Anode[n] = Math.cos(2 * Math.atan2(y, x));
    }
    const Nr = 12, Ntheta = 96;
    const grid = MMV.resampleField(mesh, Anode, { Nr, Ntheta });

    assert.strictEqual(grid.Az.length,     Nr * Ntheta);
    assert.strictEqual(grid.rs.length,     Nr);
    assert.strictEqual(grid.thetas.length, Ntheta);

    // Pick a mid-range interior grid point and check interpolation accuracy.
    const iMid = Math.floor(Nr / 2);
    const jMid = Math.floor(Ntheta / 4);  // θ ≈ π/2
    const theta = grid.thetas[jMid];
    const analytic = Math.cos(2 * theta);
    const got = grid.Az[iMid * Ntheta + jMid];
    assert.ok(Math.abs(got - analytic) < 0.1,
      `resampleField: got ${got.toFixed(4)}, analytic ${analytic.toFixed(4)}, diff ${Math.abs(got - analytic).toFixed(4)}`);
  });

  it("drawFluxLines strokes smooth curves from a grid", () => {
    const grid = makeCosGrid(12, 96);
    const { ctx, log } = recordingCtx();
    MMV.drawFluxLines(ctx, grid, { levels: 8 });

    const nStroke = log.filter(e => e.op === "stroke").length;
    assert.ok(nStroke >= 1,
      `expected at least one stroke from a non-constant field, got ${nStroke}`);

    const hasCurve = log.some(e => e.op === "bezierCurveTo" || e.op === "quadraticCurveTo");
    assert.ok(hasCurve,
      "expected bezierCurveTo or quadraticCurveTo ops (smooth curves, not raw lineTo facets)");
  });

  it("drawFluxLines emits no strokes for a constant grid", () => {
    const Nr = 12, Ntheta = 96;
    const rs     = new Float64Array(Nr);
    const thetas = new Float64Array(Ntheta);
    for (let i = 0; i < Nr; i++)     rs[i]     = 0.01 + 0.04 * (i + 0.5) / Nr;
    for (let j = 0; j < Ntheta; j++) thetas[j] = 2 * Math.PI * j / Ntheta;
    const Az = new Float64Array(Nr * Ntheta).fill(1.0);
    const grid = { rs, thetas, Az, Nr, Ntheta };

    const { ctx, log } = recordingCtx();
    MMV.drawFluxLines(ctx, grid, { levels: 8 });
    assert.strictEqual(log.filter(e => e.op === "stroke").length, 0);
  });

  it("drawModulusB blends across the grid", () => {
    // Radial |B| ramp: value increases with radius index.
    const Nr = 12, Ntheta = 96;
    const rs     = new Float64Array(Nr);
    const thetas = new Float64Array(Ntheta);
    for (let i = 0; i < Nr; i++)     rs[i]     = 0.01 + 0.04 * (i + 0.5) / Nr;
    for (let j = 0; j < Ntheta; j++) thetas[j] = 2 * Math.PI * j / Ntheta;
    const Az = new Float64Array(Nr * Ntheta);
    for (let i = 0; i < Nr; i++) {
      for (let j = 0; j < Ntheta; j++) {
        Az[i * Ntheta + j] = i / (Nr - 1);
      }
    }
    const grid = { rs, thetas, Az, Nr, Ntheta };

    const { ctx, log } = recordingCtx();
    MMV.drawModulusB(ctx, grid, { range: "auto" });

    const fills = log.filter(e => e.op === "set" && e.key === "fillStyle").map(e => e.value);
    const distinct = new Set(fills);
    assert.ok(distinct.size >= 8,
      `expected >= 8 distinct fillStyle values (smooth blend), got ${distinct.size}`);
  });

  it("drawSaturation only shades iron elements", () => {
    const mesh = meshOf("pmsm", "rotor");
    const Ne = mesh.elems.length / 4;
    const mag = new Float64Array(Ne).fill(1.0);
    const { ctx, log } = recordingCtx();
    MMV.drawSaturation(ctx, mesh, { mag }, {});

    let ironN = 0;
    for (let e = 0; e < Ne; e++) {
      if (mesh.materials[mesh.matId[e]].kind === "iron") ironN++;
    }
    assert.ok(ironN > 0, "pmsm rotor should have iron elements");
    assert.strictEqual(log.filter(e => e.op === "fill").length, ironN);
  });

  it("drawSaturation uses BkneeDefault when material.Bknee is null", () => {
    const mesh = {
      member: "rotor",
      nodes: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]),
      elems: new Int32Array([0, 1, 2, 3]),
      matId: new Int32Array([1]),
      srcId: new Int32Array([-1]),
      turns: new Float64Array([0]),
      magDir: new Float64Array([0, 0]),
      materials: [
        { kind: "air",  muR: 1,    mrMag: 0, Bknee: null },
        { kind: "iron", muR: 1000, mrMag: 0, Bknee: null },
      ],
      gapLoop:  new Int32Array(0),
      gapTheta: new Float64Array(0),
      gapR: 1,
    };
    const mag = new Float64Array([1.6]);
    const { ctx, log } = recordingCtx();
    MMV.drawSaturation(ctx, mesh, { mag }, {});  // BkneeDefault=1.6 → ratio 1.0 → t 0.5

    const fills = log.filter(e => e.op === "set" && e.key === "fillStyle").map(e => e.value);
    assert.ok(fills.length >= 1, "expected at least one fillStyle set");
    assert.strictEqual(fills[0], MMV.viridis(0.5));
    assert.strictEqual(fills[0], "rgb(33,145,140)");
  });

  it("the removed geometry surface is gone", () => {
    const filePath = path.resolve(__dirname, "../../lib/motor-mesh-view.js");
    const text = fs.readFileSync(filePath, "utf8");
    const removed = ["drawMaterial", "drawCurrentDensity", "colorFor", "magnetPoleColor", "KIND_PALETTE"];
    for (const name of removed) {
      assert.strictEqual(text.indexOf(name), -1,
        `motor-mesh-view.js still contains removed symbol '${name}'`);
    }
  });
});
