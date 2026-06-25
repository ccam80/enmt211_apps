(function () {
  "use strict";

  // 4-pole 36-slot three-phase induction motor, m=3 q=3, 28 rotor bars
  // Small industrial, OD ≈ 184 mm, air gap 3.0 mm at 54 mm radius
  // Rotor: 28 squirrel-cage bars
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.022, rOuter: 0.092, ell: 0.130 },
    poles: 4,
    mechanical: { J: 3e-3, damping: 3e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.022, 0.042],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "cage",
            rRange: [0.042, 0.054],
            slotRRange: [0.042, 0.054],
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
            rRange: [0.074, 0.092],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.057, 0.074],
            slotRRange: [0.057, 0.074],
            winding: {
              standard: {
                m: 3,
                p: 4,
                Q: 36,
                coilPitch: 9,
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
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "none" },
        R: 2.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "induction-3ph", label: "3-φ induction 4p/36s", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
