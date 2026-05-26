"use strict";

// =============================================================================
//  Shared fixtures and helpers for motor-mesh tests.
//  Not a test file — no .test.js suffix.
//
//  Loads the window global via the shim, then requires the needed libs.
//  Re-exports assertClose from tests/_assert.js.
// =============================================================================

const path = require("path");

// Shim: install window global
if (!globalThis.window) globalThis.window = globalThis;

// Load required lib modules in order
const ROOT = path.join(__dirname, "..", "..");

function loadLib(name) {
  require(path.join(ROOT, "lib", name));
}

function loadLesson(relPath) {
  require(path.join(ROOT, relPath));
}

loadLib("util.js");
loadLib("winding-model.js");
loadLesson("lessons/unified_motor/config-schema.js");
loadLib("motor-mesh.js");
loadLib("motor-mesh-view.js");

const { assertClose } = require("../_assert.js");

const LIB = window.LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  singleAnnulusSection() → section
//
//  A single iron annulus covering both "rotor" and "stator" in one body.
//  For simplicity we use one rotor iron ring as a standalone body.
//  r_rotor_surface = 0.045, r_stator_bore = 0.050 so gap = 0.005.
// ---------------------------------------------------------------------------
function singleAnnulusSection() {
  return {
    features: [
      {
        kind: "iron",
        member: "rotor",
        rRange: [0.030, 0.045],
        thetaRange: [0, TWO_PI],
        muR: 1000,
      },
      {
        kind: "iron",
        member: "stator",
        rRange: [0.050, 0.060],
        thetaRange: [0, TWO_PI],
        muR: 1000,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
//  ringStackSection() → section
//
//  A multi-ring section with rotor (M + back-iron I) and stator (W + yoke I).
//  Mimics a PMSM-like topology.
// ---------------------------------------------------------------------------
function ringStackSection() {
  const ROTOR_YOKE    = [0.030, 0.038];
  const ROTOR_SURFACE = [0.038, 0.043];
  const STATOR_YOKE   = [0.051, 0.055];
  const STATOR_BORE   = [0.047, 0.051];

  return {
    features: [
      // Rotor: 4 alternating magnets
      { kind: "magnet", member: "rotor", rRange: ROTOR_SURFACE,
        thetaRange: [0,            TWO_PI / 4], Mr:  9e5, Mtheta: 0 },
      { kind: "magnet", member: "rotor", rRange: ROTOR_SURFACE,
        thetaRange: [TWO_PI / 4,  TWO_PI / 2], Mr: -9e5, Mtheta: 0 },
      { kind: "magnet", member: "rotor", rRange: ROTOR_SURFACE,
        thetaRange: [TWO_PI / 2,  3*TWO_PI/4], Mr:  9e5, Mtheta: 0 },
      { kind: "magnet", member: "rotor", rRange: ROTOR_SURFACE,
        thetaRange: [3*TWO_PI/4,  TWO_PI],     Mr: -9e5, Mtheta: 0 },
      // Rotor back-iron (full circle)
      { kind: "iron", member: "rotor", rRange: ROTOR_YOKE,
        thetaRange: [0, TWO_PI], muR: 1000 },
      // Stator winding slots (simplified: 4 conductor slots + iron)
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [0,           TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [TWO_PI / 4, TWO_PI / 2], circuit: 1, turns: -40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [TWO_PI / 2, 3*TWO_PI/4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [3*TWO_PI/4, TWO_PI],     circuit: 1, turns: -40 },
      // Stator back-iron (full circle)
      { kind: "iron", member: "stator", rRange: STATOR_YOKE,
        thetaRange: [0, TWO_PI], muR: 1000 },
    ],
  };
}

// ---------------------------------------------------------------------------
//  meshFromConfig(config, opts) → { rotor, stator }
//
//  Expand the config via ConfigSchema, take slice-0 section, build mesh.
// ---------------------------------------------------------------------------
function meshFromConfig(config, opts) {
  const expanded = window.UnifiedMotor.ConfigSchema.expand(config);
  const section = expanded.slices[0].section;
  return LIB.MotorMesh.build(section, opts || {});
}

// ---------------------------------------------------------------------------
//  signedAreaOf(mesh, e) → signed area of element e (positive = CCW)
// ---------------------------------------------------------------------------
function signedAreaOf(mesh, e) {
  const { nodes, elems } = mesh;
  const n0 = elems[4 * e];
  const n1 = elems[4 * e + 1];
  const n2 = elems[4 * e + 2];
  const n3 = elems[4 * e + 3];
  const x0 = nodes[2*n0], y0 = nodes[2*n0+1];
  const x1 = nodes[2*n1], y1 = nodes[2*n1+1];
  const x2 = nodes[2*n2], y2 = nodes[2*n2+1];
  if (n3 === -1) {
    return 0.5 * ((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
  }
  const x3 = nodes[2*n3], y3 = nodes[2*n3+1];
  return 0.5 * ((x0*y1-x1*y0) + (x1*y2-x2*y1) + (x2*y3-x3*y2) + (x3*y0-x0*y3));
}

// ---------------------------------------------------------------------------
//  annulusArea(r0, r1) → π(r1²−r0²)
// ---------------------------------------------------------------------------
function annulusArea(r0, r1) {
  return Math.PI * (r1 * r1 - r0 * r0);
}

// ---------------------------------------------------------------------------
//  interiorEdgeSharing(mesh) → { ok: boolean, badEdges: Array<[nodeA, nodeB]> }
//
//  Every interior edge (shared by 2 elements) must be referenced exactly twice.
//  Boundary edges (referenced once) on the outer/inner/gap radial boundaries
//  are allowed exactly once.
//  Returns ok:true if no violations found, else ok:false with up to 3 bad edges.
// ---------------------------------------------------------------------------
function interiorEdgeSharing(mesh) {
  const { nodes, elems } = mesh;
  const Ne = elems.length / 4;
  const Nn = nodes.length / 2;

  // Find boundary node indices (on the radial extremes)
  let rMin = Infinity, rMax = -Infinity;
  for (let n = 0; n < Nn; n++) {
    const r = Math.hypot(nodes[2*n], nodes[2*n+1]);
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }

  const TOL = 1e-10;
  function isBoundaryNode(ni) {
    const r = Math.hypot(nodes[2*ni], nodes[2*ni+1]);
    return Math.abs(r - rMin) < TOL || Math.abs(r - rMax) < TOL;
  }

  // Count edge references
  const edgeCount = new Map();
  function edgeKey(a, b) {
    return a < b ? `${a},${b}` : `${b},${a}`;
  }
  function addEdge(a, b) {
    const k = edgeKey(a, b);
    edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    return k;
  }

  for (let e = 0; e < Ne; e++) {
    const n0 = elems[4*e];
    const n1 = elems[4*e+1];
    const n2 = elems[4*e+2];
    const n3 = elems[4*e+3];
    const isTri = n3 === -1;
    if (isTri) {
      addEdge(n0, n1);
      addEdge(n1, n2);
      addEdge(n2, n0);
    } else {
      addEdge(n0, n1);
      addEdge(n1, n2);
      addEdge(n2, n3);
      addEdge(n3, n0);
    }
  }

  const badEdges = [];
  for (const [k, count] of edgeCount) {
    if (count === 1) {
      // Boundary edge — check both nodes are on radial boundary
      const parts = k.split(",");
      const a = parseInt(parts[0], 10);
      const b = parseInt(parts[1], 10);
      if (!isBoundaryNode(a) || !isBoundaryNode(b)) {
        badEdges.push([a, b]);
        if (badEdges.length >= 3) break;
      }
    } else if (count > 2) {
      const parts = k.split(",");
      badEdges.push([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
      if (badEdges.length >= 3) break;
    }
  }

  return { ok: badEdges.length === 0, badEdges };
}

// ---------------------------------------------------------------------------
//  recordingCtx() → mock 2-D context that counts draw calls
// ---------------------------------------------------------------------------
function recordingCtx() {
  const counts = {
    beginPath: 0,
    moveTo: 0,
    lineTo: 0,
    closePath: 0,
    fill: 0,
    stroke: 0,
    arc: 0,
  };
  const ctx = {
    _counts: counts,
    beginPath() { counts.beginPath++; },
    moveTo(x, y) { counts.moveTo++; },
    lineTo(x, y) { counts.lineTo++; },
    closePath() { counts.closePath++; },
    fill() { counts.fill++; },
    stroke() { counts.stroke++; },
    arc(x, y, r, a0, a1) { counts.arc++; },
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
  };
  return ctx;
}

module.exports = {
  assertClose,
  singleAnnulusSection,
  ringStackSection,
  meshFromConfig,
  signedAreaOf,
  annulusArea,
  interiorEdgeSharing,
  recordingCtx,
  LIB,
};
