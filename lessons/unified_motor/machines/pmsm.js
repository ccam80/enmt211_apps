(function () {
  "use strict";

  // 8-pole 48-slot integer-slot PMSM, m=3 q=2, surface magnets
  // OD=132 mm (servo class), air gap 2.0 mm at 42 mm radius
  // Nr=50 ensures at least 2 grid cells across the 2 mm air gap

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.020, rOuter: 0.066, ell: 0.080 },
    poles: 8,
    mechanical: { J: 5e-4, damping: 1e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "magnet",
            rRange: [0.035, 0.042],
            poles: 8,
            Mr: 900000,
            muR: 1000,
            alpha: 1
          },
          {
            kind: "iron",
            rRange: [0.02, 0.035],
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
            rRange: [0.058, 0.066],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.044, 0.058],
            slotRRange: [0.044, 0.058],
            winding: {
              standard: {
                m: 3,
                p: 8,
                Q: 48,
                coilPitch: 6,
                turns: 20
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
