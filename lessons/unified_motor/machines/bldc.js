(function () {
  "use strict";

  // BLDC: 12-pole 18-slot fractional-slot concentrated winding (SPP=0.5)
  // High-torque inrunner, OD=124 mm (servo class), air gap 2.0 mm at 38 mm radius
  // 12p/18s is a canonical high-pole-count BLDC topology (fractional-slot, m=3, p=6)
  // Nr=48 ensures at least 2 grid cells across the 2 mm air gap
  const ROTOR_YOKE_R    = [0.018, 0.030];
  const ROTOR_SURFACE_R = [0.030, 0.038];
  const STATOR_BORE_R   = [0.040, 0.052];
  const STATOR_YOKE_R   = [0.052, 0.062];

  const config = {
    grid: { Nr: 48, Ntheta: 512, rInner: 0.018, rOuter: 0.062, ell: 0.060 },
    poles: 12,
    mechanical: { J: 3e-4, damping: 8e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: ROTOR_SURFACE_R,
        magnets: 12,
        Mr: 9.5e5,
        backIron: true,
        backIronRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 6, Q: 18, coilPitch: 1, turns: 30 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.55,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "PULSE", amp: 48, phaseOffset: -2 * Math.PI * 0 / 3, conductionAngle: 2 * Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 12 },
        R: 0.2,
      },
      {
        terminal: { type: "PULSE", amp: 48, phaseOffset: -2 * Math.PI * 1 / 3, conductionAngle: 2 * Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 12 },
        R: 0.2,
      },
      {
        terminal: { type: "PULSE", amp: 48, phaseOffset: -2 * Math.PI * 2 / 3, conductionAngle: 2 * Math.PI / 3 },
        commutation: { mode: "electronic-trap", poles: 12 },
        R: 0.2,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "bldc", label: "BLDC 12p/18s (trapezoidal)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
