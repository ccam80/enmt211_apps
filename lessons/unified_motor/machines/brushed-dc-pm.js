(function () {
  "use strict";

  // 4-pole 24-slot brushed DC with PM stator field, magnet arc ≈ 120°
  // Small-frame power-tool / wiper motor, OD ≈ 50 mm
  // Nr=22 ensures at least 2 grid cells across the 2.0 mm air gap

  const config = {
    grid: { Nr: 22, Ntheta: 256, rInner: 0.006, rOuter: 0.025, ell: 0.050 },
    poles: 4,
    mechanical: { J: 2e-5, damping: 5e-6, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.006, 0.013],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.013, 0.019],
            slotRRange: [0.013, 0.019],
            winding: {
              standard: {
                m: 1,
                p: 4,
                Q: 24,
                coilPitch: 6,
                turns: 15
              }
            },
            slotFraction: 0.55,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "outer",
        components: [
          {
            kind: "magnet",
            rRange: [0.021, 0.022],
            poles: 4,
            Mr: 800000,
            muR: 1000,
            alpha: 1
          },
          {
            kind: "iron",
            rRange: [0.022, 0.025],
            muR: 1000,
            alpha: 1
          }
        ]
      }
    ],
    circuits: [
      {
        terminal: { type: "DC", amp: 12 },
        commutation: { mode: "mechanical", poles: 4, conductionAngle: Math.PI / 2 },
        R: 0.8,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "brushed-dc-pm", label: "Brushed DC 4p/24s (PM field)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
