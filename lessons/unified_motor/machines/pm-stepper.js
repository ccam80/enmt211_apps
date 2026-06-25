(function () {
  "use strict";

  // PM stepper (can-stack style): 24-pole radial PM rotor, 2-phase stator wound to
  // match (p=24, Q=48). A can-stack is electromagnetically a matched-pole 2-phase
  // PM machine — the claw-poles make each phase's stator field match the rotor pole
  // count — so the winding pole-count p MUST equal the rotor pole-count, else the
  // magnet flux does not link the winding and there is no torque. 2-phase sequencer
  // drive → 48 steps/rev (7.5°). OD ≈ 42 mm (NEMA 17 / canstack). SPP = Q/(m*p) = 1.

  const config = {
    grid: { Nr: 14, Ntheta: 768, rInner: 0.005, rOuter: 0.028, ell: 0.030 },
    poles: 24,
    mechanical: { J: 8e-6, damping: 3e-3, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "magnet",
            rRange: [0.01, 0.014],
            poles: 24,
            Mr: 700000,
            muR: 1000,
            alpha: 1
          },
          {
            kind: "iron",
            rRange: [0.005, 0.01],
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
            rRange: [0.024, 0.028],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "concentrated-winding",
            rRange: [0.016, 0.024],
            slotRRange: [0.016, 0.024],
            winding: {
              standard: {
                m: 2,
                p: 24,
                Q: 48,
                coilPitch: 2,
                turns: 100
              }
            },
            slotFraction: 0.5,
            muR: 1000,
            alpha: 1
          }
        ]
      }
    ],
    // Two-phase full-step commutation table (both phases energised, sign-sequenced):
    // the 4-state cycle (A,B) = (+,−),(+,+),(−,+),(−,−) advances the rotor 90°
    // electrical per commandStep → 7.5° mechanical, 48 steps/rev for 24 poles.
    circuits: [
      { terminal: { type: "STEP", amp: 12 }, commutation: { mode: "sequencer", pattern: [1, 1, -1, -1] }, R: 8.0 },
      { terminal: { type: "STEP", amp: 12 }, commutation: { mode: "sequencer", pattern: [-1, 1, 1, -1] }, R: 8.0 },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "pm-stepper", label: "PM stepper 24p/12s (can-stack)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
