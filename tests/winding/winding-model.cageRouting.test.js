"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
require("./_fixtures.js");

const WM = globalThis.window.LIB.WindingModel;

// ---------------------------------------------------------------------------
//  cageRouting — squirrel-cage routing: N independent bar-loop circuits
// ---------------------------------------------------------------------------
describe("cageRouting", () => {
  it("cageRouting exists on LIB.WindingModel", () => {
    assert.strictEqual(typeof WM.cageRouting, "function",
      "LIB.WindingModel.cageRouting must be a function");
  });

  it("cageRouting({ bars:28 }) produces 28 independent circuits", () => {
    const routing = WM.cageRouting({ bars: 28 });
    const { nCircuits, nSlots } = WM.ampereConductors(routing);

    assert.strictEqual(nCircuits, 28,
      "nCircuits must equal bars (28)");
    assert.strictEqual(nSlots, 28,
      "nSlots must equal bars (28)");
  });

  it("each bar circuit is one slot with an end-ring return", () => {
    const routing = WM.cageRouting({ bars: 28 });

    assert.strictEqual(routing.phases.length, 28,
      "must have 28 phases (one per bar)");

    for (let b = 0; b < 28; b++) {
      const phase = routing.phases[b];
      assert.strictEqual(phase.branches.length, 1,
        `bar ${b} must have exactly one branch`);
      assert.strictEqual(phase.branches[0].coils.length, 1,
        `bar ${b} must have exactly one coil`);

      const coil = phase.branches[0].coils[0];
      assert.strictEqual(coil.slotGo, b,
        `bar ${b} go-slot must be ${b}`);
      // The bar returns through the shorting end-ring, so slotReturn is null.
      assert.strictEqual(coil.slotReturn, null,
        `bar ${b} return must be the end-ring (slotReturn null)`);
      assert.strictEqual(coil.turns, 1,
        `bar ${b} turns must be 1`);
    }
  });

  it("cageRouting produces a routing that passes validate()", () => {
    const routing = WM.cageRouting({ bars: 28 });
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, true,
      `validate must return ok:true; errors: ${result.errors.join(", ")}`);
  });

  it("each bar circuit occupies exactly one slot (end-ring return)", () => {
    const routing = WM.cageRouting({ bars: 28 });
    const { nCircuits, nSlots, turns } = WM.ampereConductors(routing);

    for (let c = 0; c < nCircuits; c++) {
      let nonZeroSlots = 0;
      let sumTurns = 0;
      for (let s = 0; s < nSlots; s++) {
        const T = turns[c * nSlots + s];
        if (T !== 0) {
          nonZeroSlots++;
          sumTurns += T;
        }
      }
      // Each bar drives one slot (+1); the return is the end-ring, so the
      // per-slot turns sum to +1, not zero.
      assert.strictEqual(nonZeroSlots, 1,
        `circuit ${c} must occupy exactly 1 slot (bar + end-ring return)`);
      assert.strictEqual(sumTurns, 1,
        `circuit ${c}: the single bar carries +1 conductor`);
    }
  });

  it("no two bar circuits share the same pair of slots", () => {
    const routing = WM.cageRouting({ bars: 28 });
    const { nCircuits, nSlots, turns } = WM.ampereConductors(routing);

    const pairSigs = new Set();
    for (let c = 0; c < nCircuits; c++) {
      const nonZeroSlots = [];
      for (let s = 0; s < nSlots; s++) {
        if (turns[c * nSlots + s] !== 0) nonZeroSlots.push(s);
      }
      const sig = nonZeroSlots.sort((a, b) => a - b).join(",");
      assert.ok(!pairSigs.has(sig),
        `circuits must span distinct slot pairs; circuit ${c} repeats pair [${sig}]`);
      pairSigs.add(sig);
    }
  });

  it("cageRouting produces uniform slotTheta by default", () => {
    const bars = 12;
    const routing = WM.cageRouting({ bars });
    const TWO_PI = 2 * Math.PI;

    assert.strictEqual(routing.slotTheta.length, bars);
    for (let b = 0; b < bars; b++) {
      const expected = b * TWO_PI / bars;
      assert.ok(
        Math.abs(routing.slotTheta[b] - expected) < 1e-12,
        `slotTheta[${b}] must be ${expected.toFixed(6)}, got ${routing.slotTheta[b]}`
      );
    }
  });

  it("cageRouting accepts custom slotTheta", () => {
    const customTheta = [0, 1, 2, 3];
    const routing = WM.cageRouting({ bars: 4, slotTheta: customTheta });
    assert.deepStrictEqual(Array.from(routing.slotTheta), customTheta,
      "slotTheta must match the provided custom array");
  });

  it("cageRouting throws on non-positive bars", () => {
    assert.throws(() => WM.cageRouting({ bars: 0 }), /bars must be a positive integer/);
    assert.throws(() => WM.cageRouting({ bars: -5 }), /bars must be a positive integer/);
  });

  it("cageRouting throws on non-integer bars", () => {
    assert.throws(() => WM.cageRouting({ bars: 1.5 }), /bars must be a positive integer/);
  });

  it("cageRouting has no coilPitch, no phase grouping, no pole-pair structure", () => {
    const routing = WM.cageRouting({ bars: 28 });

    // No phase grouping: each phase id is unique (bar-indexed), not 'A', 'B', 'C'
    const phaseIds = routing.phases.map(ph => ph.id);
    const uniqueIds = new Set(phaseIds);
    assert.strictEqual(uniqueIds.size, 28,
      "all 28 bar circuit phase IDs must be unique");

    // None of the phase IDs should be 'A', 'B', or 'C' (no polyphase grouping)
    for (const id of phaseIds) {
      assert.ok(id !== "A" && id !== "B" && id !== "C",
        `cage routing must not use polyphase labels; got "${id}"`);
    }
  });
});
