(function () {
  "use strict";

  // 4-pole 36-slot single-phase induction motor (cap-start)
  // Washing-machine scale, OD ≈ 180 mm, air gap 3.0 mm at 52 mm radius
  // Rotor: 28 squirrel-cage bars
  // Stator: 36 slots, main+aux 2-phase winding (m=2, p=4, Q=36, coilPitch=9)
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.020, rOuter: 0.090, ell: 0.120 },
    poles: 4,
    mechanical: { J: 2e-3, damping: 2e-4, loadTorque: 0, frictionTorque: 0.1 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.02, 0.04],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "cage",
            rRange: [0.04, 0.052],
            slotRRange: [0.04, 0.052],
            cage: {
              bars: 28
            },
            slotFraction: 0.45,
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
            rRange: [0.072, 0.09],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.055, 0.072],
            slotRRange: [0.055, 0.072],
            winding: {
              standard: {
                m: 2,
                p: 4,
                Q: 36,
                coilPitch: 9,
                turns: 80
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
