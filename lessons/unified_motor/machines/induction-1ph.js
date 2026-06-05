(function () {
  "use strict";

  // 4-pole 36-slot single-phase induction motor (cap-start)
  // Washing-machine scale, OD ≈ 180 mm, air gap 3.0 mm at 52 mm radius
  // Rotor: 28 squirrel-cage bars
  // Stator: 36 slots, main+aux 2-phase winding (m=2, p=4, Q=36, coilPitch=9)
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap
  const ROTOR_YOKE_R    = [0.020, 0.040];
  const ROTOR_BAR_R     = [0.040, 0.052];
  const STATOR_BORE_R   = [0.055, 0.072];
  const STATOR_YOKE_R   = [0.072, 0.090];

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.020, rOuter: 0.090, ell: 0.120 },
    poles: 4,
    mechanical: { J: 2e-3, damping: 2e-4, loadTorque: 0, frictionTorque: 0.1 },
    rings: [
      {
        member: "rotor",
        element: "K",
        rRange: ROTOR_BAR_R,
        // Bar resistance R_b is GEOMETRY-DERIVED by config-schema (ρ_Al·ell/A_bar
        // ≈ 6.0e-5 Ω here); the R: 0.03 on the SHORT bar circuits below is a
        // vestigial placeholder, overridden by the derived value. (cage.rho or
        // cage.Rb override the default aluminium derivation.)
        cage: { bars: 28 },
        slotRRange: ROTOR_BAR_R,
        slotFraction: 0.45,
        ironRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 2, p: 4, Q: 36, coilPitch: 9, turns: 80 } },
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
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      { terminal: { type: "SHORT" }, commutation: { mode: "none" }, R: 0.03 },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: 0 },
        commutation: { mode: "none" },
        R: 3.0,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: Math.PI / 2 },
        commutation: { mode: "none" },
        R: 5.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "induction-1ph", label: "1-φ induction 4p/36s (cap-start)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
