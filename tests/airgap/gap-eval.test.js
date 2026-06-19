"use strict";

// =============================================================================
//  LIB.GapEval unit tests — polar-Laplace gap reconstruction helper
// =============================================================================

const { test, before } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

if (!globalThis.window) globalThis.window = globalThis;
try { require("../../lib/util.js"); } catch (e) { globalThis.window.LIB = globalThis.window.LIB || {}; }

process.env.FEA_SOLVER_MJS_PATH = path.resolve(__dirname, "../../lib/solver.mjs");
require("../../lib/fea-solver.js");
require("../../lib/gap-eval.js");

const LIB = globalThis.window.LIB || globalThis.LIB;

before(async () => { await LIB.FeaSolver.init(); });

const PI = Math.PI;
const TWO_PI = 2 * PI;
const Rr = 0.050, Rs = 0.053;
const N = 256;

// Analytic harmonic A(r,theta) = (a*rho^k + b*rho^-k)*cos(k*theta) + (c*rho^k + d*rho^-k)*sin(k*theta)
// rho = r/r0, r0 = 0.5*(Rr+Rs)
const r0 = 0.5 * (Rr + Rs);
const HA = 1.0, HB = 0.5, HC = 0.3, HD = 0.8;

function analyticA(r, theta, k) {
  const rho = r / r0;
  const pk = Math.pow(rho, k), pmk = Math.pow(rho, -k);
  return (HA * pk + HB * pmk) * Math.cos(k * theta) + (HC * pk + HD * pmk) * Math.sin(k * theta);
}

function analyticBr(r, theta, k) {
  const rho = r / r0;
  const pk = Math.pow(rho, k), pmk = Math.pow(rho, -k);
  const A = (HA * pk + HB * pmk) * (-k * Math.sin(k * theta)) + (HC * pk + HD * pmk) * (k * Math.cos(k * theta));
  return A / r;
}

function analyticBth(r, theta, k) {
  const rho = r / r0;
  const dApk = k * Math.pow(rho, k - 1) / r0;
  const dApmk = -k * Math.pow(rho, -k - 1) / r0;
  const dAdr = (HA * dApk + HB * dApmk) * Math.cos(k * theta) + (HC * dApk + HD * dApmk) * Math.sin(k * theta);
  return -dAdr;
}

// Build a descriptor for the analytic harmonic in the lab frame, with rotor offset off=0.5/N nodes
function makeDescriptor(k, phi) {
  const off = 0.5;  // half-node rotor offset
  const rotorTheta = new Float64Array(N);
  const rotorA = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const bodyAngle = ((i + off) * TWO_PI / N) % TWO_PI;
    rotorTheta[i] = bodyAngle;
    // Lab angle for rotor node i = bodyAngle + phi; sample analytic A at that lab angle
    rotorA[i] = analyticA(Rr, bodyAngle + phi, k);
  }

  const statorTheta = new Float64Array(N);
  const statorA = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    statorTheta[i] = (i * TWO_PI / N) % TWO_PI;
    statorA[i] = analyticA(Rs, statorTheta[i], k);
  }

  return {
    rotor:  { gapR: Rr, gapTheta: rotorTheta, A: rotorA },
    stator: { gapR: Rs, gapTheta: statorTheta, A: statorA },
    phi,
  };
}

// -------------------------------------------------------------------------
test("reconstructs an analytic gap harmonic (round-trip)", () => {
  for (const k of [1, 2, 3, 4]) {
    for (const phi of [0, 0.4]) {
      const desc = makeDescriptor(k, phi);
      const { rs, thetas, Az } = LIB.GapEval.evalAOnGrid(desc, { Nr: 16, Ntheta: 128 });
      const Nr = rs.length, Ntheta = thetas.length;

      // Compute maxInteriorA over interior rings i in [1, Nr-2]
      let maxInteriorA = 0;
      for (let i = 1; i <= Nr - 2; i++) {
        for (let j = 0; j < Ntheta; j++) {
          const v = Math.abs(Az[i * Ntheta + j]);
          if (v > maxInteriorA) maxInteriorA = v;
        }
      }
      assert.ok(maxInteriorA > 0,
        `k=${k} phi=${phi}: maxInteriorA=${maxInteriorA} must be > 0`);

      // Max relative error over interior rings
      let maxRelErr = 0;
      for (let i = 1; i <= Nr - 2; i++) {
        for (let j = 0; j < Ntheta; j++) {
          const analytic = analyticA(rs[i], thetas[j], k);
          const err = Math.abs(Az[i * Ntheta + j] - analytic) / maxInteriorA;
          if (err > maxRelErr) maxRelErr = err;
        }
      }
      assert.ok(maxRelErr < 0.03,
        `k=${k} phi=${phi}: max relative Az error = ${maxRelErr.toFixed(4)} (want < 0.03)`);
    }
  }
});

// -------------------------------------------------------------------------
test("honors the Dirichlet boundary rings", () => {
  const k = 2, phi = 0.37;
  const desc = makeDescriptor(k, phi);
  const { rs, thetas, Az } = LIB.GapEval.evalAOnGrid(desc, { Nr: 16, Ntheta: 128 });
  const Nr = rs.length, Ntheta = thetas.length;

  // Boundary normalization: max |A| on the boundary rows
  let maxA = 0;
  for (let j = 0; j < Ntheta; j++) {
    maxA = Math.max(maxA, Math.abs(analyticA(Rr, thetas[j], k)));
    maxA = Math.max(maxA, Math.abs(analyticA(Rs, thetas[j], k)));
  }

  // Row 0: r = Rr
  let maxErrR = 0;
  for (let j = 0; j < Ntheta; j++) {
    const analytic = analyticA(Rr, thetas[j], k);
    maxErrR = Math.max(maxErrR, Math.abs(Az[j] - analytic) / maxA);
  }
  assert.ok(maxErrR < 0.01,
    `Dirichlet Rr row: max relative error = ${maxErrR.toFixed(4)} (want < 0.01)`);

  // Row Nr-1: r = Rs
  let maxErrS = 0;
  for (let j = 0; j < Ntheta; j++) {
    const analytic = analyticA(Rs, thetas[j], k);
    maxErrS = Math.max(maxErrS, Math.abs(Az[(Nr - 1) * Ntheta + j] - analytic) / maxA);
  }
  assert.ok(maxErrS < 0.01,
    `Dirichlet Rs row: max relative error = ${maxErrS.toFixed(4)} (want < 0.01)`);
});

// -------------------------------------------------------------------------
test("field is smooth, finite, and monotone for a radial BC", () => {
  // (a) k=2 harmonic at multiple phi: all Az, Br, Bth finite
  const k = 2;
  for (const phi of [0, 0.37, PI / 3]) {
    const desc = makeDescriptor(k, phi);
    const { Az, Br, Bth } = LIB.GapEval.evalAOnGrid(desc, { Nr: 16, Ntheta: 128 });
    for (let idx = 0; idx < Az.length; idx++) {
      assert.ok(isFinite(Az[idx]), `phi=${phi}: Az[${idx}] is not finite: ${Az[idx]}`);
    }
    for (let idx = 0; idx < Br.length; idx++) {
      assert.ok(isFinite(Br[idx]), `phi=${phi}: Br[${idx}] is not finite: ${Br[idx]}`);
    }
    for (let idx = 0; idx < Bth.length; idx++) {
      assert.ok(isFinite(Bth[idx]), `phi=${phi}: Bth[${idx}] is not finite: ${Bth[idx]}`);
    }
  }

  // (b) Constant-boundary descriptor: rotor.A = 0, stator.A = 1, phi = 0
  const rotorTheta = new Float64Array(N);
  const statorTheta = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rotorTheta[i] = i * TWO_PI / N;
    statorTheta[i] = i * TWO_PI / N;
  }
  const constDesc = {
    rotor:  { gapR: Rr, gapTheta: rotorTheta, A: new Float64Array(N).fill(0) },
    stator: { gapR: Rs, gapTheta: statorTheta, A: new Float64Array(N).fill(1) },
    phi: 0,
  };
  const { Az: AzC, rs: rsC } = LIB.GapEval.evalAOnGrid(constDesc, { Nr: 8, Ntheta: 64 });
  const NrC = rsC.length, NthetaC = 64;
  // Az must be monotone non-decreasing in i at every j
  for (let j = 0; j < NthetaC; j++) {
    for (let i = 0; i < NrC - 1; i++) {
      assert.ok(AzC[(i + 1) * NthetaC + j] >= AzC[i * NthetaC + j] - 1e-12,
        `Constant BC: Az not monotone at j=${j} i=${i}: ${AzC[i * NthetaC + j]} -> ${AzC[(i + 1) * NthetaC + j]}`);
    }
  }
});

// -------------------------------------------------------------------------
test("reconstructs gap B from the harmonic", () => {
  const k = 2, phi = 0;
  const desc = makeDescriptor(k, phi);
  const { rs, thetas, Az, Br, Bth } = LIB.GapEval.evalAOnGrid(desc, { Nr: 24, Ntheta: 192 });
  const Nr = rs.length, Ntheta = thetas.length;

  // Normalization: max |B| over interior
  let maxB = 0;
  for (let i = 1; i <= Nr - 2; i++) {
    for (let j = 0; j < Ntheta; j++) {
      maxB = Math.max(maxB, Math.abs(analyticBr(rs[i], thetas[j], k)));
      maxB = Math.max(maxB, Math.abs(analyticBth(rs[i], thetas[j], k)));
    }
  }

  let maxErrBr = 0, maxErrBth = 0;
  for (let i = 1; i <= Nr - 2; i++) {
    for (let j = 0; j < Ntheta; j++) {
      const aBr = analyticBr(rs[i], thetas[j], k);
      const aBth = analyticBth(rs[i], thetas[j], k);
      maxErrBr = Math.max(maxErrBr, Math.abs(Br[i * Ntheta + j] - aBr) / maxB);
      maxErrBth = Math.max(maxErrBth, Math.abs(Bth[i * Ntheta + j] - aBth) / maxB);
    }
  }
  assert.ok(maxErrBr < 0.08,
    `Br max relative error = ${maxErrBr.toFixed(4)} (want < 0.08)`);
  assert.ok(maxErrBth < 0.08,
    `Bth max relative error = ${maxErrBth.toFixed(4)} (want < 0.08)`);
});

// -------------------------------------------------------------------------
test("output shape and indexing", () => {
  const Nr = 8, Ntheta = 64;
  const desc = makeDescriptor(2, 0);
  const result = LIB.GapEval.evalAOnGrid(desc, { Nr, Ntheta });
  const { rs, thetas, Az, Br, Bth, Bmag } = result;

  assert.strictEqual(rs.length, Nr, `rs.length should be ${Nr}`);
  assert.strictEqual(thetas.length, Ntheta, `thetas.length should be ${Ntheta}`);
  assert.strictEqual(Az.length, Nr * Ntheta, `Az.length should be ${Nr * Ntheta}`);
  assert.strictEqual(Br.length, Nr * Ntheta, `Br.length should be ${Nr * Ntheta}`);
  assert.strictEqual(Bth.length, Nr * Ntheta, `Bth.length should be ${Nr * Ntheta}`);
  assert.strictEqual(Bmag.length, Nr * Ntheta, `Bmag.length should be ${Nr * Ntheta}`);

  assert.ok(Math.abs(rs[0] - Rr) < 1e-12, `rs[0]=${rs[0]} should equal Rr=${Rr}`);
  assert.ok(Math.abs(rs[Nr - 1] - Rs) < 1e-12, `rs[Nr-1]=${rs[Nr - 1]} should equal Rs=${Rs}`);

  for (let j = 0; j < Ntheta; j++) {
    assert.strictEqual(thetas[j], j * TWO_PI / Ntheta,
      `thetas[${j}]=${thetas[j]} should equal ${j * TWO_PI / Ntheta}`);
  }
});

// -------------------------------------------------------------------------
test("Nr=2 degenerate grid has no interior solve", () => {
  const Nr = 2, Ntheta = 64;
  const desc = makeDescriptor(2, 0);
  let result;
  assert.doesNotThrow(() => {
    result = LIB.GapEval.evalAOnGrid(desc, { Nr, Ntheta });
  });
  const { Az, Br, Bth, Bmag } = result;
  for (let idx = 0; idx < Az.length; idx++) {
    assert.ok(isFinite(Az[idx]), `Nr=2: Az[${idx}] is not finite`);
  }
  assert.strictEqual(Az.length, Nr * Ntheta);
});

// -------------------------------------------------------------------------
test("rejects malformed input", () => {
  const rotorTheta = new Float64Array(N);
  const statorTheta = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rotorTheta[i] = i * TWO_PI / N;
    statorTheta[i] = i * TWO_PI / N;
  }
  const R = { gapR: Rr, gapTheta: rotorTheta, A: new Float64Array(N) };

  // No rings
  assert.throws(
    () => LIB.GapEval.evalAOnGrid({ phi: 0 }, { Nr: 8, Ntheta: 64 }),
    /Error/
  );

  // stator.gapR <= rotor.gapR
  const sameR = { gapR: Rr, gapTheta: statorTheta, A: new Float64Array(N) };
  assert.throws(
    () => LIB.GapEval.evalAOnGrid({ rotor: R, stator: sameR, phi: 0 }, { Nr: 8, Ntheta: 64 }),
    /Error/
  );

  // Nr < 2
  const sDesc = makeDescriptor(2, 0);
  assert.throws(
    () => LIB.GapEval.evalAOnGrid(sDesc, { Nr: 1, Ntheta: 64 }),
    /Error/
  );
});

// -------------------------------------------------------------------------
test("is machine-agnostic and DOM-free", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../lib/gap-eval.js"),
    "utf8"
  );

  const machineNames = ["bldc", "pmsm", "srm", "squirrel", "stepper", "brushed", "universal-motor", "wound-field"];
  for (const name of machineNames) {
    const re = new RegExp(name, "i");
    assert.ok(!re.test(src),
      `gap-eval.js must not contain machine name "${name}"`);
  }

  assert.ok(!src.includes("document."),
    "gap-eval.js must not contain any document. reference");
});