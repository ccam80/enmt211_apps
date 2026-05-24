(function () {
  "use strict";

  const ROTOR_YOKE     = [0.030, 0.038];
  const ROTOR_SURFACE  = [0.038, 0.043];
  const STATOR_YOKE    = [0.051, 0.055];
  const STATOR_SURFACE = [0.047, 0.051];

  const config = {
    grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 },
    poles: 4,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: ROTOR_SURFACE,
        magnets: 4,
        Mr: 8e5,
        backIron: true,
        backIronRRange: ROTOR_YOKE,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_SURFACE,
        winding: { standard: { m: 2, p: 4, Q: 8, coilPitch: 1, turns: 40 } },
        slotRRange: STATOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 0, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 4, stepAngleElec: Math.PI / 2 },
        R: 0.6,
      },
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 1, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 4, stepAngleElec: Math.PI / 2 },
        R: 0.6,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "pm-stepper", label: "PM stepper", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
