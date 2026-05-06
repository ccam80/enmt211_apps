"use strict";

// =============================================================================
//  LIB.Layout — small, named layout factories for lesson canvases.
//
//  A layout is a frozen object holding canvas dimensions, an origin/scale, and
//  the world ↔ pixel transforms a lesson's renderer + pointer hit-tests share.
//  Lessons call one of the factories below at the top of `spec.render` (and
//  again inside `spec.onPointer` if needed) and use the returned object.
//
//  Three factories cover everything we currently render. Lessons pick one
//  explicitly — there is no polymorphic Layout type, because the relevant
//  fields differ enough that a single shape would carry dead/null members for
//  every type other than the active one.
//
//    LIB.Layout.linearTrack(W, H, opts)
//      Load on a finite x-range track. Used by motion-transmission lead-screw
//      / ball-screw / conveyor, PID-cart, three-carts, and the controltutorial
//      car/heli (axis: "vertical" for altitude-style mappings).
//      Returns: { axis, W, H, padX, padY, mToPx, usableLen, xToPx, pxToX,
//                 xMin, xMax,
//                 trackY  (axis: "horizontal", + usableW),
//                 trackX  (axis: "vertical",   + usableH) }
//      Options: { xMin = -0.6, xMax = +0.6, padX = 60, padY = 30,
//                 trackFrac = 0.55, axis: "horizontal" | "vertical" }
//      For axis: "vertical", xToPx returns pixel-Y (xMax → top, xMin → bottom)
//      so renderers can write `h` (altitude) with positive-up. The "track"
//      pixel column is `trackX = W * trackFrac`.
//
//    LIB.Layout.world2D(W, H, opts)
//      Generic top-down 2D world (rover, ball mill, anything Cartesian).
//      Returns: { W, H, originPx: {x, y}, scale,    // pixels per world unit
//                 toPx({x, y}), toWorld({px, py}) }
//      Options: { worldW, worldH,                   // world bbox to fit
//                 originX = "center", originY = "center",   // numeric or "center"
//                 padPx = 20,
//                 maxScale = Infinity }             // optional zoom cap
//      If only one of worldW/worldH is given, scale is chosen to fit that
//      dimension. If neither, scale defaults to 1 px/world-unit.
//
//    LIB.Layout.rotational(W, H, opts)
//      Lessons that draw a single body rotating around a fixed pivot
//      (motionapp wheels, pendulum, single-rotor demos). Returns:
//        { W, H, originPx: {x, y}, scale,
//          polar(r, theta), centerPx, toPx, toWorld }
//      `polar(r, theta) → {x, y}` returns canvas pixels at the given polar
//      offset from origin (theta = 0 points +x, +theta is CCW).
//      Options: { originX = "center", originY = "center",
//                 worldR,                          // world radius to fit
//                 padPx = 20,
//                 maxScale = Infinity }
//
//  Convention: pixel y increases downward (canvas convention). World y in
//  rotational uses the math convention (CCW from +x), so renderers using
//  these helpers can write θ in the natural direction without sign juggling.
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function resolveOrigin(spec, span) {
    if (spec === "center" || spec == null) return span / 2;
    return +spec;
  }

  function freeze(obj) {
    return Object.freeze(obj);
  }

  // ---------------------------------------------------------------------------
  //  linearTrack
  // ---------------------------------------------------------------------------

  function linearTrack(W, H, opts) {
    opts = opts || {};
    const xMin = (opts.xMin != null) ? +opts.xMin : -0.6;
    const xMax = (opts.xMax != null) ? +opts.xMax : +0.6;
    const padX = (opts.padX != null) ? +opts.padX : 60;
    const padY = (opts.padY != null) ? +opts.padY : 30;
    const trackFrac = (opts.trackFrac != null) ? +opts.trackFrac : 0.55;
    const axis = (opts.axis === "vertical") ? "vertical" : "horizontal";

    if (axis === "horizontal") {
      const usableW = Math.max(1, W - padX * 2);
      const span    = Math.max(1e-9, xMax - xMin);
      const mToPx   = usableW / span;
      const trackY  = H * trackFrac;
      function xToPx(xm) { return padX + (xm - xMin) * mToPx; }
      function pxToX(px) { return (px - padX) / mToPx + xMin; }
      return freeze({
        kind: "linearTrack", axis,
        W, H,
        padX, padY, trackY, usableW,
        usableLen: usableW,
        mToPx, xMin, xMax,
        xToPx, pxToX,
      });
    }

    // Vertical: DOF maps to pixel-Y. Larger DOF ⇒ smaller pixel-y (canvas
    // convention flipped to match the math/altitude convention so renderers
    // can write h with positive-up). The "track" is at trackX = W * trackFrac.
    const usableH = Math.max(1, H - padY * 2);
    const span    = Math.max(1e-9, xMax - xMin);
    const mToPx   = usableH / span;
    const trackX  = W * trackFrac;
    function xToPx(xm) { return padY + (xMax - xm) * mToPx; }
    function pxToX(py) { return xMax - (py - padY) / mToPx; }
    return freeze({
      kind: "linearTrack", axis,
      W, H,
      padX, padY, trackX, usableH,
      usableLen: usableH,
      mToPx, xMin, xMax,
      xToPx, pxToX,
    });
  }

  // ---------------------------------------------------------------------------
  //  world2D
  // ---------------------------------------------------------------------------

  function world2D(W, H, opts) {
    opts = opts || {};
    const padPx = (opts.padPx != null) ? +opts.padPx : 20;
    const worldW = +opts.worldW || 0;
    const worldH = +opts.worldH || 0;
    const maxScale = (opts.maxScale != null) ? +opts.maxScale : Infinity;

    let scale = 1;
    if (worldW > 0 && worldH > 0) {
      scale = Math.min((W - padPx * 2) / worldW, (H - padPx * 2) / worldH);
    } else if (worldW > 0) {
      scale = (W - padPx * 2) / worldW;
    } else if (worldH > 0) {
      scale = (H - padPx * 2) / worldH;
    }
    scale = Math.max(1e-9, Math.min(scale, maxScale));

    const originPx = {
      x: resolveOrigin(opts.originX, W),
      y: resolveOrigin(opts.originY, H),
    };

    function toPx(p) {
      return { px: originPx.x + p.x * scale,
               py: originPx.y - p.y * scale };
    }
    function toWorld(p) {
      return { x: (p.px - originPx.x) / scale,
               y: (originPx.y - p.py) / scale };
    }

    return freeze({
      kind: "world2D",
      W, H,
      originPx, scale,
      toPx, toWorld,
    });
  }

  // ---------------------------------------------------------------------------
  //  rotational
  // ---------------------------------------------------------------------------

  function rotational(W, H, opts) {
    opts = opts || {};
    const padPx = (opts.padPx != null) ? +opts.padPx : 20;
    const worldR = +opts.worldR || 0;
    const maxScale = (opts.maxScale != null) ? +opts.maxScale : Infinity;

    let scale = 1;
    if (worldR > 0) {
      const fitW = (W - padPx * 2) / (2 * worldR);
      const fitH = (H - padPx * 2) / (2 * worldR);
      scale = Math.min(fitW, fitH);
    }
    scale = Math.max(1e-9, Math.min(scale, maxScale));

    const originPx = {
      x: resolveOrigin(opts.originX, W),
      y: resolveOrigin(opts.originY, H),
    };

    function toPx(p) {
      return { px: originPx.x + p.x * scale,
               py: originPx.y - p.y * scale };
    }
    function toWorld(p) {
      return { x: (p.px - originPx.x) / scale,
               y: (originPx.y - p.py) / scale };
    }
    function polar(r, theta) {
      return { px: originPx.x + Math.cos(theta) * r * scale,
               py: originPx.y - Math.sin(theta) * r * scale };
    }
    const centerPx = freeze({ x: originPx.x, y: originPx.y });

    return freeze({
      kind: "rotational",
      W, H,
      originPx, scale,
      toPx, toWorld, polar, centerPx,
    });
  }

  LIB.Layout = { linearTrack, world2D, rotational };
})();
