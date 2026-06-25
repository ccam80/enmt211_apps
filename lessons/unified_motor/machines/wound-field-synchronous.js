(function () {
  "use strict";

  // Wound-field synchronous motor/alternator: 8 poles (4 pole-pairs), 36 stator slots
  // Salient rotor with 8 separately-excited field coils, small alternator
  // OD ≈ 184 mm, air gap 3.0 mm at 54 mm radius
  // Nr=50 ensures at least 2 grid cells across the 3 mm air gap
  // Stator: m=3, p=8 (pole-count), Q=36, coilPitch=4, SPP=36/(3*8)=1.5
  // Rotor:  m=1, p=8 (pole-count), Q=8,  coilPitch=1, SPP=8/(1*8)=1

  const config = {
    grid: { Nr: 50, Ntheta: 512, rInner: 0.022, rOuter: 0.092, ell: 0.130 },
    poles: 8,
    // J is the rotor plus its coupled load. A line-fed synchronous machine only
    // fails to self-start when its inertia is large enough that the rotor cannot
    // reach synchronous speed within a torque half-cycle; below that it pulls into
    // step from rest. 0.4 kg·m² keeps this machine firmly non-self-starting (mean
    // speed from rest stays «1% of synchronous), against its ~76 N·m peak torque.
    mechanical: { J: 0.4, damping: 3e-4, loadTorque: 0 },
    motion: { inner: "rotating", outer: "static" },
    rings: [
      {
        member: "inner",
        components: [
          {
            kind: "iron",
            rRange: [0.022, 0.04],
            muR: 1000,
            alpha: 1
          },
          {
            kind: "distributed-winding",
            rRange: [0.04, 0.054],
            slotRRange: [0.04, 0.054],
            winding: {
              standard: {
                m: 1,
                p: 8,
                Q: 8,
                coilPitch: 1,
                turns: 80
              }
            },
            slotFraction: 0.5,
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
                p: 8,
                Q: 36,
                coilPitch: 4,
                turns: 30
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
        terminal: { type: "CURRENT", amp: 12 },
        commutation: { mode: "none" },
        R: 2.0,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 0 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 1 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
      {
        terminal: { type: "AC", amp: 230, freq: 50, phaseOffset: -2 * Math.PI * 2 / 3 },
        commutation: { mode: "none" },
        R: 1.5,
      },
    ],
    stack: { slices: 1, sliceOffsets: [0], fluxSources: [] },
  };

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  (UM.MACHINES || (UM.MACHINES = [])).push({ id: "wound-field-synchronous", label: "Wound-field synchronous 8p/36s", config });
  if (!UM.defaultConfig) UM.defaultConfig = config;
})();
