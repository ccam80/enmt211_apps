(function () {
  "use strict";

  // Variable-reluctance stepper: 8 stator teeth, 6 rotor teeth, 3-phase
  // Classic single-stack VR, OD ≈ 72 mm
  // Air gap 2.0 mm at 19 mm radius
  // Stator: Q=12 slots (3 slots/tooth), m=3, p=4 pole-pairs → Q%(m*p)=12%12=0 ✓
  // Nr=34 ensures at least 2 grid cells across the 2 mm air gap
  const ROTOR_YOKE_R    = [0.006, 0.014];
  const ROTOR_TEETH_R   = [0.014, 0.019];
  const STATOR_BORE_R   = [0.021, 0.030];
  const STATOR_YOKE_R   = [0.030, 0.036];

  const config = {
    grid: { Nr: 34, Ntheta: 256, rInner: 0.006, rOuter: 0.036, ell: 0.038 },
    poles: 8,
    mechanical: { J: 1e-5, damping: 5e-6, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_TEETH_R,
        teeth: 6,
        theta0: 0,
        spanFraction: 0.5,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 4, Q: 12, coilPitch: 1, turns: 120 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "STEP", amp: 24, conductionAngle: Math.PI, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "sequencer", poles: 8, stepAngleElec: 2 * Math.PI / 3 },
        R: 3.0,
      },
      {
        terminal: { type: "STEP", amp: 24, conductionAngle: Math.PI, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "sequencer", poles: 8, stepAngleElec: 2 * Math.PI / 3 },
        R: 3.0,
      },
      {
        terminal: { type: "STEP", amp: 24, conductionAngle: Math.PI, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "sequencer", poles: 8, stepAngleElec: 2 * Math.PI / 3 },
        R: 3.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "vr-stepper", label: "VR stepper 8s/6r (3-phase)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
