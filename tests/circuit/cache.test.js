"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { LIB } = require("./_fixtures.js");

const MC = LIB.MotorCircuit;

// ---------------------------------------------------------------------------
//  makeCache — θ-binned coefficient cache
// ---------------------------------------------------------------------------
describe("makeCache — θ-binned coefficient cache", () => {
  it("cache extracts once per bin", () => {
    const cache = MC.makeCache({ period: Math.PI, binCount: 8 });
    // binWidth = π/8 ≈ 0.3927

    let calls = 0;
    const dummyCoeffs = {
      L: new Float64Array(1),
      dLdth: new Float64Array(1),
      lambdaPm: new Float64Array(1),
      dLambdaPmdth: new Float64Array(1),
    };
    function extractAt(_theta) {
      calls++;
      return dummyCoeffs;
    }

    // Both 0.05 and 0.10 fall in bin 0 (both < π/8 ≈ 0.3927)
    cache.coeffs(0.05, extractAt);
    assert.strictEqual(calls, 1, "first call to bin 0 should extract once");

    cache.coeffs(0.10, extractAt);
    assert.strictEqual(calls, 1, "second call to same bin 0 should not extract again");

    // 0.50 falls in bin 1 (π/8 ≈ 0.3927 ≤ 0.50 < 2*π/8 ≈ 0.7854)
    cache.coeffs(0.50, extractAt);
    assert.strictEqual(calls, 2, "first call to bin 1 should extract once more");
  });

  it("cache.clear forces re-extraction", () => {
    const cache = MC.makeCache({ period: Math.PI, binCount: 8 });

    let calls = 0;
    const dummyCoeffs = {
      L: new Float64Array(1),
      dLdth: new Float64Array(1),
      lambdaPm: new Float64Array(1),
      dLambdaPmdth: new Float64Array(1),
    };
    function extractAt(_theta) {
      calls++;
      return dummyCoeffs;
    }

    // Populate bin 0
    cache.coeffs(0.05, extractAt);
    cache.coeffs(0.10, extractAt);
    cache.coeffs(0.50, extractAt);
    assert.strictEqual(calls, 2, "setup: 2 bins populated");

    // Clear and re-query bin 0
    cache.clear();
    cache.coeffs(0.05, extractAt);
    assert.strictEqual(calls, 3, "after clear(), bin 0 should re-extract");
  });

  it("binIndex wraps by period", () => {
    const cache = MC.makeCache({ period: Math.PI, binCount: 8 });

    // binIndex(θ) === binIndex(θ + period)
    assert.strictEqual(
      cache.binIndex(0.05),
      cache.binIndex(0.05 + Math.PI),
      "binIndex should wrap by period"
    );

    let calls = 0;
    const dummyCoeffs = {
      L: new Float64Array(1),
      dLdth: new Float64Array(1),
      lambdaPm: new Float64Array(1),
      dLambdaPmdth: new Float64Array(1),
    };
    function extractAt(_theta) {
      calls++;
      return dummyCoeffs;
    }

    // Populate bin 0 via θ = 0.05
    cache.coeffs(0.05, extractAt);
    assert.strictEqual(calls, 1, "first query populates bin 0");

    // θ = 0.05 + π should map to the same bin and NOT re-extract
    cache.coeffs(0.05 + Math.PI, extractAt);
    assert.strictEqual(calls, 1, "wrapped θ hits the same bin — no re-extraction");
  });
});
