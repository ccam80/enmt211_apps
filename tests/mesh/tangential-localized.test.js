"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  loadAllFixtures,
  meshFromConfig,
  syntheticPhysics,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Gap-band uniformity tests.
//
//  The gap-adjacent band uses uniform Δθ at poles × round(2.4 × ν_max_slice).
//  This test verifies that the gapTheta array (which indexes the gapLoop)
//  is perfectly uniform for all 15 fixtures, and that the gap-band element
//  columns match the expected count.
//
//  "localized extras" (magnet pole-edge +5, salient tooth-tip +3) are NOT
//  implemented in the current architecture — the gap-band is strictly uniform
//  at the physics-derived count. This test confirms that the gap band is uniform
//  and does NOT get inflated by per-feature extras (the extras belong inside
//  the interior per-feature band, not the uniform gap band).
// ---------------------------------------------------------------------------

describe("Gap-adjacent band is uniformly spaced for all 15 fixtures", () => {
  it("gapTheta diffs are all equal within 1e-12 rad for every fixture body", () => {
    const machines = loadAllFixtures();
    assert.ok(machines.length >= 15, `expected >= 15 fixtures, got ${machines.length}`);

    for (const m of machines) {
      const mesh = meshFromConfig(m.config);

      for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
        const N = body.gapLoop.length;
        if (N < 2) continue;

        const expectedStep = TWO_PI / N;
        for (let k = 1; k < N; k++) {
          const diff = body.gapTheta[k] - body.gapTheta[k - 1];
          assert.ok(
            Math.abs(diff - expectedStep) < 1e-12,
            `${m.id} ${label}: gapTheta not uniform at k=${k}: diff=${diff}, expected=${expectedStep}`
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  Gap band column count matches physics target for all 15 fixtures.
//  The gap band is NOT inflated by per-feature extras — it is exactly
//  poles × round(2.4 × nuMaxSlice).
// ---------------------------------------------------------------------------

describe("Gap band Ntheta_gap equals poles × round(2.4 × nuMaxSlice)", () => {
  it("every fixture body gapLoop.length === poles * round(2.4 * nuMaxSlice)", () => {
    const machines = loadAllFixtures();

    for (const m of machines) {
      const physics = MotorMesh.physicsFromConfig(m.config);
      const { nuMaxSlice } = MotorMesh.tangentialPhysicsTargets([], "rotor", { physics });
      const poles = m.config.poles;
      const expectedN = poles * Math.round(2.4 * nuMaxSlice);

      const mesh = meshFromConfig(m.config);

      for (const [label, body] of [["rotor", mesh.rotor], ["stator", mesh.stator]]) {
        assert.strictEqual(
          body.gapLoop.length,
          expectedN,
          `${m.id} ${label}: gapLoop.length=${body.gapLoop.length} should equal ${expectedN} (poles=${poles} × round(2.4×nuMaxSlice=${nuMaxSlice})=${Math.round(2.4*nuMaxSlice)})`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
//  Per-feature interior band: feature boundaries are respected.
//  For a section where features have distinct thetaRanges, no element
//  in the interior bands (non-gap-adjacent) straddles a feature boundary.
//
//  This test uses the PMSM fixture whose stator has 48 slots — each slot
//  is a conductor feature with a well-defined thetaRange boundary.
// ---------------------------------------------------------------------------

describe("Interior band elements do not straddle feature boundaries", () => {
  it("PMSM stator interior band: no element centroid on wrong side of slot boundary", () => {
    const machines = loadAllFixtures();
    const pmsm = machines.find(m => m.id === "pmsm");
    assert.ok(pmsm, "pmsm fixture must be present");

    const mesh = meshFromConfig(pmsm.config);
    const { stator } = mesh;
    const { nodes, elems, matId, materials } = stator;
    const Ne = elems.length / 4;

    // Collect stator feature boundaries from the physics-derived section
    const expanded = window.UnifiedMotor.ConfigSchema.expand(pmsm.config);
    const section = expanded.slices[0].section;
    const statorFeats = section.features.filter(f => f.member === "stator");

    // Build sorted list of unique non-full-circle angular boundaries
    const boundarySet = new Set();
    for (const f of statorFeats) {
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue;
      const t0 = ((f.thetaRange[0] % TWO_PI) + TWO_PI) % TWO_PI;
      const t1 = ((f.thetaRange[1] % TWO_PI) + TWO_PI) % TWO_PI;
      boundarySet.add(Math.round(t0 * 1e10) / 1e10);
      boundarySet.add(Math.round(t1 * 1e10) / 1e10);
    }
    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);
    if (boundaries.length === 0) return;

    const EPS = 1e-8; // tolerance for boundary coincidence

    // Determine which rRange bands have partial (non-full-circle) features.
    // Only elements whose centroid falls in a partial-feature rRange should be checked.
    // Full-circle features (yoke iron) have uniform theta coverage, so any element
    // there is correctly classified regardless of theta boundary.
    const partialFeatRanges = [];
    for (const f of statorFeats) {
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span < TWO_PI - 1e-9) {
        // partial feature: include its rRange as a zone to check
        partialFeatRanges.push(f.rRange);
      }
    }

    function isInPartialFeatZone(cr) {
      for (const [r0, r1] of partialFeatRanges) {
        if (cr >= r0 - EPS && cr <= r1 + EPS) return true;
      }
      return false;
    }

    // Collar boundary: gap elements are above maxFeatR
    const maxFeatR = Math.max(...statorFeats.map(f => f.rRange[1]));

    let straddleCount = 0;
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4*e], n1 = elems[4*e+1], n2 = elems[4*e+2], n3 = elems[4*e+3];
      const nv = n3 === -1 ? 3 : 4;

      const thetas = [];
      let maxR = -Infinity;
      let cx = 0, cy = 0;
      for (let v = 0; v < nv; v++) {
        const ni = elems[4*e + v];
        const x = nodes[2*ni], y = nodes[2*ni+1];
        cx += x; cy += y;
        const r = Math.hypot(x, y);
        if (r > maxR) maxR = r;
        const th = Math.atan2(y, x);
        thetas.push(((th % TWO_PI) + TWO_PI) % TWO_PI);
      }
      cx /= nv; cy /= nv;
      const cr = Math.hypot(cx, cy);

      // Skip collar elements (above maxFeatR)
      if (maxR > maxFeatR + EPS) continue;

      // Skip elements NOT in a partial-feature radial zone
      // (full-circle feature elements like yoke iron are not subject to boundary straddling)
      if (!isInPartialFeatZone(cr)) continue;

      // For each boundary angle, check if element straddles it.
      for (const b of boundaries) {
        const below = thetas.some(t => t < b - EPS);
        const above = thetas.some(t => t > b + EPS);
        if (below && above) {
          // Exclude elements that wrap around 0/2π boundary
          const nearWrap = thetas.some(t => t > TWO_PI - 0.1) && thetas.some(t => t < 0.1);
          if (!nearWrap) {
            straddleCount++;
            break;
          }
        }
      }
    }

    // No elements in partial-feature zones should straddle feature boundaries
    assert.ok(
      straddleCount === 0,
      `PMSM stator interior: ${straddleCount} elements in partial-feature zones straddle a feature boundary`
    );
  });
});
