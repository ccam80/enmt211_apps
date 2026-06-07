(function () {
  "use strict";

  // PM stepper (can-stack style): 24-pole radial PM rotor, 2-phase stator wound to
  // match (p=24, Q=48). A can-stack is electromagnetically a matched-pole 2-phase
  // PM machine — the claw-poles make each phase's stator field match the rotor pole
  // count — so the winding pole-count p MUST equal the rotor pole-count, else the
  // magnet flux does not link the winding and there is no torque. 2-phase sequencer
  // drive → 48 steps/rev (7.5°). OD ≈ 42 mm (NEMA 17 / canstack). SPP = Q/(m*p) = 1.
  const ROTOR_YOKE_R    = [0.005, 0.010];
  const ROTOR_SURFACE_R = [0.010, 0.014];
  const STATOR_BORE_R   = [0.016, 0.024];
  const STATOR_YOKE_R   = [0.024, 0.028];

  const config = {
    grid: { Nr: 14, Ntheta: 768, rInner: 0.005, rOuter: 0.028, ell: 0.030 },
    poles: 24,
    mechanical: { J: 8e-6, damping: 3e-3, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: ROTOR_SURFACE_R,
        magnets: 24,
        Mr: 7e5,
        backIron: true,
        backIronRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 2, p: 24, Q: 48, coilPitch: 2, turns: 100 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
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
