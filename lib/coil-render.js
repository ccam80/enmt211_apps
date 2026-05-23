"use strict";

// =============================================================================
//  LIB.CoilRender — coil/conductor rendering for AC-motor lessons.
//
//  Two visual jobs:
//
//    1. Stroke the conductor wire as a 3D polyline projected to screen,
//       optionally tinted by terminal voltage (green +ve, red −ve, neutral 0).
//    2. Animate evenly-spaced bright-yellow dots travelling along the
//       conductor, with velocity (and direction) proportional to the
//       instantaneous current.
//
//  Public surface:
//
//    LIB.CoilRender.voltageColor(v, vMax) → "#rrggbb"
//      Diverging gradient: positive → green ("--good"), negative → red
//      ("--cP"), zero → muted ink. Saturates at ±vMax.
//
//    LIB.CoilRender.drawConductor3D(ctx, L3, points, opts)
//      Stroke a 3D polyline through `points` (array of {x,y,z}) projected
//      via the LIB.Layout3D handle. opts:
//        color           explicit colour (overrides voltageMode)
//        voltage         signed scalar (used when voltageMode is true)
//        vMax            saturation magnitude for voltageColor
//        voltageMode     bool — when true, derive stroke colour from voltage
//        lineWidth       px (default 2.5)
//        alpha           globalAlpha (default 1)
//        closed          bool — when true, append the first point at the end
//        outlineColor    optional dim halo stroke painted underneath
//        outlineWidthAdd extra px on the halo (default 3)
//
//    LIB.CoilRender.drawLoopWire(ctx, L3, loop, opts)
//      Convenience for circular loops — samples K points around the loop and
//      hands off to drawConductor3D. K defaults to 64 for smooth circles.
//
//    LIB.CoilRender.drawCurrentDots3D(ctx, L3, points, current, phaseRef, opts)
//      Draw `dotCount` dots evenly spaced along the polyline's arc length,
//      offset by phaseRef.phase ∈ [0, 1). Phase advances by
//        Δphase = sign(current) · gain · |current| · dt
//      mod 1 each call, so dots flow in the current's direction at a rate
//      that is visibly tied to its magnitude. The arc-length parameterisation
//      means dots travel at uniform on-screen speed even for non-uniform
//      polylines (e.g. a slot-and-end-turn winding).
//
//      opts:
//        dotCount        default 8
//        dotSize         px at depth=1 (default 4); scaled by 1/depth
//        dotColor        default "#ffd54a"
//        outlineColor    default "rgba(0,0,0,0.55)" — halo to lift dots off the wire
//        gain            phase units per (current · second) (default 0.4)
//        dt              physics dt (s); the lesson supplies it (default 1/60)
//        closed          bool (default true) — wraps phase across the seam
//        minSpeed        floor on |Δphase| so dots still creep when current is small (default 0)
//        maxScreenSize   clamp dot pixel size after depth scaling (default 8)
//
//    LIB.CoilRender.drawLoopCurrentDots(ctx, L3, loop, current, phaseRef, opts)
//      Convenience for circular loops. Internally calls pointOnLoop at evenly-
//      spaced phases — no polyline allocation, much cheaper than sampling +
//      drawCurrentDots3D when you have a circle.
//
//  Dependencies: lib/util.js, lib/layout3d.js, lib/em-physics.js.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util)     throw new Error("LIB.CoilRender requires lib/util.js");
  if (!LIB.Layout3D) throw new Error("LIB.CoilRender requires lib/layout3d.js");
  if (!LIB.EM)       throw new Error("LIB.CoilRender requires lib/em-physics.js");

  // ---------------------------------------------------------------------------
  //  voltageColor — diverging green/grey/red gradient
  // ---------------------------------------------------------------------------

  function voltageColor(v, vMax) {
    const ref = (vMax != null && +vMax > 0) ? +vMax : 1;
    const t = Math.max(-1, Math.min(1, v / ref));
    // Vivid palette so the swing reads even at thin line widths against the
    // dark canvas background. Pale-grey midpoint, saturated green at +max,
    // saturated red at −max. Theme tokens were too pastel — they blended
    // into the wire's outline halo.
    const mid = "#cdd4e0";
    const pos = "#00e676";   // material green A400
    const neg = "#ff5252";   // material red A200
    if (t >= 0) return LIB.Util.lerpColor(mid, pos, t);
    return LIB.Util.lerpColor(mid, neg, -t);
  }

  // ---------------------------------------------------------------------------
  //  drawConductor3D — polyline projection with optional voltage tint
  // ---------------------------------------------------------------------------

  function strokePolyline(ctx, L3, points, closed) {
    let started = false, prevBehind = true;
    ctx.beginPath();
    for (const p of points) {
      const sp = L3.project(p);
      if (sp.behind) { prevBehind = true; continue; }
      if (!started || prevBehind) { ctx.moveTo(sp.px, sp.py); started = true; }
      else                        { ctx.lineTo(sp.px, sp.py); }
      prevBehind = false;
    }
    if (closed && started && points.length > 0) {
      const sp0 = L3.project(points[0]);
      if (!sp0.behind) ctx.lineTo(sp0.px, sp0.py);
    }
    ctx.stroke();
  }

  function drawConductor3D(ctx, L3, points, opts) {
    opts = opts || {};
    if (!points || points.length < 2) return;

    let stroke;
    if (opts.color)             stroke = opts.color;
    else if (opts.voltageMode)  stroke = voltageColor(+opts.voltage || 0, opts.vMax);
    else                        stroke = LIB.Util.getVar("--ink") || "#e6e9ef";

    const lineWidth = (opts.lineWidth != null) ? +opts.lineWidth : 2.5;
    const alpha     = (opts.alpha     != null) ? +opts.alpha     : 1;
    const closed    = !!opts.closed;

    ctx.save();
    ctx.globalAlpha = alpha;

    if (opts.outlineColor) {
      const halo = (opts.outlineWidthAdd != null) ? +opts.outlineWidthAdd : 3;
      ctx.strokeStyle = opts.outlineColor;
      ctx.lineWidth   = lineWidth + halo;
      ctx.lineCap     = "round";
      strokePolyline(ctx, L3, points, closed);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = lineWidth;
    ctx.lineCap     = "round";
    strokePolyline(ctx, L3, points, closed);

    ctx.restore();
  }

  function drawLoopWire(ctx, L3, loop, opts) {
    opts = opts || {};
    const K = Math.max(12, Math.round(+opts.K || 64));
    const pts = LIB.EM.sampleLoopPoints(loop, K);
    drawConductor3D(ctx, L3, pts, Object.assign({}, opts, { closed: true }));
  }

  // ---------------------------------------------------------------------------
  //  Current-dot animation — circular-loop shortcut
  //
  //  For a circle the arc-length parameter equals the angle parameter (up to
  //  the constant 1/r), so we can place dots at φ_k = 2π·(k/N + phase) directly
  //  via LIB.EM.pointOnLoop without sampling.
  // ---------------------------------------------------------------------------

  function advancePhase(phaseRef, current, opts) {
    const gain     = (opts.gain     != null) ? +opts.gain     : 0.4;
    const dt       = (opts.dt       != null) ? +opts.dt       : (1 / 60);
    const minSpeed = (opts.minSpeed != null) ? +opts.minSpeed : 0;
    let dPhase = current * gain * dt;
    if (Math.abs(dPhase) < minSpeed) {
      dPhase = (Math.sign(current) || 1) * minSpeed;
    }
    let p = ((phaseRef.phase || 0) + dPhase) % 1;
    if (p < 0) p += 1;
    phaseRef.phase = p;
    return p;
  }

  function drawDotAtScreen(ctx, sp, baseSize, maxSize, fill, outline) {
    if (sp.behind) return;
    // Larger when nearer (depth 1.0 = unit). Clamp to maxSize.
    const ref = Math.max(0.1, sp.depth);
    let r = baseSize / ref;
    if (r > maxSize) r = maxSize;
    if (r < 0.5)     r = 0.5;
    if (outline) {
      ctx.fillStyle = outline;
      ctx.beginPath(); ctx.arc(sp.px, sp.py, r + 1.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(sp.px, sp.py, r, 0, Math.PI * 2); ctx.fill();
  }

  function drawLoopCurrentDots(ctx, L3, loop, current, phaseRef, opts) {
    opts = opts || {};
    const dotCount = Math.max(2, Math.round(+opts.dotCount || 8));
    const dotSize  = (opts.dotSize != null) ? +opts.dotSize : 4;
    const dotColor = opts.dotColor || "#ffd54a";
    const outline  = opts.outlineColor || "rgba(0,0,0,0.55)";
    const maxSize  = (opts.maxScreenSize != null) ? +opts.maxScreenSize : 8;
    const phase    = advancePhase(phaseRef, current, opts);
    ctx.save();
    for (let k = 0; k < dotCount; k++) {
      const f = (k / dotCount + phase) % 1;
      const phi = f * 2 * Math.PI;
      const w = LIB.EM.pointOnLoop(loop, phi);
      const sp = L3.project(w);
      drawDotAtScreen(ctx, sp, dotSize, maxSize, dotColor, outline);
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  Current-dot animation — arbitrary 3D polyline
  //
  //  Parameterise by cumulative arc length s ∈ [0, S]. For each dot at
  //  fraction f = (k/N + phase) mod 1, find the polyline segment containing
  //  s = f·S and lerp.
  // ---------------------------------------------------------------------------

  function arcLengths(points, closed) {
    const n = points.length;
    const s = new Float64Array(n + (closed ? 1 : 0));
    s[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      const dz = points[i].z - points[i - 1].z;
      s[i] = s[i - 1] + Math.hypot(dx, dy, dz);
    }
    if (closed) {
      const dx = points[0].x - points[n - 1].x;
      const dy = points[0].y - points[n - 1].y;
      const dz = points[0].z - points[n - 1].z;
      s[n] = s[n - 1] + Math.hypot(dx, dy, dz);
    }
    return s;
  }

  function pointAtArc(points, s, target, closed) {
    // Binary search for the segment containing `target`.
    const n = closed ? s.length - 1 : s.length - 1;
    let lo = 0, hi = n;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] <= target) lo = mid; else hi = mid;
    }
    const a = points[lo];
    const b = (closed && hi >= points.length) ? points[0] : points[hi];
    const seg = s[hi] - s[lo] || 1;
    const t = (target - s[lo]) / seg;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }

  function drawCurrentDots3D(ctx, L3, points, current, phaseRef, opts) {
    opts = opts || {};
    if (!points || points.length < 2) return;
    const closed   = (opts.closed !== false);
    const dotCount = Math.max(2, Math.round(+opts.dotCount || 8));
    const dotSize  = (opts.dotSize != null) ? +opts.dotSize : 4;
    const dotColor = opts.dotColor || "#ffd54a";
    const outline  = opts.outlineColor || "rgba(0,0,0,0.55)";
    const maxSize  = (opts.maxScreenSize != null) ? +opts.maxScreenSize : 8;
    const s = arcLengths(points, closed);
    const S = s[s.length - 1];
    if (S <= 0) return;
    const phase = advancePhase(phaseRef, current, opts);
    ctx.save();
    for (let k = 0; k < dotCount; k++) {
      const f = (k / dotCount + phase) % 1;
      const target = f * S;
      const w = pointAtArc(points, s, target, closed);
      const sp = L3.project(w);
      drawDotAtScreen(ctx, sp, dotSize, maxSize, dotColor, outline);
    }
    ctx.restore();
  }

  LIB.CoilRender = {
    voltageColor,
    drawConductor3D,
    drawLoopWire,
    drawCurrentDots3D,
    drawLoopCurrentDots,
  };
})();
