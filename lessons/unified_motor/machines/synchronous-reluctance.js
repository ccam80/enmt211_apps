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

  const config = {
    grid: { Nr: 52, Ntheta: 512, rInner: 0.022, rOuter: 0.095, ell: 0.130 },
    poles: 4,
    mechanical: { J: 4e-3, damping: 3e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.022, 0.035],
            teeth: 1,
            spanFraction: 1,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.035, 0.044],
            teeth: 4,
            spanFraction: 0.6,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.044, 0.052],
            teeth: 4,
            spanFraction: 0.7,
            theta0: 0,
            muR: 1000,
            alpha: 1
          }
        ]
      },
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.052, 0.058],
            teeth: 4,
            spanFraction: 0.8,
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
            rRange: [0.078, 0.095],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.061, 0.078],
            slotRRange: [0.061, 0.078],
            winding: {
              standard: {
                m: 3,
                p: 4,
                Q: 36,
                coilPitch: 9,
                turns: 50
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
