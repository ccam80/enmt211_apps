"use strict";

// =============================================================================
//  Car-on-road lesson — keep the car on the centerline against a gusty
//  crosswind. The PID variant integrates the steady offset away; the bang-
//  bang variant deliberately oscillates across the centerline.
//
//  Shared factory `makeCarSpec({windBias, ...})` is exported on
//  window.ControlLessons so carwind.js can reuse it with a non-zero wind bias.
//
//  Controller plumbing follows the LIB.PID / LIB.BangBang.flip convention:
//  state.ctrlLoop = { I, ePrev, bbDir } reserves one loop slot, advance() is
//  called once per step in preStep, effort() is read by preStep too (RK4
//  itself doesn't see the controller — u is latched into state.lastU and
//  dxdt reads it as a constant).
// =============================================================================

(function () {
  const ControlLessons = window.ControlLessons || (window.ControlLessons = {});

  // ---- physical constants (shared between the two car variants) ----
  const ROAD_HALF_W = 2.0;     // road half-width (m)
  const FORWARD_V   = 18;      // forward speed (m/s) — drives the road scroll
  const CAR_HALF_W  = 0.45;
  const CAR_HALF_L  = 0.85;
  const TAU_WIND    = 0.8;     // crosswind correlation time (s)
  const LAT_MASS    = 80;
  const LAT_DRAG    = 1;
  const SIGMA       = 5;       // OU std on the side-wind force (N)

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function makeCarSpec(opts) {
    const windBias = +opts.windBias || 0;

    let holdDetector = null;

    const SPEC = {
      id: opts.id,
      title: opts.title,
      subtitle: opts.subtitle,
      description: opts.description || (
        "<b>Drive sideways, not the car.</b> The car wants the centre line; " +
        "the wind keeps pushing it off. The <i>P</i> term steers proportionally " +
        "to the offset, the <i>I</i> term remembers a steady push the wind keeps " +
        "applying, and the <i>D</i> term pre-empts overshoot. " +
        (windBias !== 0
          ? "This variant adds a <b>steady " + windBias + " N push</b>: pure P " +
            "feedback alone will sit off-centre by F<sub>bias</sub>/K<sub>p</sub> forever — " +
            "only an integrator can lean against it."
          : "There is no steady offset here, so a strong P alone can keep the car near the centre.") +
        " <br/><br/>Bang-bang flips between left and right effort whenever the " +
        "car crosses past the deadband edge — it can never sit still."),

      state: () => ({
        y: 0, vy: 0,
        Fwind: 0,
        ctrlLoop: { I: 0, ePrev: 0, bbDir: 0 },
        scroll: 0,
        lastE: 0, lastUP: 0, lastUI: 0, lastUD: 0,
        lastU: 0, lastDist: 0,
        t: 0,
      }),

      onReset: (state) => {
        state.Fwind = 0;
        state.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
        state.scroll = 0;
        if (holdDetector) holdDetector.reset();
      },

      modes: {
        default: "pid",
        persistKey: opts.id + "-mode",
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
          { key: "kp",     label: "P",     min: 0, max: 1000, step: 0.01, value: 0,
            log: true, logMin: 1,
            tip: "Proportional gain — how hard to steer per metre off centre." },
          { key: "ki",     label: "I",     min: 0, max: 1000, step: 0.01, value: 0,
            log: true, logMin: 1,
            tip: "Integral gain — accumulates a steady push to lean against an average wind." },
          { key: "kd",     label: "D",     min: 0, max: 1000, step: 0.01, value: 0,
            log: true, logMin: 1,
            tip: "Derivative gain (on measured velocity) — damps overshoot." },
          { key: "iClamp", label: "Imax",  min: 0, max: 1000, step: 0.1,  value: 1000,
            log: true, logMin: 1,
            tip: "Cap on the integral term (N). Stops it growing while uMax saturates." },
          { key: "uMax",   label: "uMax",  min: 1, max: 1000, step: 0.1,  value: 1000,
            log: true,
            tip: "Largest steering force the controller can ever command (N)." },
        ];
        const ctrlBB = [
          { key: "dead",   label: "dead",  min: 0, max: 1.5,  step: 0.01, value: 0.0,
            tip: "Deadband width (m). Direction flips after the car crosses past the OPPOSITE edge." },
          { key: "effort", label: "eff",   min: 0, max: 1000, step: 0.1,  value: 0.0,
            log: true, logMin: 1,
            tip: "Steering force the bang-bang controller pushes with (N) — always pushing, never zero." },
          { key: "uMax",   label: "uMax",  min: 1, max: 1000, step: 0.1,  value: 1000,
            log: true,
            tip: "Outer cap on the bang-bang effort (N)." },
        ];
        return {
          Controller: state.mode === "bangbang" ? ctrlBB : ctrlPID,
          System: [
            { key: "mass",  label: "m_lat", min: 10, max: 400, step: 1,   value: LAT_MASS, disabled: true,
              tip: "How heavy the car feels sideways (kg)." },
            { key: "drag",  label: "c",     min: 0,  max: 200, step: 1,   value: LAT_DRAG, disabled: true,
              tip: "How strongly the road resists sideways motion (N per m/s)." },
            { key: "sigma", label: "σ",     min: 0,  max: 15,  step: 0.1, value: SIGMA,    disabled: true,
              tip: "Typical strength of the gusty crosswind (N)." },
          ],
        };
      },

      plots: (state) => {
        const series = [
          { label: "ref", color: LIB.Util.getVar("--cRef"), lw: 1.4,
            source: () => 0 },
          { label: "y",   color: LIB.Util.getVar("--cX"),   lw: 2.0,
            source: (s) => s.y },
        ];
        if (state.mode === "bangbang") {
          series.push(
            { label: "deadHi", color: "#ef5350", lw: 1.0, dash: [4, 4],
              source: (s, p) => +(p.dead || 0) / 2 },
            { label: "deadLo", color: "#ef5350", lw: 1.0, dash: [4, 4],
              source: (s, p) => -(p.dead || 0) / 2 },
          );
        }
        return [
          { title: "lateral position (m)", yMin: -ROAD_HALF_W, yMax: ROAD_HALF_W,
            yFmt: (v) => v.toFixed(2),
            series },
          { title: "control effort & crosswind (N)",
            yFmt: (v) => v.toFixed(0),
            series: [
              { label: "P",    color: LIB.Util.getVar("--cP"), lw: 1.2,
                source: (s) => s.lastUP },
              { label: "I",    color: LIB.Util.getVar("--cI"), lw: 1.2,
                source: (s) => s.lastUI },
              { label: "D",    color: LIB.Util.getVar("--cD"), lw: 1.2,
                source: (s) => s.lastUD },
              { label: "wind", color: LIB.Util.getVar("--cW"), lw: 1.2,
                source: (s) => s.lastDist },
              { label: "u",    color: LIB.Util.getVar("--cU"), lw: 2.0,
                source: (s) => s.lastU },
            ] },
        ];
      },

      readouts: () => [
        { label: "y",     units: "m",   value: (s) => s.y.toFixed(3) },
        { label: "ẏ",    units: "m/s", value: (s) => s.vy.toFixed(3) },
        { label: "err",   units: "m",   value: (s) => s.lastE.toFixed(3) },
        { label: "∫err",                value: (s) => (s.ctrlLoop ? s.ctrlLoop.I : 0).toFixed(3) },
        { label: "P",     units: "N",   value: (s) => s.lastUP.toFixed(2) },
        { label: "I",     units: "N",   value: (s) => s.lastUI.toFixed(2) },
        { label: "D",     units: "N",   value: (s) => s.lastUD.toFixed(2) },
        { label: "u",     units: "N",   value: (s) => s.lastU.toFixed(2) },
        { label: "wind",  units: "N",   value: (s) => s.lastDist.toFixed(2) },
      ],

      physics: {
        dof: ["y", "vy"],
        // PID/bang-bang advance once per step; the ZOH actuator force lives
        // on state.lastU and is read back as a constant during the rk4 stages.
        preStep: (s, p, dt) => {
          if (!s.ctrlLoop) s.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
          s.Fwind = LIB.Noise.ouStep(s.Fwind, +p.sigma || 0, TAU_WIND, dt);
          const e = 0 - s.y;
          let u = 0, uP = 0, uI = 0, uD = 0;
          if (p.mode === "bangbang") {
            LIB.BangBang.flip.advance(s.ctrlLoop, e, { dead: +p.dead || 0 });
            const out = LIB.BangBang.flip.effort(s.ctrlLoop,
              { effort: +p.effort || 0, uCap: +p.uMax });
            u = out.u;
          } else {
            LIB.PID.advance(s.ctrlLoop, e, dt,
              { ki: +p.ki || 0, iClamp: +p.iClamp });
            const out = LIB.PID.effort(s.ctrlLoop, e, s.vy,
              { kp: +p.kp || 0, kd: +p.kd || 0, uCap: +p.uMax });
            uP = out.uP; uI = out.uI; uD = out.uD; u = out.u;
          }
          s.lastE   = e;
          s.lastUP  = uP; s.lastUI = uI; s.lastUD = uD; s.lastU = u;
          s.lastDist = s.Fwind + windBias;
        },
        dxdt: (s, p /*, t*/) => {
          const m = Math.max(1e-3, +p.mass);
          const Ftot = s.lastU - (+p.drag) * s.vy + s.lastDist;
          return { y: s.vy, vy: Ftot / m };
        },
        integrator: "rk4",
        postStep: (s, p, dt) => {
          const yMax = ROAD_HALF_W - CAR_HALF_W;
          if (s.y >  yMax) { s.y =  yMax; if (s.vy > 0) s.vy = 0; }
          if (s.y < -yMax) { s.y = -yMax; if (s.vy < 0) s.vy = 0; }
          s.scroll += FORWARD_V * dt;
          if (holdDetector) holdDetector.step(dt, s, p);
        },
      },

      // Custom layout: a vertical road with the car at fixed screen-Y and
      // lateral world-y → screen-x. We don't use LIB.Layout.linearTrack here
      // because the visual rail is vertical (lanes scroll past) and the
      // built-in rail rendering doesn't fit that idiom.
      layout: (W, H) => {
        const cx = W / 2;
        const usableW = Math.min(W * 0.7, 520);
        const pxPerM = usableW / (2 * ROAD_HALF_W);
        const roadLeft  = cx - ROAD_HALF_W * pxPerM;
        const roadRight = cx + ROAD_HALF_W * pxPerM;
        return { W, H, cx, pxPerM, roadLeft, roadRight,
                 carY: H * 0.62, roadHalfW: ROAD_HALF_W };
      },

      render: (ctx, L, state, params) => {
        const { W, H, cx, pxPerM, roadLeft, roadRight, carY } = L;

        // Verge / road / centre-line scroll
        ctx.fillStyle = "#16191e"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#1a1f27"; ctx.fillRect(roadLeft, 0, roadRight - roadLeft, H);
        ctx.strokeStyle = "#aab2c0"; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(roadLeft + 0.5, 0);  ctx.lineTo(roadLeft + 0.5, H);
        ctx.moveTo(roadRight - 0.5, 0); ctx.lineTo(roadRight - 0.5, H);
        ctx.stroke();

        const dashLen = 4.0;
        const offset  = state.scroll % (dashLen * 2);
        ctx.strokeStyle = "#f6c945"; ctx.lineWidth = 3;
        ctx.setLineDash([dashLen * pxPerM, dashLen * pxPerM]);
        ctx.lineDashOffset = -offset * pxPerM;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;

        // Verge ribs
        ctx.strokeStyle = "#3a4453"; ctx.lineWidth = 1.2;
        const ribStep = 5.0;
        const ribOff = (state.scroll % ribStep) * pxPerM;
        for (let yp = -ribStep * pxPerM + ribOff; yp < H + ribStep; yp += ribStep * pxPerM) {
          ctx.beginPath();
          ctx.moveTo(roadLeft - 14, yp); ctx.lineTo(roadLeft - 4, yp);
          ctx.moveTo(roadRight + 4, yp); ctx.lineTo(roadRight + 14, yp);
          ctx.stroke();
        }

        // Reference triangle (centerline)
        ctx.fillStyle = LIB.Util.getVar("--cRef");
        ctx.beginPath();
        ctx.moveTo(cx, 6); ctx.lineTo(cx - 6, 18); ctx.lineTo(cx + 6, 18);
        ctx.closePath(); ctx.fill();

        // Car body
        const carX = cx + state.y * pxPerM;
        const carW = CAR_HALF_W * 2 * pxPerM;
        const carL = CAR_HALF_L * 2 * pxPerM;
        ctx.save(); ctx.translate(carX, carY);
        ctx.fillStyle = "#2b3340"; ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 1.5;
        roundRect(ctx, -carW/2, -carL/2, carW, carL, 6);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#4ea1ff44"; ctx.strokeStyle = "#4ea1ff88";
        roundRect(ctx, -carW/2 + 4, -carL/2 + 4, carW - 8, carL * 0.32, 4);
        ctx.fill(); ctx.stroke();
        roundRect(ctx, -carW/2 + 4,  carL * 0.10, carW - 8, carL * 0.28, 4);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#12161c";
        const wW = carW * 0.18, wH = carL * 0.18;
        ctx.fillRect(-carW/2 - 3, -carL * 0.30 - wH/2, wW + 3, wH);
        ctx.fillRect( carW/2 - wW, -carL * 0.30 - wH/2, wW + 3, wH);
        ctx.fillRect(-carW/2 - 3,  carL * 0.30 - wH/2, wW + 3, wH);
        ctx.fillRect( carW/2 - wW,  carL * 0.30 - wH/2, wW + 3, wH);
        ctx.fillStyle = "#e6e9ef";
        ctx.fillRect(-1, -carL/2 + 3, 2, 5);
        ctx.restore();

        // Stacked horizontal force arrows above the car
        const F_PX  = 0.6;
        const F_CAP = 220;
        const fx = (F) => {
          let dx = F * F_PX;
          if (Math.abs(dx) > F_CAP) dx = Math.sign(dx) * F_CAP;
          return dx;
        };
        const slotGap = 14;
        const topY = carY - carL / 2 - 8;
        const slots = [{ F: state.lastU, color: LIB.Util.getVar("--cU"), label: "u" }];
        if (params.mode !== "bangbang") {
          slots.push(
            { F: state.lastUP, color: LIB.Util.getVar("--cP"), label: "P" },
            { F: state.lastUI, color: LIB.Util.getVar("--cI"), label: "I" },
            { F: state.lastUD, color: LIB.Util.getVar("--cD"), label: "D" },
          );
        }
        slots.push({ F: state.lastDist, color: LIB.Util.getVar("--cW"), label: "crosswind" });
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          const y = topY - slotGap * i;
          LIB.Draw.arrow(ctx, carX, y, carX + fx(s.F), y, {
            color: s.color, width: 2, head: 8,
            label: s.label + " " + s.F.toFixed(0), fontSize: 10,
          });
        }

        // Telemetry
        ctx.fillStyle = "#aab2c0"; ctx.font = "12px ui-sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText("y = " + state.y.toFixed(2) + " m  (ref 0.00)", cx, 24);

        // Hold-detector overlay
        if (holdDetector) LIB.Draw.holdBadge(ctx, W, H, holdDetector);
      },

      init: (handle) => {
        holdDetector = LIB.HoldDetector.create({
          thresholdFrac: 0.02, durationS: 10,
          metric: (s) => ({ error: s.y, scale: ROAD_HALF_W }),
        });
      },

      physHz: 240,
    };

    return SPEC;
  }

  function roundRect(ctx, x, y, w, h, r) {
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
  }

  ControlLessons._makeCarSpec = makeCarSpec;
  ControlLessons.car = makeCarSpec({
    id: "car",
    title: "Car on Road",
    subtitle: "keep the car on the centerline against a gusty crosswind",
    windBias: 0,
  });
})();
