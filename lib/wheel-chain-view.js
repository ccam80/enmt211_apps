"use strict";

// =============================================================================
//  LIB.WheelChainView — shared per-frame view + pointer helpers for any
//  rotational lesson built on LIB.WheelChain. Pulls the per-lesson
//  buildView/hitTestWheel/pointerAngleFor/wheelColor boilerplate that used to
//  be hand-rolled in every rotational *.js into one place.
//
//  Public surface:
//
//    LIB.WheelChainView.color(i)
//        Per-wheel CSS-var colour (--w0..--w7, cycled).
//
//    LIB.WheelChainView.buildView(L, wheels, mode, opts?)
//        Lays the chain into canvas pixels and returns
//          { centers: [{cx, cy, rPx, r1Px, r2Px}], scale, mode }
//        opts: { padPx = 24, beltGap = 0 }
//
//    LIB.WheelChainView.hitTestWheel(view, wheels, mode, mx, my, opts?)
//        Returns the wheel index under (mx, my), or -1. The hit radius is
//        outerR(mode) for compound assemblies, plain r otherwise, plus pad.
//        opts: { pad = 6, minR = 6 }
//
//    LIB.WheelChainView.pointerAngleFor(view, i, mx, my)
//        Math-CCW pointer angle relative to wheel i's centre.
//
//  Dependencies: lib/util.js (getVar), lib/wheel-chain.js (layout math).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util)       throw new Error("LIB.WheelChainView requires lib/util.js");
  if (!LIB.WheelChain) throw new Error("LIB.WheelChainView requires lib/wheel-chain.js");

  function color(i) {
    return LIB.Util.getVar(`--w${i % 8}`);
  }

  function buildView(L, wheels, mode, opts) {
    opts = opts || {};
    // padPx covers the wheel-disc clearance to the canvas edge.
    // padYExtra reserves additional vertical room for the per-wheel labels
    // (drawWheel paints "#i (drive)", omega, tau above and below the disc).
    // Bumped from 24 to 40 so wheel labels never clip on the rotational
    // belt-and-pulley canvas.
    const padPx     = (opts.padPx     != null) ? +opts.padPx     : 40;
    const padYExtra = (opts.padYExtra != null) ? +opts.padYExtra : 36;
    const beltGap = +opts.beltGap || 0;
    const layout  = LIB.WheelChain.layoutCenters(wheels, mode, beltGap);

    let xMin = +Infinity, xMax = -Infinity, rMax = 0;
    for (let i = 0; i < wheels.length; i++) {
      const oR = LIB.WheelChain.outerR(wheels[i], mode, i);
      if (oR > rMax) rMax = oR;
      xMin = Math.min(xMin, layout[i].cx - oR);
      xMax = Math.max(xMax, layout[i].cx + oR);
    }
    const usableW = L.W - padPx * 2;
    const usableH = L.H - padPx * 2 - padYExtra * 2;
    const worldW  = (xMax - xMin) || 1;
    const worldH  = (2 * rMax)    || 1;
    const scale   = Math.min(usableW / worldW, usableH / worldH);
    const originX = padPx + (usableW - worldW * scale) / 2 - xMin * scale;
    const originY = L.H / 2;
    const w2sX = (xm) => originX + xm * scale;
    const w2sY = (ym) => originY - ym * scale;
    const w2sR = (rm) => rm * scale;

    const centers = layout.map((c, i) => ({
      cx: w2sX(c.cx), cy: w2sY(c.cy),
      rPx:  w2sR(wheels[i].r),
      r1Px: w2sR(wheels[i].r1),
      r2Px: w2sR(wheels[i].r2),
    }));
    return { centers, scale, mode };
  }

  function hitTestWheel(view, wheels, mode, mx, my, opts) {
    opts = opts || {};
    const pad  = (opts.pad  != null) ? +opts.pad  : 6;
    const minR = (opts.minR != null) ? +opts.minR : 6;
    for (let i = 0; i < wheels.length; i++) {
      const c = view.centers[i];
      if (!c) continue;
      const d = Math.hypot(mx - c.cx, my - c.cy);
      const outerPx = LIB.WheelChain.isCompound(mode, i)
        ? Math.max(c.r1Px, c.r2Px) : c.rPx;
      if (d <= outerPx + pad && d >= minR) return i;
    }
    return -1;
  }

  function pointerAngleFor(view, i, mx, my) {
    const c = view.centers[i];
    return Math.atan2(-(my - c.cy), mx - c.cx);
  }

  LIB.WheelChainView = { color, buildView, hitTestWheel, pointerAngleFor };
})();
