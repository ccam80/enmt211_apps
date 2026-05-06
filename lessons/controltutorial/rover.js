"use strict";

// =============================================================================
//  2D-rover lesson — two motors driving a body in a planar world. The yaw
//  PID picks how unequal the motors should be; the drive PID picks how
//  strong on average. Click anywhere on the canvas to set a new target.
//
//  Two declarative LIB.ControlBlock entries (yaw + drive). Both share an
//  `enable` predicate that shuts them off inside the arrival radius (8 cm)
//  so the rover coasts to rest with both integrators reset.
// =============================================================================

(function () {
  const ControlLessons = window.ControlLessons || (window.ControlLessons = {});

  const ARM      = 0.25;
  const WORLD_R  = 6;
  const ARRIVE_R = 0.08;

  let holdDetector = null;

  function active(s) {
    const dx = s.tx - s.x, dy = s.ty - s.y;
    return Math.hypot(dx, dy) > ARRIVE_R;
  }

  const SPEC = {
    id: "rover",
    title: "2D Rover",
    subtitle: "drive to the click point with two motors and two PIDs",
    description:
      "<b>Two motors, two jobs.</b> The <i>yaw</i> PID points the rover at the " +
      "target by making the motors unequal; the <i>drive</i> PID pushes both motors " +
      "forward by the same amount. Final motor commands are <i>avg ± imbalance</i>, " +
      "clamped at each PID's own <i>uMax</i>. " +
      "<br/><br/>Click anywhere on the canvas to set a target. " +
      "Both controllers shut off inside the arrival radius (8 cm) so the rover coasts to rest.",

    state: () => ({
      x: 0, y: 0, theta: 0, v: 0, omega: 0,
      tx: 2.5, ty: 0,
      yawLoop:   { I: 0, ePrev: 0, bbDir: 0 },
      driveLoop: { I: 0, ePrev: 0, bbDir: 0 },
      yawOut:    { e: 0, u: 0, uP: 0, uI: 0, uD: 0 },
      driveOut:  { e: 0, u: 0, uP: 0, uI: 0, uD: 0 },
      lastDist: 0,
      t: 0,
    }),

    onReset: (s) => {
      s.tx = 2.5; s.ty = 0;
      s.yawLoop   = { I: 0, ePrev: 0, bbDir: 0 };
      s.driveLoop = { I: 0, ePrev: 0, bbDir: 0 };
      s.yawOut    = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 };
      s.driveOut  = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 };
      if (holdDetector) holdDetector.reset();
    },

    sliders: () => ({
      Yaw: [
        { key: "yKp",   label: "yP",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1,
          tip: "Yaw proportional gain." },
        { key: "yKi",   label: "yI",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1,
          tip: "Yaw integral gain." },
        { key: "yKd",   label: "yD",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1,
          tip: "Yaw derivative gain (on −ω)." },
        { key: "yImax", label: "yImax", min: 0, max: 1000, step: 0.1,  value: 1000, log: true, logMin: 1 },
        { key: "yUmax", label: "yUmax", min: 1, max: 1000, step: 0.1,  value: 1000, log: true,
          tip: "Cap on the yaw output (the motor imbalance)." },
      ],
      Drive: [
        { key: "dKp",   label: "dP",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1,
          tip: "Drive proportional gain — pushes on distance error." },
        { key: "dKi",   label: "dI",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1 },
        { key: "dKd",   label: "dD",    min: 0, max: 1000, step: 0.01, value: 0,    log: true, logMin: 1 },
        { key: "dImax", label: "dImax", min: 0, max: 1000, step: 0.1,  value: 1000, log: true, logMin: 1 },
        { key: "dUmax", label: "dUmax", min: 1, max: 1000, step: 0.1,  value: 1000, log: true,
          tip: "Cap on the drive output (the motor average)." },
      ],
      System: [
        { key: "mass",    label: "m",  min: 1,    max: 50, step: 0.1,  value: 5,   disabled: true,
          tip: "Rover mass (kg)." },
        { key: "drag",    label: "c",  min: 0,    max: 50, step: 0.1,  value: 6,   disabled: true,
          tip: "Forward drag (N per m/s)." },
        { key: "inertia", label: "J",  min: 0.05, max: 5,  step: 0.01, value: 0.6, disabled: true,
          tip: "Yaw inertia." },
        { key: "angDrag", label: "cω", min: 0,    max: 20, step: 0.05, value: 1.5, disabled: true,
          tip: "Yaw drag." },
        { key: "arm",     label: "L",  min: 0.05, max: 1,  step: 0.01, value: ARM, disabled: true,
          tip: "Distance from centre to each motor (m)." },
      ],
      // Buttons-only panel: the actions mutate target state directly. The
      // shell renders these without any sliders.
      Targets: {
        title: "Targets",
        actions: [
          { label: "(2.5, 0)", run: (s) => { s.tx = 2.5; s.ty = 0;  if (holdDetector) holdDetector.reset(); } },
          { label: "(-2, 2)",  run: (s) => { s.tx = -2;  s.ty = 2;  if (holdDetector) holdDetector.reset(); } },
          { label: "(0, -3)",  run: (s) => { s.tx = 0;   s.ty = -3; if (holdDetector) holdDetector.reset(); } },
          { label: "(4, 4)",   run: (s) => { s.tx = 4;   s.ty = 4;  if (holdDetector) holdDetector.reset(); } },
        ],
      },
    }),

    plots: () => [
      { title: "distance to target (m)", yMin: 0, yMax: 8,
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "ref",  color: LIB.Util.getVar("--cRef"), lw: 1.4, source: () => 0 },
          { label: "dist", color: LIB.Util.getVar("--cX"),   lw: 2.0,
            source: (s) => s.driveOut.e },
        ] },
      { title: "motor command (N)",
        yFmt: (v) => v.toFixed(0),
        series: [
          { label: "uL",  color: LIB.Util.getVar("--cY"), lw: 1.6,
            source: (s) => s.driveOut.u - s.yawOut.u },
          { label: "uR",  color: LIB.Util.getVar("--cW"), lw: 1.6,
            source: (s) => s.driveOut.u + s.yawOut.u },
          { label: "imb", color: LIB.Util.getVar("--cU"), lw: 1.0,
            source: (s) => s.yawOut.u },
          { label: "avg", color: LIB.Util.getVar("--cD"), lw: 1.4,
            source: (s) => s.driveOut.u },
        ] },
    ],

    readouts: () => [
      { label: "x",     units: "m",     value: (s) => s.x.toFixed(2) },
      { label: "y",     units: "m",     value: (s) => s.y.toFixed(2) },
      { label: "θ",     units: "°",     value: (s) => (s.theta * 180 / Math.PI).toFixed(1) },
      { label: "v",     units: "m/s",   value: (s) => s.v.toFixed(2) },
      { label: "ω",     units: "rad/s", value: (s) => s.omega.toFixed(2) },
      { label: "dist",  units: "m",     value: (s) => s.driveOut.e.toFixed(2) },
      { label: "yaw e", units: "°",     value: (s) => (s.yawOut.e * 180 / Math.PI).toFixed(1) },
      { label: "uL",    units: "N",     value: (s) => (s.driveOut.u - s.yawOut.u).toFixed(1) },
      { label: "uR",    units: "N",     value: (s) => (s.driveOut.u + s.yawOut.u).toFixed(1) },
    ],

    controllers: [
      // Yaw — motor imbalance.
      {
        slot: "yawLoop", output: "yawOut",
        enable: active,
        pid: {
          err:   (s) => {
            const dx = s.tx - s.x, dy = s.ty - s.y;
            return LIB.Util.wrapAngle(Math.atan2(dy, dx) - s.theta);
          },
          dmeas: (s) => s.omega,
          gains: (s, p) => ({
            kp: +p.yKp || 0, ki: +p.yKi || 0, kd: +p.yKd || 0,
            iClamp: +p.yImax, uCap: +p.yUmax,
          }),
        },
      },
      // Drive — motor average.
      {
        slot: "driveLoop", output: "driveOut",
        enable: active,
        pid: {
          err:   (s) => Math.hypot(s.tx - s.x, s.ty - s.y),
          dmeas: (s) => s.v,
          gains: (s, p) => ({
            kp: +p.dKp || 0, ki: +p.dKi || 0, kd: +p.dKd || 0,
            iClamp: +p.dImax, uCap: +p.dUmax,
          }),
        },
      },
    ],

    physics: {
      dof: ["x", "y", "theta", "v", "omega"],
      dxdt: (s, p) => {
        const m = +p.mass, c = +p.drag, J = +p.inertia, cw = +p.angDrag;
        const uL = s.driveOut.u - s.yawOut.u;
        const uR = s.driveOut.u + s.yawOut.u;
        const F = uL + uR;
        const M = (uR - uL) * (+p.arm);
        return {
          x:     s.v * Math.cos(s.theta),
          y:     s.v * Math.sin(s.theta),
          theta: s.omega,
          v:     (F - c * s.v)  / Math.max(1e-3, m),
          omega: (M - cw * s.omega) / Math.max(1e-3, J),
        };
      },
      integrator: "rk4",
      postStep: (s, p, dt) => {
        LIB.Saturate.box2D(s, "x", "y", WORLD_R, WORLD_R);
        s.theta = LIB.Util.wrapAngle(s.theta);
        if (holdDetector) holdDetector.step(dt, s, p);
      },
    },

    layout: { kind: "world2D",
              worldW: 2 * WORLD_R, worldH: 2 * WORLD_R, padPx: 18 },

    render: (ctx, L, state /*, params*/) => {
      const { W, H, scale } = L;
      const half = WORLD_R * scale;
      const cx = L.originPx.x, cy = L.originPx.y;

      // Grid
      ctx.strokeStyle = "#1e252f"; ctx.lineWidth = 1;
      for (let g = -WORLD_R; g <= WORLD_R; g++) {
        const p = L.toPx({ x: g, y: 0 });
        ctx.beginPath(); ctx.moveTo(p.px, cy - half); ctx.lineTo(p.px, cy + half); ctx.stroke();
        const q = L.toPx({ x: 0, y: g });
        ctx.beginPath(); ctx.moveTo(cx - half, q.py); ctx.lineTo(cx + half, q.py); ctx.stroke();
      }
      ctx.strokeStyle = "#3a4453"; ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - half, cy - half, 2 * half, 2 * half);

      ctx.fillStyle = "#55606f"; ctx.font = "11px ui-sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("0,0", cx + 4, cy + 4);

      // Target
      const tgt = L.toPx({ x: state.tx, y: state.ty });
      ctx.strokeStyle = LIB.Util.getVar("--cRef"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(tgt.px, tgt.py, 14, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tgt.px - 18, tgt.py); ctx.lineTo(tgt.px + 18, tgt.py);
      ctx.moveTo(tgt.px, tgt.py - 18); ctx.lineTo(tgt.px, tgt.py + 18);
      ctx.stroke();
      ctx.fillStyle = LIB.Util.getVar("--cRef");
      ctx.font = "12px ui-sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
      ctx.fillText("(" + state.tx.toFixed(2) + ", " + state.ty.toFixed(2) + ")",
                   tgt.px + 18, tgt.py - 4);

      // Hold band
      const bandR = WORLD_R * 0.02 * scale;
      ctx.fillStyle = "rgba(102,187,106,0.10)";
      ctx.beginPath(); ctx.arc(tgt.px, tgt.py, bandR, 0, 2 * Math.PI); ctx.fill();

      // Direction line
      const cur = L.toPx({ x: state.x, y: state.y });
      ctx.strokeStyle = "rgba(102,187,106,0.35)"; ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cur.px, cur.py); ctx.lineTo(tgt.px, tgt.py); ctx.stroke();
      ctx.setLineDash([]);

      // Rover body — centralised renderer with motor-arrow overlay.
      const uL = state.driveOut.u - state.yawOut.u;
      const uR = state.driveOut.u + state.yawOut.u;
      LIB.VehicleRender.rover(ctx, cur.px, cur.py, state.theta, {
        bodyW: scale * 0.7, bodyH: scale * 0.55,
      }, { uL, uR, scale });

      // Status
      ctx.fillStyle = "#aab2c0"; ctx.font = "12px ui-sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("dist " + state.driveOut.e.toFixed(2) +
                   " m   yaw err " + (state.yawOut.e * 180 / Math.PI).toFixed(1) + "°", 10, 8);
      ctx.fillText("Click anywhere to set the target.", 10, 24);

      if (holdDetector) LIB.Draw.holdBadge(ctx, W, H, holdDetector);
    },

    onPointer: (type, mx, my, L, state /*, params*/) => {
      if (type !== "down") return;
      const w = L.toWorld({ px: mx, py: my });
      state.tx = LIB.Util.clamp(w.x, -WORLD_R + 0.2, WORLD_R - 0.2);
      state.ty = LIB.Util.clamp(w.y, -WORLD_R + 0.2, WORLD_R - 0.2);
      if (holdDetector) holdDetector.reset();
    },

    init: () => {
      holdDetector = LIB.HoldDetector.create({
        thresholdFrac: 0.02, durationS: 10,
        metric: (s) => ({ error: s.driveOut.e, scale: WORLD_R }),
      });
    },

    physHz: 240,
  };

  ControlLessons.rover = SPEC;
})();
