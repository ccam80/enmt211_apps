"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  byId,
  build,
  validate,
  runFromRest,
} = require("./_fixtures.js");

test("config validates", function () {
  const result = validate("brushed-dc-pm");
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.errors.length, 0);
});

test("expands to Phase-2 sections with matching circuit count", function () {
  const { expanded } = build("brushed-dc-pm");
  assert.strictEqual(expanded.nCircuits, byId["brushed-dc-pm"].config.circuits.length);
  for (const slice of expanded.slices) {
    for (const feature of slice.section.features) {
      assert.ok(
        feature.kind === "conductor" ||
        feature.kind === "magnet" ||
        feature.kind === "iron",
        "feature.kind must be conductor, magnet, or iron; got: " + feature.kind
      );
    }
  }
});

test("torque scales linearly with armature current", function () {
  const { stack } = build("brushed-dc-pm");
  // Operating point θ=0 — a rotor pole-alignment symmetry point of the 4-pole
  // PM detent. The total Maxwell-stress torque is T(i) = T_cog + T_arm(i):
  // the cogging (zero-current PM detent) term is i-INDEPENDENT, while the
  // brush-commutated armature term T_arm is the physical claim under test
  // (linear/odd in armature current). At a PM pole-alignment angle the detent
  // torque crosses zero by symmetry (measured |T_cog| ~ 1e-13 N·m here, vs the
  // armature torque ~7.5e-2 N·m), so the total torque IS the armature torque and
  // the t2/t1 ratio isolates the linear-in-i claim with no cogging
  // contamination. (At an arbitrary loaded angle the much-larger 4-pole detent
  // — cog/arm ≈ 1.2 at θ=0.2 — swamps the ratio; that is a test-fixture
  // operating-point artifact, not an engine flaw: T_arm is independently
  // verified ~constant and ∝ i at every angle. See spec/feature-brush-commutator.md.)
  const t1 = stack.solve(0, new Float64Array([10])).torque;
  const t2 = stack.solve(0, new Float64Array([20])).torque;
  assert.ok(Math.abs(t1) > 1e-5, "torque at i=10 too small: " + t1);
  const ratio = t2 / t1;
  assert.ok(
    Math.abs(ratio - 2) <= 0.03 * 2,
    "torque ratio t2/t1 = " + ratio + " deviates more than 3% from 2"
  );
});

test("self-starts under mechanical commutation", { timeout: 25000 }, function () {
  const { runtime } = build("brushed-dc-pm");
  // Self-start only needs the rotor to leave rest (|theta| > 1e-3), reached well
  // under 150 coarse steps; a longer free-spin only adds cost, not coverage.
  const state = runFromRest(runtime, 150);
  assert.ok(
    Math.abs(state.theta) > 1e-3,
    "rotor did not move from rest; |theta| = " + Math.abs(state.theta)
  );
});
