(function () {
  "use strict";

  // 8-pole 48-slot integer-slot PMSM, m=3 q=2, surface magnets
  // OD=132 mm (servo class), air gap 2.0 mm at 42 mm radius
  // Nr=50 ensures at least 2 grid cells across the 2 mm air gap
  const ROTOR_YOKE_R    = [0.020, 0.035];
  const ROTOR_SURFACE_R = [0.035, 0.042];
  const STATOR_BORE_R   = [0.044, 0.058];
  const STATOR_YOKE_R   = [0.058, 0.066];

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.020, rOuter: 0.066, ell: 0.080 },
    poles: 8,
    mechanical: { J: 5e-4, damping: 1e-4, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: ROTOR_SURFACE_R,
        magnets: 8,
        Mr: 9e5,
        backIron: true,
        backIronRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 8, Q: 48, coilPitch: 6, turns: 20 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "AC", amp: 48, freq: 0, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "electronic-sine", poles: 8 },
        R: 0.3,
      },
      {
        terminal: { type: "AC", amp: 48, freq: 0, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "electronic-sine", poles: 8 },
        R: 0.3,
      },
      {
        terminal: { type: "AC", amp: 48, freq: 0, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "electronic-sine", poles: 8 },
        R: 0.3,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "pmsm", label: "PMSM 8p/48s (sinusoidal)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
