"use strict";

// =============================================================================
//  Shared fixtures and helpers for winding-model tests.
//  Not a test file — no .test.js suffix.
//
//  Loads the window global via the shim, then requires the winding-model lib
//  so it attaches to window.LIB. Re-exports assertClose from _assert.js.
// =============================================================================

require("../_shim.js");
require("../../lib/winding-model.js");

const { assertClose } = require("../_assert.js");

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

module.exports = { assertClose, seriesPhaseRouting, parallelPhaseRouting };
