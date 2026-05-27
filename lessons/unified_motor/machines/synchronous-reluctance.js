(function () {
  "use strict";

  // Synchronous reluctance motor: 4 poles, 36 stator slots, multi-barrier rotor
  // Industrial scale, OD ≈ 190 mm, air gap 3.0 mm at 58 mm radius
  // Nr=52 ensures at least 2 grid cells across the 3 mm air gap
  //
  // Flux-barrier rotor approximation: multiple radially stacked I-rings.
  // Alternating iron-rich spans and narrow spans (low spanFraction) at each
  // radial layer approximate the d/q anisotropy of a multi-barrier rotor
  // without requiring a new element kind in the schema.
  const ROTOR_INNER_YOKE_R  = [0.022, 0.035];
  const ROTOR_BARRIER1_R    = [0.035, 0.044];
  const ROTOR_BARRIER2_R    = [0.044, 0.052];
  const ROTOR_SURFACE_R     = [0.052, 0.058];
  const STATOR_BORE_R       = [0.061, 0.078];
  const STATOR_YOKE_R       = [0.078, 0.095];

  const config = {
    grid: { Nr: 52, Ntheta: 512, rInner: 0.022, rOuter: 0.095, ell: 0.130 },
    poles: 4,
    mechanical: { J: 4e-3, damping: 3e-4, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_INNER_YOKE_R,
        teeth: 1,
        theta0: 0,
        spanFraction: 1.0,
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_BARRIER1_R,
        teeth: 4,
        theta0: 0,
        spanFraction: 0.6,
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_BARRIER2_R,
        teeth: 4,
        theta0: 0,
        spanFraction: 0.7,
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: ROTOR_SURFACE_R,
        teeth: 4,
        theta0: 0,
        spanFraction: 0.8,
        muR: 1000,
      },
      {
        member: "stator",
        element: "W",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 3, p: 4, Q: 36, coilPitch: 9, turns: 50 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 1.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "synchronous-reluctance", label: "Synchronous reluctance 4p/36s (multi-barrier)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
