"use strict";

// =============================================================================
//  LIB.Plot — time-series grid + lines + legend.
//
//   drawGrid(ctx, x, y, w, h, yMin, yMax, tMin, tMax, title, fsize, opts?)
//     opts.yFmt: function(v) → string  (defaults to v.toFixed(1))
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
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#2a313c";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.font = `${fsize}px ui-sans-serif`;
      ctx.textBaseline = "middle"; ctx.textAlign = "right";
      const yTicks = 4;
      for (let i = 0; i <= yTicks; i++) {
        const frac = i / yTicks;
        const yv = yMax - frac * (yMax - yMin);
        const yy = y + frac * h;
        ctx.strokeStyle = "#1e252f";
        ctx.beginPath(); ctx.moveTo(x + 36, yy); ctx.lineTo(x + w, yy); ctx.stroke();
        ctx.fillStyle = "#55606f";
        ctx.fillText(yFmt(yv), x + 34, yy);
      }
      if (yMin < 0 && yMax > 0) {
        const yy = y + (yMax / (yMax - yMin)) * h;
        ctx.strokeStyle = "#3a4453";
        ctx.beginPath(); ctx.moveTo(x + 36, yy); ctx.lineTo(x + w, yy); ctx.stroke();
      }
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const xTicks = 4;
      for (let i = 0; i <= xTicks; i++) {
        const frac = i / xTicks;
        const tv = tMin + frac * (tMax - tMin);
        const xx = x + 36 + frac * (w - 40);
        ctx.strokeStyle = "#1e252f";
        ctx.beginPath(); ctx.moveTo(xx, y); ctx.lineTo(xx, y + h - 14); ctx.stroke();
        ctx.fillStyle = "#55606f";
        ctx.fillText(tv.toFixed(1) + "s", xx, y + h - 12);
      }
      ctx.fillStyle = "#8a93a3";
      ctx.font = `${fsize}px ui-sans-serif`;
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText(title, x + 6, y + 4);
    },
    drawLine(ctx, x, y, w, h, yMin, yMax, tMin, tMax, pts, color, lw, dash) {
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw || 1.4;
      if (dash && dash.length) ctx.setLineDash(dash);
      ctx.beginPath();
      const x0 = x + 36;
      const usableW = w - 40;
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
