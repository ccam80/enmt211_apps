(function () {
  "use strict";

  // 4-pole 24-slot brushed DC with wound stator field (traction scale)
  // OD ≈ 216 mm, large frame, air gap 3.0 mm at 70 mm radius
  // Nr=56 ensures at least 2 grid cells across the 3 mm air gap
  const ROTOR_YOKE_R    = [0.030, 0.055];
  const ROTOR_SURFACE_R = [0.055, 0.070];
  const STATOR_BORE_R   = [0.073, 0.090];
  const STATOR_YOKE_R   = [0.090, 0.108];

  const config = {
    grid: { Nr: 56, Ntheta: 384, rInner: 0.030, rOuter: 0.108, ell: 0.150 },
    poles: 4,
    mechanical: { J: 8e-3, damping: 5e-4, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "W",
        rRange: ROTOR_SURFACE_R,
        winding: { standard: { m: 1, p: 2, Q: 24, coilPitch: 6, turns: 30 } },
        slotRRange: ROTOR_SURFACE_R,
        slotFraction: 0.55,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 1, p: 2, Q: 8, coilPitch: 2, turns: 60 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "DC", amp: 48 },
        commutation: { mode: "mechanical", poles: 4, conductionAngle: Math.PI / 2 },
        R: 0.5,
      },
      {
        terminal: { type: "DC", amp: 48 },
        commutation: { mode: "none" },
        R: 3.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "brushed-dc-wound", label: "Brushed DC 4p/24s (wound field)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
