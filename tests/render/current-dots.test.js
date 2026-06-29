"use strict";

// =============================================================================
//  LIB.CurrentDots — phase advance + dot placement along conductor polylines.
//
//  Pure geometry/algebra (no canvas). Guards the contract the 3-D renderer
//  relies on: dots evenly spaced along a path, a signed offset that shifts and
//  reverses the train, and a per-circuit phase advanced by the signed current.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

if (!globalThis.window) globalThis.window = globalThis;
require("../../lib/current-dots.js");
const CD = window.LIB.CurrentDots;

function xs(dots) { return dots.map(function (d) { return +d[0].toFixed(6); }); }

test("placeDots spaces dots evenly along a straight polyline", function () {
  const line = new Float64Array([0, 0, 0, 1, 0, 0]); // length 1 along +x
  const dots = CD.placeDots(line, 0, 0.25);
  assert.deepEqual(xs(dots), [0, 0.25, 0.5, 0.75], "dots at 0, .25, .5, .75");
  for (const d of dots) assert.equal(d[1], 0, "stays on the line (y=0)");
});

test("placeDots offset shifts the dot train into [0, spacing)", function () {
  const line = new Float64Array([0, 0, 0, 1, 0, 0]);
  assert.deepEqual(xs(CD.placeDots(line, 0.1, 0.25)), [0.1, 0.35, 0.6, 0.85], "shifted by +0.1");
  // A negative offset wraps into [0, spacing): -0.1 → 0.15
  assert.deepEqual(xs(CD.placeDots(line, -0.1, 0.25)), [0.15, 0.4, 0.65, 0.9], "wraps negative");
});

test("placeDots walks a multi-segment polyline by arc length", function () {
  // L-shape: (0,0,0)->(1,0,0)->(1,1,0), total length 2.
  const poly = new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0]);
  const dots = CD.placeDots(poly, 0, 0.5);
  assert.equal(dots.length, 4, "4 dots over length 2 at spacing 0.5 (0,0.5,1,1.5)");
  // dot at arc-length 1.5 sits on the second segment at (1, 0.5)
  const last = dots[dots.length - 1];
  assert.ok(Math.abs(last[0] - 1) < 1e-9 && Math.abs(last[1] - 0.5) < 1e-9, "last dot on 2nd segment");
});

test("placeDots degenerates safely", function () {
  assert.deepEqual(CD.placeDots(new Float64Array([0, 0, 0]), 0, 0.25), [], "single point → none");
  assert.deepEqual(CD.placeDots(new Float64Array([0, 0, 0, 0, 0, 0]), 0, 0.25), [], "zero length → none");
});

test("step advances each circuit's phase by signed current (linear)", function () {
  const phase = new Float64Array([0, 0]);
  CD.step(phase, new Float64Array([10, -4]), 1.0, { speedScale: 0.02 });
  assert.ok(Math.abs(phase[0] - 0.2) < 1e-12, "+10A → +0.2");
  assert.ok(Math.abs(phase[1] + 0.08) < 1e-12, "-4A → -0.08 (reverses)");
});

test("autoScale normalises speed to the live current envelope", function () {
  const a = CD.autoScale(new Float64Array([2, -10, 0]), 0, { target: 0.02, floor: 0.05 });
  assert.equal(a.peak, 10, "peak tracks max |I|");
  assert.ok(Math.abs(a.scale - 0.002) < 1e-12, "scale = target / peak");

  const z = CD.autoScale(new Float64Array([0, 0]), 0, { target: 0.02, floor: 0.05 });
  assert.equal(z.peak, 0.05, "floor prevents a zero-current blow-up");

  // A prior envelope decays slowly so an AC zero-crossing doesn't spike the scale.
  const d = CD.autoScale(new Float64Array([0]), 10, { target: 0.02, decay: 0.98, floor: 0.05 });
  assert.ok(Math.abs(d.peak - 9.8) < 1e-9, "envelope decays, not collapses");
});

test("step logarithmic mode compresses magnitude but keeps sign", function () {
  const phase = new Float64Array([0]);
  CD.step(phase, new Float64Array([10]), 1.0, { speedScale: 1, mode: "logarithmic", logRef: 1 });
  assert.ok(Math.abs(phase[0] - Math.log1p(10)) < 1e-12, "log1p(|I|/ref)");
  const neg = new Float64Array([0]);
  CD.step(neg, new Float64Array([-10]), 1.0, { speedScale: 1, mode: "logarithmic", logRef: 1 });
  assert.ok(neg[0] < 0, "negative current flows backward");
});
