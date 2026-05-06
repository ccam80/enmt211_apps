"use strict";

// =============================================================================
//  Helicopter-hover lesson — a 3-DOF system [h, vh, T] where the rotor's
//  first-order spool dynamics (τ ≈ 0.6 s) is the reason a high P gain alone
//  makes the heli porpoise. Steady-state hover demands T = m·g exactly,
//  which the I-term (or the offset slider) is responsible for carrying.
//
//  Reference altitude is a slider with quick-preset buttons (5 / 10 / 20 /
//  30 / 40 m). The "controlled" badge appears after holding within ±2 % of
//  the reference for 10 s.
//
//  Controller: state.ctrlLoop = { I, ePrev, bbDir }, advanced through the
//  shared LIB.PID and LIB.BangBang.flip primitives.
// =============================================================================

(function () {
  const ControlLessons = window.ControlLessons || (window.ControlLessons = {});

  const G       = 9.81;
  const M       = 6.0;
  const C_DRAG  = 0.8;
  const TAU     = 0.6;
  const T_HOVER = M * G;
  const T_MAX   = T_HOVER * 2.4;
  const ALT_MAX = 60;
  const SIGMA_W = 6;
  const TAU_W   = 2.0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  let holdDetector  = null;
  let mountedHandle = null;

  function setRef(v) {
    if (!mountedHandle) return;
    mountedHandle.state.ref = v;
    mountedHandle.setSlider("ref", v);
    if (holdDetector) holdDetector.reset();
  }

  const SPEC = {
    id: "heli",
    title: "Helicopter Hover",
    subtitle: "hold the target altitude through gusty updrafts",
    description:
      "<b>Hover is a balancing act.</b> The rotor lag (τ ≈ 0.6 s) means " +
      "thrust catches up <i>after</i> you ask for it — turn P up too high and " +
      "the helicopter porpoises. Steady-state hover needs <i>T = m·g</i> exactly, " +
      "so without an integrator (or the <i>offset</i> slider) the helicopter " +
      "settles below the target by the gravity-error margin. " +
      "The OU updraft adds a small drifting disturbance the I-term has to absorb.",

    state: () => ({
      h: 0, vh: 0, T: T_HOVER,
      ctrlLoop: { I: 0, ePrev: 0, bbDir: 0 },
      wind: 0,
      ref: 20,            // persisted across mode switches; mirrors the slider
      lastE: 0, lastUP: 0, lastUI: 0, lastUD: 0,
      lastU: 0, lastFw: 0, lastTcmd: T_HOVER, lastT: T_HOVER,
      t: 0,
    }),

    onReset: (s) => {
      s.T = T_HOVER; s.lastTcmd = T_HOVER; s.lastT = T_HOVER;
      s.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
      s.wind = 0;
      if (holdDetector) holdDetector.reset();
    },

    modes: {
      default: "pid",
      persistKey: "heli-mode",
      list: [
        { id: "pid",      label: "PID" },
        { id: "bangbang", label: "Bang-bang" },
      ],
      onChange: (state) => {
        state.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
        if (holdDetector) holdDetector.reset();
      },
    },

    sliders: (state) => {
      const ctrlPID = [
        { key: "kp",     label: "P",    min: 0, max: 1000, step: 0.01, value: 0,
          log: true, logMin: 1,
          tip: "Proportional gain on altitude error." },
        { key: "ki",     label: "I",    min: 0, max: 1000, step: 0.01, value: 0,
          log: true, logMin: 1,
          tip: "Integral gain — accumulates the hover-thrust offset." },
        { key: "kd",     label: "D",    min: 0, max: 1000, step: 0.01, value: 0,
          log: true, logMin: 1,
          tip: "Derivative gain on measured climb rate — damps porpoising." },
        { key: "iClamp", label: "Imax", min: 0, max: 1000, step: 0.1,  value: T_HOVER,
          log: true, logMin: 1,
          tip: "Cap on the integral term (N)." },
        { key: "uMax",   label: "uMax", min: 1, max: 1000, step: 0.1,  value: 1000,
          log: true,
          tip: "Cap on the PID's command above hover (N)." },
        { key: "offset", label: "offset", min: 0, max: 100, step: 0.1, value: 0,
          tip: "Constant baseline thrust added to the PID's command (N). Set near m·g ≈ "
            + T_HOVER.toFixed(1) + " N to give the integrator less work, or 0 to make it learn." },
      ];
      const ctrlBB = [
        { key: "dead",   label: "dead", min: 0, max: 4, step: 0.05, value: 0.5,
          tip: "Deadband width (m). Thrust flips between hover±effort once altitude crosses past the opposite edge." },
        { key: "effort", label: "eff",  min: 0, max: 1000, step: 0.1, value: T_HOVER * 0.4,
          log: true, logMin: 1,
          tip: "Extra thrust above or below hover that the bang-bang controller adds." },
      ];
      return {
        Reference: {
          kind: "dynamic", title: "Reference",
          items: (s) => [[
            { key: "ref", label: "h*", min: 1, max: 50, step: 0.1,
              value: (s && s.ref != null) ? s.ref : 20,
              tip: "Target altitude (m).",
              onChange: (v, st) => {
                st.ref = v;
                if (holdDetector) holdDetector.reset();
              } },
          ]],
          actions: [5, 10, 20, 30, 40].map(v => ({
            label: v + " m", run: () => setRef(v),
          })),
          span: "full",
        },
        Controller: state.mode === "bangbang" ? ctrlBB : ctrlPID,
        System: [
          { key: "mass", label: "m",    min: 0.5,  max: 50,  step: 0.1,  value: M,     disabled: true,
            tip: "Helicopter mass (kg). Hover thrust must equal m·g ≈ " + T_HOVER.toFixed(1) + " N." },
          { key: "drag", label: "c",    min: 0,    max: 10,  step: 0.1,  value: C_DRAG,disabled: true,
            tip: "Vertical drag (N per m/s)." },
          { key: "tau",  label: "τ",   min: 0.05, max: 2,   step: 0.05, value: TAU,   disabled: true,
            tip: "Rotor spool-up time constant (s). The reason high P porpoises." },
          { key: "Tmax", label: "Tmax", min: T_HOVER, max: T_HOVER * 4, step: 1, value: T_MAX, disabled: true,
            tip: "Largest thrust the rotor can produce (N)." },
          { key: "g",    label: "g",    min: 1,    max: 25,  step: 0.01, value: G,     disabled: true,
            tip: "Gravity (m/s²)." },
        ],
      };
    },

    plots: (state) => {
      const series = [
        { label: "ref", color: LIB.Util.getVar("--cRef"), lw: 1.4,
          source: (s, p) => +p.ref || 0 },
        { label: "h",   color: LIB.Util.getVar("--cX"),   lw: 2.0,
          source: (s) => s.h },
      ];
      if (state.mode === "bangbang") {
        series.push(
          { label: "deadHi", color: "#ef5350", lw: 1.0, dash: [4, 4],
            source: (s, p) => (+p.ref || 0) + (+p.dead || 0) / 2 },
          { label: "deadLo", color: "#ef5350", lw: 1.0, dash: [4, 4],
            source: (s, p) => (+p.ref || 0) - (+p.dead || 0) / 2 },
        );
      }
      return [
        { title: "altitude (m)", yMin: 0, yMax: ALT_MAX, yFmt: (v) => v.toFixed(1),
          series },
        { title: "command above hover & updraft (N)",
          yFmt: (v) => v.toFixed(0),
          series: [
            { label: "P",    color: LIB.Util.getVar("--cP"), lw: 1.2,
              source: (s) => s.lastUP },
            { label: "I",    color: LIB.Util.getVar("--cI"), lw: 1.2,
              source: (s) => s.lastUI },
            { label: "D",    color: LIB.Util.getVar("--cD"), lw: 1.2,
              source: (s) => s.lastUD },
            { label: "wind", color: LIB.Util.getVar("--cW"), lw: 1.2,
              source: (s) => s.lastFw },
            { label: "u",    color: LIB.Util.getVar("--cU"), lw: 2.0,
              source: (s) => s.lastU },
          ] },
      ];
    },

    readouts: () => [
      { label: "h",     units: "m",   value: (s) => s.h.toFixed(3) },
      { label: "ḣ",    units: "m/s", value: (s) => s.vh.toFixed(3) },
      { label: "T",     units: "N",   value: (s) => s.T.toFixed(2) },
      { label: "err",   units: "m",   value: (s) => s.lastE.toFixed(3) },
      { label: "∫err",                value: (s) => (s.ctrlLoop ? s.ctrlLoop.I : 0).toFixed(3) },
      { label: "P",     units: "N",   value: (s) => s.lastUP.toFixed(2) },
      { label: "I",     units: "N",   value: (s) => s.lastUI.toFixed(2) },
      { label: "D",     units: "N",   value: (s) => s.lastUD.toFixed(2) },
      { label: "u",     units: "N",   value: (s) => s.lastU.toFixed(2) },
      { label: "wind",  units: "N",   value: (s) => s.lastFw.toFixed(2) },
    ],

    physics: {
      dof: ["h", "vh", "T"],
      preStep: (s, p, dt) => {
        if (!s.ctrlLoop) s.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
        s.wind = LIB.Noise.ouStep(s.wind, SIGMA_W, TAU_W, dt);
        const ref = +p.ref || 0;
        const e = ref - s.h;
        const m = +p.mass, g = +p.g;
        let Tcmd, uP = 0, uI = 0, uD = 0;
        if (p.mode === "bangbang") {
          LIB.BangBang.flip.advance(s.ctrlLoop, e, { dead: +p.dead || 0 });
          const out = LIB.BangBang.flip.effort(s.ctrlLoop,
            { effort: +p.effort || 0 });
          Tcmd = clamp(m * g + out.u, 0, +p.Tmax);
        } else {
          LIB.PID.advance(s.ctrlLoop, e, dt,
            { ki: +p.ki || 0, iClamp: +p.iClamp });
          const out = LIB.PID.effort(s.ctrlLoop, e, s.vh,
            { kp: +p.kp || 0, kd: +p.kd || 0, uCap: +p.uMax });
          uP = out.uP; uI = out.uI; uD = out.uD;
          Tcmd = clamp((+p.offset || 0) + out.u, 0, +p.Tmax);
        }
        s.lastE    = e;
        s.lastUP   = uP; s.lastUI = uI; s.lastUD = uD;
        s.lastU    = Tcmd - m * g;
        s.lastFw   = s.wind;
        s.lastTcmd = Tcmd;
      },
      dxdt: (s, p /*, t*/) => {
        const m = +p.mass, g = +p.g, c = +p.drag, tau = +p.tau;
        return {
          h:  s.vh,
          vh: (s.T - m * g - c * s.vh + s.wind) / m,
          T:  (s.lastTcmd - s.T) / Math.max(1e-3, tau),
        };
      },
      integrator: "rk4",
      postStep: (s, p, dt) => {
        s.T = clamp(s.T, 0, +p.Tmax);
        if (s.h < 0)        { s.h = 0;        if (s.vh < 0) s.vh = 0; }
        if (s.h > ALT_MAX)  { s.h = ALT_MAX;  if (s.vh > 0) s.vh = 0; }
        s.lastT = s.T;
        if (holdDetector) holdDetector.step(dt, s, p);
      },
    },

    layout: (W, H) => {
      const groundY   = H - 28;
      const topMargin = 30;
      const altPxPerM = (groundY - topMargin) / ALT_MAX;
      return {
        W, H, groundY, topMargin, altPxPerM,
        altToY: (a) => groundY - a * altPxPerM,
        heliX:  W * 0.55,
      };
    },

    render: (ctx, L, state, params) => {
      const { W, H, groundY, altToY, heliX } = L;

      // Sky gradient
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, "#1a2333");
      grad.addColorStop(1, "#0d1013");
      ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

      // Ground + hatch
      ctx.fillStyle = "#1a1f27"; ctx.fillRect(0, groundY, W, H - groundY);
      ctx.strokeStyle = "#2a313c"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
      for (let x = 0; x < W; x += 14) {
        ctx.beginPath(); ctx.moveTo(x, groundY); ctx.lineTo(x - 8, groundY + 10); ctx.stroke();
      }

      // Altitude scale
      ctx.strokeStyle = "#1e252f"; ctx.lineWidth = 1;
      ctx.fillStyle = "#55606f"; ctx.font = "11px ui-sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (let a = 0; a <= ALT_MAX; a += 10) {
        const y = altToY(a);
        ctx.beginPath(); ctx.moveTo(28, y); ctx.lineTo(W, y); ctx.stroke();
        ctx.fillText(a + " m", 26, y);
      }

      // Reference line + ±2 % band
      const ref = +params.ref || 0;
      const refY = altToY(ref);
      ctx.strokeStyle = LIB.Util.getVar("--cRef");
      ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(34, refY); ctx.lineTo(W - 6, refY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = LIB.Util.getVar("--cRef");
      ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText("ref " + ref.toFixed(1) + " m", W - 8, refY - 3);

      const halfBand = ref * 0.02;
      ctx.fillStyle = "rgba(102,187,106,0.10)";
      ctx.fillRect(34, altToY(ref + halfBand),
                   W - 40, altToY(ref - halfBand) - altToY(ref + halfBand));

      // Helicopter
      const heliY = altToY(state.h);
      drawHelicopter(ctx, heliX, heliY, state.t, state.T / Math.max(1e-3, T_HOVER));

      // Downwash
      const downwashLen = clamp((state.T / T_HOVER) * 30, 6, 80);
      ctx.strokeStyle = "rgba(78,161,255,0.4)"; ctx.lineWidth = 1.5;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        const x = heliX + i * 10;
        ctx.moveTo(x, heliY + 14);
        ctx.lineTo(x, heliY + 14 + downwashLen);
        ctx.stroke();
      }

      // Updraft arrow
      if (Math.abs(state.lastFw) > 1) {
        LIB.Draw.arrow(ctx, 80, heliY, 80, heliY - state.lastFw * 1.5, {
          color: LIB.Util.getVar("--cW"), width: 2, head: 8,
          label: "updraft " + state.lastFw.toFixed(0) + " N", fontSize: 11,
        });
      }

      // Weight + offset arrows side-by-side
      const F_PX = 1.0;
      const cap = (v) => {
        const C = 80; return Math.sign(v) * Math.min(Math.abs(v), C);
      };
      const weight = (+params.mass || M) * (+params.g || G);
      LIB.Draw.arrow(ctx, heliX - 70, heliY, heliX - 70, heliY + cap(weight * F_PX), {
        color: LIB.Util.getVar("--cY"), width: 2, head: 8,
        label: "m·g " + weight.toFixed(0), fontSize: 10,
      });
      if (params.mode !== "bangbang" && (+params.offset || 0) > 0) {
        LIB.Draw.arrow(ctx, heliX - 40, heliY, heliX - 40, heliY - cap((+params.offset) * F_PX), {
          color: LIB.Util.getVar("--cRef"), width: 2, head: 8,
          label: "offset " + (+params.offset).toFixed(0), fontSize: 10,
        });
      }

      // PID component arrows (PID mode only)
      if (params.mode !== "bangbang") {
        const fy = (F) => {
          const CAP = 70; let dy = -F * F_PX;
          if (Math.abs(dy) > CAP) dy = Math.sign(dy) * CAP;
          return dy;
        };
        const baseY = heliY + 30;
        const colDx = 30;
        const colX0 = heliX + 70;
        const items = [
          { F: state.lastUP, color: LIB.Util.getVar("--cP"), label: "P" },
          { F: state.lastUI, color: LIB.Util.getVar("--cI"), label: "I" },
          { F: state.lastUD, color: LIB.Util.getVar("--cD"), label: "D" },
          { F: state.lastU,  color: LIB.Util.getVar("--cU"), label: "u" },
        ];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const x  = colX0 + colDx * i;
          LIB.Draw.arrow(ctx, x, baseY, x, baseY + fy(it.F), {
            color: it.color, width: 2, head: 8,
            label: it.label + " " + it.F.toFixed(0), fontSize: 10,
          });
        }
      }

      // Telemetry
      ctx.fillStyle = "#aab2c0"; ctx.font = "12px ui-sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("T = " + state.T.toFixed(1) + " N  (hover " + (weight).toFixed(1) + ")",
                   10, 8);
      ctx.fillText("h = " + state.h.toFixed(2) + " m   ḣ = " + state.vh.toFixed(2) + " m/s",
                   10, 24);

      if (holdDetector) LIB.Draw.holdBadge(ctx, W, H, holdDetector);
    },

    init: (handle) => {
      mountedHandle = handle;
      holdDetector  = LIB.HoldDetector.create({
        thresholdFrac: 0.02, durationS: 10,
        metric: (s, p) => ({ error: s.h - (+p.ref || 0), scale: +p.ref || 1 }),
      });
    },

    physHz: 240,
  };

  function drawHelicopter(ctx, cx, cy, t, thrustRatio) {
    ctx.fillStyle = "#2b3340"; ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(cx, cy, 28, 14, 0, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#4ea1ff44"; ctx.strokeStyle = "#4ea1ff88";
    ctx.beginPath(); ctx.ellipse(cx + 12, cy - 2, 10, 7, 0, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#2b3340"; ctx.strokeStyle = "#6a7384";
    ctx.beginPath();
    ctx.moveTo(cx - 18, cy - 3);
    ctx.lineTo(cx - 70, cy - 1);
    ctx.lineTo(cx - 70, cy + 1);
    ctx.lineTo(cx - 18, cy + 4);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 65, cy);
    ctx.lineTo(cx - 75, cy - 10);
    ctx.lineTo(cx - 70, cy);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    const tt = t * 18;
    ctx.strokeStyle = "#aab2c0"; ctx.lineWidth = 1.5;
    ctx.save(); ctx.translate(cx - 73, cy - 4); ctx.rotate(tt);
    ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(7, 0); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 24, cy + 14); ctx.lineTo(cx + 22, cy + 14);
    ctx.moveTo(cx - 18, cy + 12); ctx.lineTo(cx - 22, cy + 14);
    ctx.moveTo(cx + 16, cy + 12); ctx.lineTo(cx + 20, cy + 14);
    ctx.stroke();
    ctx.save(); ctx.translate(cx, cy - 10);
    const rotSpd = 30 + thrustRatio * 10;
    ctx.rotate((t * rotSpd) % (2 * Math.PI));
    ctx.strokeStyle = "rgba(230,233,239,0.35)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-44, 0); ctx.lineTo(44, 0); ctx.stroke();
    ctx.strokeStyle = "rgba(230,233,239,0.85)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 44, 0, 2 * Math.PI); ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy - 14); ctx.stroke();
  }

  ControlLessons.heli = SPEC;
})();
