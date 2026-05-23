"use strict";

// =============================================================================
//  Belt-and-pulley lesson — N-pulley belt drive.
//
//  Wheel 0 has a single radius r. Wheels 1..N−1 are stepped (compound)
//  pulleys: r1 takes the belt from the left, r2 drives the belt to the right.
//  Setting r1=r2 reduces a stepped pulley to a plain one. Belts couple in
//  the SAME direction (sign +1), unlike gear contacts.
//
//  Physics: rigid contact via LIB.WheelChain.contactDxdt + meshSign("belt").
//  No bespoke physics.step — fully declarative same as lead-screw / gears.
// =============================================================================

(function () {

  const PHYS_HZ = 240;
  const HIST_HZ = 60;
  const MODE    = "belt";
  const K_DRAG  = 5.0e3;
  const C_DRAG  = 60;

  function defaultState() {
    const s = LIB.WheelChain.makeState(2, { mode: MODE });
    s.driveOn = false;
    s.lastT   = 0;
    s.mode    = MODE;
    return s;
  }

  function driveTorque(state, p) {
    if (!state.driveOn) return 0;
    let T = p.Kp * (p.wTarget - state.omega_0);
    if (T >  p.Tmax) T =  p.Tmax;
    if (T < -p.Tmax) T = -p.Tmax;
    return T;
  }
  function driveSaturated(state, p) {
    if (!state.driveOn) return true;
    return Math.abs(p.Kp * (p.wTarget - state.omega_0)) >= p.Tmax;
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag
  // ---------------------------------------------------------------------------

  let cachedView = null;
  const dragger = LIB.Drag.chainWheel({
    kind: "wheel",
    hitTest: (state, params, layout, mx, my) => cachedView
      ? LIB.WheelChainView.hitTestWheel(cachedView, state.wheels, MODE, mx, my)
      : -1,
    centerPxFor: (state, params, layout, i) => {
      const c = cachedView && cachedView.centers[i];
      return c ? { x: c.cx, y: c.cy } : { x: 0, y: 0 };
    },
  });

  function dxdt(state, params, t) {
    return LIB.WheelChain.contactDxdt(state, params, t, {
      mode: MODE, c: params.drag,
      drive: driveTorque,
      extraTorque: (s, p, i) => dragger.springTheta(s, i, K_DRAG, C_DRAG),
    });
  }
  function jacobian(state, params, t) {
    const J  = LIB.WheelChain.contactJacobian(state, params, t,
                                               { mode: MODE, c: params.drag });
    const n  = 2 * state.N;
    const wi = (i) => 2 * i + 1;
    const ti = (i) => 2 * i;
    if (state.driveOn && !driveSaturated(state, params)) {
      const J0 = Math.max(1e-9, state.wheels[0].J);
      J[wi(0) * n + wi(0)] += -params.Kp / J0;
    }
    if (dragger.isActive(state)) {
      const i  = dragger.activeIndex(state);
      const Ji = Math.max(1e-9, state.wheels[i].J);
      J[wi(i) * n + ti(i)] += -K_DRAG / Ji;
      J[wi(i) * n + wi(i)] += -C_DRAG / Ji;
    }
    return J;
  }
  function preStep(state, params, dt)  { dragger.preStep(state, dt); }
  function postStep(state, params)     { state.lastT = driveTorque(state, params); }

  function onPointer(type, mx, my, L, state, params) {
    return dragger.handle(type, mx, my, L, state, params);
  }

  // ---------------------------------------------------------------------------
  //  Render — pulleys + open belts (drawn in front of compound stepped pulleys
  //  whose belt wraps the inner radius)
  // ---------------------------------------------------------------------------

  function drawBeltSegment(ctx, view, state, i) {
    const a = view.centers[i], b = view.centers[i + 1];
    const ra = LIB.WheelChain.rightR(state.wheels[i],     MODE, i);
    const rb = LIB.WheelChain.leftR (state.wheels[i + 1], MODE, i + 1);
    const raPx = ra * view.scale, rbPx = rb * view.scale;
    const beltOffsetPx = state[`theta_${i}`] * raPx;
    LIB.BeltRender.drawOpenBelt(ctx, a, b, raPx, rbPx, beltOffsetPx);
  }

  function render(ctx, L, state, p) {
    cachedView = LIB.WheelChainView.buildView(L, state.wheels, MODE,
      { beltGap: p.beltGap });
    const view = cachedView;

    // Belts that wrap an INNER step go in front of the wheel; outer belts
    // are drawn behind so the rim covers the band naturally.
    const beltsInFront = [];
    for (let i = 0; i < state.N - 1; i++) {
      const aInner = LIB.WheelChain.rightR(state.wheels[i],     MODE, i)
                   < LIB.WheelChain.outerR(state.wheels[i],     MODE, i) - 1e-9;
      const bInner = LIB.WheelChain.leftR (state.wheels[i + 1], MODE, i + 1)
                   < LIB.WheelChain.outerR(state.wheels[i + 1], MODE, i + 1) - 1e-9;
      if (aInner || bInner) beltsInFront.push(i);
      else                  drawBeltSegment(ctx, view, state, i);
    }

    const order = LIB.WheelChain.computeDrawOrder(state.wheels, MODE);
    for (const i of order) {
      const w = state.wheels[i];
      const c = view.centers[i];
      LIB.GearRender.drawWheel(ctx, c, w, {
        color:      LIB.WheelChainView.color(i),
        isDrive:    i === 0,
        isDragging: dragger.isActive(state) && dragger.activeIndex(state) === i,
        compound:   LIB.WheelChain.isCompound(MODE, i),
        scale:      view.scale,
        label:      i === 0 ? `#${i} (drive)` : `#${i}`,
        omega:      w.omega,
        tau:        w.lastTau || 0,
      });
    }

    for (const i of beltsInFront) drawBeltSegment(ctx, view, state, i);

    if (state.driveOn && view.centers[0]) {
      LIB.GearRender.drawDriveArrow(ctx, view.centers[0], state.lastT || 0);
    }
  }

  // ---------------------------------------------------------------------------
  //  Sliders
  // ---------------------------------------------------------------------------

  function wheelRows(state) {
    const groups = [];
    for (let i = 0; i < state.N; i++) {
      const grp = [];
      const w = state.wheels[i];
      if (i === 0) {
        grp.push({ key: `r_${i}`, label: `r #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r,
                   onChange: (v) => { w.r = v; LIB.WheelChain.recomputeJ(w); } });
      } else {
        grp.push({ key: `r1_${i}`, label: `r₁ #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r1,
                   onChange: (v) => { w.r1 = v; LIB.WheelChain.recomputeJ(w); } });
        grp.push({ key: `r2_${i}`, label: `r₂ #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r2,
                   onChange: (v) => { w.r2 = v; LIB.WheelChain.recomputeJ(w); } });
      }
      if (i !== 0) {
        grp.push({ key: `m_${i}`, label: `m #${i}`, min: 0.01, max: 50,
                   step: 0.001, value: w.m, log: true,
                   tip: "Pulley mass (kg). Solid-disc inertia J = ½·m·r².",
                   onChange: (v) => { w.m = v; LIB.WheelChain.recomputeJ(w); } });
      }
      groups.push(grp);
    }
    return groups;
  }

  function sliderSpec(state) {
    const w0 = state.wheels[0];
    return {
      Drive: [
        { key: "wTarget", label: "ω_tgt", min: -30, max: 30, step: 0.01, value: 6.0,
          tip: "Target ω for the drive pulley (rad/s)." },
        { key: "Tmax",    label: "τ_max", min: 0.01, max: 50, step: 0.01, value: 2.0, log: true,
          tip: "Peak drive torque (N·m)." },
        { key: "Kp",      label: "K_p",   min: 0.01, max: 200, step: 0.01, value: 5.0, log: true,
          tip: "Drive-loop gain." },
        { key: "mmotor",  label: "m #0",  min: 0.01, max: 50, step: 0.001,
          value: w0.m, log: true,
          tip: "Wheel-#0 (motor) mass (kg). J #0 = ½·m·r².",
          onChange: (v) => { w0.m = v; LIB.WheelChain.recomputeJ(w0); } },
      ],
      Mechanism: [
        { key: "drag",    label: "c", min: 0, max: 2, step: 0.001, value: 0.02,
          tip: "Viscous damping per pulley (N·m·s/rad)." },
        { key: "beltGap", label: "belt d", min: 0.1, max: 4, step: 0.01, value: 1.0,
          tip: "Free space between adjacent pulleys, rim-to-rim at the outer radii (m)." },
      ],
      Pulleys: {
        kind: "dynamic",
        title: "Pulleys",
        items: wheelRows,
        actions: [
          { label: "+ Add pulley",
            run: (s) => { if (s.N < 8) LIB.WheelChain.addWheel(s, MODE); } },
          { label: "− Remove last",
            run: (s) => {
              if (s.N > 1) LIB.WheelChain.removeLast(s, MODE);
              if (s.drag && s.drag.i >= s.N) s.drag = null;
            } },
        ],
      },
    };
  }

  function plotsSpec(state) {
    return [
      { title: "ω per pulley (rad/s)",
        yFmt: (v) => v.toFixed(1),
        yFloor: { lo: -2, hi: 2 },
        yChunk: 2,
        series: state.wheels.map((_, i) => ({
          label: `w${i}`, color: LIB.WheelChainView.color(i),
          lw: i === 0 ? 2.4 : 1.6,
          source: (s) => +s[`omega_${i}`] || 0,
        })) },
      { title: "τ per pulley (N·m)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -1, hi: 1 },
        yChunk: 1,
        series: state.wheels.map((_, i) => ({
          label: `t${i}`, color: LIB.WheelChainView.color(i),
          lw: i === 0 ? 2.4 : 1.6,
          source: (s) => (s.wheels[i] ? (s.wheels[i].lastTau || 0) : 0),
        })) },
    ];
  }

  function readoutsSpec(state) {
    const fixed = [
      { label: "τ applied", units: "N·m",
        value: (s) => (s.lastT || 0).toFixed(3) },
      { label: "Power",     units: "W",
        value: (s) => ((s.lastT || 0) * s.omega_0).toFixed(3) },
      { label: "J_motor",   units: "kg·m²",
        value: (s) => s.wheels[0].J.toFixed(4) },
      { label: "J_eff @ drive", units: "kg·m²",
        value: (s) => LIB.WheelChain.reflectedJ(s.wheels, MODE).toFixed(4) },
      { label: "Match M",
        value: (s) => {
          const Jt = LIB.WheelChain.reflectedJ(s.wheels, MODE);
          const Jl = Math.max(0, Jt - s.wheels[0].J);
          const M  = (s.wheels[0].J > 1e-12) ? (Jl / s.wheels[0].J) : Infinity;
          return { text: Number.isFinite(M) ? M.toFixed(2) : "∞",
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
      { label: "sim t", units: "s", value: (s) => s.t.toFixed(2) },
    ];
    const R = LIB.WheelChain.cumRatios(state.wheels, MODE);
    const perWheel = state.wheels.map((_, i) => ({
      label: `#${i} (R=${R[i].toFixed(3)})`,
      value: (s) => {
        const w = s.wheels[i];
        if (!w) return "—";
        return `ω=${(s[`omega_${i}`] || 0).toFixed(2)} τ=${(w.lastTau || 0).toFixed(2)}`;
      },
    }));
    return fixed.concat(perWheel);
  }

  const SPEC = {
    id: "rotational-belt-and-pulley",
    title: "Belt and pulley",
    subtitle: "N-pulley belt drive with optional stepped pulleys",
    description:
      "<b>belt and pulley</b> — adjacent pulleys are coupled by a flexible belt " +
      "instead of meshing teeth. The belt does not flip direction at the contact, " +
      "so both pulleys spin the same way. Pulleys 1..N can be <i>stepped (compound) " +
      "pulleys</i>: r<sub>1</sub> takes the belt from the left, r<sub>2</sub> drives " +
      "the belt to the right, both rigidly on one shaft. Stage ratio is +r2<sub>i</sub>" +
      "/r1<sub>i+1</sub> — cascading stepped pulleys is how drills, lathes and old " +
      "machine tools select different output speeds. Set r<sub>1</sub>=r<sub>2</sub> " +
      "for a plain pulley. The <code>belt d</code> slider sets the rim-to-rim gap " +
      "between adjacent outer radii.",

    state: defaultState,

    sliders: sliderSpec,
    plots: plotsSpec,
    readouts: readoutsSpec,

    physics: {
      dof: (state) => LIB.WheelChain.dof(state),
      dxdt, jacobian,
      integrator: "implicitEuler",
      preStep, postStep,
    },

    layout: (W, H) => ({ W, H }),
    render,
    onPointer,

    icon: (ctx, W, H) => {
      const S = Math.min(W, H);
      const accent = LIB.Util.getVar("--accent");
      const good   = LIB.Util.getVar("--good");
      const ink    = LIB.Util.getVar("--ink");

      // Two stepped pulleys with a belt around the smaller (inner) step.
      const cy = H / 2;
      const r1Outer = S * 0.20, r1Inner = S * 0.13;
      const r2Outer = S * 0.27, r2Inner = S * 0.17;
      const sep = W * 0.50;
      const cx1 = W / 2 - sep / 2;
      const cx2 = W / 2 + sep / 2;

      // Belt — open belt tangent to the inner pulley pitches
      ctx.strokeStyle = ink + "cc";
      ctx.lineWidth = Math.max(1.5, S * 0.007);
      ctx.beginPath();
      ctx.moveTo(cx1, cy - r1Inner);
      ctx.lineTo(cx2, cy - r2Inner);
      ctx.moveTo(cx1, cy + r1Inner);
      ctx.lineTo(cx2, cy + r2Inner);
      ctx.stroke();

      function drawStepped(cx, rOuter, rInner, color) {
        ctx.fillStyle = "#2a313c";
        ctx.beginPath(); ctx.arc(cx, cy, rOuter, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.005);
        ctx.stroke();
        // Inner step ring (where the belt rides)
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.arc(cx, cy, rInner, 0, Math.PI * 2); ctx.stroke();
        // Hub
        ctx.fillStyle = ink;
        ctx.beginPath(); ctx.arc(cx, cy, rOuter * 0.10, 0, Math.PI * 2); ctx.fill();
      }
      drawStepped(cx1, r1Outer, r1Inner, accent);
      drawStepped(cx2, r2Outer, r2Inner, good);
    },

    dragControls: [
      { label: "Any pulley", desc: "click rim, rotate" },
    ],

    headerButtons: [LIB.HeaderButtons.driveToggle()],

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.RotationalLessons = window.RotationalLessons || {}).beltAndPulley = SPEC;
})();
