"use strict";

// =============================================================================
//  Three-cart spring-damper train — PID drives cart 1; the controlled output
//  is cart 3, two springs and a damper away. The first time most students
//  meet a non-collocated controller: P alone may stabilise the cart you're
//  pushing while leaving the cart you care about ringing. The point of the
//  lesson is to feel that distance.
//
//  Plant
//  -----
//      Three identical-by-default masses linked by springs+dampers (natural
//      length 1 m). Equilibrium at x = 1, 2, 3. Wall bumper against cart 1.
//      Cart-cart contact penalty when bodies overlap. Wind is applied to all
//      three. Control u is applied to cart 1 only.
//
//      e = ref - x[2]                          (error on cart 3)
//      dmeas = v[2]                            (derivative on cart 3's velocity)
//
//  Pointer drag
//  ------------
//      Three LIB.Drag.hbar draggers in a mux, hit-tested per-cart. preStep
//      and postStep clobber the dragged cart's x/v so the held cart is
//      completely under pointer control.
// =============================================================================

(function () {

  const N             = 3;
  const X_MIN         = 0;
  const X_MAX         = 5;
  const EQ            = [1.0, 2.0, 3.0];
  const REF_EQ        = EQ[2];          // cart-3 equilibrium = open-loop rest
  const L_LINK        = 1.0;            // natural length of every link spring (m)
  const X_BUMP        = 0.35;           // wall bumper engages when x[0] < X_BUMP
  const K_BUMP        = 5000;           // bumper / contact stiffness (N/m)
  const CART_HALF_W_M = 0.18;
  const MIN_GAP       = 2 * CART_HALF_W_M;

  const DOF = ["x0", "v0", "x1", "v1", "x2", "v2"];

  // ---------------------------------------------------------------------------
  //  Pointer drag — N hbar draggers in a mux, one per cart.
  // ---------------------------------------------------------------------------

  function activeCartIndex(state) {
    const d = state.drag;
    if (!d) return -1;
    if (d.kind === "cart-0") return 0;
    if (d.kind === "cart-1") return 1;
    if (d.kind === "cart-2") return 2;
    return -1;
  }

  function hitCart(i, state, L, mx, my) {
    const g = state._geom && state._geom[i];
    if (!g) return false;
    const sx = L.xToPx(state["x" + i]);
    return Math.abs(mx - sx) < g.bodyW / 2 + 8
        && my >= g.cy - g.bodyH / 2 - 4
        && my <= g.axleY + g.wheelR + 2;
  }

  function makeCartDragger(i) {
    return LIB.Drag.hbar({
      kind: "cart-" + i,
      hitTest: (state, params, L, mx, my) => hitCart(i, state, L, mx, my),
      worldX:  (mx, L) => L.pxToX(mx),
      bounds:  (state) => ({
        // Don't let the dragged cart pass through neighbours — they're
        // physical bodies that would have caused contact penetration.
        min: i === 0     ? CART_HALF_W_M
                         : state["x" + (i - 1)] + MIN_GAP,
        max: i === N - 1 ? X_MAX - CART_HALF_W_M
                         : state["x" + (i + 1)] - MIN_GAP,
      }),
      onSeedV: (state) => state["v" + i],
    });
  }

  const draggers = [makeCartDragger(0), makeCartDragger(1), makeCartDragger(2)];
  const dragMux  = LIB.Drag.mux(draggers);

  // ---------------------------------------------------------------------------
  //  Physics — 6-DOF mass-spring-damper-bumper-contact-wind.
  // ---------------------------------------------------------------------------

  function dxdt(state, p, t) {
    const m0 = Math.max(1e-6, p.mass0);
    const m1 = Math.max(1e-6, p.mass1);
    const m2 = Math.max(1e-6, p.mass2);
    const w  = p.wind || 0;
    const x0 = state.x0, v0 = state.v0;
    const x1 = state.x1, v1 = state.v1;
    const x2 = state.x2, v2 = state.v2;

    // Wall ↔ cart 0 (link 0)
    let F0 = -p.k0 * (x0 - L_LINK) - p.c0 * v0;
    if (x0 < X_BUMP) F0 += K_BUMP * (X_BUMP - x0);

    // Cart 0 ↔ cart 1 (link 1)
    const s01 = (x1 - x0) - L_LINK;
    const d01 = (v1 - v0);
    const Flink01 = p.k1 * s01 + p.c1 * d01;
    F0 += Flink01;
    let F1 = -Flink01;

    // Cart 1 ↔ cart 2 (link 2)
    const s12 = (x2 - x1) - L_LINK;
    const d12 = (v2 - v1);
    const Flink12 = p.k2 * s12 + p.c2 * d12;
    F1 += Flink12;
    let F2 = -Flink12;

    // Cart-cart contact penalty (carts cannot overlap).
    const pen01 = MIN_GAP - (x1 - x0);
    if (pen01 > 0) {
      const Fc = K_BUMP * pen01 + Math.max(0, -d01) * K_BUMP * 0.01;
      F0 -= Fc; F1 += Fc;
    }
    const pen12 = MIN_GAP - (x2 - x1);
    if (pen12 > 0) {
      const Fc = K_BUMP * pen12 + Math.max(0, -d12) * K_BUMP * 0.01;
      F1 -= Fc; F2 += Fc;
    }

    // Wind on every cart.
    F0 += w; F1 += w; F2 += w;

    // Control u on cart 0 only.
    F0 += (state._u || 0);

    return {
      x0: v0, v0: F0 / m0,
      x1: v1, v1: F1 / m1,
      x2: v2, v2: F2 / m2,
    };
  }

  function dirFromRef(p) {
    return (p.ref > REF_EQ) ? 1 : (p.ref < REF_EQ ? -1 : 0);
  }

  function preStep(state, p, dt) {
    dragMux.preStep(state, dt);

    // Pointer override: clobber the dragged cart's DOF so the cart is
    // dead-still under the pointer. Continue running the controller (so I
    // accumulates against an external disturbance the user creates).
    const di = activeCartIndex(state);
    if (di >= 0) {
      state["x" + di] = state.drag.value;
      state["v" + di] = 0;
    }

    const e = (p.ref || 0) - state.x2;
    if (p.mode === "bangbang") {
      const dir = dirFromRef(p);
      LIB.BangBang.latch.advance(state.ctrlLoop, e, dir, { dead: p.dead });
      const out = LIB.BangBang.latch.effort(state.ctrlLoop, dir,
        { effort: p.effort, uCap: p.uMax });
      state._u = out.u;
      state.lastE = e;
      state.lastUP = 0; state.lastUI = 0; state.lastUD = 0; state.lastU = out.u;
    } else {
      LIB.PID.advance(state.ctrlLoop, e, dt,
        { ki: p.ki, iClamp: p.iClamp });
      const out = LIB.PID.effort(state.ctrlLoop, e, state.v2,
        { kp: p.kp, kd: p.kd, uCap: p.uMax });
      state._u = out.u;
      state.lastE  = e;
      state.lastUP = out.uP; state.lastUI = out.uI;
      state.lastUD = out.uD; state.lastU  = out.u;
    }
  }

  function postStep(state, p, dt) {
    const di = activeCartIndex(state);
    if (di >= 0) {
      state["x" + di] = state.drag.value;
      state["v" + di] = 0;
    }
    // Hard wall safety net for cart 0.
    if (state.x0 < CART_HALF_W_M) {
      state.x0 = CART_HALF_W_M;
      if (state.v0 < 0) state.v0 = 0;
    }
  }

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------

  // Per-cart palettes — cart 1 (driven) blue, cart 2 purple, cart 3 (controlled
  // output) orange-red.
  const FILLS   = ["#2b3340", "#33293f", "#3a2a25"];
  const STROKES = ["#6a7384", "#9a78b0", "#c47a5e"];
  const WINS    = ["#4ea1ff", "#ab47bc", "#ff7043"];

  function render(ctx, L, state, p) {
    const W = L.W, H = L.H;
    const fsmall = Math.max(9, Math.min(W, H) * 0.022);
    const fbase  = Math.max(10, Math.min(W, H) * 0.028);

    const groundY = L.trackY;
    const wallSx  = L.xToPx(0);

    // Ground.
    ctx.fillStyle = "#1a1f27";
    ctx.fillRect(0, groundY, W, H - groundY);
    ctx.strokeStyle = "#2a313c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY); ctx.lineTo(W, groundY);
    ctx.stroke();

    // X-axis tick labels.
    ctx.fillStyle = "#55606f";
    ctx.font = `${fsmall}px ui-sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.strokeStyle = "#1e252f";
    for (let xm = 0; xm <= X_MAX; xm++) {
      const sx = L.xToPx(xm);
      ctx.beginPath();
      ctx.moveTo(sx, groundY); ctx.lineTo(sx, groundY + 6);
      ctx.stroke();
      ctx.fillText(xm + " m", sx, groundY + 8);
    }

    // Wall.
    const wallTop = groundY - Math.max(80, H * 0.25);
    const wallH   = groundY - wallTop;
    ctx.fillStyle = "#2a313c";
    ctx.fillRect(wallSx - 16, wallTop, 16, wallH);
    ctx.strokeStyle = "#3a4453";
    const hatchN = Math.max(4, Math.round(wallH / 12));
    for (let i = 0; i < hatchN; i++) {
      const yy = wallTop + (i * wallH) / hatchN;
      ctx.beginPath();
      ctx.moveTo(wallSx - 16, yy);
      ctx.lineTo(wallSx - 28, yy + (wallH / hatchN) * 0.8);
      ctx.stroke();
    }

    // Cart geometry — same for all three.
    const bodyH  = Math.max(20, H * 0.06);
    const bodyW  = Math.max(40, bodyH * 2.2);
    const wheelR = Math.max(6, bodyH * 0.36);
    const axleY  = groundY - wheelR;
    const cy     = axleY - bodyH / 2;
    const cartSx = [
      L.xToPx(state.x0), L.xToPx(state.x1), L.xToPx(state.x2),
    ];

    // Stash per-cart geometry for hit-tests.
    state._geom = [
      { bodyW, bodyH, wheelR, axleY, cy },
      { bodyW, bodyH, wheelR, axleY, cy },
      { bodyW, bodyH, wheelR, axleY, cy },
    ];

    // Bumper spring (wall vs cart 0).
    const bumperPlateX = L.xToPx(Math.min(state.x0 - CART_HALF_W_M, X_BUMP));
    const bumperHot = state.x0 < X_BUMP + 0.02;
    LIB.Draw.spring(ctx, wallSx, cy + bodyH * 0.30,
                    bumperPlateX, 5, Math.max(3, bodyH * 0.12),
                    { color: bumperHot ? "#ef5350" : "#8a93a3",
                      width: Math.max(1.5, fsmall * 0.15) });
    ctx.fillStyle = bumperHot ? "#ef5350" : "#5a6575";
    ctx.fillRect(bumperPlateX - 2, cy + bodyH * 0.30 - bodyH * 0.18,
                 4, bodyH * 0.36);

    // Three spring/damper links: wall→0, 0→1, 1→2.
    const linkAnchors = [
      { x0: wallSx,                         x1: cartSx[0] - bodyW / 2 - 6 },
      { x0: cartSx[0] + bodyW / 2 + 6,      x1: cartSx[1] - bodyW / 2 - 6 },
      { x0: cartSx[1] + bodyW / 2 + 6,      x1: cartSx[2] - bodyW / 2 - 6 },
    ];
    for (const a of linkAnchors) {
      LIB.Draw.spring(ctx, a.x0, cy - bodyH * 0.18,
                      a.x1, 8, Math.max(4, bodyH * 0.18),
                      { color: "#c0c9d8",
                        width: Math.max(1.5, fsmall * 0.18) });
      LIB.Draw.damper(ctx, a.x0, cy + bodyH * 0.10,
                      a.x1, Math.max(4, bodyH * 0.16),
                      { color: "#8a93a3",
                        width: Math.max(1.2, fsmall * 0.14) });
    }

    // Reference vertical (target for cart 3).
    const refSx = L.xToPx(p.ref || 0);
    ctx.strokeStyle = LIB.Util.getVar("--cRef");
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(refSx, wallTop - 12); ctx.lineTo(refSx, groundY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = LIB.Util.getVar("--cRef");
    ctx.beginPath();
    ctx.moveTo(refSx, wallTop - 14);
    ctx.lineTo(refSx - 6, wallTop - 24);
    ctx.lineTo(refSx + 6, wallTop - 24);
    ctx.closePath();
    ctx.fill();
    ctx.font = `${fsmall}px ui-sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    ctx.fillText("ref " + (p.ref || 0).toFixed(2) + " (target x₃)",
                 refSx, wallTop - 28);

    // Equilibrium ticks (faint).
    ctx.strokeStyle = "#2e3642";
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    for (const e of EQ) {
      const sx = L.xToPx(e);
      ctx.beginPath();
      ctx.moveTo(sx, groundY - 4); ctx.lineTo(sx, groundY);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Three carts.
    for (let i = 0; i < N; i++) {
      LIB.CartRender.draw(ctx, {
        cx: cartSx[i], cy, bodyW, bodyH, wheelR, axleY,
        x: state["x" + i],
        mToPx: L.mToPx,
        lineW: Math.max(1, fsmall * 0.12),
        fillColor:   FILLS[i],
        strokeColor: STROKES[i],
        windowColor: WINS[i],
        springHookY: cy - bodyH * 0.18,
        damperHookY: cy + bodyH * 0.10,
        label: String(i + 1),
        labelColor: WINS[i],
        markerY1: wallTop - 4,
        markerY2: groundY,
      });
    }

    // Force arrows on cart 0 (where u is applied).
    const F_PX_PER_N = Math.min(0.8, (W * 0.18) / 200);
    const F_CAP_PX   = Math.min(W * 0.35, 300);
    const slots = [
      { color: LIB.Util.getVar("--cU"), F: state.lastU || 0,  label: "u → cart 1" },
    ];
    if (p.mode !== "bangbang") {
      slots.push(
        { color: LIB.Util.getVar("--cP"), F: state.lastUP || 0, label: "P" },
        { color: LIB.Util.getVar("--cI"), F: state.lastUI || 0, label: "I" },
        { color: LIB.Util.getVar("--cD"), F: state.lastUD || 0, label: "D" },
      );
    }
    slots.push(
      { color: LIB.Util.getVar("--cW"), F: p.wind || 0, label: "wind" },
    );
    LIB.CartRender.forceArrows(ctx, cartSx[0], cy - bodyH / 2, slots,
      { fsmall, slotGap: Math.max(13, fbase * 1.25),
        F_PX_PER_N, F_CAP_PX });

    // Wind arrow on cart 3 (so the disturbance on the controlled output is
    // visible).
    LIB.CartRender.forceArrows(ctx, cartSx[2], cy - bodyH / 2,
      [{ color: LIB.Util.getVar("--cW"), F: p.wind || 0, label: "wind" }],
      { fsmall, slotGap: Math.max(13, fbase * 1.25),
        F_PX_PER_N, F_CAP_PX });
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "pid-three-cart",
    title: "PID — three-cart spring train",
    subtitle: "drive cart 1, control cart 3",
    description: `<b>three-cart spring-damper train</b> — three masses linked by springs (natural length 1 m) and dampers; equilibrium at x = 1, 2, 3 m. Control <i>u</i> is applied to cart 1; error is measured on cart 3. The two intervening links are a low-pass filter that delays and attenuates whatever you do upstream — so a P that would settle a single cart instantly leaves cart 3 ringing for seconds. Pedagogical takeaway: <b>collocation matters</b>. The further the actuator from the controlled output, the more flexible modes the controller has to live with. Drag any cart to disturb it.`,

    state: () => ({
      x0: EQ[0], v0: 0,
      x1: EQ[1], v1: 0,
      x2: EQ[2], v2: 0,
      ctrlLoop: { I: 0, ePrev: 0, bbOn: false },
      _u: 0,
      lastE: 0, lastUP: 0, lastUI: 0, lastUD: 0, lastU: 0,
      drag: null,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      s.ctrlLoop = { I: 0, ePrev: 0, bbOn: false };
      s.lastE = 0; s.lastUP = 0; s.lastUI = 0; s.lastUD = 0; s.lastU = 0;
    },

    modes: {
      default: "pid",
      persistKey: "pid-three-cart-mode",
      list: [
        { id: "pid",      label: "PID" },
        { id: "bangbang", label: "Bang-bang" },
      ],
      onChange: (state) => {
        state.ctrlLoop = { I: 0, ePrev: 0, bbOn: false };
      },
    },

    sliders: (state) => {
      const Reference = { span: "full", items: [
        { key: "ref", label: "ref", min: 0.3, max: 4.5, step: 0.01, value: 3.0,
          tip: "Target position of cart 3 (m). Open-loop equilibrium for cart 3 is " + REF_EQ.toFixed(2) + " m." },
      ]};
      const Controller = (state.mode === "bangbang")
        ? [
            { key: "dead",   label: "dead", min: 0,  max: 2,    step: 0.01, value: 0.10,
              tip: "Deadband width (m) on cart-3 error." },
            { key: "effort", label: "eff",  min: 0,  max: 2000, step: 1,    value: 400,
              tip: "Effort magnitude (N) applied to cart 1." },
            { key: "uMax",   label: "uMax", min: 0,  max: 2000, step: 1,    value: 1500,
              tip: "Actuator saturation: |u| clamped to this." },
          ]
        : [
            { key: "kp",     label: "P",    min: 0, max: 800,  step: 0.1,  value: 0,
              tip: "Proportional gain (N/m) on cart-3 position error." },
            { key: "ki",     label: "I",    min: 0, max: 800,  step: 0.1,  value: 0,
              tip: "Integral gain (N/m·s)." },
            { key: "kd",     label: "D",    min: 0, max: 200,  step: 0.05, value: 0,
              tip: "Derivative gain (N·s/m). Computed on cart-3 measured velocity." },
            { key: "iClamp", label: "Imax", min: 0, max: 800,  step: 1,    value: 800,
              tip: "Anti-windup: caps |I| (N)." },
            { key: "uMax",   label: "uMax", min: 0, max: 2000, step: 1,    value: 1500,
              tip: "Actuator saturation: final clamp on |u| applied to cart 1." },
          ];
      const Carts = [
        { key: "mass0", label: "m1", min: 0.1, max: 1000, step: 0.01, value: 1.0, log: true,
          tip: "Mass of cart 1 (kg)." },
        { key: "k0",    label: "k1", min: 0,   max: 200,  step: 0.1,  value: 20,
          tip: "Spring stiffness wall ↔ cart 1 (N/m)." },
        { key: "c0",    label: "c1", min: 0,   max: 20,   step: 0.01, value: 0.5,
          tip: "Damping wall ↔ cart 1 (N·s/m)." },
        { key: "mass1", label: "m2", min: 0.1, max: 1000, step: 0.01, value: 1.0, log: true,
          tip: "Mass of cart 2 (kg)." },
        { key: "k1",    label: "k2", min: 0,   max: 200,  step: 0.1,  value: 20,
          tip: "Spring stiffness cart 1 ↔ cart 2 (N/m)." },
        { key: "c1",    label: "c2", min: 0,   max: 20,   step: 0.01, value: 0.5,
          tip: "Damping cart 1 ↔ cart 2 (N·s/m)." },
        { key: "mass2", label: "m3", min: 0.1, max: 1000, step: 0.01, value: 1.0, log: true,
          tip: "Mass of cart 3 (kg)." },
        { key: "k2",    label: "k3", min: 0,   max: 200,  step: 0.1,  value: 20,
          tip: "Spring stiffness cart 2 ↔ cart 3 (N/m)." },
        { key: "c2",    label: "c3", min: 0,   max: 20,   step: 0.01, value: 0.5,
          tip: "Damping cart 2 ↔ cart 3 (N·s/m)." },
      ];
      const Environment = [
        { key: "wind", label: "wind", min: -200, max: 200, step: 0.1, value: 0,
          tip: "Steady horizontal wind force applied equally to all three carts (N)." },
      ];
      return { Reference, Controller, Mechanism: Carts, Environment };
    },

    plots: (state) => {
      const positionSeries = [
        { label: "ref", color: LIB.Util.getVar("--cRef"), lw: 1.4,
          source: (s, p) => p.ref || 0 },
        { label: "x1",  color: WINS[0], lw: 1.4,
          source: (s) => s.x0 },
        { label: "x2",  color: WINS[1], lw: 1.4,
          source: (s) => s.x1 },
        { label: "x3",  color: WINS[2], lw: 2.0,
          source: (s) => s.x2 },
      ];
      if (state.mode === "bangbang") {
        positionSeries.push(
          { label: "deadHi", color: "#ef5350", lw: 1.0,
            source: (s, p) => (p.ref || 0) + (p.dead || 0) / 2 },
          { label: "deadLo", color: "#ef5350", lw: 1.0,
            source: (s, p) => (p.ref || 0) - (p.dead || 0) / 2 },
        );
      }
      const effortSeries = [
        { label: "u",    color: LIB.Util.getVar("--cU"), lw: 2.0,
          source: (s) => s.lastU || 0 },
      ];
      if (state.mode !== "bangbang") {
        effortSeries.push(
          { label: "P", color: LIB.Util.getVar("--cP"), lw: 1.2,
            source: (s) => s.lastUP || 0 },
          { label: "I", color: LIB.Util.getVar("--cI"), lw: 1.2,
            source: (s) => s.lastUI || 0 },
          { label: "D", color: LIB.Util.getVar("--cD"), lw: 1.2,
            source: (s) => s.lastUD || 0 },
        );
      }
      effortSeries.push(
        { label: "wind", color: LIB.Util.getVar("--cW"), lw: 1.2,
          source: (s, p) => p.wind || 0 },
      );
      return [
        { title: "position vs time (m)",
          yFmt: (v) => v.toFixed(2),
          series: positionSeries },
        { title: "control effort on cart 1 (N)",
          yFmt: (v) => v.toFixed(0),
          series: effortSeries },
      ];
    },

    readouts: () => [
      { label: "x₁",    units: "m",   value: (s) => s.x0.toFixed(3) },
      { label: "x₂",    units: "m",   value: (s) => s.x1.toFixed(3) },
      { label: "x₃",    units: "m",   value: (s) => s.x2.toFixed(3) },
      { label: "v₃",    units: "m/s", value: (s) => s.v2.toFixed(3) },
      { label: "err",   units: "m",   value: (s) => s.lastE.toFixed(3) },
      { label: "∫err",                value: (s) => (s.ctrlLoop.I || 0).toFixed(3) },
      { label: "u",     units: "N",   value: (s) => (s.lastU || 0).toFixed(2) },
      { label: "P",     units: "N",   value: (s) => (s.lastUP || 0).toFixed(2) },
      { label: "I",     units: "N",   value: (s) => (s.lastUI || 0).toFixed(2) },
      { label: "D",     units: "N",   value: (s) => (s.lastUD || 0).toFixed(2) },
      { label: "wind",  units: "N",   value: (s, p) => (p.wind || 0).toFixed(2) },
    ],

    physics: {
      dof: DOF,
      dxdt,
      integrator: "rk4",
      preStep, postStep,
    },

    layout: { kind: "linearTrack",
              xMin: X_MIN, xMax: X_MAX,
              padX: 60, padY: 30, trackFrac: 0.7 },

    render,
    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    physHz: 240,
  };

  (window.PidControlLessons = window.PidControlLessons || {}).threeCart = SPEC;
})();
