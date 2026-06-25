(function () {
  "use strict";

  // Variable-reluctance stepper: 12 stator slots, 8 rotor teeth, 3-phase.
  // A reluctance machine has no magnets — torque is i²·dL/dθ as the rotor teeth seek
  // alignment with the energised stator poles. For a 3-phase machine the inter-phase
  // mechanical offset must be one third of a rotor-tooth pitch, which requires the
  // winding pole-count p = 2·Nr_teeth (here p=8 for 8 teeth) so successive phases'
  // alignment wells fall pitch/3 apart. The drive is a commutation table: energise
  // one phase at a time, switched by commandStep — full step = 360/(8·3) = 15°
  // (24 steps/rev). OD ≈ 72 mm, 2.0 mm air gap at 19 mm radius.
  // damping sized to ζ≈0.7 of the energised holding stiffness (k≈0.11 N·m/rad,
  // J=1e-5 ⇒ critical ≈ 2.1e-3) so each commanded step settles in ~one swing.

  const config = {
    grid: { Nr: 34, Ntheta: 256, rInner: 0.006, rOuter: 0.036, ell: 0.038 },
    poles: 8,
    mechanical: { J: 1e-5, damping: 1.5e-3, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.014, 0.019],
            teeth: 8,
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
            rRange: [0.03, 0.036],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "concentrated-winding",
            rRange: [0.021, 0.03],
            slotRRange: [0.021, 0.03],
            winding: {
              standard: {
                m: 3,
                p: 8,
                Q: 12,
                coilPitch: 1,
                turns: 120
              }
            },
            slotFraction: 0.5,
            muR: 1000,
            alpha: 1
          }
        ]
      }
    ],
    circuits: [
      { terminal: { type: "STEP", amp: 24 }, commutation: { mode: "sequencer", pattern: [1, 0, 0] }, R: 3.0 },
      { terminal: { type: "STEP", amp: 24 }, commutation: { mode: "sequencer", pattern: [0, 1, 0] }, R: 3.0 },
      { terminal: { type: "STEP", amp: 24 }, commutation: { mode: "sequencer", pattern: [0, 0, 1] }, R: 3.0 },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "vr-stepper", label: "VR stepper 12/8 (3-phase)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
