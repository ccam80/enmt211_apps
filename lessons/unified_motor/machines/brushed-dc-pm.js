(function () {
  "use strict";

  // 4-pole 24-slot brushed DC with PM stator field, magnet arc ≈ 120°
  // Small-frame power-tool / wiper motor, OD ≈ 50 mm
  // Nr=22 ensures at least 2 grid cells across the 2.0 mm air gap
  const ROTOR_YOKE_R    = [0.006, 0.013];
  const ROTOR_SURFACE_R = [0.013, 0.019];
  const STATOR_PM_R     = [0.021, 0.022];
  const STATOR_YOKE_R   = [0.022, 0.025];

  const config = {
    grid: { Nr: 22, Ntheta: 256, rInner: 0.006, rOuter: 0.025, ell: 0.050 },
    poles: 4,
    mechanical: { J: 2e-5, damping: 5e-6, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "W",
        rRange: ROTOR_SURFACE_R,
        winding: { standard: { m: 1, p: 4, Q: 24, coilPitch: 6, turns: 15 } },
        slotRRange: ROTOR_SURFACE_R,
        slotFraction: 0.55,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "M",
        rRange: STATOR_PM_R,
        magnets: 4,
        Mr: 8e5,
        backIron: true,
        backIronRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "DC", amp: 12 },
        commutation: { mode: "mechanical", poles: 4, conductionAngle: Math.PI / 2 },
        R: 0.8,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "brushed-dc-pm", label: "Brushed DC 4p/24s (PM field)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
