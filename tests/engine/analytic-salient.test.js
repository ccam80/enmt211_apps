"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const LIB = require("../_shim.js");
const { assertClose, SALIENT_DEFAULTS, buildSalient, fitCos2 } = require("./_fixtures.js");

// Build the fixture once (shared across all three tests in this file)
const fixture = buildSalient(SALIENT_DEFAULTS);
const { op, coilMasks } = fixture;
const current = SALIENT_DEFAULTS.current;

// Sweep θr ∈ [0, π) with 32 samples
const nSamples = 32;
const thetaRs = [];
const L11s = [];
const arkkios = [];

for (let k = 0; k < nSamples; k++) {
  const thetaR = (k / nSamples) * Math.PI;
  thetaRs.push(thetaR);
  const { L11, torqueArkkio } = fixture.sweepThetaR(thetaR);
  L11s.push(L11);
  arkkios.push(torqueArkkio);
}

// Fit L(θr) = L0 + L2·cos2θr
const { L0, L2, r2 } = fitCos2(thetaRs, L11s);

test("L(θr) fits L0 + L2 cos2θr", () => {
  assert.ok(r2 > 0.999, `R² = ${r2} should be > 0.999 for L(θr) = L0 + L2·cos2θr fit`);
});

test("Arkkio torque matches −i²L2 sin2θr", () => {
  // Analytic: T(θr) = −current² · L2 · sin(2θr).
  // Relative-L∞ error over the sweep: ‖arkkio − analytic‖∞ / ‖analytic‖∞.
  // Normalizing by the sweep peak (not pointwise) keeps the metric well-defined
  // at the sin2θr zero-crossings, where the true torque is exactly zero.
  let maxDiff = 0;
  let maxRef = 0;
  for (let k = 0; k < nSamples; k++) {
    const Tanalytic = -current * current * L2 * Math.sin(2 * thetaRs[k]);
    const Tnum = arkkios[k];
    const diff = Math.abs(Tnum - Tanalytic);
    if (diff > maxDiff) maxDiff = diff;
    if (Math.abs(Tanalytic) > maxRef) maxRef = Math.abs(Tanalytic);
  }
  const relErr = maxDiff / maxRef;
  assert.ok(
    relErr < 0.03,
    `Arkkio vs −i²L2sin2θr: relative L∞ error = ${relErr}, expected < 0.03`
  );
});

test("Arkkio matches co-energy total", () => {
  // Compare arkkio vs coenergy.total over the swept angles, using the same
  // relative-L∞ norm (peak-normalized, robust at the torque zero-crossings).
  // The co-energy solve needs a tight tolerance so its finite-difference dL/dθ
  // is not swamped by solver residual.
  const solveFn = (op, b, opts) =>
    LIB.AirgapSolve.pcg(op, b, Object.assign({ tol: 1e-11, maxIter: 8000 }, opts));
  const currents = [current];

  let maxDiff = 0;
  let maxRef = 0;
  const step = 4;
  for (let k = 0; k < nSamples; k += step) {
    const thetaR = thetaRs[k];
    const TArkkio = arkkios[k];

    const { total: TCoenergy } = LIB.AirgapTorque.coenergy(op, solveFn, {
      thetaR,
      currents,
      coilMasks,
      magnetization: null,
      ironMask: null,
    });

    const diff = Math.abs(TArkkio - TCoenergy);
    if (diff > maxDiff) maxDiff = diff;
    if (Math.abs(TCoenergy) > maxRef) maxRef = Math.abs(TCoenergy);
  }

  const relErr = maxDiff / maxRef;
  assert.ok(
    relErr < 0.02,
    `Arkkio vs co-energy total: relative L∞ error = ${relErr}, expected < 0.02`
  );
});
