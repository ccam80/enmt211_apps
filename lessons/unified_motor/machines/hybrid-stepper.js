(function () {
  "use strict";

  // Hybrid stepper — 50 rotor teeth, 200 steps/rev (1.8°). Faithful 2.5-D model:
  // the permanent magnet is AXIAL (one per rotor cup, opposite polarity), magnetizing
  // each cup's teeth to a single polarity. That uniform per-cup bias cannot live in a
  // single 2-D r-θ slice (net radial flux there is topologically zero); it is carried
  // by the axial-flux circuit (stack.axial) — net flux out cup A's all-N teeth, across
  // the gap, back through cup B's all-S teeth, closing axially through the magnet. The
  // two cups are one half-tooth apart (sliceOffsets). Modulated by the 50 teeth the
  // bias couples to the Q=8/p=4 winding's 50th gap harmonic (8·6+2), and the 50/8 =
  // 6.25 pole/tooth ratio places the four full-step states a quarter-tooth apart.
  //
  // Stator: 8 salient poles, each a GROUP of 6 fine teeth at the rotor tooth pitch
  // (poleTeeth) — the genuine salient-pole hybrid structure, not teeth spread evenly
  // round the bore. Small physical gap (0.3 mm) so the tooth-pitch modulation is not
  // smeared flat. The gap mesh resolves the finer of the two tooth counts automatically.
  const ROTOR_BODY_R   = [0.010, 0.019];   // pole-piece body carrying the radial+axial flux
  const ROTOR_TEETH_R  = [0.019, 0.020];   // 50 surface teeth, 1 mm
  const POLE_TEETH_R   = [0.0203, 0.0213]; // stator pole-face fine teeth (across the 0.3 mm gap)
  const STATOR_SLOT_R  = [0.0213, 0.030];  // conductors behind the pole teeth
  const STATOR_YOKE_R  = [0.030, 0.040];   // back-iron

  const config = {
    grid: { Nr: 300, Ntheta: 768, rInner: 0.010, rOuter: 0.040, ell: 0.038 },
    poles: 4,
    mechanical: { J: 5e-5, damping: 3e-3, frictionTorque: 3e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.01, 0.019],
            teeth: 1,
            spanFraction: 1,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.019, 0.02],
            teeth: 50,
            spanFraction: 0.5,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "outer",
        components: [
          {
            kind: "iron",
            rRange: [0.03, 0.04],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "concentrated-winding",
            rRange: [0.0203, 0.0213],
            slotRRange: [0.0213, 0.03],
            winding: {
              standard: {
                m: 2,
                p: 4,
                Q: 8,
                coilPitch: 1,
                turns: 100
              }
            },
            poleTeeth: {
              count: 6,
              pitch: 0.12566370614359174,
              span: 0.5
            },
            muR: 1000,
            alpha: 1
          }
        ]
      }
    ],
    // Two-phase full-step commutation table: the 4-state cycle (A,B) advances the rotor
    // a quarter tooth per commandStep → 200 steps/rev (1.8°).
    circuits: [
      { terminal: { type: "STEP", amp: 24 }, commutation: { mode: "sequencer", pattern: [1, 1, -1, -1] }, R: 2.0 },
      { terminal: { type: "STEP", amp: 24 }, commutation: { mode: "sequencer", pattern: [-1, 1, 1, -1] }, R: 2.0 },
    ],
    stack: {
      slices: 2,
      sliceOffsets: [0, Math.PI / 50],   // the two cups, one half-tooth apart
      axial: {
        // Axial NdFeB magnet (MMF = Br·ℓ/μ0 ≈ 6000 A-turns), opposite polarity per cup.
        branches: { pm: { Br: 1.2, length: 0.00628 } },
        loops: [ { slices: [{ s: 0, sign: 1 }, { s: 1, sign: -1 }], branches: ["pm"], Raxial: 0 } ],
      },
    },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "hybrid-stepper", label: "Hybrid stepper 50T (200 steps/rev)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
