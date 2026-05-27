(function () {
  "use strict";

  // Hybrid stepper motor: NEMA 23/34 style, 200 steps/rev
  // 50 rotor teeth, 8 stator pole pairs (Q=16), 2 axial magnets
  // OD ≈ 80 mm, air gap 2.0 mm at 20 mm radius
  // Nr=34 ensures at least 2 grid cells across the 2 mm air gap
  const MAGNET_R        = [0.010, 0.014];
  const ROTOR_TEETH_R   = [0.014, 0.020];
  const STATOR_BORE_R   = [0.022, 0.034];
  const STATOR_YOKE_R   = [0.034, 0.040];

  const config = {
    grid: { Nr: 34, Ntheta: 512, rInner: 0.010, rOuter: 0.040, ell: 0.038 },
    poles: 8,
    mechanical: { J: 5e-5, damping: 2e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: MAGNET_R,
        magnets: 2,
        Mr: 8e5,
        backIron: false,
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_TEETH_R,
        teeth: 50,
        theta0: 0,
        spanFraction: 0.5,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 2, p: 8, Q: 16, coilPitch: 1, turns: 100 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 0, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 8, stepAngleElec: Math.PI / 2 },
        R: 2.0,
      },
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 1, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 8, stepAngleElec: Math.PI / 2 },
        R: 2.0,
      },
    ],
    stack: {
      slices: 2,
      sliceOffsets: [0, Math.PI / 50],
      fluxSources: [{ ringRef: 0, sliceSigns: [+1, -1] }],
    },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "hybrid-stepper", label: "Hybrid stepper 50T/8PP (200 steps/rev)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
