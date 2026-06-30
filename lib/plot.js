"use strict";

// =============================================================================
//  LIB.Plot — time-series grid + lines + legend.
//
//   drawGrid(ctx, x, y, w, h, yMin, yMax, tMin, tMax, title, fsize, opts?)
//     opts.yFmt:      function(v) → string  (defaults to v.toFixed(1))
//     opts.titleFs:   font size (px) for the top-left title; defaults to fsize
//     opts.tickFs:    font size (px) for axis tick labels; defaults to fsize
//   drawLine(ctx, x, y, w, h, yMin, yMax, tMin, tMax, pts, color, lw, dash?)
//     pts = [{t, y}, ...] with non-finite y treated as a break.
//     dash = optional Array<number> forwarded to ctx.setLineDash (e.g. [4,4]).
//   drawLegend(ctx, rightX, topY, fsize, [{color, label}, ...])
//
//  Pure ctx-and-bounds — works against any 2D context. Zero deps.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.Plot = {
    drawGrid(ctx, x, y, w, h, yMin, yMax, tMin, tMax, title, fsize, opts) {
      opts = opts || {};
      const yFmt = opts.yFmt || ((v) => v.toFixed(1));
      const titleFs = +opts.titleFs || fsize;
      const tickFs  = +opts.tickFs  || fsize;
      // Axis-label gutter scales with tick size so the y labels never crowd
      // the plot lines on a small canvas.
      const yGutter = Math.max(28, Math.round(tickFs * 2.6));
      const xGutter = Math.max(12, Math.round(tickFs * 1.1));
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#2a313c";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.font = `${tickFs}px ui-sans-serif`;
      ctx.textBaseline = "middle"; ctx.textAlign = "right";
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const frac = i / yTicks;
        const yv = yMax - frac * (yMax - yMin);
        const yy = y + frac * h;
        ctx.strokeStyle = "#1e252f";
        ctx.beginPath(); ctx.moveTo(x + yGutter, yy); ctx.lineTo(x + w, yy); ctx.stroke();
        ctx.fillStyle = "#55606f";
        ctx.fillText(yFmt(yv), x + yGutter - 2, yy);
      }
      if (yMin < 0 && yMax > 0) {
        const yy = y + (yMax / (yMax - yMin)) * h;
        ctx.strokeStyle = "#3a4453";
        ctx.beginPath(); ctx.moveTo(x + yGutter, yy); ctx.lineTo(x + w, yy); ctx.stroke();
      }
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const tRange = (tMax - tMin) || 1;
      const xData0 = x + yGutter;
      const xDataW = w - yGutter - 4;
      if (opts.tStep > 0) {
        // Scrolling grid: vertical lines anchored to absolute time at a fixed
        // `tStep` spacing, so they move left with the samples (a given time stays
        // glued to its sample) instead of sitting at fixed screen fractions.
        const s = opts.tStep;
        const dec = s >= 10 ? 0 : s >= 1 ? 1 : s >= 0.1 ? 2 : s >= 0.01 ? 3 : 4;
        const first = Math.ceil(tMin / s - 1e-9) * s;
        for (let tv = first; tv <= tMax + 1e-9; tv += s) {
          const xx = xData0 + ((tv - tMin) / tRange) * xDataW;
          ctx.strokeStyle = "#1e252f";
          ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h - xGutter); ctx.stroke();
          ctx.fillStyle = "#55606f";
          ctx.fillText(tv.toFixed(dec) + "s", xx, y + h - xGutter + 2);
        }
      } else {
        const xTicks = 4;
        for (let i = 0; i <= xTicks; i++) {
          const frac = i / xTicks;
          const tv = tMin + frac * tRange;
          const xx = xData0 + frac * xDataW;
          ctx.strokeStyle = "#1e252f";
          ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h - xGutter); ctx.stroke();
          ctx.fillStyle = "#55606f";
          ctx.fillText(tv.toFixed(1) + "s", xx, y + h - xGutter + 2);
        }
      }
      ctx.fillStyle = "#8a93a3";
      ctx.font = `600 ${titleFs}px ui-sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(title, x + 8, y + 6);
    },
    drawLine(ctx, x, y, w, h, yMin, yMax, tMin, tMax, pts, color, lw, dash) {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw || 1.4;
      if (dash && dash.length) ctx.setLineDash(dash);
      ctx.beginPath();
      // Match the y-gutter computed in drawGrid so lines align with ticks.
      const T = (LIB.Type && LIB.Type.current) || null;
      const tickFs = T ? T.plotTick : 11;
      const yGutter = Math.max(28, Math.round(tickFs * 2.6));
      const x0 = x + yGutter;
      const usableW = w - yGutter - 4;
      const yRange = (yMax - yMin) || 1;
      const tRange = (tMax - tMin) || 1;
      let started = false;
      for (const p of pts) {
        if (!Number.isFinite(p.y)) { started = false; continue; }
        const xx = x0 + ((p.t - tMin) / tRange) * usableW;
        const yy = y + (1 - (p.y - yMin) / yRange) * h;
        if (!started) { ctx.moveTo(xx, yy); started = true; }
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      if (dash && dash.length) ctx.setLineDash([]);
    },
    deadbandSeries(opts) {
      // Returns the two dashed series objects for a ±dead/2 band centred on
      // `ref`, ready to be spread into a `series:` array. Used by every PID
      // lesson with a bang-bang mode (car/heli today, future PID lessons).
      // opts: { ref, dead, color, lw, dash, refKey, deadKey }
      // ref/dead may each be a number or a (state, params) source fn. If
      // refKey is supplied the series read params[refKey]; same for deadKey.
      opts = opts || {};
      const color = opts.color || "#ef5350";
      const lw    = +opts.lw   || 1.0;
      const dash  = opts.dash  || [4, 4];
      const refOf  = (opts.refKey != null)
        ? (s, p) => +p[opts.refKey] || 0
        : (typeof opts.ref === "function" ? opts.ref : (() => +opts.ref || 0));
      const deadOf = (opts.deadKey != null)
        ? (s, p) => +p[opts.deadKey] || 0
        : (typeof opts.dead === "function" ? opts.dead : (() => +opts.dead || 0));
      return [
        { label: "deadHi", color, lw, dash,
          source: (s, p) => refOf(s, p) + deadOf(s, p) / 2 },
        { label: "deadLo", color, lw, dash,
          source: (s, p) => refOf(s, p) - deadOf(s, p) / 2 },
      ];
    },
    drawLegend(ctx, rightX, topY, fsize, entries) {
      ctx.font = `${fsize}px ui-sans-serif`;
      ctx.textAlign = "right"; ctx.textBaseline = "top";
      let y = topY;
      for (const e of entries) {
        ctx.fillStyle = e.color;
        ctx.fillText("■ " + e.label, rightX, y);
        y += fsize + 2;
      }
    },
  };
})();
