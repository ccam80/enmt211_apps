"use strict";

// =============================================================================
//  LIB.EndStop — bumper-spring force at travel limits.
//
//  Replaces a hard-clamp (v=0) end-stop with a stiff but finite spring +
//  damper, modelled exactly like the pidapp bumper. Returns a force to add
//  into the load's equation of motion (m·ẍ).
//
//  Use a stiff k (≈ 5000 N/m for ~30 mm compression at typical loads) and
//  moderate damping (≈ 50 N·s/m) for solid-but-not-rigid wall feel. Zero deps.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.EndStop = {
    force(x, v, xMin, xMax, kBump, cBump) {
      let F = 0;
      if (x < xMin) {
        const pen = xMin - x;
        F += kBump * pen;
        if (v < 0) F -= cBump * v;
      }
      if (x > xMax) {
        const pen = x - xMax;
        F -= kBump * pen;
        if (v > 0) F -= cBump * v;
      }
      return F;
    },
  };
})();
