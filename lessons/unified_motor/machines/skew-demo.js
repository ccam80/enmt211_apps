(function () {
  "use strict";

  // Skew demo: 8-pole 48-slot PMSM with continuous skew over 1 stator slot pitch
  // 4 axial slices offset by 1/4 slot pitch each = 1 full slot pitch total skew
  // OD=132 mm (servo class) — same geometry as the PMSM fixture
  // Nr=50 ensures at least 2 grid cells across the 2 mm air gap
  const ROTOR_YOKE_R    = [0.020, 0.035];
  const ROTOR_SURFACE_R = [0.035, 0.042];
  const STATOR_BORE_R   = [0.044, 0.058];
  const STATOR_YOKE_R   = [0.058, 0.066];

  // 1 slot pitch = 2π/48 = π/24 rad; skew over 4 slices: offset = (π/24)/4 per slice
  const slotPitch = 2 * Math.PI / 48;
  const s = slotPitch / 4;

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
    stack: {
      slices: 4,
      sliceOffsets: [0, s, 2 * s, 3 * s],
      fluxSources: [],
    },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "skew-demo", label: "Skew demo 8p/48s (4 slices, 1-slot skew)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
