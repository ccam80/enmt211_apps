"use strict";

// =============================================================================
//  LIB.HoldDetector — "did the student hold the system steady for N seconds?"
//
//  Lessons that ask the student to bring a controlled state into a tolerance
//  band and keep it there create a detector with a metric callback that
//  returns the current absolute error and an error scale, plus a tolerance
//  fraction (default 2 %) and a duration (default 10 s). They call .step(dt)
//  every physics tick and read .inBand / .controlled / .remaining for UI.
//
//   create({ thresholdFrac=0.02, durationS=10, metric })
//      metric(state, params) → { error, scale }
//      Returns a detector with:
//        step(dt, state, params)   advance the timer with the latest sample
//        reset()                   clear inBand / bandT / controlled
//        inBand                    boolean — currently inside the band
//        bandT                     seconds accumulated inside band this run
//        controlled                latched once bandT >= durationS;
//                                  un-latches the moment inBand goes false
//        remaining                 max(0, durationS − bandT)
//        thresholdFrac, durationS  echo back the constructor opts
//
//  Lessons render the badge themselves — typical patterns are
//  LIB.Draw.holdBadge(ctx, W, H, detector) drawn inside spec.render after
//  the scene, plus a "controlled!" border drawn around the canvas.
//
//  Zero dependencies (no LIB.Util needed).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function create(opts) {
    if (!opts || typeof opts.metric !== "function") {
      throw new Error("LIB.HoldDetector.create: opts.metric() is required");
    }
    const thresholdFrac = (opts.thresholdFrac != null) ? +opts.thresholdFrac : 0.02;
    const durationS     = (opts.durationS     != null) ? +opts.durationS     : 10;
    const metric        = opts.metric;

    let inBand = false, bandT = 0, controlled = false;

    return {
      step(dt, state, params) {
        const m = metric(state, params) || {};
        const err   = +m.error;
        const scale = +m.scale;
        const next = Number.isFinite(err) && Number.isFinite(scale)
                  && Math.abs(err) <= scale * thresholdFrac;
        if (next) {
          if (!inBand) { inBand = true; bandT = 0; controlled = false; }
          bandT += dt;
          if (bandT >= durationS) controlled = true;
        } else {
          inBand = false; bandT = 0; controlled = false;
        }
      },
      reset() { inBand = false; bandT = 0; controlled = false; },
      get inBand()     { return inBand; },
      get bandT()      { return bandT; },
      get controlled() { return controlled; },
      get remaining()  { return Math.max(0, durationS - bandT); },
      thresholdFrac, durationS,
    };
  }

  LIB.HoldDetector = { create };
})();
