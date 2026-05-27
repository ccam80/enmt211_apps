(function () {
  "use strict";

  // 4-pole 36-slot three-phase induction motor, m=3 q=3, 28 rotor bars
  // Small industrial, OD ≈ 184 mm, air gap 3.0 mm at 54 mm radius
  // Rotor: 28 squirrel-cage bars (K ring, m=4 p=7 Q=28: Q%(m*p)=0)
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap
  const ROTOR_YOKE_R    = [0.022, 0.042];
  const ROTOR_BAR_R     = [0.042, 0.054];
  const STATOR_BORE_R   = [0.057, 0.074];
  const STATOR_YOKE_R   = [0.074, 0.092];

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.022, rOuter: 0.092, ell: 0.130 },
    poles: 4,
    mechanical: { J: 3e-3, damping: 3e-4, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "K",
        rRange: ROTOR_BAR_R,
        winding: { standard: { m: 4, p: 7, Q: 28, coilPitch: 1, turns: 1 } },
        slotRRange: ROTOR_BAR_R,
        slotFraction: 0.45,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 4, Q: 36, coilPitch: 9, turns: 60 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "induction-3ph", label: "3-φ induction 4p/36s", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
