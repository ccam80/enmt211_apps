(function () {
  "use strict";

  // PM stepper (can-stack style), 24 poles (12 pole-pairs), Q=12 slots, small frame
  // OD ≈ 42 mm (NEMA 17 / canstack), air gap at ~14 mm radius
  // m=2 phases, p=12 (pole-count), Q=12, coilPitch=1, SPP=Q/(m*p)=0.5
  const ROTOR_YOKE_R    = [0.005, 0.010];
  const ROTOR_SURFACE_R = [0.010, 0.014];
  const STATOR_BORE_R   = [0.016, 0.024];
  const STATOR_YOKE_R   = [0.024, 0.028];

  const config = {
    grid: { Nr: 14, Ntheta: 384, rInner: 0.005, rOuter: 0.028, ell: 0.030 },
    poles: 24,
    mechanical: { J: 8e-6, damping: 5e-6, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: ROTOR_SURFACE_R,
        magnets: 24,
        Mr: 7e5,
        backIron: true,
        backIronRRange: ROTOR_YOKE_R,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: STATOR_BORE_R,
        winding: { standard: { m: 2, p: 12, Q: 12, coilPitch: 1, turns: 100 } },
        slotRRange: STATOR_BORE_R,
        slotFraction: 0.5,
        ironRRange: STATOR_YOKE_R,
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "STEP", amp: 12, phaseOffset: -Math.PI / 2 * 0, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 24, stepAngleElec: Math.PI / 2 },
        R: 8.0,
      },
      {
        terminal: { type: "STEP", amp: 12, phaseOffset: -Math.PI / 2 * 1, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 24, stepAngleElec: Math.PI / 2 },
        R: 8.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "pm-stepper", label: "PM stepper 24p/12s (can-stack)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
