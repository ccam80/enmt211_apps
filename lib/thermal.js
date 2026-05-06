"use strict";

// =============================================================================
//  LIB.Thermal — leaky-integrator motor heat model + colour tints.
//
//   dE/dt = (E_inf − E) / τ,   E_inf ∝ (τ_app/τ_max)²
//   E ∈ [0,1]; explosion when E ≥ 1. Caller passes a state object with
//   { thermal, exploded, explosionT, t } so the step is fully data-driven.
//
//  Depends on LIB.Util (lerpColor). Load AFTER lib/util.js.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.Thermal = {
    T_AMBIENT: 25,
    T_BLOW:    180,
    TAU_S:     12,
    get E_INF_MAX() { return 1 / (1 - Math.exp(-5 / this.TAU_S)); },
    tempFromE(E) { return this.T_AMBIENT + E * (this.T_BLOW - this.T_AMBIENT); },
    step(state, dt, tauApplied, tauMax) {
      const tn = tauApplied / Math.max(1e-3, tauMax);
      const Einf = LIB.Thermal.E_INF_MAX * tn * tn;
      state.thermal += dt * (Einf - state.thermal) / LIB.Thermal.TAU_S;
      if (state.thermal < 0) state.thermal = 0;
      if (!state.exploded && state.thermal >= 1.0) {
        state.exploded = true;
        state.explosionT = state.t || 0;
      }
    },
    tint(baseHex, E) {
      if (E <= 0.4) return baseHex;
      if (E <= 0.7) return LIB.Util.lerpColor(baseHex, "#f6c945", (E - 0.4) / 0.3);
      return LIB.Util.lerpColor("#f6c945", "#ef5350", Math.min(1, (E - 0.7) / 0.3));
    },
    fillTint(E) {
      if (E <= 0.4) return "#1a2030";
      if (E <= 0.7) return LIB.Util.lerpColor("#1a2030", "#3a2d10", (E - 0.4) / 0.3);
      return LIB.Util.lerpColor("#3a2d10", "#3a1212", Math.min(1, (E - 0.7) / 0.3));
    },
    // Pre-baked options for LIB.Draw.motor that reflect the motor's thermal
    // excursion: amber halo at E>0.4, red at E>0.7, body fill darkens to
    // burnt orange / red, stroke tints to match. Lessons spread it onto
    // their motor opts. `state` carries thermal+exploded; motorR sets the
    // halo radius (~0.45·motorR by convention).
    motorOpts(state, motorR) {
      const E = state.thermal || 0;
      const haloColor = E > 0.7 ? "#ef5350" : (E > 0.4 ? "#f6c945" : null);
      const fillColor = (E > 0.4)
        ? LIB.Util.lerpColor("#1a2030", E > 0.7 ? "#3a1212" : "#3a2d10",
                             Math.min(1, (E - 0.4) / 0.3))
        : "#1a2030";
      const strokeColor = LIB.Thermal.tint("#4ea1ff", E);
      return {
        fillColor, strokeColor, haloColor,
        haloAlpha: haloColor ? Math.min(1, 0.18 + 0.45 * Math.min(1, (E - 0.4) / 0.6)) : 0,
        haloRadius: motorR * 0.45,
        exploded: !!state.exploded,
      };
    },

    // Cartoonish explosion sprite drawn over the motor when state.exploded.
    // Reads state.t and state.explosionT to animate expansion + flash decay.
    drawExplosion(ctx, cx, cy, r, state, opts) {
      opts = opts || {};
      const tSince = Math.max(0, (state.t || 0) - (state.explosionT || 0));
      const expand = Math.min(1, tSince * 1.2);
      const flash  = Math.max(0, 1 - tSince * 0.6);
      const N = +opts.points || 14;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      for (let k = 0; k <= N * 2; k++) {
        const a = (k / (N * 2)) * Math.PI * 2;
        const isOuter = (k % 2) === 0;
        const j = 0.85 + 0.3 * Math.sin(k * 13.37 + (state.t || 0) * 9);
        const rr = (isOuter ? r * 1.85 : r * 0.95) * expand * j;
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = opts.starFill || "#ff6b1a";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = opts.starStroke || "#ffd460";
      ctx.stroke();
      // Inner core
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.75 * expand, 0, Math.PI * 2);
      ctx.fillStyle = opts.coreFill || "#ffe98a";
      ctx.fill();
      if (flash > 0) {
        ctx.globalAlpha = flash;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.5 * expand, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.font = (opts.labelFont || "bold 14px ui-sans-serif");
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = opts.labelColor || "#2a1500";
      ctx.fillText(opts.label || "BOOM", 0, 0);
      ctx.restore();
    },

    // Compact thermal gauge with current/max temperature label. Called below
    // the motor; centred on `cx`, top edge at `y`.
    drawGauge(ctx, cx, y, w, E, opts) {
      opts = opts || {};
      const h = +opts.height || 6;
      const x = cx - w / 2;
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#3a4453";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      const fillW = Math.max(0, Math.min(1, E)) * (w - 2);
      const col = E > 0.7 ? "#ef5350" : (E > 0.4 ? "#f6c945" : "#66bb6a");
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, y + 1, fillW, h - 2);
      ctx.fillStyle = opts.labelColor || "#8a93a3";
      ctx.font = opts.labelFont || "10px ui-sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const T = LIB.Thermal.tempFromE(E).toFixed(0);
      const Tblow = LIB.Thermal.T_BLOW;
      ctx.fillText(`T ${T} °C / ${Tblow} °C`, cx, y + h + 2);
    },
  };
})();
