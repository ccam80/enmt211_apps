"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  build, validate, sweepInductance, crossCheck, runFromRest, LIB,
} = require("./_fixtures.js");
const { fitCos2Cos4 } = require("../engine/_fixtures.js");

const POLES = 4;
const TIMEOUT = 25000;

test("config validates", { timeout: TIMEOUT }, function () {
  const result = validate("switched-reluctance");
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("expands to Phase-2 sections with matching circuit count", { timeout: TIMEOUT }, function () {
  const { expanded, config } = build("switched-reluctance");
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
  const { stack } = build("switched-reluctance");
  const period = 2 * Math.PI / (POLES / 2);
  const N = 48;
  const thetas = [];
  for (let k = 0; k < N; k++) thetas.push((k / N) * period);
  const Ls = sweepInductance(stack, thetas, 0);
  const thetasE = thetas.map((t) => (POLES / 2) * t);
  const fit = fitCos2Cos4(thetasE, Ls);
  assert.ok(fit.r2 >= 0.99, `r2=${fit.r2} < 0.99`);
  assert.ok(
    Math.max(Math.abs(fit.L2), Math.abs(fit.L4)) > 1e-9,
    `max(|L2|,|L4|)=${Math.max(Math.abs(fit.L2), Math.abs(fit.L4))} not > 1e-9`
  );
});

test("lambda_pm is identically zero", { timeout: TIMEOUT }, function () {
  const { stack } = build("switched-reluctance");
  const co = stack.extractCoeffs(0.3);
  for (let k = 0; k < co.lambdaPm.length; k++) {
    assert.equal(co.lambdaPm[k], 0, `lambdaPm[${k}] !== 0`);
    assert.equal(co.dLambdaPmdth[k], 0, `dLambdaPmdth[${k}] !== 0`);
  }
});

test("reluctance torque is proportional to i^2 below the iron knee", { timeout: TIMEOUT }, function () {
  // Linear-regime law — evaluate on the ceiling-disabled (linear) stack, the
  // same linear-operating-point methodology crossCheck uses.
  const { expanded } = build("switched-reluctance");
  const stackLin = LIB.MotorStack.create(expanded, { ceiling: { enabled: false } });
  const theta = 0.3;
  const t1 = stackLin.solve(theta, new Float64Array([8, 0, 0])).torque;
  const t2 = stackLin.solve(theta, new Float64Array([16, 0, 0])).torque;
  assert.ok(Math.abs(t1) > 1e-5, `|t1|=${Math.abs(t1)} not > 1e-5`);
  const ratio = t2 / t1;
  assert.ok(Math.abs(ratio - 4) <= 0.05 * 4,
    `t2/t1=${ratio} not within 4 +/- 0.2 (reluctance torque not proportional to i^2)`);
});

test("self-starts under electronic-trap commutation", { timeout: TIMEOUT }, function () {
  // The rotor clears 1e-3 within ~3 steps; 20 gives a ~500x margin while keeping
  // the no-load free-spin (and its per-step cache misses) bounded (FIX 8 trim).
  const { runtime } = build("switched-reluctance");
  const state = runFromRest(runtime, 20);
  assert.ok(Math.abs(state.theta) > 1e-3, `theta=${state.theta} not > 1e-3 (did not start)`);
});

test("Maxwell vs co-energy within 5%", { timeout: TIMEOUT }, function () {
  const { stack } = build("switched-reluctance");
  const result = crossCheck(stack, 0.3, new Float64Array([12, 0, 0]));
  assert.ok(result.ok, `crossCheck failed: arkkio=${result.arkkio}, coe=${result.coe}, rel=${result.rel}`);
});

// (C) carve-out, not asserted here: the saturated aligned-vs-unaligned torque
// differential is a Phase-9 acceptance; this file checks only the linear
// reluctance shape + i^2 law below the knee.
