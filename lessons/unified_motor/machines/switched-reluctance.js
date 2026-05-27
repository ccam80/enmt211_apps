(function () {
  "use strict";

  // Switched reluctance motor: canonical 8/6 topology (8 stator teeth, 6 rotor teeth)
  // 4-phase (m=4), industrial scale, OD ≈ 180 mm
  // Air gap 3.0 mm at 54 mm radius
  // Stator: Q=8 slots, m=4 phases, p=2 pole-pairs → Q%(m*p)=8%8=0 ✓, coilPitch=1
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap
  const ROTOR_YOKE_R    = [0.022, 0.042];
  const ROTOR_TEETH_R   = [0.042, 0.054];
  const STATOR_BORE_R   = [0.057, 0.074];
  const STATOR_YOKE_R   = [0.074, 0.090];

  const config = {
    grid: { Nr: 50, Ntheta: 384, rInner: 0.022, rOuter: 0.090, ell: 0.120 },
    poles: 8,
    mechanical: { J: 2e-3, damping: 2e-4, loadTorque: 0 },
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
        winding: { standard: { m: 4, p: 2, Q: 8, coilPitch: 1, turns: 80 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "PULSE", amp: 300, phaseOffset: -2 * Math.PI * 0 / 4, conductionAngle: Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 8 },
        R: 1.5,
      },
      {
        terminal: { type: "PULSE", amp: 300, phaseOffset: -2 * Math.PI * 1 / 4, conductionAngle: Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 8 },
        R: 1.5,
      },
      {
        terminal: { type: "PULSE", amp: 300, phaseOffset: -2 * Math.PI * 2 / 4, conductionAngle: Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 8 },
        R: 1.5,
      },
      {
        terminal: { type: "PULSE", amp: 300, phaseOffset: -2 * Math.PI * 3 / 4, conductionAngle: Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 8 },
        R: 1.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "switched-reluctance", label: "Switched reluctance 8s/6r (4-phase)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
