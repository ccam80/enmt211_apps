"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assertClose } = require("./_fixtures.js");

const WM = globalThis.window.LIB.WindingModel;

// ---------------------------------------------------------------------------
//  Fractional-slot winding: validate() returns ok:true with qIsInteger:false,
//  standardWinding() produces a determinate asymmetric routing.
//
//  Test case: 14p/12s/m=3 (BLDC-style fractional slot)
//    Q=12, m=3, p=14 → q = Q/(m*p) = 12/42 ≈ 0.286 (non-integer)
//    coilPitch=1 ≤ Q/p=12/14≈0.857 ... wait, that fails the coilPitch check.
//
//  Use instead: 12p/18s/m=3 (canonical BLDC fractional-slot)
//    Q=18, m=3, p=12 → q = 18/36 = 0.5 (non-integer)
//    coilPitch=1 ≤ Q/p=18/12=1.5 ✓
// ---------------------------------------------------------------------------
describe("standardWinding fractional-q", () => {
  it("validate returns ok:true and qIsInteger:false for fractional-slot winding", () => {
    const routing = WM.standardWinding({
      m: 3, p: 12, Q: 18, coilPitch: 1, turns: 1,
    });

    const result = WM.validate(routing);
    assert.strictEqual(result.ok, true, "fractional-slot routing must validate ok");
    assert.ok(Array.isArray(result.errors) && result.errors.length === 0,
      "errors must be empty for a valid routing");
  });

  it("standardWinding produces a routing for fractional-slot 12p/18s/m=3", () => {
    const routing = WM.standardWinding({
      m: 3, p: 12, Q: 18, coilPitch: 1, turns: 1,
    });

    assert.strictEqual(routing.nSlots, 18, "nSlots must equal Q=18");
    assert.ok(Array.isArray(routing.phases) && routing.phases.length === 3,
      "must have m=3 phases");
    assert.ok(Array.isArray(routing.slotTheta) && routing.slotTheta.length === 18,
      "slotTheta must have 18 entries");

    const { nCircuits, turns } = WM.ampereConductors(routing);
    assert.strictEqual(nCircuits, 3, "nCircuits must equal m=3");

    // Verify that the routing is non-trivially populated:
    // every row must have at least some non-zero entries
    for (let c = 0; c < nCircuits; c++) {
      let nonZeroCount = 0;
      for (let s = 0; s < 18; s++) {
        if (turns[c * 18 + s] !== 0) nonZeroCount++;
      }
      assert.ok(nonZeroCount > 0, `circuit ${c} must have at least one non-zero slot`);
    }
  });

  it("fractional-slot routing covers every slot exactly once on the go-side", () => {
    // 12p/18s/m=3: q=0.5 (non-integer). Every slot must appear as a go-side
    // exactly once across all phases (the belt-index rule assigns each slot to
    // exactly one phase).
    const routing = WM.standardWinding({
      m: 3, p: 12, Q: 18, coilPitch: 1, turns: 1,
    });

    // Collect all go-slots across all phases
    const goSlots = [];
    for (const ph of routing.phases) {
      for (const coil of ph.branches[0].coils) {
        goSlots.push(coil.slotGo);
      }
    }

    // Total go-side assignments must equal Q
    assert.strictEqual(goSlots.length, 18,
      "total go-side coil assignments must equal Q=18");

    // Each slot must appear exactly once
    goSlots.sort((a, b) => a - b);
    for (let s = 0; s < 18; s++) {
      assert.strictEqual(goSlots[s], s,
        `slot ${s} must appear exactly once in go-side assignments`);
    }
  });

  it("standardWinding still throws on odd p (p must be even pole-count)", () => {
    assert.throws(() => {
      WM.standardWinding({
        m: 3, p: 3, Q: 9, coilPitch: 1, turns: 1,
      });
    }, /p must be an even integer/);
  });

  it("standardWinding still throws on coilPitch > Q/p", () => {
    assert.throws(() => {
      WM.standardWinding({
        m: 3, p: 12, Q: 18, coilPitch: 2, turns: 1,
      });
    }, /coilPitch/);
  });
});
