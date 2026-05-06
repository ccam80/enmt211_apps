"use strict";

// =============================================================================
//  2D-rover lesson — two motors driving a body in a planar world. The yaw
//  PID picks how unequal the motors should be; the drive PID picks how
//  strong on average. Click anywhere on the canvas to set a new target.
//
//  Two LIB.PID loops, one per axis: state.yawLoop and state.driveLoop. Both
//  shut off inside the arrival radius (8 cm) so the rover coasts to rest.
// =============================================================================

(function () {
  const ControlLessons = window.ControlLessons || (window.ControlLessons = {});

  const ARM      = 0.25;
  const WORLD_R  = 6;
  const ARRIVE_R = 0.08;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function wrapAngle(a) {
    while (a >  Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }

  let holdDetector = null;

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
      yawLoop:   { I: 0, ePrev: 0 },
      driveLoop: { I: 0, ePrev: 0 },
      lastYE: 0, lastDE: 0,
      lastYP: 0, lastYI: 0, lastYD: 0, lastImb: 0,
      lastDP: 0, lastDI: 0, lastDD: 0, lastAvg: 0,
      lastUL: 0, lastUR: 0,
      t: 0,
    }),

    onReset: (s) => {
      s.tx = 2.5; s.ty = 0;
      s.yawLoop   = { I: 0, ePrev: 0 };
      s.driveLoop = { I: 0, ePrev: 0 };
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
      Targets: {
        kind: "dynamic", title: "Targets",
        items: () => [],
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
            source: (s) => s.lastDE },
        ] },
      { title: "motor command (N)",
        yFmt: (v) => v.toFixed(0),
        series: [
          { label: "uL",  color: LIB.Util.getVar("--cY"), lw: 1.6, source: (s) => s.lastUL },
          { label: "uR",  color: LIB.Util.getVar("--cW"), lw: 1.6, source: (s) => s.lastUR },
          { label: "imb", color: LIB.Util.getVar("--cU"), lw: 1.0, source: (s) => s.lastImb },
          { label: "avg", color: LIB.Util.getVar("--cD"), lw: 1.4, source: (s) => s.lastAvg },
        ] },
    ],

    readouts: () => [
      { label: "x",     units: "m",     value: (s) => s.x.toFixed(2) },
      { label: "y",     units: "m",     value: (s) => s.y.toFixed(2) },
      { label: "θ",     units: "°",     value: (s) => (s.theta * 180 / Math.PI).toFixed(1) },
      { label: "v",     units: "m/s",   value: (s) => s.v.toFixed(2) },
      { label: "ω",     units: "rad/s", value: (s) => s.omega.toFixed(2) },
      { label: "dist",  units: "m",     value: (s) => s.lastDE.toFixed(2) },
      { label: "yaw e", units: "°",     value: (s) => (s.lastYE * 180 / Math.PI).toFixed(1) },
      { label: "uL",    units: "N",     value: (s) => s.lastUL.toFixed(1) },
      { label: "uR",    units: "N",     value: (s) => s.lastUR.toFixed(1) },
    ],

    physics: {
      dof: ["x", "y", "theta", "v", "omega"],
      preStep: (s, p, dt) => {
        if (!s.yawLoop)   s.yawLoop   = { I: 0, ePrev: 0 };
        if (!s.driveLoop) s.driveLoop = { I: 0, ePrev: 0 };
        const dx = s.tx - s.x, dy = s.ty - s.y;
        const dist = Math.hypot(dx, dy);
        const desiredHeading = Math.atan2(dy, dx);
        const yE = wrapAngle(desiredHeading - s.theta);
        const dE = dist;
        const inArrive = dist <= ARRIVE_R;
        const active   = !inArrive;

        // Yaw PID
        let yP = 0, yD = 0, imb = 0;
        if (active) {
          LIB.PID.advance(s.yawLoop, yE, dt,
            { ki: +p.yKi || 0, iClamp: +p.yImax });
          const out = LIB.PID.effort(s.yawLoop, yE, s.omega,
            { kp: +p.yKp || 0, kd: +p.yKd || 0, uCap: +p.yUmax });
          yP = out.uP; yD = out.uD; imb = out.u;
        } else {
          s.yawLoop.I = 0;
        }

        // Drive PID
        let dP = 0, dD = 0, avg = 0;
        if (active) {
          LIB.PID.advance(s.driveLoop, dE, dt,
            { ki: +p.dKi || 0, iClamp: +p.dImax });
          const out = LIB.PID.effort(s.driveLoop, dE, s.v,
            { kp: +p.dKp || 0, kd: +p.dKd || 0, uCap: +p.dUmax });
          dP = out.uP; dD = out.uD; avg = out.u;
        } else {
          s.driveLoop.I = 0;
        }

        const uL = avg - imb;
        const uR = avg + imb;
        s.lastYE = yE; s.lastDE = dE;
        s.lastYP = yP; s.lastYI = s.yawLoop.I;   s.lastYD = yD; s.lastImb = imb;
        s.lastDP = dP; s.lastDI = s.driveLoop.I; s.lastDD = dD; s.lastAvg = avg;
        s.lastUL = uL; s.lastUR = uR;
      },
      dxdt: (s, p) => {
        const m = +p.mass, c = +p.drag, J = +p.inertia, cw = +p.angDrag;
        const F = s.lastUL + s.lastUR;
        const M = (s.lastUR - s.lastUL) * (+p.arm);
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
        s.x = clamp(s.x, -WORLD_R, WORLD_R);
        s.y = clamp(s.y, -WORLD_R, WORLD_R);
        s.theta = wrapAngle(s.theta);
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

      // Cart body
      ctx.save(); ctx.translate(cur.px, cur.py); ctx.rotate(-state.theta);
      const bodyW = scale * 0.7, bodyH = scale * 0.55;
      ctx.fillStyle = "#2b3340"; ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 1.5;
      roundRect(ctx, -bodyW / 2, -bodyH / 2, bodyW, bodyH, 6);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#4ea1ff";
      ctx.beginPath();
      ctx.moveTo( bodyW / 2 - 2, 0);
      ctx.lineTo( bodyW / 2 - 12, -bodyH * 0.32);
      ctx.lineTo( bodyW / 2 - 12,  bodyH * 0.32);
      ctx.closePath(); ctx.fill();
      const motW = bodyW * 0.30, motH = bodyH * 0.22;
      ctx.fillStyle = "#3a4453"; ctx.strokeStyle = "#6a7384";
      ctx.fillRect(-motW / 2, -bodyH / 2 - motH, motW, motH);
      ctx.strokeRect(-motW / 2, -bodyH / 2 - motH, motW, motH);
      ctx.fillRect(-motW / 2,  bodyH / 2,         motW, motH);
      ctx.strokeRect(-motW / 2, bodyH / 2,        motW, motH);

      const motorScaleMax = Math.max(1,
        Math.abs(state.lastUL) + Math.abs(state.lastUR));
      const uS = scale * 0.6 / motorScaleMax;
      LIB.Draw.arrow(ctx, 0, -bodyH / 2 - motH / 2,
                          state.lastUL * uS, -bodyH / 2 - motH / 2, {
        color: LIB.Util.getVar("--cP"), width: 2, head: 6,
        label: "L " + state.lastUL.toFixed(0), fontSize: 10,
      });
      LIB.Draw.arrow(ctx, 0,  bodyH / 2 + motH / 2,
                          state.lastUR * uS,  bodyH / 2 + motH / 2, {
        color: LIB.Util.getVar("--cI"), width: 2, head: 6,
        label: "R " + state.lastUR.toFixed(0), fontSize: 10,
      });
      ctx.restore();

      // Status
      ctx.fillStyle = "#aab2c0"; ctx.font = "12px ui-sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillText("dist " + state.lastDE.toFixed(2) +
                   " m   yaw err " + (state.lastYE * 180 / Math.PI).toFixed(1) + "°", 10, 8);
      ctx.fillText("Click anywhere to set the target.", 10, 24);

      if (holdDetector) LIB.Draw.holdBadge(ctx, W, H, holdDetector);
    },

    onPointer: (type, mx, my, L, state /*, params*/) => {
      if (type !== "down") return;
      const w = L.toWorld({ px: mx, py: my });
      state.tx = clamp(w.x, -WORLD_R + 0.2, WORLD_R - 0.2);
      state.ty = clamp(w.y, -WORLD_R + 0.2, WORLD_R - 0.2);
      if (holdDetector) holdDetector.reset();
    },

    init: () => {
      holdDetector = LIB.HoldDetector.create({
        thresholdFrac: 0.02, durationS: 10,
        metric: (s) => ({ error: s.lastDE, scale: WORLD_R }),
      });
    },

    physHz: 240,
  };

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

  ControlLessons.rover = SPEC;
})();
