"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SALIENT_DEFAULTS, buildSalient } = require("./_fixtures.js");

test("∮ B_r dθ = 0 on the mid-gap row", () => {
  const { op, Jz, sweepThetaR } = buildSalient(SALIENT_DEFAULTS);

  // Solve at thetaR=0
  const { Az, Br } = sweepThetaR(0);

  const Ntheta = op.Ntheta;
  const Nr = op.Nr;
  const dtheta = op.dtheta;

  // Mid-gap row
  const midGapRow = Math.floor(Nr / 2);

  let sum = 0;
  for (let j = 0; j < Ntheta; j++) {
    sum += Br[midGapRow * Ntheta + j] * dtheta;
  }

  assert.ok(
    Math.abs(sum) < 1e-9,
    `∮ B_r dθ = ${sum} on mid-gap row, expected < 1e-9 in absolute value`
  );
});
