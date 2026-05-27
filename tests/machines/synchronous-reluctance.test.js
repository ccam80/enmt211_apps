"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepInductance, crossCheck, runFromRest,
} = require("./_fixtures.js");
const { fitCos2Cos4 } = require("../_assert.js");

const POLES = 4;
const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("synchronous-reluctance");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("synchronous-reluctance");
  assert.equal(expanded.nCircuits, config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        `unexpected feature kind: ${feature.kind}`
      );
    }
  }
});

test("self-inductance follows L0+L2cos2theta_e+L4cos4theta_e", { timeout: TIMEOUT }, function () {
  const { stack } = build("synchronous-reluctance");
  const period = 2 * Math.PI / (POLES / 2);
  const N = 48;
  const thetas = [];
  for (let k = 0; k < N; k++) thetas.push((k / N) * period);
  const Ls = sweepInductance(stack, thetas, 0);
  const thetasE = thetas.map((t) => (POLES / 2) * t);
  const fit = fitCos2Cos4(thetasE, Ls);
  // synrel is L2-dominant: electrical-2 ~94.8%, electrical-4 ~5.1%, combined r2 ~0.999.
  assert.ok(fit.r2 >= 0.99, `r2=${fit.r2} < 0.99`);
  assert.ok(
    Math.max(Math.abs(fit.L2), Math.abs(fit.L4)) > 1e-9,
    `max(|L2|,|L4|)=${Math.max(Math.abs(fit.L2), Math.abs(fit.L4))} not > 1e-9`
  );
});

test("lambda_pm is identically zero", { timeout: TIMEOUT }, function () {
  const { stack } = build("synchronous-reluctance");
  const co = stack.extractCoeffs(0.3);
  for (let k = 0; k < co.lambdaPm.length; k++) {
    assert.equal(co.lambdaPm[k], 0, `lambdaPm[${k}] !== 0`);
    assert.equal(co.dLambdaPmdth[k], 0, `dLambdaPmdth[${k}] !== 0`);
  }
});

test("self-starts under electronic-sine commutation", { timeout: TIMEOUT }, function () {
  // Clears 1e-3 within ~3 steps; 20 gives a wide margin while bounding the
  // no-load free-spin and its per-step cache misses (FIX 8 trim).
  const { runtime } = build("synchronous-reluctance");
  const state = runFromRest(runtime, 20);
  assert.ok(Math.abs(state.theta) > 1e-3, `theta=${state.theta} not > 1e-3 (did not start)`);
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("synchronous-reluctance");
  const result = crossCheck(stack, 0.3, new Float64Array([24, -12, -12]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});
