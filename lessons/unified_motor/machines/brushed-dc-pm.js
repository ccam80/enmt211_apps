(function () {
  "use strict";

  const ROTOR_YOKE    = [0.030, 0.038];
  const ROTOR_SURFACE = [0.038, 0.043];
  const STATOR_YOKE   = [0.051, 0.055];
  const STATOR_SURFACE = [0.047, 0.051];

  const config = {
    grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 },
    poles: 2,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "W",
        rRange: ROTOR_SURFACE,
        winding: { standard: { m: 1, p: 2, Q: 8, coilPitch: 4, turns: 30 } },
        slotRRange: ROTOR_SURFACE,
        slotFraction: 0.5,
        ironRRange: ROTOR_YOKE,
        muR: 1000,
      },
      {
        member: "stator",
        element: "M",
        rRange: STATOR_SURFACE,
        magnets: 2,
        Mr: 8e5,
        backIron: true,
        backIronRRange: STATOR_YOKE,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "DC", amp: 12 },
        commutation: { mode: "mechanical", poles: 2, conductionAngle: Math.PI },
        R: 1.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "brushed-dc-pm", label: "Brushed DC (PM field)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
