"use strict";

// =============================================================================
//  ∂T/∂A correctness gate — torqueGrad vs central differences.
//
//  The monolithic field-circuit-motion Newton needs the torque sensitivity
//  ∂T/∂A on the gap rings (the mechanics-row border ∂R_mech/∂A). torqueGrad
//  computes it by back-propagating the Maxwell band-average (a bilinear form in
//  the ring-field stack) through one adjoint reconstruction solve and the
//  resample transpose. This gate verifies it node-by-node against a central
//  difference of torque() — they must agree to the FD truncation floor.
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const path = require("path");

if (!globalThis.window) globalThis.window = globalThis;
try { require("../../lib/util.js"); } catch (e) { globalThis.window.LIB = globalThis.window.LIB || {}; }
process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/airgap-mortar.js");

const LIB = globalThis.window.LIB || globalThis.LIB;
const M = LIB.AirgapMortar;
const PI = Math.PI;

before(async () => { await LIB.FeaSolver.init(); });

function ring(N, R, off) {
  const th = new Float64Array(N);
  for (let i = 0; i < N; i++) th[i] = ((i + off) * 2 * PI / N) % (2 * PI);
  return { gapTheta: th, gapR: R };
}

test("torqueGrad matches central-difference ∂T/∂A on both gap rings", () => {
  const Rr = 0.050, Rs = 0.053, N = 64, ell = 0.1, phi = 0.37;
  const rg = ring(N, Rr, 0.5), sg = ring(N, Rs, 0);   // rotor ring offset (FEA always rotates it)
  const eng = M.build(rg, sg, { ell });

  const aR = new Float64Array(N), aS = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    aR[i] = Math.sin(2.3 * i + 1) + 0.4 * Math.cos(5 * i);
    aS[i] = Math.cos(1.7 * i) - 0.3 * Math.sin(3 * i);
  }
  const gRot = new Float64Array(N), gStat = new Float64Array(N);
  eng.torqueGrad(aR, aS, phi, gRot, gStat);

  const eps = 1e-6;
  function fd(which, k) {
    const a = Float64Array.from(which === "r" ? aR : aS);
    a[k] += eps;
    const tp = which === "r" ? eng.torque(a, aS, phi) : eng.torque(aR, a, phi);
    a[k] -= 2 * eps;
    const tm = which === "r" ? eng.torque(a, aS, phi) : eng.torque(aR, a, phi);
    return (tp - tm) / (2 * eps);
  }

  let maxRel = 0;
  for (const k of [0, 5, 11, 19, 27, 33, 48, 60]) {
    const rel = Math.abs(gRot[k] - fd("r", k)) / (Math.abs(fd("r", k)) + 1e-9);
    if (rel > maxRel) maxRel = rel;
  }
  for (const k of [2, 8, 14, 22, 30, 41, 55, 63]) {
    const rel = Math.abs(gStat[k] - fd("s", k)) / (Math.abs(fd("s", k)) + 1e-9);
    if (rel > maxRel) maxRel = rel;
  }
  assert.ok(maxRel < 1e-5, `∂T/∂A vs FD max relative error ${maxRel.toExponential(2)} (want < 1e-5)`);
});
