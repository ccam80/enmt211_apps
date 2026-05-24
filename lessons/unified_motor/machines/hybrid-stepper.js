(function () {
  "use strict";

  const config = {
    grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 },
    poles: 4,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    rings: [
      {
        member: "rotor",
        element: "M",
        rRange: [0.038, 0.0405],
        magnets: 2,
        Mr: 8e5,
        backIron: false,
        muR: 1000,
      },
      {
        member: "rotor",
        element: "I",
        rRange: [0.0405, 0.043],
        teeth: 5,
        theta0: 0,
        spanFraction: 0.5,
        muR: 1000,
      },
      {
        member: "stator",
        element: "C",
        rRange: [0.047, 0.051],
        winding: { standard: { m: 2, p: 4, Q: 8, coilPitch: 1, turns: 40 } },
        slotRRange: [0.047, 0.051],
        slotFraction: 0.5,
        ironRRange: [0.051, 0.055],
        muR: 1000,
      },
    ],
    circuits: [
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 0, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 4, stepAngleElec: Math.PI / 2 },
        R: 0.6,
      },
      {
        terminal: { type: "STEP", amp: 24, phaseOffset: -Math.PI / 2 * 1, conductionAngle: Math.PI },
        commutation: { mode: "sequencer", poles: 4, stepAngleElec: Math.PI / 2 },
        R: 0.6,
      },
    ],
    stack: {
      slices: 2,
      sliceOffsets: [0, Math.PI / 5],
      fluxSources: [{ ringRef: 0, sliceSigns: [+1, -1] }],
    },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "hybrid-stepper", label: "Hybrid stepper", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
