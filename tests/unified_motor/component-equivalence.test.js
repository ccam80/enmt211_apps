"use strict";

// =============================================================================
//  Converter equivalence — ringToComponents(elementRing) must expand to exactly
//  the same geometry as the element ring. For every registered machine we expand
//  the element config and the component-converted config and assert the per-slice
//  feature multisets, circuit count, cage descriptor, and gap band all match.
//  (alpha/component tags are new on the component path and ignored here.)
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { installShims, loadApp } = require("./_dom-harness.js");

// Canonical, order-independent key for a feature (physical fields only).
function featKey(f) {
  const n = (x) => (x == null ? "" : Number(x).toFixed(8));
  const arr = (a) => (Array.isArray(a) ? a.map(n).join(",") : "");
  // A full annulus (span >= 2π) is the same region regardless of its start
  // angle, so canonicalize it — the element and component paths represent it
  // with different start angles ([0,2π] vs [-π,π]).
  const theta = (Array.isArray(f.thetaRange) && (f.thetaRange[1] - f.thetaRange[0]) >= 2 * Math.PI - 1e-6)
    ? "FULL"
    : arr(f.thetaRange);
  return [
    f.kind, f.member, arr(f.rRange), theta,
    n(f.Mr), n(f.Mtheta), f.circuit == null ? "" : String(f.circuit),
    f.turns == null ? "" : String(f.turns), n(f.muR), n(f.Bknee),
  ].join("|");
}

function multiset(features) {
  const m = new Map();
  for (const f of features) {
    const k = featKey(f);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function assertSameMultiset(a, b, label) {
  const ma = multiset(a);
  const mb = multiset(b);
  assert.strictEqual(ma.size, mb.size, `${label}: distinct-feature count differs (${ma.size} vs ${mb.size})`);
  for (const [k, c] of ma) {
    assert.strictEqual(mb.get(k), c, `${label}: feature multiplicity differs for\n  ${k}\n  element=${c} component=${mb.get(k)}`);
  }
}

function toComponentConfig(cfg, CS) {
  return CS.toComponentConfig(cfg);
}

test("every machine's element config and its component conversion expand identically", () => {
  const shim = installShims();
  try {
    const { UnifiedMotor } = loadApp();
    const CS = UnifiedMotor.ConfigSchema;
    const machines = UnifiedMotor.MACHINES || [];
    assert.ok(machines.length >= 15, `expected >= 15 machines, got ${machines.length}`);

    for (const entry of machines) {
      const elemExp = CS.expand(entry.config);
      const compCfg = toComponentConfig(entry.config, CS);

      const v = CS.validate(compCfg);
      assert.ok(v.ok, `${entry.id}: component config must validate; errors: ${JSON.stringify(v.errors)}`);

      // The conversion must decouple geometry (inner/outer) from motion: members
      // become sides and a motion map with exactly one rotating side appears.
      for (const r of compCfg.rings) {
        assert.ok(r.member === "inner" || r.member === "outer",
          `${entry.id}: converted ring member must be inner/outer; got ${r.member}`);
      }
      assert.ok(compCfg.motion && (compCfg.motion.inner === "rotating") !== (compCfg.motion.outer === "rotating"),
        `${entry.id}: exactly one side must rotate; got ${JSON.stringify(compCfg.motion)}`);

      const compExp = CS.expand(compCfg);

      assert.strictEqual(compExp.slices.length, elemExp.slices.length, `${entry.id}: slice count`);
      for (let k = 0; k < elemExp.slices.length; k++) {
        assertSameMultiset(
          elemExp.slices[k].section.features,
          compExp.slices[k].section.features,
          `${entry.id} slice ${k}`
        );
      }

      assert.strictEqual(compExp.nCircuits, elemExp.nCircuits, `${entry.id}: nCircuits`);
      assert.deepStrictEqual(compExp.gapBand, elemExp.gapBand, `${entry.id}: gapBand`);
      // Cage descriptor (null for non-cage machines); compare numerically.
      if (elemExp.cage == null) {
        assert.strictEqual(compExp.cage, null, `${entry.id}: cage should be null`);
      } else {
        assert.ok(compExp.cage, `${entry.id}: cage missing on component path`);
        assert.strictEqual(compExp.cage.bars, elemExp.cage.bars, `${entry.id}: cage.bars`);
        assert.strictEqual(compExp.cage.startIndex, elemExp.cage.startIndex, `${entry.id}: cage.startIndex`);
        assert.ok(Math.abs(compExp.cage.Rb - elemExp.cage.Rb) < 1e-12 * Math.max(1, Math.abs(elemExp.cage.Rb)),
          `${entry.id}: cage.Rb (${compExp.cage.Rb} vs ${elemExp.cage.Rb})`);
      }
    }
  } finally {
    shim.uninstall();
  }
});
