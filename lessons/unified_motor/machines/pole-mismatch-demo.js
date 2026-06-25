(function () {
  "use strict";


  const config = {
    grid: { Nr: 12, Ntheta: 256, rInner: 0.030, rOuter: 0.055, ell: 0.10 },
    poles: 4,
    mechanical: { J: 1e-4, damping: 1e-5, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.038, 0.043],
            teeth: 6,
            spanFraction: 0.5,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "outer",
        components: [
          {
            kind: "iron",
            rRange: [0.051, 0.055],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.047, 0.051],
            slotRRange: [0.047, 0.051],
            winding: {
              standard: {
                m: 3,
                p: 4,
                Q: 12,
                coilPitch: 3,
                turns: 40
              }
            },
            slotFraction: 0.5,
            muR: 1000,
            alpha: 1
          }
        ]
      }
    ],
    circuits: [
      {
        terminal: { type: "AC", amp: 24, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 0.5,
      },
      {
        terminal: { type: "AC", amp: 24, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 0.5,
      },
      {
        terminal: { type: "AC", amp: 24, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "electronic-sine", poles: 4 },
        R: 0.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "pole-mismatch-demo", label: "Pole mismatch (4-pole stator / 6-pole rotor)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
