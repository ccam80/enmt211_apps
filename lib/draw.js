"use strict";

// =============================================================================
//  LIB.Draw — small set of canvas drawing primitives shared across lessons.
//
//  Lifted from motionapp's per-lesson renderers and de-app-ified: every
//  function takes the 2D context as its first argument and reads colours
//  from its options (no closed-over globals, no LP/linear references).
//
//  Primitives:
//    trapezoidWeight(ctx, cx, cyTop, mass, opts?)
//      Cartoon trapezoidal mass with hatched fill. Width grows sub-linearly
//      with `mass` (kg) so 100 kg doesn't drown the canvas. Returns box
//      metrics {topY, bottomY, halfBot, halfTop, height}.
//    jReflectedCallout(ctx, cx, yTop, J, opts?)
//      Two-line "J_load,refl = X kg·m² (reflected to motor)" caption above
//      the load. opts.color overrides accent.
//    motor(ctx, cx, cy, r, opts)
//      Filled disc + shaft indicator + label. opts: { theta, thermal (0..1),
//      exploded, label, fillColor, strokeColor, haloColor }.
//    track(ctx, opts)
//      Horizontal travel rail with end-stop ticks and optional target marker.
//      opts: { xToPx, xMin, xMax, y, padX, x, target?, targetLabel? }.
//    groundHatch(ctx, x0, x1, y, depth, opts?)
//      Hatched ground/wall fill below a horizontal line. opts: { color, step }.
//    arrow(ctx, x0, y0, x1, y1, opts?)
//      Single-headed arrow line. opts: { color, width, head, label?, fontSize? }.
//      If `label` is set, the text is drawn just past the arrowhead; alignment
//      flips to keep the text on the outside of the arrow regardless of dir.
//    dimensionLine(ctx, x0, y, x1, label, opts?)
//      Horizontal dimension line with arrowheads at each end and a centred
//      label. opts: { color, fontSize }.
//    spring(ctx, x0, y, x1, coils, amp, opts?)
//      Cartoon helical spring along a horizontal segment. opts: { color, width }.
//    damper(ctx, x0, y, x1, h, opts?)
//      Cartoon dashpot (cylinder + piston rod). x0=cylinder closed end, x1=rod
//      tip, h=cylinder half-height. opts: { color, width }.
//    roundRect(ctx, x, y, w, h, r)
//      Path-only rounded rectangle. Caller sets fill/stroke and calls
//      fill()/stroke() after.
//    componentArrows(ctx, x, y, items, opts?)
//      Stacked column/row of labelled force arrows. opts.axis ∈ {"x","y"}.
//      items = [{F, color, label}, …]. Used by PID lessons that want a
//      visual P/I/D/u/disturbance breakdown above/beside the plant.
//    holdBadge(ctx, W, H, hold, opts?)
//      Top-left status badge + "controlled!" border, used by lessons that
//      drive a LIB.HoldDetector. `hold` is the detector itself — we read
//      `.controlled`, `.inBand`, `.remaining`. opts: { color, goodColor,
//      bgColor, font }.
//
//  Zero dependencies (does not need util.js).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function withDefault(v, d) { return v == null ? d : v; }

  LIB.Draw = {

    trapezoidWeight(ctx, cx, cyTop, mass, opts) {
      opts = opts || {};
      const accent = opts.accentColor || "#c0c9d8";
      const fill   = opts.fillColor   || "#3a3024";
      const hatch  = opts.hatchColor  || "#5a4a32";
      const label  = withDefault(opts.label, mass.toFixed(1) + " kg");

      const sz = 36 + 26 * Math.log10(1 + Math.max(0, mass));
      const halfBot = sz * 0.55;
      const halfTop = sz * 0.32;
      const h       = sz * 0.65;
      const x0 = cx - halfBot, y0 = cyTop;
      const x1 = cx + halfBot, y1 = cyTop;
      const x2 = cx + halfTop, y2 = cyTop - h;
      const x3 = cx - halfTop, y3 = cyTop - h;

      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2); ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2); ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.clip();
      ctx.strokeStyle = hatch;
      ctx.lineWidth = 1;
      for (let xx = x0 - h; xx < x1 + h; xx += 8) {
        ctx.beginPath();
        ctx.moveTo(xx, y0);
        ctx.lineTo(xx + h, y0 - h);
        ctx.stroke();
      }
      ctx.restore();

      if (label) {
        ctx.fillStyle = opts.labelColor || "#e6e9ef";
        ctx.font = opts.labelFont || "600 12px ui-sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cyTop - h * 0.55);
      }
      return { topY: y3, bottomY: y0, halfBot, halfTop, height: h };
    },

    jReflectedCallout(ctx, cx, yTop, J, opts) {
      opts = opts || {};
      ctx.fillStyle = opts.color || "#66bb6a";
      ctx.font = opts.titleFont || "700 13px ui-sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(`J_load,refl = ${J.toFixed(4)} kg·m²`, cx, yTop - 6);
      ctx.font = opts.subFont || "11px ui-sans-serif";
      ctx.fillStyle = opts.subColor || "#8a93a3";
      ctx.fillText("(reflected to motor)", cx, yTop + 8);
    },

    motor(ctx, cx, cy, r, opts) {
      opts = opts || {};
      const theta    = +opts.theta || 0;
      const fill     = opts.fillColor   || "#1a2030";
      const stroke   = opts.strokeColor || "#4ea1ff";
      const halo     = opts.haloColor;
      const haloAlpha= +opts.haloAlpha || 0;
      const exploded = !!opts.exploded;
      const label    = opts.label;

      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      if (halo && haloAlpha > 0 && !exploded) {
        ctx.save();
        ctx.globalAlpha = haloAlpha;
        ctx.fillStyle = halo;
        ctx.beginPath();
        const haloR = r + (opts.haloRadius || (r * 0.4));
        ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      const ind = r * 0.8;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(theta) * ind, cy - Math.sin(theta) * ind);
      ctx.stroke();
      ctx.fillStyle = "#6a7384";
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

      if (label) {
        ctx.fillStyle = opts.labelColor || "#e6e9ef";
        ctx.font = opts.labelFont || "600 12px ui-sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(label, cx, cy + r + 6);
      }
    },

    track(ctx, opts) {
      const xToPx = opts.xToPx;
      const xMin  = opts.xMin;
      const xMax  = opts.xMax;
      const y     = opts.y;
      const padX  = withDefault(opts.padX, 0);
      const railColor   = opts.railColor   || "#3a4453";
      const tickColor   = opts.tickColor   || "#2a313c";
      const dotColor    = opts.dotColor    || "#4ea1ff";
      const labelColor  = opts.labelColor  || "#8a93a3";
      const targetColor = opts.targetColor || "#f6c945";

      ctx.strokeStyle = railColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xToPx(xMin), y);
      ctx.lineTo(xToPx(xMax), y);
      ctx.stroke();

      // End-stop ticks
      for (const xm of [xMin, xMax]) {
        const xp = xToPx(xm);
        ctx.beginPath();
        ctx.moveTo(xp, y - 8);
        ctx.lineTo(xp, y + 8);
        ctx.stroke();
      }
      // Centre tick
      ctx.strokeStyle = tickColor;
      ctx.beginPath();
      ctx.moveTo(xToPx(0), y - 6);
      ctx.lineTo(xToPx(0), y + 6);
      ctx.stroke();

      // Position label
      if (opts.posLabel != null) {
        ctx.fillStyle = labelColor;
        ctx.font = "11px ui-sans-serif";
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(opts.posLabel, padX, y + 12);
      }

      // Load dot
      if (opts.x != null) {
        const xp = xToPx(opts.x);
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(xp, y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // Target marker (downward triangle above the rail)
      if (opts.target != null && Number.isFinite(opts.target)) {
        const tp = xToPx(opts.target);
        ctx.strokeStyle = targetColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tp, y - 14);
        ctx.lineTo(tp - 6, y - 22);
        ctx.lineTo(tp + 6, y - 22);
        ctx.closePath();
        ctx.fillStyle = targetColor;
        ctx.fill();
        ctx.strokeStyle = "#3a2c00";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (opts.targetLabel) {
          ctx.fillStyle = targetColor;
          ctx.font = "10px ui-sans-serif";
          ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(opts.targetLabel, tp, y - 24);
        }
      }
    },

    groundHatch(ctx, x0, x1, y, depth, opts) {
      opts = opts || {};
      const color = opts.color || "#3a4453";
      const step  = +opts.step || 8;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
      ctx.stroke();
      for (let xx = x0; xx <= x1; xx += step) {
        ctx.beginPath();
        ctx.moveTo(xx, y);
        ctx.lineTo(xx - depth, y + depth);
        ctx.stroke();
      }
    },

    arrow(ctx, x0, y0, x1, y1, opts) {
      opts = opts || {};
      const color = opts.color || "#8a93a3";
      const w     = +opts.width || 1.4;
      const head  = +opts.head  || 8;
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-3 && !opts.label) return;
      ctx.strokeStyle = color;
      ctx.fillStyle   = color;
      ctx.lineWidth = w;
      if (len >= 1e-3) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        const ang = Math.atan2(dy, dx);
        const ah = head;
        const aw = head * 0.55;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ah * Math.cos(ang) + aw * Math.sin(ang),
                   y1 - ah * Math.sin(ang) - aw * Math.cos(ang));
        ctx.lineTo(x1 - ah * Math.cos(ang) - aw * Math.sin(ang),
                   y1 - ah * Math.sin(ang) + aw * Math.cos(ang));
        ctx.closePath();
        ctx.fill();
      }
      if (opts.label) {
        const fontSize = +opts.fontSize || 11;
        ctx.font = fontSize + "px ui-sans-serif";
        // Place the label past the tip on the side the arrow points to. For
        // mostly-horizontal arrows we anchor on x; for mostly-vertical we
        // centre horizontally and place above/below the tip.
        if (Math.abs(dx) >= Math.abs(dy)) {
          const dir = dx >= 0 ? 1 : -1;
          ctx.textAlign  = dir > 0 ? "left" : "right";
          ctx.textBaseline = "middle";
          ctx.fillText(opts.label, x1 + dir * 6, y1);
        } else {
          ctx.textAlign  = "center";
          ctx.textBaseline = dy >= 0 ? "top" : "bottom";
          ctx.fillText(opts.label, x1, y1 + (dy >= 0 ? 4 : -4));
        }
      }
    },

    holdBadge(ctx, W, H, hold, opts) {
      opts = opts || {};
      const goodColor = opts.goodColor || "#66bb6a";
      const inkColor  = opts.color     || "#e6e9ef";
      const muted     = opts.mutedColor|| "#aab2c0";
      const bg        = opts.bgColor   || "rgba(13,16,19,0.78)";
      const font      = opts.font      || "13px ui-sans-serif";

      if (hold && hold.controlled) {
        ctx.save();
        ctx.strokeStyle = goodColor;
        ctx.lineWidth   = 3;
        ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
        ctx.shadowColor = goodColor;
        ctx.shadowBlur  = 14;
        ctx.lineWidth   = 2;
        ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
        ctx.restore();

        const text = "✓ System Controlled!";
        ctx.save();
        ctx.font = "600 " + font;
        const m = ctx.measureText(text);
        const w = Math.ceil(m.width) + 22, h = 26;
        ctx.fillStyle = bg; ctx.strokeStyle = goodColor; ctx.lineWidth = 1;
        ctx.fillRect(12, 12, w, h);
        ctx.strokeRect(12.5, 12.5, w - 1, h - 1);
        ctx.fillStyle = goodColor;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, 22, 12 + h / 2);
        ctx.restore();
      } else if (hold && hold.inBand) {
        const text = "At target… " + hold.remaining.toFixed(1) + " s";
        ctx.save();
        ctx.font = font;
        const m = ctx.measureText(text);
        const w = Math.ceil(m.width) + 22, h = 26;
        ctx.fillStyle = bg; ctx.strokeStyle = "#2e3642"; ctx.lineWidth = 1;
        ctx.fillRect(12, 12, w, h);
        ctx.strokeRect(12.5, 12.5, w - 1, h - 1);
        ctx.fillStyle = inkColor;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, 22, 12 + h / 2);
        ctx.restore();
        // Subtle hint about how much longer
        if (typeof opts.subtitle === "string") {
          ctx.save();
          ctx.font = "11px ui-sans-serif";
          ctx.fillStyle = muted;
          ctx.textAlign = "left"; ctx.textBaseline = "top";
          ctx.fillText(opts.subtitle, 22, 12 + h + 4);
          ctx.restore();
        }
      }
    },

    spring(ctx, x0, y, x1, coils, amp, opts) {
      opts = opts || {};
      const color = opts.color || "#c0c9d8";
      const w     = +opts.width || 2;
      ctx.strokeStyle = color;
      ctx.lineWidth   = w;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      const len = x1 - x0;
      if (Math.abs(len) < 2) { ctx.lineTo(x1, y); ctx.stroke(); return; }
      const segs = Math.max(2, (coils || 8) * 2);
      const lead = Math.min(10, Math.abs(len) * 0.15) * Math.sign(len);
      const cs   = x0 + lead;
      const ce   = x1 - lead;
      ctx.lineTo(cs, y);
      for (let i = 1; i < segs; i++) {
        const t  = i / segs;
        const cx = cs + (ce - cs) * t;
        const cy = y + (i % 2 === 0 ? -amp : amp);
        ctx.lineTo(cx, cy);
      }
      ctx.lineTo(ce, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    },

    damper(ctx, x0, y, x1, h, opts) {
      opts = opts || {};
      const color = opts.color || "#8a93a3";
      const w     = +opts.width || 1.4;
      const len = x1 - x0;
      if (Math.abs(len) < 4) return;
      const dir = Math.sign(len);
      const cylLen = Math.min(Math.abs(len) * 0.45, 22);
      const cylX0 = x0;
      const cylX1 = x0 + dir * cylLen;
      ctx.strokeStyle = color;
      ctx.lineWidth   = w;
      // Cylinder body — three sides, open end on the rod side.
      ctx.beginPath();
      ctx.moveTo(cylX1, y - h);
      ctx.lineTo(cylX0, y - h);
      ctx.lineTo(cylX0, y + h);
      ctx.lineTo(cylX1, y + h);
      ctx.stroke();
      // Piston disc inside cylinder.
      const pistonX = cylX0 + dir * cylLen * 0.55;
      ctx.beginPath();
      ctx.moveTo(pistonX, y - h * 0.85);
      ctx.lineTo(pistonX, y + h * 0.85);
      ctx.stroke();
      // Rod from piston out to x1.
      ctx.beginPath();
      ctx.moveTo(pistonX, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    },

    roundRect(ctx, x, y, w, h, r) {
      // Path-only — caller sets fill/stroke and calls fill()/stroke() after.
      // Used by every "vehicle on canvas" lesson (car, rover, heli, future
      // PID-cart). Lifted from the duplicated copies in car.js / rover.js.
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    },

    componentArrows(ctx, x, y, items, opts) {
      // Stacked column / row of labelled force arrows. Used by every PID
      // lesson that wants to show {P, I, D, u, disturbance} as a visual
      // breakdown above/beside the plant. opts:
      //   axis:    "x" | "y"     (default "x" — horizontal arrows stacked vertically)
      //   gap:     px between adjacent arrows (default 14)
      //   pxPerN:  scale (default 0.6)
      //   cap:     px clamp on arrow length (default 220)
      //   width:   arrow line width (default 2)
      //   head:    arrowhead size (default 8)
      //   fontSize, labelFmt, labelDecimals
      // items: [{ F, color, label }, …] — F in N, label is the prefix.
      opts = opts || {};
      const axis     = opts.axis     || "x";
      const gap      = +opts.gap     || 14;
      const pxPerN   = +opts.pxPerN  || 0.6;
      const cap      = +opts.cap     || 220;
      const width    = +opts.width   || 2;
      const head     = +opts.head    || 8;
      const fontSize = +opts.fontSize || 10;
      const dec      = (opts.labelDecimals != null) ? +opts.labelDecimals : 0;
      const labelFmt = (typeof opts.labelFmt === "function")
        ? opts.labelFmt
        : (it) => it.label + " " + (+it.F).toFixed(dec);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let d = (+it.F) * pxPerN;
        if (Math.abs(d) > cap) d = Math.sign(d) * cap;
        let x0 = x, y0 = y, x1, y1;
        if (axis === "x") {
          y0 = y - gap * i; y1 = y0; x1 = x + d;
        } else {
          x0 = x + gap * i; x1 = x0; y1 = y - d;
        }
        LIB.Draw.arrow(ctx, x0, y0, x1, y1, {
          color: it.color, width, head,
          label: labelFmt(it), fontSize,
        });
      }
    },

    dimensionLine(ctx, x0, y, x1, label, opts) {
      opts = opts || {};
      const color    = opts.color || "#8a93a3";
      const fontSize = +opts.fontSize || 11;
      const head     = +opts.head || 6;

      ctx.strokeStyle = color;
      ctx.fillStyle   = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + head, y); ctx.lineTo(x1 - head, y);
      ctx.stroke();
      // arrowheads
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + head, y - head * 0.5);
      ctx.lineTo(x0 + head, y + head * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x1 - head, y - head * 0.5);
      ctx.lineTo(x1 - head, y + head * 0.5);
      ctx.closePath();
      ctx.fill();
      // label centred above
      if (label) {
        ctx.font = fontSize + "px ui-sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText(label, (x0 + x1) / 2, y - 3);
      }
    },
  };
})();
