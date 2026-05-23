"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SALIENT_DEFAULTS, buildSalient, fitCos2 } = require("./_fixtures.js");

test("torque error decreases with Nθ", () => {
  const NthetaValues = [64, 128, 256];
  const nSamples = 16; // ≥ 16 samples over [0, π)
  const current = SALIENT_DEFAULTS.current;

  const errors = [];

  for (const Ntheta of NthetaValues) {
    const params = Object.assign({}, SALIENT_DEFAULTS, { Ntheta });
    const fixture = buildSalient(params);
    const { op } = fixture;

    // Sweep θr ∈ [0, π)
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

    // Fit L(θr) = L0 + L2·cos2θr to get the analytic L2
    const { L2 } = fitCos2(thetaRs, L11s);

    // Relative-L∞ error vs closed form T(θr) = −i²·L2·sin2θr:
    // ‖arkkio − analytic‖∞ / ‖analytic‖∞ (peak-normalized over the sweep).
    let maxDiff = 0;
    let maxRef = 0;
    for (let k = 0; k < nSamples; k++) {
      const Tanalytic = -current * current * L2 * Math.sin(2 * thetaRs[k]);
      const Tnum = arkkios[k];
      const diff = Math.abs(Tnum - Tanalytic);
      if (diff > maxDiff) maxDiff = diff;
      if (Math.abs(Tanalytic) > maxRef) maxRef = Math.abs(Tanalytic);
    }

    errors.push(maxDiff / maxRef);
  }

  // Error must be strictly monotone decreasing with Ntheta
  for (let k = 1; k < errors.length; k++) {
    assert.ok(
      errors[k] < errors[k - 1],
      `Error at Ntheta=${NthetaValues[k]} (${errors[k]}) should be strictly less than at Ntheta=${NthetaValues[k-1]} (${errors[k-1]})`
    );
  }

  // Error at Ntheta=256 must be < 0.03
  const finalError = errors[errors.length - 1];
  assert.ok(
    finalError < 0.03,
    `Relative L∞ error at Ntheta=256 is ${finalError}, expected < 0.03`
  );
});
