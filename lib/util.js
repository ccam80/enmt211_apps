"use strict";

// =============================================================================
//  LIB.Util — colour helpers, canvas DPR-fit, env reads.
//
//  Zero dependencies. Loaded first; every other LIB module assumes Util is
//  already attached to window.LIB.
// =============================================================================

(function () {
  const root = (typeof window !== "undefined") ? window : globalThis;
  const LIB = root.LIB || (root.LIB = {});

  LIB.Util = {
    getVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#fff";
    },
    hexToRgb(hx) {
      const m = hx.replace("#", "");
      const v = parseInt(m.length === 3 ? m.split("").map(c => c + c).join("") : m, 16);
      return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    },
    rgbToHex(r, g, b) {
      const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
      return "#" + h(r) + h(g) + h(b);
    },
    lerpColor(a, b, t) {
      const A = LIB.Util.hexToRgb(a), B = LIB.Util.hexToRgb(b);
      return LIB.Util.rgbToHex(A[0] + (B[0]-A[0])*t, A[1] + (B[1]-A[1])*t, A[2] + (B[2]-A[2])*t);
    },
    fitCanvas(canvas, ctx) {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width  = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: r.width, h: r.height };
    },
    clamp(v, lo, hi) {
      return v < lo ? lo : (v > hi ? hi : v);
    },
  };
})();
