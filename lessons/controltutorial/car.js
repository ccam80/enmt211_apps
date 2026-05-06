"use strict";

// =============================================================================
//  Car-on-road lesson — keep the car on the centerline against a gusty
//  crosswind. The PID variant integrates the steady offset away; the bang-
//  bang variant deliberately oscillates across the centerline.
//
//  Shared factory `makeCarSpec({windBias, …})` is exported on
//  window.ControlLessons so carwind.js can reuse it with a non-zero wind bias.
//
//  Controller plumbing is fully declarative now: spec.controllers feeds
//  LIB.ControlBlock and the shell stashes the breakdown in state.ctrlOut
//  before the integrator runs. preStep only handles the OU disturbance and
//  the road-scroll bookkeeping.
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
        ctrlOut:  { e: 0, u: 0, uP: 0, uI: 0, uD: 0 },
        scroll: 0,
        lastDist: 0,
        t: 0,
      }),

      onReset: (state) => {
        state.Fwind = 0;
        state.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
        state.ctrlOut  = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 };
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
          series.push(...LIB.Plot.deadbandSeries({ ref: 0, deadKey: "dead" }));
        }
        return [
          { title: "lateral position (m)", yMin: -ROAD_HALF_W, yMax: ROAD_HALF_W,
            yFmt: (v) => v.toFixed(2),
            series },
          { title: "control effort & crosswind (N)",
            yFmt: (v) => v.toFixed(0),
            series: [
              { label: "P",    color: LIB.Util.getVar("--cP"), lw: 1.2,
                source: (s) => s.ctrlOut.uP },
              { label: "I",    color: LIB.Util.getVar("--cI"), lw: 1.2,
                source: (s) => s.ctrlOut.uI },
              { label: "D",    color: LIB.Util.getVar("--cD"), lw: 1.2,
                source: (s) => s.ctrlOut.uD },
              { label: "wind", color: LIB.Util.getVar("--cW"), lw: 1.2,
                source: (s) => s.lastDist },
              { label: "u",    color: LIB.Util.getVar("--cU"), lw: 2.0,
                source: (s) => s.ctrlOut.u },
            ] },
        ];
      },

      readouts: () => [
        { label: "y",     units: "m",   value: (s) => s.y.toFixed(3) },
        { label: "ẏ",    units: "m/s", value: (s) => s.vy.toFixed(3) },
        { label: "err",   units: "m",   value: (s) => s.ctrlOut.e.toFixed(3) },
        { label: "∫err",                value: (s) => (s.ctrlLoop ? s.ctrlLoop.I : 0).toFixed(3) },
        { label: "P",     units: "N",   value: (s) => s.ctrlOut.uP.toFixed(2) },
        { label: "I",     units: "N",   value: (s) => s.ctrlOut.uI.toFixed(2) },
        { label: "D",     units: "N",   value: (s) => s.ctrlOut.uD.toFixed(2) },
        { label: "u",     units: "N",   value: (s) => s.ctrlOut.u.toFixed(2) },
        { label: "wind",  units: "N",   value: (s) => s.lastDist.toFixed(2) },
      ],

      controllers: [
        {
          slot: "ctrlLoop", output: "ctrlOut",
          modeKey: "mode",
          pid: {
            err:   (s)    => 0 - s.y,
            dmeas: (s)    => s.vy,
            gains: (s, p) => ({
              kp: +p.kp || 0, ki: +p.ki || 0, kd: +p.kd || 0,
              iClamp: +p.iClamp, uCap: +p.uMax,
            }),
          },
          bangbang: {
            flavor: "flip",
            err:   (s)    => 0 - s.y,
            gains: (s, p) => ({
              dead: +p.dead || 0, effort: +p.effort || 0, uCap: +p.uMax,
            }),
          },
        },
      ],

      physics: {
        dof: ["y", "vy"],
        // Disturbance advance + plot bookkeeping. The shell runs the
        // controller block immediately AFTER this preStep, so dxdt sees the
        // latched ctrlOut.u as a constant during rk4 sub-evaluations.
        preStep: (s, p, dt) => {
          s.Fwind = LIB.Noise.ouStep(s.Fwind, +p.sigma || 0, TAU_WIND, dt);
          s.lastDist = s.Fwind + windBias;
        },
        dxdt: (s, p) => {
          const m = Math.max(1e-3, +p.mass);
          const Ftot = s.ctrlOut.u - (+p.drag) * s.vy + s.lastDist;
          return { y: s.vy, vy: Ftot / m };
        },
        integrator: "rk4",
        postStep: (s, p, dt) => {
          const yMax = ROAD_HALF_W - CAR_HALF_W;
          LIB.Saturate.box1D(s, "y", -yMax, yMax, "vy");
          s.scroll += FORWARD_V * dt;
          if (holdDetector) holdDetector.step(dt, s, p);
        },
      },

      // Lateral DOF maps horizontally (linearTrack default). The "road runs
      // vertically" is purely scenery painted in render. We keep a function-
      // form layout to bake in the lesson's visual sizing (usableW capped at
      // 520 px) and to expose carY for the renderer.
      layout: (W, H) => {
        const usableW = Math.min(W * 0.7, 520);
        const padX    = Math.max(0, (W - usableW) / 2);
        const L = LIB.Layout.linearTrack(W, H,
          { xMin: -ROAD_HALF_W, xMax: +ROAD_HALF_W, padX, padY: 0 });
        return Object.assign({}, L, { carY: H * 0.62 });
      },

      render: (ctx, L, state, params) => {
        const { W, H, mToPx, carY } = L;
        const cx = L.xToPx(0);
        const roadLeft  = L.xToPx(-ROAD_HALF_W);
        const roadRight = L.xToPx(+ROAD_HALF_W);

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
        ctx.setLineDash([dashLen * mToPx, dashLen * mToPx]);
        ctx.lineDashOffset = -offset * mToPx;
        ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;

        // Verge ribs
        ctx.strokeStyle = "#3a4453"; ctx.lineWidth = 1.2;
        const ribStep = 5.0;
        const ribOff = (state.scroll % ribStep) * mToPx;
        for (let yp = -ribStep * mToPx + ribOff; yp < H + ribStep; yp += ribStep * mToPx) {
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

        // Car body — centralised renderer.
        const carX = L.xToPx(state.y);
        const carW = CAR_HALF_W * 2 * mToPx;
        const carL = CAR_HALF_L * 2 * mToPx;
        LIB.VehicleRender.car(ctx, carX, carY, { width: carW, length: carL });

        // Component arrows above the car: u always shown; P/I/D only in PID
        // mode; crosswind always last in the stack.
        const slots = [
          { F: state.ctrlOut.u, color: LIB.Util.getVar("--cU"), label: "u" },
        ];
        if (params.mode !== "bangbang") {
          slots.push(
            { F: state.ctrlOut.uP, color: LIB.Util.getVar("--cP"), label: "P" },
            { F: state.ctrlOut.uI, color: LIB.Util.getVar("--cI"), label: "I" },
            { F: state.ctrlOut.uD, color: LIB.Util.getVar("--cD"), label: "D" },
          );
        }
        slots.push({ F: state.lastDist, color: LIB.Util.getVar("--cW"), label: "crosswind" });
        const topY = carY - carL / 2 - 8;
        LIB.Draw.componentArrows(ctx, carX, topY, slots, { axis: "x" });

        // Telemetry
        ctx.fillStyle = "#aab2c0"; ctx.font = "12px ui-sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText("y = " + state.y.toFixed(2) + " m  (ref 0.00)", cx, 24);

        if (holdDetector) LIB.Draw.holdBadge(ctx, W, H, holdDetector);
      },

      init: () => {
        holdDetector = LIB.HoldDetector.create({
          thresholdFrac: 0.02, durationS: 10,
          metric: (s) => ({ error: s.y, scale: ROAD_HALF_W }),
        });
      },

      physHz: 240,
    };

    return SPEC;
  }

  ControlLessons._makeCarSpec = makeCarSpec;
  ControlLessons.car = makeCarSpec({
    id: "car",
    title: "Car on Road",
    subtitle: "keep the car on the centerline against a gusty crosswind",
    windBias: 0,
  });
})();
