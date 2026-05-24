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
        element: "W",
        rRange: ROTOR_SURFACE,
        winding: { standard: { m: 1, p: 4, Q: 8, coilPitch: 2, turns: 60 } },
        slotRRange: ROTOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: ROTOR_YOKE,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_SURFACE,
        winding: { standard: { m: 3, p: 4, Q: 12, coilPitch: 3, turns: 40 } },
        slotRRange: STATOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "DC", amp: 12 },
        commutation: { mode: "none" },
        R: 2.0,
      },
      {
        terminal: { type: "AC", amp: 24, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "none" },
        R: 0.5,
      },
      {
        terminal: { type: "AC", amp: 24, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "none" },
        R: 0.5,
      },
      {
        terminal: { type: "AC", amp: 24, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "none" },
        R: 0.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "wound-field-synchronous", label: "Wound-field synchronous", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
