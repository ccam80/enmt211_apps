"use strict";

// =============================================================================
//  Shared fixtures and helpers for winding-model and motor-compile tests.
//  Not a test file — no .test.js suffix.
//
//  Loads the window global via the Phase-1 shim, then requires the Phase-2
//  lib files so they attach to window.LIB. Re-exports assertClose from the
//  Phase-1 engine fixtures.
// =============================================================================

require("../_shim.js");
require("../../lib/winding-model.js");
require("../../lib/motor-compile.js");

const { assertClose } = require("../engine/_fixtures.js");

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  seriesPhaseRouting() → routing
//
//  nSlots = 6, one phase, one branch, two series coils:
//    {slotGo:0, slotReturn:3, turns:10}
//    {slotGo:1, slotReturn:4, turns:10}
//  slotTheta[s] = s * 2π / 6
// ---------------------------------------------------------------------------
function seriesPhaseRouting() {
  const nSlots = 6;
  const slotTheta = [];
  for (let s = 0; s < nSlots; s++) slotTheta.push(s * TWO_PI / nSlots);

  return {
    nSlots,
    slotTheta,
    phases: [
      {
        id: "A",
        branches: [
          {
            coils: [
              { slotGo: 0, slotReturn: 3, turns: 10 },
              { slotGo: 1, slotReturn: 4, turns: 10 },
            ],
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
//  parallelPhaseRouting() → routing
//
//  Same two coils split into two parallel branches under one phase.
//  nSlots = 6, slotTheta[s] = s * 2π / 6
// ---------------------------------------------------------------------------
function parallelPhaseRouting() {
  const nSlots = 6;
  const slotTheta = [];
  for (let s = 0; s < nSlots; s++) slotTheta.push(s * TWO_PI / nSlots);

  return {
    nSlots,
    slotTheta,
    phases: [
      {
        id: "A",
        branches: [
          { coils: [{ slotGo: 0, slotReturn: 3, turns: 10 }] },
          { coils: [{ slotGo: 1, slotReturn: 4, turns: 10 }] },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
//  compileSection({ withMagnet=true, withIron=true }) → section
//
//  Small section for motor-compile tests:
//    grid = { Nr:4, Ntheta:12, rInner:0.04, rOuter:0.05, ell:0.1 }
//    gapBand = { iInner:1, iOuter:2 }
//  One conductor feature (circuit:0, turns:5, member:"stator",
//    rRange:[0.045,0.05], thetaRange:[0, π/6])
//  Optional magnet feature on rotor (rRange:[0.04,0.043], thetaRange:[0,π],
//    Mr:1e5, Mtheta:0)
//  Optional iron feature on rotor (rRange:[0.04,0.043], thetaRange:[π,2π],
//    muR:1000, member:"rotor")
// ---------------------------------------------------------------------------
function compileSection({ withMagnet = true, withIron = true } = {}) {
  const grid = { Nr: 4, Ntheta: 12, rInner: 0.04, rOuter: 0.05, ell: 0.1 };
  const gapBand = { iInner: 1, iOuter: 2 };

  const features = [
    {
      kind: "conductor",
      member: "stator",
      rRange: [0.045, 0.05],
      thetaRange: [0, Math.PI / 6],
      circuit: 0,
      turns: 5,
    },
  ];

  if (withMagnet) {
    features.push({
      kind: "magnet",
      member: "rotor",
      rRange: [0.04, 0.043],
      thetaRange: [0, Math.PI],
      Mr: 1e5,
      Mtheta: 0,
    });
  }

  if (withIron) {
    features.push({
      kind: "iron",
      member: "rotor",
      rRange: [0.04, 0.043],
      thetaRange: [Math.PI, 2 * Math.PI],
      muR: 1000,
    });
  }

  return { grid, gapBand, features };
}

module.exports = { assertClose, seriesPhaseRouting, parallelPhaseRouting, compileSection };
