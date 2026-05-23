"use strict";

// =============================================================================
//  Cart-on-spring lesson — direct-force PID against a mass-spring-damper plant.
//
//  Single-loop PID (or hysteresis bang-bang) drives a force u that's applied
//  directly to the cart — no motor, no velocity loop, no transmission. This
//  is the canonical PID-tuning playground: pure P leaves a steady-state
//  offset against constant wind, I removes it, D damps the porpoise, and
//  bang-bang's deadband sets the limit-cycle amplitude.
//
//  Plant
//  -----
//      m·ẍ = -k·(x - L0) + F_bumper(x) - c·ẋ + u + F_wind
//      F_bumper engages when the cart enters x < X_BUMP (stiff penalty spring
//      against the wall — the cart cannot pass through). Modelled via
//      LIB.EndStop.force with cBump = 0 (matches the original soft bumper).
//
//  Controller
//  ----------
//    Declarative: spec.controllers feeds LIB.ControlBlock and the shell
//    stashes the breakdown in state.ctrlOut before the integrator runs.
//    Bang-bang uses the latch flavour with dir = sign(ref − L0) (force only
//    pushes when error is on the ref-side of the spring's natural rest).
//
//  Pointer
//  -------
//    LIB.Drag.hbar — drag the cart body horizontally. preStep/postStep
//    override state.x/state.v while held so the cart is dead-still under
//    the pointer regardless of the controller's command. The controller
//    keeps running while held — the I-term builds up against the imposed
//    "disturbance" and you can watch it wind in the plots.
// =============================================================================

(function () {

  const X_MIN         = 0;
  const X_MAX         = 5;
  const L0            = 2.0;     // spring natural length (m)
  const X_BUMP        = 0.35;    // wall bumper engages when x < X_BUMP (m)
  const K_BUMP        = 5000;    // bumper stiffness (N/m)
  const CART_HALF_W_M = 0.18;    // cart half-width in metres (for drag bounds + safety)

  // ---------------------------------------------------------------------------
  //  Pointer drag
  // ---------------------------------------------------------------------------

  function hitCart(state, L, mx, my) {
    const g = state._geom;
    if (!g) return false;
    const sx = L.xToPx(state.x);
    return Math.abs(mx - sx) < g.bodyW / 2 + 8
        && my >= g.cy - g.bodyH / 2 - 4
        && my <= g.axleY + g.wheelR + 2;
  }

  const dragger = LIB.Drag.hbar({
    kind: "cart",
    hitTest: (state, params, L, mx, my) => hitCart(state, L, mx, my),
    worldX: (mx, L) => L.pxToX(mx),
    bounds: () => ({ min: CART_HALF_W_M, max: X_MAX - CART_HALF_W_M }),
    onSeedV: (state) => state.v,
  });

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

  function dxdt(state, p, t) {
    const m = Math.max(1e-6, p.mass);
    const Fend = LIB.EndStop.force(state.x, state.v, X_BUMP, +Infinity, K_BUMP, 0);
    const F = -p.k * (state.x - L0)
            + Fend
            - p.c * state.v
            + (state.ctrlOut ? state.ctrlOut.u : 0)
            + (p.wind || 0);
    return { x: state.v, v: F / m };
  }

  function preStep(state, p, dt) {
    dragger.preStep(state, dt);
    if (dragger.isActive(state)) {
      // Pointer is holding the cart — pin DOF so the cart is dead-still
      // under the pointer. The controller keeps running (so I accumulates
      // against the imposed disturbance the user creates).
      state.x = state.drag.value;
      state.v = 0;
    }
  }

  function postStep(state, p, dt) {
    if (dragger.isActive(state)) {
      state.x = state.drag.value;
      state.v = 0;
    }
    // Hard-wall safety net at x = CART_HALF_W_M (cart left edge at world 0).
    LIB.Saturate.box1D(state, "x", CART_HALF_W_M, X_MAX - CART_HALF_W_M, "v");
  }

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------

  function render(ctx, L, state, p) {
    const W = L.W, H = L.H;
    const fsmall = Math.max(9, Math.min(W, H) * 0.022);
    const fbase  = Math.max(10, Math.min(W, H) * 0.028);

    const groundY = L.trackY;
    const wallSx  = L.xToPx(0);
    const wallTop = groundY - Math.max(80, H * 0.25);

    // Floor + axis ticks, wall block, reference marker — all centralised.
    LIB.Draw.cartGround(ctx, L, { fsmall });
    LIB.Draw.wall(ctx, wallSx, wallTop, groundY);

    // Cart geometry.
    const bodyH  = Math.max(22, H * 0.07);
    const bodyW  = Math.max(50, bodyH * 2.3);
    const wheelR = Math.max(7, bodyH * 0.36);
    const axleY  = groundY - wheelR;
    const cy     = axleY - bodyH / 2;
    const cx     = L.xToPx(state.x);
    state._geom = { bodyW, bodyH, wheelR, axleY, cy };

    // Bumper spring (wall vs cart left edge).
    const bumperPlateX = L.xToPx(Math.min(state.x - CART_HALF_W_M, X_BUMP));
    const bumperHot = state.x < X_BUMP + 0.02;
    LIB.Draw.spring(ctx, wallSx, cy + bodyH * 0.15,
                    bumperPlateX, 6, Math.max(4, bodyH * 0.15),
                    { color: bumperHot ? "#ef5350" : "#8a93a3",
                      width: Math.max(1.5, fsmall * 0.15) });
    ctx.fillStyle = bumperHot ? "#ef5350" : "#5a6575";
    ctx.fillRect(bumperPlateX - 2, cy + bodyH * 0.15 - bodyH * 0.22,
                 4, bodyH * 0.44);

    // Main spring (wall to cart left hook).
    const hookX = cx - bodyW / 2 - 6;
    LIB.Draw.spring(ctx, wallSx, cy - bodyH * 0.15,
                    hookX, 10, Math.max(5, bodyH * 0.22),
                    { color: "#c0c9d8",
                      width: Math.max(1.5, fsmall * 0.18) });

    // Reference marker.
    LIB.Draw.refMarker(ctx, L.xToPx(p.ref || 0), wallTop - 12, groundY, {
      color: LIB.Util.getVar("--cRef"),
      label: "ref " + (p.ref || 0).toFixed(2),
      font:  fsmall + "px ui-sans-serif",
    });

    // Cart.
    LIB.CartRender.draw(ctx, {
      cx, cy, bodyW, bodyH, wheelR, axleY,
      x: state.x,
      mToPx: L.mToPx,
      lineW: Math.max(1, fsmall * 0.12),
      springHookY: cy - bodyH * 0.15,
      windowColor: LIB.Util.getVar("--cX"),
      markerY1: wallTop - 4,
      markerY2: groundY,
    });

    // Force-arrow stack above the cart.
    const F_PX_PER_N = Math.min(0.8, (W * 0.18) / 200);
    const F_CAP_PX   = Math.min(W * 0.35, 300);
    const out = state.ctrlOut;
    const slots = [
      { color: LIB.Util.getVar("--cU"), F: out.u,  label: "u" },
    ];
    if (p.mode !== "bangbang") {
      slots.push(
        { color: LIB.Util.getVar("--cP"), F: out.uP, label: "P" },
        { color: LIB.Util.getVar("--cI"), F: out.uI, label: "I" },
        { color: LIB.Util.getVar("--cD"), F: out.uD, label: "D" },
      );
    }
    slots.push(
      { color: LIB.Util.getVar("--cW"), F: p.wind || 0, label: "wind" },
    );
    LIB.CartRender.forceArrows(ctx, cx, cy - bodyH / 2, slots,
      { fsmall, slotGap: Math.max(14, fbase * 1.35),
        F_PX_PER_N, F_CAP_PX });
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "pid-single-cart",
    title: "PID — cart on spring",
    subtitle: "single mass against a wall, driven by direct force",
    description: `<b>cart on spring</b> — mass-spring-damper with a wall bumper. <i>u</i> is a horizontal force applied directly to the cart (no motor model). PID and bang-bang share the same actuator path and saturation. Watch how the I term <i>integrates</i> a steady wind disturbance away while pure P leaves an offset proportional to wind/Kp; how D damps the porpoise; and how bang-bang's deadband sets the limit-cycle amplitude. Drag the cart to disturb it; release to let the controller recover.`,

    state: () => ({
      x: L0, v: 0,
      ctrlLoop: { I: 0, ePrev: 0, bbDir: 0 },
      ctrlOut:  { e: 0, u: 0, uP: 0, uI: 0, uD: 0 },
      drag: null,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      s.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
      s.ctrlOut  = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 };
    },

    modes: {
      default: "pid",
      persistKey: "pid-single-cart-mode",
      list: [
        { id: "pid",      label: "PID" },
        { id: "bangbang", label: "Bang-bang" },
      ],
      onChange: (state) => {
        // Stale latch / integrator state would carry the wrong sign across
        // the swap.
        state.ctrlLoop = { I: 0, ePrev: 0, bbDir: 0 };
      },
    },

    sliders: (state) => {
      const Reference = { span: "full", items: [
        { key: "ref", label: "ref", min: 0.3, max: 4.5, step: 0.01, value: 2.0,
          tip: "Target cart position (m). Spring equilibrium is L₀ = " + L0.toFixed(2) + " m." },
      ]};
      const Controller = (state.mode === "bangbang")
        ? [
            { key: "dead",   label: "dead", min: 0,  max: 2,    step: 0.01, value: 0.10,
              tip: "Deadband width (m). Hysteresis around the reference: thrust latches on/off when |error| crosses ±dead/2." },
            { key: "effort", label: "eff",  min: 0,  max: 1000, step: 1,    value: 200,
              tip: "Effort magnitude (N). Sign is set by ref vs spring equilibrium." },
            { key: "uMax",   label: "uMax", min: 0,  max: 1000, step: 1,    value: 1000,
              tip: "Actuator saturation: |u| clamped to this." },
          ]
        : [
            { key: "kp",     label: "P",    min: 0,  max: 400,  step: 0.1,  value: 0,
              tip: "Proportional gain (N/m)." },
            { key: "ki",     label: "I",    min: 0,  max: 400,  step: 0.1,  value: 0,
              tip: "Integral gain (N/m·s). Removes steady-state error against constant wind." },
            { key: "kd",     label: "D",    min: 0,  max: 100,  step: 0.05, value: 0,
              tip: "Derivative gain (N·s/m). Damps overshoot. Computed on measured velocity, not error." },
            { key: "iClamp", label: "Imax", min: 0,  max: 400,  step: 1,    value: 400,
              tip: "Anti-windup: caps |I| (the integral term's contribution to u, in N)." },
            { key: "uMax",   label: "uMax", min: 0,  max: 1000, step: 1,    value: 1000,
              tip: "Actuator saturation: final clamp on |u| after P+I+D." },
          ];
      const Mechanism = [
        { key: "mass", label: "m", min: 0.1, max: 1000, step: 0.01, value: 1.0, log: true,
          tip: "Cart mass (kg)." },
        { key: "c",    label: "c", min: 0,   max: 20,   step: 0.01, value: 0.5,
          tip: "Linear damping (N·s/m). Models air drag + bearing friction." },
        { key: "k",    label: "k", min: 0,   max: 200,  step: 0.1,  value: 20,
          tip: "Spring stiffness (N/m). Equilibrium at L₀ = " + L0.toFixed(2) + " m." },
      ];
      const Environment = [
        { key: "wind", label: "wind", min: -200, max: 200, step: 0.1, value: 0,
          tip: "Steady horizontal wind force on the cart (N). Pure P alone leaves an offset of wind/Kp; only an integrator (or bang-bang) can lean against it." },
      ];
      return { Reference, Controller, Mechanism, Environment };
    },

    plots: (state) => {
      const positionSeries = [
        { label: "ref", color: LIB.Util.getVar("--cRef"), lw: 1.4,
          source: (s, p) => p.ref || 0 },
        { label: "x",   color: LIB.Util.getVar("--cX"),   lw: 2.0,
          source: (s) => s.x },
      ];
      if (state.mode === "bangbang") {
        positionSeries.push(...LIB.Plot.deadbandSeries({ refKey: "ref", deadKey: "dead" }));
      }
      const effortSeries = [
        { label: "u", color: LIB.Util.getVar("--cU"), lw: 2.0,
          source: (s) => s.ctrlOut.u },
      ];
      if (state.mode !== "bangbang") {
        effortSeries.push(
          { label: "P", color: LIB.Util.getVar("--cP"), lw: 1.2,
            source: (s) => s.ctrlOut.uP },
          { label: "I", color: LIB.Util.getVar("--cI"), lw: 1.2,
            source: (s) => s.ctrlOut.uI },
          { label: "D", color: LIB.Util.getVar("--cD"), lw: 1.2,
            source: (s) => s.ctrlOut.uD },
        );
      }
      effortSeries.push(
        { label: "wind", color: LIB.Util.getVar("--cW"), lw: 1.2,
          source: (s, p) => p.wind || 0 },
      );
      return [
        { title: "position vs time (m)",
          yFmt: (v) => v.toFixed(2),
          yFloor: { lo: 0, hi: 5 },
          yChunk: 1,
          series: positionSeries },
        { title: "control effort (N)",
          yFmt: (v) => v.toFixed(0),
          yFloor: { lo: -200, hi: 200 },
          yChunk: 100,
          series: effortSeries },
      ];
    },

    readouts: () => [
      { label: "x",     units: "m",   value: (s) => s.x.toFixed(3) },
      { label: "v",     units: "m/s", value: (s) => s.v.toFixed(3) },
      { label: "err",   units: "m",   value: (s) => s.ctrlOut.e.toFixed(3) },
      { label: "∫err",                value: (s) => (s.ctrlLoop.I || 0).toFixed(3) },
      { label: "u",     units: "N",   value: (s) => s.ctrlOut.u.toFixed(2) },
      { label: "P",     units: "N",   value: (s) => s.ctrlOut.uP.toFixed(2) },
      { label: "I",     units: "N",   value: (s) => s.ctrlOut.uI.toFixed(2) },
      { label: "D",     units: "N",   value: (s) => s.ctrlOut.uD.toFixed(2) },
      { label: "wind",  units: "N",   value: (s, p) => (p.wind || 0).toFixed(2) },
    ],

    controllers: [
      {
        slot: "ctrlLoop", output: "ctrlOut",
        modeKey: "mode",
        pid: {
          err:   (s, p) => (p.ref || 0) - s.x,
          dmeas: (s)    => s.v,
          gains: (s, p) => ({
            kp: +p.kp || 0, ki: +p.ki || 0, kd: +p.kd || 0,
            iClamp: +p.iClamp, uCap: +p.uMax,
          }),
        },
        bangbang: {
          flavor: "latch",
          err:  (s, p) => (p.ref || 0) - s.x,
          dir:  (s, p) => (p.ref > L0) ? 1 : (p.ref < L0 ? -1 : 0),
          gains: (s, p) => ({
            dead: +p.dead || 0, effort: +p.effort || 0, uCap: +p.uMax,
          }),
        },
      },
    ],

    physics: {
      dof: ["x", "v"],
      dxdt,
      integrator: "rk4",
      preStep, postStep,
    },

    layout: { kind: "linearTrack",
              xMin: X_MIN, xMax: X_MAX,
              padX: 60, padY: 30, trackFrac: 0.7 },

    dragControls: [
      { label: "Cart", desc: "drag horizontally to disturb" },
    ],

    render,
    onPointer: (type, mx, my, L, state, params) =>
      dragger.handle(type, mx, my, L, state, params),

    icon: (ctx, W, H) => {
      const S = Math.min(W, H);
      const accent = LIB.Util.getVar("--accent");
      const ink    = LIB.Util.getVar("--ink");
      const muted  = LIB.Util.getVar("--muted");

      const cy = H * 0.55;
      const padX = W * 0.06;
      const wallW = S * 0.04;
      const wallH = S * 0.40;
      const wallX = padX;
      const wallY = cy - wallH * 0.55;

      // Track baseline
      ctx.strokeStyle = muted + "aa";
      ctx.lineWidth = Math.max(2, S * 0.008);
      ctx.beginPath();
      ctx.moveTo(padX, cy + S * 0.10);
      ctx.lineTo(W - padX, cy + S * 0.10);
      ctx.stroke();

      // Ground hatch
      ctx.strokeStyle = muted + "66";
      ctx.lineWidth = Math.max(1, S * 0.004);
      const hatchStep = S * 0.05;
      for (let x = padX; x <= W - padX; x += hatchStep) {
        ctx.beginPath();
        ctx.moveTo(x, cy + S * 0.10);
        ctx.lineTo(x - S * 0.025, cy + S * 0.14);
        ctx.stroke();
      }

      // Left wall
      ctx.fillStyle = "#2a313c";
      ctx.fillRect(wallX, wallY, wallW, wallH);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, S * 0.004);
      ctx.strokeRect(wallX, wallY, wallW, wallH);

      // Cart
      const cartW = S * 0.26, cartH = S * 0.22;
      const cartCx = W * 0.62;
      const cartCy = cy - S * 0.02;
      ctx.fillStyle = accent;
      ctx.fillRect(cartCx - cartW / 2, cartCy - cartH / 2, cartW, cartH);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.005);
      ctx.strokeRect(cartCx - cartW / 2, cartCy - cartH / 2, cartW, cartH);

      // Wheels
      ctx.fillStyle = "#1f242c";
      const wr = S * 0.025;
      ctx.beginPath();
      ctx.arc(cartCx - cartW * 0.32, cartCy + cartH / 2, wr, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cartCx + cartW * 0.32, cartCy + cartH / 2, wr, 0, Math.PI * 2);
      ctx.fill();

      // Spring zigzag, wall → cart
      ctx.strokeStyle = ink + "cc";
      ctx.lineWidth = Math.max(1.2, S * 0.005);
      const sx0 = wallX + wallW;
      const sx1 = cartCx - cartW / 2;
      const segs = 9;
      const amp = S * 0.04;
      ctx.beginPath();
      ctx.moveTo(sx0, cartCy);
      for (let i = 1; i < segs; i++) {
        const x = sx0 + ((sx1 - sx0) * i) / segs;
        const y = cartCy + (i % 2 === 0 ? -amp : amp);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(sx1, cartCy);
      ctx.stroke();
    },

    physHz: 240,
  };

  (window.PidControlLessons = window.PidControlLessons || {}).singleCart = SPEC;
})();
