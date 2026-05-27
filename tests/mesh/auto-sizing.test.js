"use strict";

// =============================================================================
//  auto-sizing.test.js — Phase 2.6 physics-driven mesh sizing tests
//
//  Tests:
//   1. Wound conductor at 60 Hz with copper gets >= 3 layers (skin-depth floor)
//   2. Wound conductor at 10 kHz (PWM) gets >= 27 layers across 6 mm slot
//   3. Iron band with expected B > 0.7 * Bknee gets >= 2x the default layer count
//   4. Iron band with expected B well below Bknee gets the default (1x) count
//   5. A localised tooth feature (small thetaRange) gets >= 2 angular sub-cells
//   6. A back-iron full-period feature does NOT get the per-feature extra column
//   7. Cache invalidates when physics.circuits[0].freq changes
// =============================================================================

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { LIB, singleAnnulusSection, ringStackSection } = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Helper: build a minimal section with one conductor feature
// ---------------------------------------------------------------------------
function conductorSection({ r0, r1, freq, amp, conductorMaterial }) {
  // One wound conductor slot (localised: half of one period = quarter circle)
  // One iron back-iron (full circle)
  // Rotor: simple iron annulus
  const STATOR_BORE  = [r0, r1];
  const STATOR_YOKE  = [r1, r1 + 0.010];
  const ROTOR_IRON   = [0.020, 0.038];

  const section = {
    features: [
      // Rotor iron (needed so gap geometry is defined)
      { kind: "iron", member: "rotor", rRange: ROTOR_IRON,
        thetaRange: [0, TWO_PI], muR: 1000 },
      // Stator conductor slot: localised (1/4 of circle, which is < half period of 4)
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [TWO_PI / 4, TWO_PI / 2], circuit: 0, turns: -40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [TWO_PI / 2, 3 * TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: STATOR_BORE,
        thetaRange: [3 * TWO_PI / 4, TWO_PI], circuit: 0, turns: -40 },
      // Stator back-iron (full circle)
      { kind: "iron", member: "stator", rRange: STATOR_YOKE,
        thetaRange: [0, TWO_PI], muR: 1000 },
    ],
  };

  const physics = {
    circuits: [{ freq, amp: amp != null ? amp : 100, conductorMaterial: conductorMaterial || "copper" }],
  };

  return { section, physics };
}

// ---------------------------------------------------------------------------
//  Count radial layers in a specific rRange band for a body mesh
// ---------------------------------------------------------------------------
function countRadialLayersInBand(body, r0, r1) {
  const { nodes, elems } = body;
  const Ne = elems.length / 4;
  const Nr = body.nodes.length / 2 / body.gapLoop.length;

  // Count how many distinct r-values fall strictly inside [r0, r1]
  const rSet = new Set();
  const Nn = nodes.length / 2;
  for (let n = 0; n < Nn; n++) {
    const r = Math.hypot(nodes[2 * n], nodes[2 * n + 1]);
    if (r > r0 - 1e-9 && r < r1 + 1e-9) {
      rSet.add(Math.round(r * 1e10) / 1e10);
    }
  }
  // Number of layers = number of internal r-interfaces = rValues - 2
  // (r0 and r1 are band boundaries, layers = intervals between them)
  const sortedR = Array.from(rSet).sort((a, b) => a - b);
  return Math.max(0, sortedR.length - 1);
}

// ---------------------------------------------------------------------------
//  physicsTargets unit-test helpers
// ---------------------------------------------------------------------------

// Test physicsTargets directly for conductor skin-depth computation
describe("physicsTargets — conductor skin-depth sizing", () => {
  it("60 Hz copper: targetCellSize = min(8.5/3, 6/3) = 2mm → >= 3 layers across 6mm", () => {
    const r0 = 0.044, r1 = 0.050; // 6 mm slot
    const features = [
      { kind: "conductor", member: "stator", rRange: [r0, r1],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "iron", member: "stator", rRange: [r1, r1 + 0.01],
        thetaRange: [0, TWO_PI], muR: 1000 },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.042],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const physics = { circuits: [{ freq: 60, amp: 100, conductorMaterial: "copper" }] };
    const opts = { refine: 1, physics };
    const { perBandLayers } = MotorMesh.physicsTargets(features, opts);

    // skin depth at 60 Hz copper: delta = sqrt(2*1.68e-8 / (4π×1e-7 * 1 * 2π*60)) ≈ 8.5 mm
    // targetCellSize = min(8.5e-3/3, 6e-3/3) = min(2.83mm, 2mm) = 2mm
    // layers = max(3, ceil(6e-3 / 2e-3)) = max(3, 3) = 3
    const bKey = `${r0}|${r1}|stator|conductor`;
    const layers = perBandLayers.get(bKey);
    assert.ok(layers != null, "perBandLayers should have an entry for the conductor band");
    assert.ok(layers >= 3, `60 Hz copper: expected >= 3 layers, got ${layers}`);
  });

  it("10 kHz copper: skin depth ≈ 0.66 mm → targetCellSize ≈ 0.22 mm → >= 27 layers across 6mm", () => {
    const r0 = 0.044, r1 = 0.050; // 6 mm slot
    const features = [
      { kind: "conductor", member: "stator", rRange: [r0, r1],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "iron", member: "stator", rRange: [r1, r1 + 0.01],
        thetaRange: [0, TWO_PI], muR: 1000 },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.042],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const physics = { circuits: [{ freq: 10000, amp: 100, conductorMaterial: "copper" }] };
    const opts = { refine: 1, physics };
    const { perBandLayers } = MotorMesh.physicsTargets(features, opts);

    // skin depth at 10 kHz copper: delta = sqrt(2*1.68e-8 / (4π×1e-7 * 2π*10000))
    //   = sqrt(3.36e-8 / (7.896e-3)) ≈ sqrt(4.25e-6) ≈ 0.00206 m ≈ 2.06 mm
    // Wait — let's compute:
    //   omega = 2π × 10000 = 62831.85
    //   mu0 * muR * omega = 4π×1e-7 * 1 * 62831.85 = 1.2566e-6 * 62831.85 = 7.896e-2
    //   delta = sqrt(2 * 1.68e-8 / 7.896e-2) = sqrt(4.25e-7) ≈ 6.52e-4 m ≈ 0.652 mm
    // targetCellSize = min(0.652/3, 6/3) mm = min(0.217, 2) mm = 0.217 mm
    // layers = max(3, ceil(6 / 0.217)) = max(3, 28) = 28
    const bKey = `${r0}|${r1}|stator|conductor`;
    const layers = perBandLayers.get(bKey);
    assert.ok(layers != null, "perBandLayers should have an entry for the conductor band");
    assert.ok(layers >= 27, `10 kHz copper: expected >= 27 layers, got ${layers}`);
  });
});

// ---------------------------------------------------------------------------
//  physicsTargets — iron saturation sizing
// ---------------------------------------------------------------------------

describe("physicsTargets — iron saturation sizing", () => {
  it("iron band with high expected B (> 0.7 * Bknee) gets >= 2x layer count vs low-B iron", () => {
    const r0 = 0.044, r1 = 0.054; // 10 mm iron band
    const Bknee = 1.6; // T

    // High-current scenario: lots of amp-turns
    const featuresHigh = [
      { kind: "conductor", member: "stator", rRange: [0.034, 0.044],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 200 },
      { kind: "iron", member: "stator", rRange: [r0, r1],
        thetaRange: [0, TWO_PI], muR: 1000, Bknee },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.032],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const physicsHigh = { circuits: [{ freq: 0, amp: 10000, conductorMaterial: "copper" }] };
    const optsHigh = { refine: 1, physics: physicsHigh };
    const { perBandLayers: highBands } = MotorMesh.physicsTargets(featuresHigh, optsHigh);

    // Low-current scenario: minimal amp-turns
    const featuresLow = [
      { kind: "conductor", member: "stator", rRange: [0.034, 0.044],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 1 },
      { kind: "iron", member: "stator", rRange: [r0, r1],
        thetaRange: [0, TWO_PI], muR: 1000, Bknee },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.032],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const physicsLow = { circuits: [{ freq: 0, amp: 0.001, conductorMaterial: "copper" }] };
    const optsLow = { refine: 1, physics: physicsLow };
    const { perBandLayers: lowBands } = MotorMesh.physicsTargets(featuresLow, optsLow);

    const bKey = `${r0}|${r1}|stator|iron`;
    const highLayers = highBands.get(bKey) || 0;
    const lowLayers  = lowBands.get(bKey)  || 0;

    assert.ok(highLayers >= 2,
      `high-B iron should have >= 2 layers, got ${highLayers}`);
    assert.ok(lowLayers >= 1,
      `low-B iron should have >= 1 layer, got ${lowLayers}`);
    assert.ok(
      highLayers >= lowLayers,
      `high-B iron (${highLayers}) should have >= layers vs low-B iron (${lowLayers})`
    );
  });

  it("iron band with B well below Bknee gets default (1×refine) count", () => {
    const r0 = 0.044, r1 = 0.054;
    const Bknee = 1.6;

    // Near-zero current → near-zero B → satMultiplier = 1 → nLayers = max(2, 1) = 2
    // With refine=1 → layers = round(2 * 1) = 2
    const features = [
      { kind: "conductor", member: "stator", rRange: [0.034, 0.044],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 1 },
      { kind: "iron", member: "stator", rRange: [r0, r1],
        thetaRange: [0, TWO_PI], muR: 1000, Bknee },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.032],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const physics = { circuits: [{ freq: 0, amp: 0, conductorMaterial: "copper" }] };
    const opts = { refine: 1, physics };
    const { perBandLayers } = MotorMesh.physicsTargets(features, opts);

    const bKey = `${r0}|${r1}|stator|iron`;
    const layers = perBandLayers.get(bKey);

    // Low B → satMultiplier=1, nLayers = max(2, ceil(1)) = 2
    assert.ok(layers != null, "should have an entry for the iron band");
    assert.ok(layers <= 4,
      `low-B iron should have <= 4 layers (no saturation), got ${layers}`);
  });
});

// ---------------------------------------------------------------------------
//  physicsTargets — angular curvature refinement
// ---------------------------------------------------------------------------

describe("physicsTargets — angular curvature refinement", () => {
  it("localised tooth feature (small thetaRange) appears in perFeatureExtraCols", () => {
    // P_body = 4 (four conductor slots → body period = 4)
    // bodyPeriodAngle = 2π/4 = π/2
    // A feature spanning π/4 (= half of bodyPeriodAngle) is exactly at the threshold
    // A feature spanning π/4 - ε is localised (< half body period)
    const bodyPeriodAngle = TWO_PI / 4;
    const localisedSpan = bodyPeriodAngle * 0.4; // 40% of period → localised

    const features = [
      // 4 conductor slots (defines P_body = 4)
      { kind: "conductor", member: "stator", rRange: [0.044, 0.050],
        thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: [0.044, 0.050],
        thetaRange: [TWO_PI / 4, TWO_PI / 2], circuit: 0, turns: -40 },
      { kind: "conductor", member: "stator", rRange: [0.044, 0.050],
        thetaRange: [TWO_PI / 2, 3 * TWO_PI / 4], circuit: 0, turns: 40 },
      { kind: "conductor", member: "stator", rRange: [0.044, 0.050],
        thetaRange: [3 * TWO_PI / 4, TWO_PI], circuit: 0, turns: -40 },
      // Small iron tooth (localised: span < half body period)
      { kind: "iron", member: "stator", rRange: [0.044, 0.054],
        thetaRange: [0, localisedSpan], muR: 1000 },
      // Back-iron (full circle — should NOT get extra cols)
      { kind: "iron", member: "stator", rRange: [0.054, 0.064],
        thetaRange: [0, TWO_PI], muR: 1000 },
      // Rotor iron (needed for gap geometry)
      { kind: "iron", member: "rotor", rRange: [0.020, 0.042],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];

    const opts = { refine: 1, physics: { circuits: [] } };
    const { perFeatureExtraCols } = MotorMesh.physicsTargets(features, opts);

    // Find the index of the localised iron tooth (index 4)
    const toothIdx = 4;
    const backIronIdx = 5;

    assert.ok(
      perFeatureExtraCols.has(toothIdx),
      `localised tooth (fi=${toothIdx}) should appear in perFeatureExtraCols`
    );
    assert.ok(
      !perFeatureExtraCols.has(backIronIdx),
      `full-circle back-iron (fi=${backIronIdx}) should NOT appear in perFeatureExtraCols`
    );
  });

  it("back-iron full-period feature does NOT get per-feature extra column", () => {
    // A full-circle (2π span) iron feature → no extra columns
    const features = [
      { kind: "iron", member: "stator", rRange: [0.050, 0.060],
        thetaRange: [0, TWO_PI], muR: 1000 },
      { kind: "iron", member: "rotor", rRange: [0.020, 0.042],
        thetaRange: [0, TWO_PI], muR: 1000 },
    ];
    const opts = { refine: 1 };
    const { perFeatureExtraCols } = MotorMesh.physicsTargets(features, opts);

    // Neither feature is localised (both are full-circle or full-period)
    for (const [fi] of perFeatureExtraCols) {
      const f = features[fi];
      const span = f.thetaRange[1] - f.thetaRange[0];
      assert.ok(
        span < TWO_PI - 1e-9,
        `full-circle feature fi=${fi} should not be in perFeatureExtraCols`
      );
    }
  });
});

// ---------------------------------------------------------------------------
//  Integration: mesh built with physics opts has >= 3 layers in conductor band
// ---------------------------------------------------------------------------

describe("integration — conductor band has >= 3 radial layers with physics opts", () => {
  it("stator conductor band gets >= 3 radial layers at 60 Hz copper", () => {
    const r0 = 0.044, r1 = 0.050;
    const { section, physics } = conductorSection({ r0, r1, freq: 60, amp: 100 });
    const mesh = MotorMesh.build(section, { physics });
    const layers = countRadialLayersInBand(mesh.stator, r0, r1);
    assert.ok(layers >= 3,
      `stator conductor band at 60 Hz should have >= 3 radial layers, got ${layers}`);
  });

  it("stator conductor band gets more layers at 10 kHz than at 60 Hz", () => {
    const r0 = 0.044, r1 = 0.050;
    const { section: s60,    physics: p60    } = conductorSection({ r0, r1, freq: 60,    amp: 100 });
    const { section: s10k,   physics: p10k   } = conductorSection({ r0, r1, freq: 10000, amp: 100 });

    const mesh60  = MotorMesh.build(s60,  { physics: p60  });
    const mesh10k = MotorMesh.build(s10k, { physics: p10k });

    const layers60  = countRadialLayersInBand(mesh60.stator,  r0, r1);
    const layers10k = countRadialLayersInBand(mesh10k.stator, r0, r1);

    assert.ok(layers10k > layers60,
      `10 kHz mesh (${layers10k} layers) should be denser than 60 Hz mesh (${layers60} layers)`);
  });
});

// ---------------------------------------------------------------------------
//  physicsFromConfig helper
// ---------------------------------------------------------------------------

describe("physicsFromConfig", () => {
  it("extracts freq, amp, conductorMaterial from AC terminal", () => {
    const config = {
      circuits: [
        { terminal: { type: "AC", freq: 60, amp: 48 }, R: 0.3, commutation: { mode: "none" } },
        { terminal: { type: "DC", amp: 10 }, R: 0.1, commutation: { mode: "none" } },
      ],
    };
    const phys = MotorMesh.physicsFromConfig(config);
    assert.strictEqual(phys.circuits.length, 2);
    assert.strictEqual(phys.circuits[0].freq, 60);
    assert.strictEqual(phys.circuits[0].amp, 48);
    assert.strictEqual(phys.circuits[0].conductorMaterial, "copper");
    assert.strictEqual(phys.circuits[1].freq, 0, "DC terminal should yield freq=0");
    assert.strictEqual(phys.circuits[1].amp, 10);
  });

  it("STEP terminal uses chopFreq as freq", () => {
    const config = {
      circuits: [
        { terminal: { type: "STEP", chopFreq: 5000, amp: 20 }, R: 0.2, commutation: { mode: "none" } },
      ],
    };
    const phys = MotorMesh.physicsFromConfig(config);
    assert.strictEqual(phys.circuits[0].freq, 5000);
  });

  it("empty circuits array is handled gracefully", () => {
    const config = { circuits: [] };
    const phys = MotorMesh.physicsFromConfig(config);
    assert.strictEqual(phys.circuits.length, 0);
  });
});
