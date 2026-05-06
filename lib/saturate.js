"use strict";

// =============================================================================
//  LIB.Saturate — postStep helpers for hard-wall position limits.
//
//  Most lessons that don't use a soft end-stop spring (LIB.EndStop.force inside
//  dxdt) instead hard-clamp position in postStep and zero the corresponding
//  velocity component. This is mathematically crude but visually fine for
//  vehicle-on-canvas lessons (car wall, heli ground/ceiling, rover world box)
//  where the wall isn't the pedagogical subject. Each handler is one line per
//  axis — eight lines tend to get re-typed verbatim across lessons. These
//  helpers absorb that repetition.
//
//  Use LIB.EndStop.force when the wall ITSELF is what the lesson is teaching
//  (lead-screw bumper). Use LIB.Saturate when the wall is just "stop the
//  visual from drifting off-canvas".
//
//   box1D(state, posKey, lo, hi, velKey?)
//     If state[posKey] < lo → state[posKey] = lo and zero state[velKey] iff
//     it points further into the wall. Same for the high side. velKey is
//     optional — omit for purely-position DOFs.
//   box2D(state, posKey, axisKey, halfA, halfB, velKey?)
//     Two-axis convenience. axisKey is the "y" key, posKey the "x" key.
//
//  Zero deps.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function box1D(state, posKey, lo, hi, velKey) {
    const x = +state[posKey];
    if (x < lo) {
      state[posKey] = lo;
      if (velKey && state[velKey] < 0) state[velKey] = 0;
    } else if (x > hi) {
      state[posKey] = hi;
      if (velKey && state[velKey] > 0) state[velKey] = 0;
    }
  }

  function box2D(state, xKey, yKey, halfX, halfY, vxKey, vyKey) {
    box1D(state, xKey, -halfX, +halfX, vxKey);
    box1D(state, yKey, -halfY, +halfY, vyKey);
  }

  LIB.Saturate = { box1D, box2D };
})();
