(function () {
  "use strict";

  // 4-pole 24-slot brushed DC with wound stator field (traction scale)
  // OD ≈ 216 mm, large frame, air gap 3.0 mm at 70 mm radius
  // Nr=56 ensures at least 2 grid cells across the 3 mm air gap

  const config = {
    grid: { Nr: 56, Ntheta: 384, rInner: 0.030, rOuter: 0.108, ell: 0.150 },
    poles: 4,
    mechanical: { J: 8e-3, damping: 5e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.03, 0.055],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.055, 0.07],
            slotRRange: [0.055, 0.07],
            winding: {
              standard: {
                m: 1,
                p: 4,
                Q: 24,
                coilPitch: 6,
                turns: 30
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
            kind: "iron",
            rRange: [0.09, 0.108],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.073, 0.09],
            slotRRange: [0.073, 0.09],
            winding: {
              standard: {
                m: 1,
                p: 4,
                Q: 8,
                coilPitch: 2,
                turns: 60
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
        terminal: { type: "DC", amp: 48 },
        commutation: { mode: "mechanical", poles: 4, conductionAngle: Math.PI / 2 },
        R: 0.5,
      },
      {
        terminal: { type: "DC", amp: 48 },
        commutation: { mode: "none" },
        R: 3.0,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "brushed-dc-wound", label: "Brushed DC 4p/24s (wound field)", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
