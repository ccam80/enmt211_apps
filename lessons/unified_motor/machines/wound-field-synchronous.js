(function () {
  "use strict";

  // Wound-field synchronous motor/alternator: 8 poles (4 pole-pairs), 36 stator slots
  // Salient rotor with 8 separately-excited field coils, small alternator
  // OD ≈ 184 mm, air gap 3.0 mm at 54 mm radius
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap
  // Stator: m=3, p=8 (pole-count), Q=36, coilPitch=4, SPP=36/(3*8)=1.5
  // Rotor:  m=1, p=8 (pole-count), Q=8,  coilPitch=1, SPP=8/(1*8)=1
  const ROTOR_YOKE_R    = [0.022, 0.040];
  const ROTOR_POLES_R   = [0.040, 0.054];
  const STATOR_BORE_R   = [0.057, 0.074];
  const STATOR_YOKE_R   = [0.074, 0.092];

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.022, rOuter: 0.092, ell: 0.130 },
    poles: 8,
    mechanical: { J: 4e-3, damping: 3e-4, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "W",
        rRange: ROTOR_POLES_R,
        winding: { standard: { m: 1, p: 8, Q: 8, coilPitch: 1, turns: 80 } },
        slotRRange: ROTOR_POLES_R,
        slotFraction: 0.5,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 8, Q: 36, coilPitch: 4, turns: 30 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "CURRENT", amp: 12 },
        commutation: { mode: "none" },
        R: 2.0,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "wound-field-synchronous", label: "Wound-field synchronous 8p/36s", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
