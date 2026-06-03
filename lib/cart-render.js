"use strict";

// =============================================================================
//  LIB.CartRender — boxy cart silhouette with rolling wheels + window strip,
//  plus a stacked horizontal force-arrow renderer. Shared by the pidcontrol
//  single-cart and three-cart lessons.
//
//  draw(ctx, opts)
//    Paint one cart given its world position (used for the rolling angle).
//    opts:
//      cx, cy           cart-body centre in canvas pixels
//      bodyW, bodyH     trapezoidal-body width and height (px)
//      wheelR, axleY    wheel radius (px) and axle y (px)
//      x                world position (m), used for wheel rolling angle
//      mToPx            world→pixel scale (so wheel angle = x / (wheelR/mToPx))
//      lineW            stroke width (px)
//      fillColor        body fill (default #2b3340)
//      strokeColor      body stroke (default #6a7384)
//      windowColor      window tint hue (default #4ea1ff)
//      label            optional centre label
//      labelColor       label colour (default windowColor)
//      labelFont        e.g. "600 12px ui-sans-serif"
//      springHookY      if set, draws spring hook stubs at this y (left+right)
//      damperHookY      if set, draws damper hook stubs at this y (left+right)
//      markerY1, markerY2  if both set, draws a faint dotted vertical centre
//                          marker between these two canvas-y values
//
//  forceArrows(ctx, x, yTopBaseline, slots, opts?)
//    Thin compatibility wrapper around LIB.Draw.componentArrows. Paints a
//    vertical stack of horizontal force arrows above a cart, with slot 0
//    just above (yTopBaseline − slotGap) and subsequent slots stacked
//    further up. Translates pidapp's pxPerN/cap/font knobs into
//    componentArrows' opts so existing callers don't have to change.
//    opts: { fsmall, slotGap, F_PX_PER_N, F_CAP_PX }
//
//  Depends on LIB.Draw (componentArrows).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function draw(ctx, opts) {
    const cx     = +opts.cx;
    const cy     = +opts.cy;
    const bodyW  = +opts.bodyW;
    const bodyH  = +opts.bodyH;
    const wheelR = +opts.wheelR;
    const axleY  = +opts.axleY;
    const lineW  = +opts.lineW || 1.5;
    const fill   = opts.fillColor   || "#2b3340";
    const stroke = opts.strokeColor || "#6a7384";
    const win    = opts.windowColor || "#4ea1ff";

    // Optional centre marker (faint dotted vertical line through the cart).
    if (opts.markerY1 != null && opts.markerY2 != null) {
      ctx.strokeStyle = win;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, opts.markerY1); ctx.lineTo(cx, opts.markerY2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trapezoidal body
    ctx.fillStyle   = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = lineW;
    ctx.beginPath();
    ctx.moveTo(cx - bodyW/2,     cy - bodyH/2);
    ctx.lineTo(cx + bodyW/2,     cy - bodyH/2);
    ctx.lineTo(cx + bodyW/2 + 6, cy + bodyH/2);
    ctx.lineTo(cx - bodyW/2 - 6, cy + bodyH/2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Window strip
    ctx.fillStyle   = win + "33";
    ctx.strokeStyle = win + "88";
    ctx.beginPath();
    ctx.rect(cx - bodyW/2 + 6, cy - bodyH/2 + 4, bodyW - 12, bodyH * 0.35);
    ctx.fill(); ctx.stroke();

    // Optional centre label
    if (opts.label) {
      ctx.fillStyle    = opts.labelColor || win;
      ctx.font         = opts.labelFont  || "600 12px ui-sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(opts.label), cx, cy + bodyH * 0.28);
    }

    // Spring + damper hook stubs at left and right edges.
    if (opts.springHookY != null) {
      ctx.strokeStyle = "#9aa4b4";
      ctx.lineWidth   = lineW;
      ctx.beginPath();
      ctx.moveTo(cx - bodyW/2 - 6, opts.springHookY);
      ctx.lineTo(cx - bodyW/2,     opts.springHookY);
      ctx.moveTo(cx + bodyW/2,     opts.springHookY);
      ctx.lineTo(cx + bodyW/2 + 6, opts.springHookY);
      ctx.stroke();
    }
    if (opts.damperHookY != null) {
      ctx.strokeStyle = "#9aa4b4";
      ctx.lineWidth   = lineW;
      ctx.beginPath();
      ctx.moveTo(cx - bodyW/2 - 6, opts.damperHookY);
      ctx.lineTo(cx - bodyW/2,     opts.damperHookY);
      ctx.moveTo(cx + bodyW/2,     opts.damperHookY);
      ctx.lineTo(cx + bodyW/2 + 6, opts.damperHookY);
      ctx.stroke();
    }

    // Wheels — ground-locked rolling. wheelAngle = x / r where r is wheel
    // radius in metres.
    const wheelR_m = wheelR / Math.max(1e-9, +opts.mToPx || 1);
    const wheelAngle = (+opts.x || 0) / Math.max(1e-9, wheelR_m);
    const wxs = [cx - bodyW/3, cx + bodyW/3];
    for (const wx of wxs) {
      ctx.fillStyle   = "#12161c";
      ctx.strokeStyle = stroke;
      ctx.lineWidth   = lineW;
      ctx.beginPath();
      ctx.arc(wx, axleY, wheelR, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      // Crossed spokes for rolling visibility.
      ctx.strokeStyle = "#e6e9ef";
      ctx.lineWidth   = Math.max(1.2, lineW * 1.1);
      ctx.beginPath();
      ctx.moveTo(wx, axleY);
      ctx.lineTo(wx + Math.cos(wheelAngle) * (wheelR - 2),
                 axleY + Math.sin(wheelAngle) * (wheelR - 2));
      ctx.moveTo(wx, axleY);
      ctx.lineTo(wx + Math.cos(wheelAngle + Math.PI/2) * (wheelR - 2),
                 axleY + Math.sin(wheelAngle + Math.PI/2) * (wheelR - 2));
      ctx.stroke();
    }
  }

  function forceArrows(ctx, x, yTopBaseline, slots, opts) {
    if (!LIB.Draw || typeof LIB.Draw.componentArrows !== "function") {
      throw new Error("LIB.CartRender.forceArrows requires LIB.Draw.componentArrows");
    }
    opts = opts || {};
    const fsmall  = +opts.fsmall || 12;
    const slotGap = +opts.slotGap     || Math.max(13, fsmall * 1.25);
    const pxPerN  = +opts.F_PX_PER_N  || 0.5;
    const capPx   = +opts.F_CAP_PX    || 300;
    const width   = +opts.width       || Math.max(1.5, fsmall * 0.14);
    const head    = +opts.head        || Math.max(6,   fsmall * 0.7);

    // Skip arrows whose drawn length is < 0.5 px (componentArrows draws them
    // otherwise), so tiny components don't clutter the stack.
    const items = [];
    for (const s of slots) {
      if (Math.abs((+s.F) * pxPerN) < 0.5) continue;
      items.push(s);
    }
    if (!items.length) return;

    // componentArrows lays slot i at (y − gap*i); slot 0 sits at
    // (yTopBaseline − slotGap), so anchor the y axis one gap above the top.
    LIB.Draw.componentArrows(ctx, x, yTopBaseline - slotGap, items, {
      axis: "x", gap: slotGap,
      pxPerN, cap: capPx,
      width, head,
      fontSize: fsmall,
      labelDecimals: 0,
    });
  }

  LIB.CartRender = { draw, forceArrows };
})();
