(function () {
  "use strict";

  // BLDC: 12-pole 18-slot fractional-slot concentrated winding (SPP=0.5)
  // High-torque inrunner, OD=124 mm (servo class), air gap 2.0 mm at 38 mm radius
  // 12p/18s: m=3 phases, p=12 (pole-count), Q=18, coilPitch=1, SPP=Q/(m*p)=0.5
  // Nr=48 ensures at least 2 grid cells across the 2 mm air gap

  const config = {
    grid: { Nr: 48, Ntheta: 512, rInner: 0.018, rOuter: 0.062, ell: 0.060 },
    poles: 12,
    mechanical: { J: 3e-4, damping: 8e-5, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "magnet",
            rRange: [0.03, 0.038],
            poles: 12,
            Mr: 950000,
            muR: 1000,
            alpha: 1
          },
          {
            kind: "iron",
            rRange: [0.018, 0.03],
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
            rRange: [0.052, 0.062],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "concentrated-winding",
            rRange: [0.04, 0.052],
            slotRRange: [0.04, 0.052],
            winding: {
              standard: {
                m: 3,
                p: 12,
                Q: 18,
                coilPitch: 1,
                turns: 30
              }
            },
            slotFraction: 0.55,
            muR: 1000,
            alpha: 1
          }
        ]
      }
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
