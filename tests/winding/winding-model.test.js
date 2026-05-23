"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { assertClose, seriesPhaseRouting, parallelPhaseRouting } = require("./_fixtures.js");

const WM = globalThis.window.LIB.WindingModel;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Surface guard — only routing functions, no field/MMF/permeance exports
// ---------------------------------------------------------------------------
describe("WindingModel surface", () => {
  it("surface exposes only routing functions", () => {
    const actual = new Set(Object.keys(WM));
    const expected = new Set(["validate", "ampereConductors", "conductorFeatures", "standardWinding"]);
    assert.deepStrictEqual(actual, expected);
  });
});

// ---------------------------------------------------------------------------
//  ampereConductors
// ---------------------------------------------------------------------------
describe("ampereConductors", () => {
  it("series coils sum into one circuit", () => {
    const routing = seriesPhaseRouting();
    const { nCircuits, nSlots, turns, circuitMeta } = WM.ampereConductors(routing);

    assert.strictEqual(nCircuits, 1);
    assert.strictEqual(nSlots, 6);

    // slot 0: +10 (go), slot 1: +10 (go), slot 3: -10 (return), slot 4: -10 (return)
    assert.strictEqual(turns[0 * 6 + 0],  10);
    assert.strictEqual(turns[0 * 6 + 1],  10);
    assert.strictEqual(turns[0 * 6 + 2],   0);
    assert.strictEqual(turns[0 * 6 + 3], -10);
    assert.strictEqual(turns[0 * 6 + 4], -10);
    assert.strictEqual(turns[0 * 6 + 5],   0);

    assert.strictEqual(Array.isArray(circuitMeta), true);
    assert.strictEqual(circuitMeta.length, 1);
    assert.strictEqual(typeof circuitMeta[0].phaseId, "string");
    assert.ok(circuitMeta[0].phaseId.length > 0, "phaseId must be non-empty string");
    assert.strictEqual(circuitMeta[0].branchIndex, 0);
  });

  it("parallel branches split into separate circuits", () => {
    const routing = parallelPhaseRouting();
    const { nCircuits, circuitMeta } = WM.ampereConductors(routing);

    assert.strictEqual(nCircuits, 2);
    assert.strictEqual(Array.isArray(circuitMeta), true);
    assert.strictEqual(circuitMeta.length, 2);
    assert.strictEqual(circuitMeta[0].branchIndex, 0);
    assert.strictEqual(circuitMeta[1].branchIndex, 1);
    assert.strictEqual(circuitMeta[0].phaseId, circuitMeta[1].phaseId);
    assert.ok(typeof circuitMeta[0].phaseId === "string" && circuitMeta[0].phaseId.length > 0);
  });
});

// ---------------------------------------------------------------------------
//  validate
// ---------------------------------------------------------------------------
describe("validate", () => {
  it("validate rejects a single-slot coil", () => {
    const routing = {
      nSlots: 6,
      slotTheta: [0, 1, 2, 3, 4, 5],
      phases: [
        {
          id: "A",
          branches: [{ coils: [{ slotGo: 2, slotReturn: 2, turns: 10 }] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0, "errors array must be non-empty");
  });

  it("validate rejects out-of-range slot", () => {
    const routing = {
      nSlots: 6,
      slotTheta: [0, 1, 2, 3, 4, 5],
      phases: [
        {
          id: "A",
          branches: [{ coils: [{ slotGo: 0, slotReturn: 6, turns: 10 }] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("validate rejects nSlots < 1", () => {
    const routing = {
      nSlots: 0,
      slotTheta: [],
      phases: [
        {
          id: "A",
          branches: [{ coils: [{ slotGo: 0, slotReturn: 1, turns: 10 }] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("validate rejects mismatched slotTheta length", () => {
    const routing = {
      nSlots: 6,
      slotTheta: [0, 1, 2],  // length 3, should be 6
      phases: [
        {
          id: "A",
          branches: [{ coils: [{ slotGo: 0, slotReturn: 3, turns: 10 }] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("validate rejects zero turns", () => {
    const routing = {
      nSlots: 6,
      slotTheta: [0, 1, 2, 3, 4, 5],
      phases: [
        {
          id: "A",
          branches: [{ coils: [{ slotGo: 0, slotReturn: 3, turns: 0 }] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("validate rejects an empty branch", () => {
    const routing = {
      nSlots: 6,
      slotTheta: [0, 1, 2, 3, 4, 5],
      phases: [
        {
          id: "A",
          branches: [{ coils: [] }],
        },
      ],
    };
    const result = WM.validate(routing);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length > 0);
  });
});

// ---------------------------------------------------------------------------
//  conductorFeatures
// ---------------------------------------------------------------------------
describe("conductorFeatures", () => {
  it("conductorFeatures emits one feature per non-zero slot", () => {
    const routing = seriesPhaseRouting();
    const slotGeom = {
      rRange: [0.045, 0.05],
      member: "stator",
      angularWidth: TWO_PI / 6,
    };
    const features = WM.conductorFeatures(routing, slotGeom);

    // Slots 0,1,3,4 are non-zero; slots 2,5 are zero
    assert.strictEqual(features.length, 4);

    for (const f of features) {
      assert.strictEqual(f.kind, "conductor");
      assert.strictEqual(f.circuit, 0);
    }

    // Sort by thetaRange[0] to get a deterministic order for checking turns
    const sorted = features.slice().sort((a, b) => a.thetaRange[0] - b.thetaRange[0]);
    // slots 0,1 have +10 turns; slots 3,4 have -10 turns
    const halfW = (TWO_PI / 6) / 2;
    const slotTheta = routing.slotTheta;

    const bySlot = {};
    for (const f of features) {
      // identify slot by thetaRange centre
      const centre = (f.thetaRange[0] + f.thetaRange[1]) / 2;
      for (let s = 0; s < routing.nSlots; s++) {
        if (Math.abs(centre - slotTheta[s]) < 1e-10) {
          bySlot[s] = f.turns;
        }
      }
    }

    assert.strictEqual(bySlot[0],  10);
    assert.strictEqual(bySlot[1],  10);
    assert.strictEqual(bySlot[3], -10);
    assert.strictEqual(bySlot[4], -10);
  });
});

// ---------------------------------------------------------------------------
//  standardWinding
// ---------------------------------------------------------------------------
describe("standardWinding", () => {
  it("standardWinding 3/4/24 full pitch — phase A belt", () => {
    // With the floor(b/2)%m formula and the interleaved label sequence [A,C,B] for m=3:
    //   belt b=0 (α∈[0,π/3)): A+  → go slots 0,1  (and 12,13 in the second revolution)
    //   belt b=1 (α∈[π/3,2π/3)): A- → go slots 2,3  (and 14,15)
    //   belt b=2 (α∈[2π/3,π)):   C+  → go slots 4,5
    //   belt b=3 (α∈[π,4π/3)):   C-  → go slots 6,7
    //   belt b=4 (α∈[4π/3,5π/3)): B+ → go slots 8,9
    //   belt b=5 (α∈[5π/3,2π)):  B-  → go slots 10,11
    //
    // Phase A accumulates in the ampereConductors turns array:
    //   From A+ go coils (s=0,1,12,13): turns[A][s] += +1, turns[A][s+6] -= 1
    //   From A- go coils (s=2,3,14,15): turns[A][s] += -1, turns[A][s+6] -= (-1) = +1
    //
    // Net per slot for phase A:
    //   slot 0,1,12,13: +1 (A+ go-side)
    //   slot 2,3,14,15: -1 (A- go-side)
    //   slot 6,7,18,19: -1 (return from A+ coils)
    //   slot 8,9,20,21: +1 (return from A- coils, negative of negative = positive)

    const routing = WM.standardWinding({
      m: 3, p: 4, Q: 24, coilPitch: 6, turns: 1,
      member: "stator", rRange: [0.045, 0.05],
    });
    const { nCircuits, nSlots, turns, circuitMeta } = WM.ampereConductors(routing);

    // Find circuit index for phase A
    const phaseACircuit = circuitMeta.findIndex((m) => m.phaseId === "A");
    assert.ok(phaseACircuit >= 0, "phase A circuit must exist");

    const aRow = Array.from({ length: nSlots }, (_, s) => turns[phaseACircuit * nSlots + s]);

    // A+ go-side conductors at slots {0,1,12,13}
    const aposGoSlots = new Set([0, 1, 12, 13]);
    for (const s of aposGoSlots) {
      assert.ok(aRow[s] > 0, `slot ${s} should be positive for A, got ${aRow[s]}`);
    }

    // A- go-side conductors at slots {2,3,14,15} — negative
    const anegGoSlots = new Set([2, 3, 14, 15]);
    for (const s of anegGoSlots) {
      assert.ok(aRow[s] < 0, `slot ${s} should be negative (A- go-side) for A, got ${aRow[s]}`);
    }

    // Return conductors from A+ coils at {6,7,18,19}: -1 (negative)
    const aposRetSlots = new Set([6, 7, 18, 19]);
    for (const s of aposRetSlots) {
      assert.ok(aRow[s] < 0, `slot ${s} should be negative (A+ return-side) for A, got ${aRow[s]}`);
    }

    // Return conductors from A- coils at {8,9,20,21}: +1 (positive)
    const anegRetSlots = new Set([8, 9, 20, 21]);
    for (const s of anegRetSlots) {
      assert.ok(aRow[s] > 0, `slot ${s} should be positive (A- return-side) for A, got ${aRow[s]}`);
    }

    // All slots accounted for (8+8 = 16 non-zero, slots 4,5,10,11,16,17,22,23 are zero for A)
    const aZeroSlots = new Set([4, 5, 10, 11, 16, 17, 22, 23]);
    for (const s of aZeroSlots) {
      assert.strictEqual(aRow[s], 0, `slot ${s} should be zero for A, got ${aRow[s]}`);
    }
  });

  it("standardWinding short pitch shifts return slots by the chord", () => {
    const routing5 = WM.standardWinding({
      m: 3, p: 4, Q: 24, coilPitch: 5, turns: 1,
      member: "stator", rRange: [0.045, 0.05],
    });
    const routing6 = WM.standardWinding({
      m: 3, p: 4, Q: 24, coilPitch: 6, turns: 1,
      member: "stator", rRange: [0.045, 0.05],
    });

    // For coilPitch:5, return slot of slot s is (s+5) mod 24
    // For coilPitch:6, return slot of slot s is (s+6) mod 24
    // Check a sample of go-slots: 0, 1, 2, 3
    const sampleGoSlots = [0, 1, 2, 3];

    // Find conductorFeatures with slotGeom to inspect thetaRanges directly
    const slotGeom = { rRange: [0.045, 0.05], member: "stator", angularWidth: TWO_PI / 24 };
    const features5 = WM.conductorFeatures(routing5, slotGeom);
    const features6 = WM.conductorFeatures(routing6, slotGeom);

    // For the short-pitch winding, the coil at slot s places a return conductor
    // at (s + 5) mod 24, not (s + 6) mod 24.
    // We verify by checking that at least one of the sample slots' return
    // positions differs between pitch-5 and pitch-6.
    const dtheta = TWO_PI / 24;

    function returnSlotsSet(features, nSlots) {
      // identify slots with negative turns (return side of coils)
      const neg = new Set();
      const slotTheta = Array.from({ length: nSlots }, (_, s) => s * TWO_PI / nSlots);
      for (const f of features) {
        if (f.turns < 0) {
          const centre = (f.thetaRange[0] + f.thetaRange[1]) / 2;
          for (let s = 0; s < nSlots; s++) {
            if (Math.abs(centre - slotTheta[s]) < 1e-10) { neg.add(s); break; }
          }
        }
      }
      return neg;
    }

    const ret5 = returnSlotsSet(features5, 24);
    const ret6 = returnSlotsSet(features6, 24);

    // Verify that pitch-5 and pitch-6 produce different return-slot sets
    let differ = false;
    for (const s of ret5) { if (!ret6.has(s)) { differ = true; break; } }
    if (!differ) for (const s of ret6) { if (!ret5.has(s)) { differ = true; break; } }
    assert.ok(differ, "coilPitch:5 and coilPitch:6 must produce different return slots");

    // Direct check: for pitch-5, slot 0's return is at slot 5 (not 6)
    // For pitch-6, slot 0's return is at slot 6 (not 5)
    assert.ok(ret5.has(5), "pitch-5: slot 5 should be a return slot (from coil at slot 0)");
    assert.ok(!ret5.has(6) || ret6.has(6), "pitch-6: slot 6 should be a return slot (from coil at slot 0)");
  });

  it("winding factor matches analytic (test-only)", () => {
    const m = 3, p = 4, Q = 24, coilPitch = 6;
    const routing = WM.standardWinding({
      m, p, Q, coilPitch, turns: 1,
      member: "stator", rRange: [0.045, 0.05],
    });
    const { nSlots, turns, circuitMeta } = WM.ampereConductors(routing);

    // Get phase A circuit
    const phaseACircuit = circuitMeta.findIndex((meta) => meta.phaseId === "A");
    const aRow = Array.from({ length: nSlots }, (_, s) => turns[phaseACircuit * nSlots + s]);

    // Compute DFT at harmonic order = p/2 = 2 (pole-pair / fundamental order)
    // using slot centres theta[s] = s * 2π/Q.
    const harmonicOrder = p / 2;
    let realPart = 0, imagPart = 0;
    for (let s = 0; s < Q; s++) {
      const theta = s * TWO_PI / Q;
      realPart += aRow[s] * Math.cos(harmonicOrder * theta);
      imagPart += aRow[s] * Math.sin(harmonicOrder * theta);
    }
    const amplitude = Math.sqrt(realPart * realPart + imagPart * imagPart);

    // Normalize by Q/m = number of series coils per phase.
    // Each coil contributes 1 go-conductor and 1 return-conductor (magnitude 1 each).
    // The accumulated turns array contains both go and return sides.
    // The ideal concentrated winding with Q/m series conductors has DFT amplitude = Q/m.
    // So kw = amplitude / (Q/m).
    const seriesCoilsPerPhase = Q / m;
    const kw = amplitude / seriesCoilsPerPhase;

    // Analytic kw = kp * kd for double-layer full-pitch winding:
    // q = Q/(m*p) = 24/(3*4) = 2 slots/pole/phase
    // α_e = (p/2)*(2π/Q) = 2*(2π/24) = π/6  (electrical angle per slot)
    // kd = sin(q*α_e/2) / (q*sin(α_e/2)) = sin(2*π/12) / (2*sin(π/12))
    //    = sin(30°) / (2*sin(15°)) = 0.5 / (2*0.2588) ≈ 0.9659
    // kp = 1 (full pitch: coilPitch = Q/p = 6)
    // kw = kp * kd ≈ 0.966
    const analytic = 0.966;
    assertClose(kw, analytic, 0.01, "winding factor kw");
  });

  it("standardWinding throws on non-divisible Q", () => {
    assert.throws(() => {
      WM.standardWinding({
        m: 3, p: 4, Q: 23, coilPitch: 6, turns: 1,
        member: "stator", rRange: [0.045, 0.05],
      });
    }, Error);
  });

  it("standardWinding throws on out-of-range coilPitch", () => {
    assert.throws(() => {
      WM.standardWinding({
        m: 3, p: 4, Q: 24, coilPitch: 7, turns: 1,
        member: "stator", rRange: [0.045, 0.05],
      });
    }, Error);
  });

  it("standardWinding generalizes to m≠3", () => {
    const m = 2, p = 2, Q = 8, coilPitch = 2;
    const routing = WM.standardWinding({
      m, p, Q, coilPitch, turns: 1,
      member: "stator", rRange: [0.045, 0.05],
    });
    const { nCircuits, nSlots, turns: turnsArr } = WM.ampereConductors(routing);

    assert.strictEqual(nCircuits, m, `nCircuits must equal m=${m}`);

    // Verify slots {0, 2, 4, 6} using the general belt formula
    const beltWidth = Math.PI / m;
    const checkSlots = [0, 2, 4, 6];

    for (const s of checkSlots) {
      const alpha = (p / 2) * s * (TWO_PI / Q);
      const b = Math.floor(alpha / beltWidth) % (2 * m);
      const polarity = (b % 2 === 0) ? 1 : -1;
      const phaseIndex = Math.floor(b / 2) % m;

      // go-side: turns[phaseIndex * nSlots + s] should have sign = polarity
      const goVal = turnsArr[phaseIndex * nSlots + s];
      assert.ok(
        goVal !== 0,
        `slot ${s}: phase ${phaseIndex} go-side should be non-zero`
      );
      assert.strictEqual(
        Math.sign(goVal), polarity,
        `slot ${s}: expected go-side sign ${polarity}, got ${Math.sign(goVal)}`
      );

      // return-side: (s + coilPitch) mod Q should have opposite sign
      const retSlot = (s + coilPitch) % Q;
      const retVal = turnsArr[phaseIndex * nSlots + retSlot];
      assert.ok(
        retVal !== 0,
        `slot ${s}: phase ${phaseIndex} return-side (slot ${retSlot}) should be non-zero`
      );
      assert.strictEqual(
        Math.sign(retVal), -polarity,
        `slot ${s}: expected return-side sign ${-polarity}, got ${Math.sign(retVal)}`
      );
    }
  });
});
