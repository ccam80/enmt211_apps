(function () {
  "use strict";

  // Universal motor (AC series), 2 poles, 24 commutator segments
  // Hand-tool scale, OD ≈ 50 mm
  // Rotor: 24-slot lap winding, p=2 (pole-count), coilPitch=12
  // Stator: 2-pole wound field on laminated core (W ring), p=2 (pole-count)
  const ROTOR_YOKE_R    = [0.006, 0.012];
  const ROTOR_SURFACE_R = [0.012, 0.018];
  const STATOR_BORE_R   = [0.020, 0.028];
  const STATOR_YOKE_R   = [0.028, 0.032];

  const config = {
    grid: { Nr: 14, Ntheta: 256, rInner: 0.006, rOuter: 0.032, ell: 0.050 },
    poles: 2,
    mechanical: { J: 1e-5, damping: 3e-6, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "W",
        rRange: ROTOR_SURFACE_R,
        winding: { standard: { m: 1, p: 2, Q: 24, coilPitch: 12, turns: 20 } },
        slotRRange: ROTOR_SURFACE_R,
        slotFraction: 0.55,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 1, p: 2, Q: 4, coilPitch: 2, turns: 60 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: 0 },
        commutation: { mode: "mechanical", poles: 2, conductionAngle: Math.PI },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: 0 },
        commutation: { mode: "none" },
        R: 2.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "universal", label: "Universal 2p/24s (AC series)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
