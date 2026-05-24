(function () {
  "use strict";

  const ROTOR_YOKE     = [0.030, 0.038];
  const ROTOR_SURFACE  = [0.038, 0.043];
  const STATOR_YOKE    = [0.051, 0.055];
  const STATOR_SURFACE = [0.047, 0.051];

  const config = {
    grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 },
    poles: 2,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "K",
        rRange: ROTOR_SURFACE,
        winding: { standard: { m: 3, p: 2, Q: 12, coilPitch: 1, turns: 1 } },
        slotRRange: ROTOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: ROTOR_YOKE,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_SURFACE,
        winding: { standard: { m: 2, p: 2, Q: 8, coilPitch: 1, turns: 40 } },
        slotRRange: STATOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "SHORT" },
        commutation: { mode: "none" },
        R: 0.05,
      },
      {
        terminal: { type: "SHORT" },
        commutation: { mode: "none" },
        R: 0.05,
      },
      {
        terminal: { type: "SHORT" },
        commutation: { mode: "none" },
        R: 0.05,
      },
      {
        terminal: { type: "AC", amp: 24, freq: 50, phaseOffset: 0 },
        commutation: { mode: "none" },
        R: 0.5,
      },
      {
        terminal: { type: "AC", amp: 24, freq: 50, phaseOffset: Math.PI / 2 },
        commutation: { mode: "none" },
        R: 0.8,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "induction-1ph", label: "1-φ induction (cap-start)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
