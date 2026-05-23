"use strict";

// =============================================================================
//  LIB.Type — viewport-aware font scale for canvas overlays + HTML chrome.
//
//  The shell calls LIB.Type.scale({W, H, viewportMin}) once per frame and
//  attaches the result to layout L (as `L.type`) and to LIB.Type.current so
//  primitives in lib/draw.js, lib/plot.js etc. can read consistent sizes
//  without each lesson hard-coding pixel values.
//
//  The scale grows linearly with min(W, H, viewportMin) and is clamped so a
//  postage-stamp canvas still produces legible labels and a giant projector
//  view doesn't blow text up to silliness.
//
//  Returned tokens:
//    sm        — axis ticks, position labels, sub-rule annotations
//    md        — body labels, motor labels, slider tip text equivalent
//    lg        — plot titles, callouts above the load
//    title     — title-strength callouts (J_load,refl etc.)
//    arrow     — text on stacked force-arrow rows
//    plotTitle — top-left title in a plot pane
//    plotTick  — y-axis tick labels in a plot pane
//
//  Each is a plain number (px). Pair with `${n}px` in font strings.
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function scale(opts) {
    opts = opts || {};
    const W = +opts.W || 0;
    const H = +opts.H || 0;
    const viewportMin = +opts.viewportMin || 0;

    // The reference dim: smallest of canvas dims and viewport-min. The
    // viewport cap stops a tall narrow canvas from growing fonts beyond what
    // the surrounding page can actually accommodate.
    let ref = Math.min(W || Infinity, H || Infinity);
    if (viewportMin > 0) ref = Math.min(ref, viewportMin);
    if (!Number.isFinite(ref) || ref < 1) ref = 600;

    // Empirically: ~16 px at 600 px ref, ~26 px at 1200 px ref. Floor 14
    // (smallest legible at iframe scale), ceiling 32 (projector wall).
    const md = Math.max(14, Math.min(32, Math.round(ref * 0.026)));
    const sm = Math.max(12, md - 2);
    const lg = md + 4;

    const T = {
      sm,
      md,
      lg,
      title:     md + 6,
      arrow:     md + 1,
      plotTitle: md + 1,
      plotTick:  Math.max(12, md - 1),
    };
    return T;
  }

  // The shell rewrites LIB.Type.current at the top of every frame. Primitives
  // in lib/draw.js read it as the default font size when the caller does not
  // pass an explicit opts.fontSize, so canvas text matches the live canvas
  // dimensions without each renderer hand-tuning numbers.
  LIB.Type = {
    scale,
    current: scale({ W: 800, H: 600 }),
  };
})();
