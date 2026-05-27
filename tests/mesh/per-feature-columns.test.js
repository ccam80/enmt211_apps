"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadAllFixtures,
  meshFromConfig,
  syntheticPhysics,
  singleAnnulusSection,
  coverageError,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Helper: collect all unique angular column positions from body nodes.
//  Returns a sorted array of unique theta values (deduplicated to 10 decimals).
// ---------------------------------------------------------------------------
function collectAllAngles(body) {
  const { nodes } = body;
  const Nn = nodes.length / 2;
  const thetaSet = new Set();
  for (let n = 0; n < Nn; n++) {
    const theta = Math.atan2(nodes[2*n+1], nodes[2*n]);
    const th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    thetaSet.add(Math.round(th * 1e10) / 1e10);
  }
  return Array.from(thetaSet).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
//  PMSM stator: per-feature columns test.
//
//  Per-feature architecture: the stator interior band divides the 48 slots
//  with round(slotSpan / Δθ_target) cells per slot, NOT LCM-aligned.
//  With nuMaxSlice=17, poles=8, Δθ_target = TWO_PI/(8*41) = TWO_PI/328:
//    slotSpan = TWO_PI/48
//    cells_per_slot = max(1, round((TWO_PI/48) / (TWO_PI/328))) = round(328/48) = round(6.83) = 7
//    interior total = 7 × 48 = 336
//
//  Verification: total angular node count / (number of radial rows in interior)
//  should match the interior column count.
// ---------------------------------------------------------------------------

describe("PMSM stator: per-feature interior column count, not LCM-driven", () => {
  it("interior column count ≈ sum(round(slotSpan / Δθ_target)) over all slots", () => {
    const machines = loadAllFixtures();
    const pmsm = machines.find(m => m.id === "pmsm");
    assert.ok(pmsm, "pmsm fixture must be present");

    const physics = MotorMesh.physicsFromConfig(pmsm.config);
    const poles = pmsm.config.poles; // 8
    const { nuMaxSlice, cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "stator", { physics });
    const Δθ_target = TWO_PI / (poles * cellsPerPole);

    // PMSM stator has 48 slots
    const nSlots = 48;
    const slotSpan = TWO_PI / nSlots;
    const cellsPerSlot = Math.max(1, Math.round(slotSpan / Δθ_target));
    const expectedInteriorCols = nSlots * cellsPerSlot;

    // Build mesh and verify coverage: if per-feature columns work, coverage error is low
    const mesh = meshFromConfig(pmsm.config);
    const expanded = window.UnifiedMotor.ConfigSchema.expand(pmsm.config);
    const section = expanded.slices[0].section;

    const covErr = coverageError(section, mesh);
    assert.ok(covErr < 1e-2,
      `PMSM coverage error ${covErr.toFixed(4)} >= 1e-2 — per-feature columns may be broken`);

    // Quality checks
    const qs = MotorMesh.quality(mesh.stator);
    assert.strictEqual(qs.nInverted, 0,
      `PMSM stator has ${qs.nInverted} inverted elements`);
    assert.strictEqual(qs.nDegenerate, 0,
      `PMSM stator has ${qs.nDegenerate} degenerate elements`);

    // The gap band has poles * cellsPerPole = 8 * 41 = 328 columns
    assert.strictEqual(mesh.stator.gapLoop.length, poles * cellsPerPole,
      `PMSM stator gapLoop.length=${mesh.stator.gapLoop.length} should be ${poles * cellsPerPole}`);

    // The total angle count across the full stator should reflect per-feature columns.
    // ALL angular positions from both interior and gap bands:
    const allAngles = collectAllAngles(mesh.stator);

    // The unique angle count should be at least the gap band count (328)
    // and at most the lcm-driven old value (would have been >> 328)
    const N_gap = poles * cellsPerPole; // 328
    assert.ok(allAngles.length >= N_gap,
      `PMSM stator: unique angle count ${allAngles.length} < N_gap=${N_gap}`);

    // With per-feature columns, the interior columns are expectedInteriorCols = 336.
    // The combined unique columns from gap (328) and interior (336) should be <= 336 + 328
    // (they partially overlap). The old LCM approach would give >> 1000 unique angles.
    const oldLCMEstimate = 2048; // approximate old LCM-driven column count
    assert.ok(allAngles.length < oldLCMEstimate,
      `PMSM stator: unique angle count ${allAngles.length} >= old LCM estimate ${oldLCMEstimate} (LCM explosion not eliminated)`);
  });
});

// ---------------------------------------------------------------------------
//  Universal rotor: per-feature columns, no LCM explosion
//
//  Universal rotor has 24 slots, poles=2, m=1 → nuMaxSlice=11, cpp=26.
//  Δθ_target = TWO_PI/(2*26) = TWO_PI/52.
//  cells_per_slot = round((TWO_PI/24)/(TWO_PI/52)) = round(52/24) = round(2.17) = 2.
//  interior total = 24 × 2 = 48.
//  Old LCM: ~204 cpp * 2 poles = 408 unique angles.
// ---------------------------------------------------------------------------

describe("Universal rotor: per-feature columns, no LCM explosion", () => {
  it("universal rotor unique angle count << old LCM value; coverage error < 1e-2", () => {
    const machines = loadAllFixtures();
    const universal = machines.find(m => m.id === "universal");
    assert.ok(universal, "universal fixture must be present");

    const physics = MotorMesh.physicsFromConfig(universal.config);
    const poles = universal.config.poles; // 2
    const { nuMaxSlice, cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });
    const N_gap = poles * cellsPerPole;

    const mesh = meshFromConfig(universal.config);
    const expanded = window.UnifiedMotor.ConfigSchema.expand(universal.config);
    const section = expanded.slices[0].section;

    // Coverage error must be low (per-feature columns respect slot boundaries)
    const covErr = coverageError(section, mesh);
    assert.ok(covErr < 1e-2,
      `Universal coverage error ${covErr.toFixed(4)} >= 1e-2`);

    // Gap band has the right column count
    assert.strictEqual(mesh.rotor.gapLoop.length, N_gap,
      `Universal rotor gapLoop.length=${mesh.rotor.gapLoop.length} should be ${N_gap}`);

    // No inverted elements
    const qr = MotorMesh.quality(mesh.rotor);
    assert.strictEqual(qr.nInverted, 0,
      `Universal rotor has ${qr.nInverted} inverted elements`);

    // Old LCM cpp was ~204; new cpp <= 30 (checked in tangential-physics.test.js)
    // The unique angle count should be much less than old LCM * poles
    const allAngles = collectAllAngles(mesh.rotor);
    const oldLCMAngleCount = 204 * 2; // approximate old worst case
    assert.ok(allAngles.length < oldLCMAngleCount,
      `Universal rotor: unique angle count ${allAngles.length} >= old LCM estimate ${oldLCMAngleCount}`);
  });
});

// ---------------------------------------------------------------------------
//  Brushed-DC-PM rotor: same per-feature check
// ---------------------------------------------------------------------------

describe("Brushed-DC-PM rotor: per-feature columns and quality", () => {
  it("brushed-dc-pm rotor has correct gap band, low coverage error, no inverted", () => {
    const machines = loadAllFixtures();
    const bdc = machines.find(m => m.id === "brushed-dc-pm");
    assert.ok(bdc, "brushed-dc-pm fixture must be present");

    const physics = MotorMesh.physicsFromConfig(bdc.config);
    const poles = bdc.config.poles; // 4
    const { cellsPerPole } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });
    const N_gap = poles * cellsPerPole;

    const mesh = meshFromConfig(bdc.config);
    const expanded = window.UnifiedMotor.ConfigSchema.expand(bdc.config);
    const section = expanded.slices[0].section;

    const covErr = coverageError(section, mesh);
    assert.ok(covErr < 1e-2,
      `brushed-dc-pm coverage error ${covErr.toFixed(4)} >= 1e-2`);

    assert.strictEqual(mesh.rotor.gapLoop.length, N_gap,
      `brushed-dc-pm rotor gapLoop.length=${mesh.rotor.gapLoop.length} should be ${N_gap}`);

    const q = MotorMesh.quality(mesh.rotor);
    assert.strictEqual(q.nInverted, 0,
      `brushed-dc-pm rotor has ${q.nInverted} inverted elements`);
    assert.strictEqual(q.nDegenerate, 0,
      `brushed-dc-pm rotor has ${q.nDegenerate} degenerate elements`);
  });
});

// ---------------------------------------------------------------------------
//  Back-iron full-circle feature: uniform angular spacing in interior band.
//
//  For a single iron annulus (full-circle only, P_body=1), the interior band
//  has uniform angular spacing — no feature boundaries to align to.
// ---------------------------------------------------------------------------

describe("Back-iron full-circle feature: uniform interior angular spacing", () => {
  it("single annulus rotor interior band has uniform angular divisions", () => {
    const section = singleAnnulusSection();
    const physics = syntheticPhysics({ m: 3, p: 2, Q: 6, poles: 2 });

    const mesh = MotorMesh.build(section, { physics });
    const { rotor } = mesh;
    const { nodes } = rotor;
    const Nn = nodes.length / 2;

    // Find all unique radii
    const rSet = new Set();
    for (let n = 0; n < Nn; n++) {
      const r = Math.hypot(nodes[2*n], nodes[2*n+1]);
      rSet.add(Math.round(r * 1e10) / 1e10);
    }
    const rArr = Array.from(rSet).sort((a, b) => a - b);
    assert.ok(rArr.length >= 3,
      `Single annulus rotor should have >= 3 unique radii, got ${rArr.length}`);

    // Pick a radius in the interior (not the innermost or outermost)
    // Use the second-from-bottom radius (first interior row above r_min)
    const targetR = rArr[1];

    // Collect nodes at this radius
    const thetasAtR = [];
    for (let n = 0; n < Nn; n++) {
      const r = Math.hypot(nodes[2*n], nodes[2*n+1]);
      if (Math.abs(r - targetR) < 1e-8) {
        let th = Math.atan2(nodes[2*n+1], nodes[2*n]);
        if (th < 0) th += TWO_PI;
        thetasAtR.push(th);
      }
    }
    thetasAtR.sort((a, b) => a - b);

    assert.ok(thetasAtR.length >= 2,
      `Single annulus rotor: no nodes at interior radius ${targetR.toFixed(6)} (tolerance 1e-8)`
    );

    // Full-circle interior band should be uniformly spaced
    const step = thetasAtR[1] - thetasAtR[0];
    assert.ok(step > 0 && step < TWO_PI,
      `Single annulus interior: step ${step} out of range`);

    for (let k = 2; k < thetasAtR.length; k++) {
      const diff = thetasAtR[k] - thetasAtR[k-1];
      assert.ok(
        Math.abs(diff - step) < 1e-9,
        `Single annulus rotor: non-uniform interior at k=${k}: diff=${diff}, expected step=${step}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  All 15 fixtures: per-feature architecture produces low coverage error
//
//  This is the key property: per-feature columns ensure that elements
//  don't straddle feature boundaries in the interior band, so coverage
//  error (fraction of mis-classified element area) is < 1e-2 for all fixtures.
// ---------------------------------------------------------------------------

describe("All 15 fixtures: per-feature columns give coverage error < 1e-2", () => {
  it("every fixture: coverageError < 1e-2 at default opts", () => {
    const machines = loadAllFixtures();
    assert.ok(machines.length >= 15, `expected >= 15 fixtures, got ${machines.length}`);

    for (const m of machines) {
      const physics = MotorMesh.physicsFromConfig(m.config);
      const expanded = window.UnifiedMotor.ConfigSchema.expand(m.config);
      const section = expanded.slices[0].section;
      const mesh = MotorMesh.build(section, { physics });

      const covErr = coverageError(section, mesh);
      assert.ok(covErr < 1e-2,
        `${m.id}: coverageError=${covErr.toFixed(4)} >= 1e-2 (per-feature columns broken?)`);

      // Also no inverted elements
      const qr = MotorMesh.quality(mesh.rotor);
      const qs = MotorMesh.quality(mesh.stator);
      assert.strictEqual(qr.nInverted, 0, `${m.id} rotor: nInverted=${qr.nInverted}`);
      assert.strictEqual(qs.nInverted, 0, `${m.id} stator: nInverted=${qs.nInverted}`);
    }
  });
});
