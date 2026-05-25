"use strict";

// =============================================================================
//  tests/detailed/cogging.test.js
//
//  Cogging/detent accuracy gate: the refined tier must be grid-converged for
//  the cogging torque amplitude, and the Live coarse tier must provably not
//  be grid-converged (validating why Detailed exists).
// =============================================================================

const assert = require("node:assert/strict");
const test   = require("node:test");

const {
  coggingConfig,
  refinedStack,
  coarseStack,
  sweepTorque,
  ripple,
  mean,
  signChanges,
  amp,
} = require("./_fixtures.js");

// ---------------------------------------------------------------------------
//  Helper: build thetas array (uniform cell-centre samples over [0, period))
// ---------------------------------------------------------------------------
function buildThetas(n, period) {
  const out = [];
  for (let k = 0; k < n; k++) out.push((k + 0.5) * period / n);
  return out;
}

// ---------------------------------------------------------------------------
//  refined cogging amplitude is grid-converged within 5%
// ---------------------------------------------------------------------------

test("refined cogging amplitude is grid-converged within 5%", function () {
  this.timeout && this.timeout(300000); // allow 5 min (refined sweeps are slow)

  const cfg    = coggingConfig();
  const zeros  = new Float64Array(3);
  const thetas = buildThetas(72, 2 * Math.PI);

  const a2 = amp(sweepTorque(refinedStack(cfg, 2), zeros, thetas));
  const a4 = amp(sweepTorque(refinedStack(cfg, 4), zeros, thetas));

  // Cogging must be present
  assert.ok(a4 > 1e-7,
    "cogging amplitude at factor:4 must be present (> 1e-7 Nm), got " + a4);

  // Grid convergence: factor-2 vs factor-4 within 5%
  const relDiff = Math.abs(a2 - a4) / Math.max(a4, 1e-9);
  assert.ok(relDiff <= 0.05,
    "refined cogging amplitude must be grid-converged within 5% (factor 2 vs 4), " +
    "a2=" + a2 + " a4=" + a4 + " relDiff=" + relDiff);
});

// ---------------------------------------------------------------------------
//  the Live coarse tier is not grid-converged for cogging
// ---------------------------------------------------------------------------

test("the Live coarse tier is not grid-converged for cogging", function () {
  this.timeout && this.timeout(300000); // allow 5 min

  const cfg    = coggingConfig();
  const zeros  = new Float64Array(3);
  const thetas = buildThetas(72, 2 * Math.PI);

  const a4      = amp(sweepTorque(refinedStack(cfg, 4), zeros, thetas));
  const aCoarse = amp(sweepTorque(coarseStack(cfg),     zeros, thetas));

  // The coarse tier must be provably outside the 5% band of the refined tier
  // (this is the whole reason Detailed exists — Live smears cogging)
  assert.ok(a4 > 1e-7,
    "refined cogging amplitude must be present (> 1e-7 Nm), got " + a4);

  const relDiff = Math.abs(aCoarse - a4) / Math.max(a4, 1e-9);
  assert.ok(relDiff > 0.05,
    "Live coarse tier must be outside the 5% convergence band of the refined tier " +
    "(it smears cogging — this is why Detailed exists). " +
    "aCoarse=" + aCoarse + " a4=" + a4 + " relDiff=" + relDiff +
    " (if relDiff <= 0.05 the refinement is not changing the answer — real failure)"
  );
});

// ---------------------------------------------------------------------------
//  zero-current detent is oscillatory with zero net average
// ---------------------------------------------------------------------------

test("zero-current detent is oscillatory with zero net average", function () {
  this.timeout && this.timeout(300000); // allow 5 min

  const cfg    = coggingConfig();
  const zeros  = new Float64Array(3);
  const thetas = buildThetas(72, 2 * Math.PI);

  // Use the factor:4 refined waveform for this assertion
  const w = sweepTorque(refinedStack(cfg, 4), zeros, thetas);

  const r   = ripple(w);
  const a   = amp(w);
  const sc  = signChanges(w);
  const m   = mean(w);

  // Cogging is present
  assert.ok(r > 1e-7,
    "ripple must be > 1e-7 Nm (cogging must be present), got " + r);

  // Oscillatory over a revolution
  assert.ok(sc >= 4,
    "sign changes must be >= 4 (oscillatory over full revolution), got " + sc);

  // Net detent over full revolution is ~zero (conservation)
  const netRelToAmp = a > 1e-12 ? Math.abs(m) / a : Math.abs(m);
  assert.ok(netRelToAmp <= 0.05,
    "mean detent must be <= 5% of amplitude (zero net average), " +
    "mean=" + m + " amp=" + a + " ratio=" + netRelToAmp);
});
