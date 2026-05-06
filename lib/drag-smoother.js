"use strict";

// =============================================================================
//  LIB.DragSmoother — moving-window velocity differentiator.
//
//  Pointer events arrive at ~60 Hz; physics runs at 120-240 Hz. Per-step Δx
//  is bursty — divide by the step dt and you get jitter that swamps the real
//  pointer velocity. A short trailing window averages this out.
//
//  windowSec defaults to 20 ms for tactile, low-lag drag. Increase to ~80 ms
//  if the lesson tolerates lag (e.g. heavy rotational chains).
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.DragSmoother = class {
    constructor(windowSec = 0.02) {
      this.windowSec = windowSec;
      this.history = [];
    }
    reset() { this.history.length = 0; }
    push(dt, delta) {
      this.history.push({ dt, dx: delta });
      let sumDt = 0, slice = 0;
      for (let k = this.history.length - 1; k >= 0; k--) {
        sumDt += this.history[k].dt;
        if (sumDt >= this.windowSec) { slice = k; break; }
      }
      if (slice > 0) this.history.splice(0, slice);
    }
    velocity() {
      let sumDt = 0, sumDx = 0;
      for (const e of this.history) { sumDt += e.dt; sumDx += e.dx; }
      return sumDt > 1e-9 ? sumDx / sumDt : 0;
    }
  };
})();
