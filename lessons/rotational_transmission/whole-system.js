"use strict";

// =============================================================================
//  Whole-system rotational lesson — PID drives the motor (wheel #0) so that
//  the rightmost wheel's ω matches the target. The motor sits in a 25 °C
//  room and dumps copper losses into a leaky-integrator thermal model: cooked
//  at 180 °C ⇒ explodes. Add gears, sweep ratios, find a setting that hits
//  the target without saturating τ_max long enough to cook.
//
//  Pedagogical takeaway: gearing is a thermal-budget choice, not just a
//  kinematic one. M ≈ 1 (inertia matching) is the sweet spot.
// =============================================================================

(function () {

  const PHYS_HZ = 240;
  const HIST_HZ = 60;
  const MODE    = "simple";
  const K_DRAG  = 2.0e5;
  const C_DRAG  = 1.0e3;
  const KI_PID  = 0.6;

  function defaultState() {
    // 3-stage default to make the lesson visible the moment you open it.
    const s = LIB.WheelChain.makeState(3, {
      defaults: (i) => i === 0 ? { r: 0.4, J: 0.02 }
                  : i === 1   ? { r: 0.5, J: 0.05 }
                              : { r: 0.5, J: 0.6  },
    });
    s.driveOn    = false;
    s.lastT      = 0;
    s.thermal    = 0;
    s.exploded   = false;
    s.explosionT = 0;
    s.ctrlLoop   = { I: 0, ePrev: 0 };
    s.mode       = MODE;
    return s;
  }

  // ---------------------------------------------------------------------------
  //  Drive — PID on rightmost wheel ω, referred back to motor frame.
  // ---------------------------------------------------------------------------

  function omega0Target(state, p) {
    const R = LIB.WheelChain.cumRatios(state.wheels, MODE);
    const Rend = R[state.N - 1];
    const safe = Math.abs(Rend) > 1e-9 ? Rend : (Rend >= 0 ? 1e-9 : -1e-9);
    return p.wTarget / safe;
  }

  function driveTorque(state, p) {
    if (!state.driveOn || state.exploded) return 0;
    let T = p.Kp * (omega0Target(state, p) - state.omega_0) + (state.ctrlLoop.I || 0);
    if (T >  p.Tmax) T =  p.Tmax;
    if (T < -p.Tmax) T = -p.Tmax;
    return T;
  }
  function driveSaturated(state, p) {
    if (!state.driveOn || state.exploded) return true;
    const T = p.Kp * (omega0Target(state, p) - state.omega_0) + (state.ctrlLoop.I || 0);
    return Math.abs(T) >= p.Tmax;
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

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

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
    if (state.driveOn && !state.exploded && !driveSaturated(state, params)) {
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

  function preStep(state, params, dt) {
    dragger.preStep(state, dt);
    if (state.driveOn && !state.exploded) {
      const e = omega0Target(state, params) - state.omega_0;
      LIB.PID.advance(state.ctrlLoop, e, dt,
                      { ki: KI_PID, iClamp: params.Tmax });
    }
  }
  function postStep(state, params, dt) {
    state.lastT = driveTorque(state, params);
    LIB.Thermal.step(state, dt, state.lastT, params.Tmax);
  }

  function onPointer(type, mx, my, L, state, params) {
    return dragger.handle(type, mx, my, L, state, params);
  }

  // ---------------------------------------------------------------------------
  //  Render — wheels + thermal halo + explosion + gauge
  // ---------------------------------------------------------------------------

  function render(ctx, L, state, p) {
    cachedView = LIB.WheelChainView.buildView(L, state.wheels, MODE);
    const view = cachedView;

    ctx.strokeStyle = "#3a4453";
    ctx.lineWidth = 1;
    for (let i = 0; i < state.N - 1; i++) {
      const a = view.centers[i], b = view.centers[i + 1];
      const cx = (a.cx + b.cx) / 2;
      const yPad = Math.max(a.rPx, b.rPx) + 14;
      ctx.beginPath();
      ctx.moveTo(cx, a.cy - yPad);
      ctx.lineTo(cx, a.cy + yPad);
      ctx.stroke();
    }

    for (let i = 0; i < state.N; i++) {
      const w = state.wheels[i];
      const c = view.centers[i];
      const isDrive = i === 0;
      const E = isDrive ? Math.min(1.2, state.thermal || 0) : 0;
      const baseColor = LIB.WheelChainView.color(i);
      const color = isDrive ? LIB.Thermal.tint(baseColor, E) : baseColor;
      LIB.GearRender.drawWheel(ctx, c, w, {
        color,
        isDrive,
        isDragging: dragger.isActive(state) && dragger.activeIndex(state) === i,
        compound:   false,
        scale:      view.scale,
        label:      isDrive ? `#${i} (drive)` : `#${i}`,
        omega:      w.omega,
        tau:        w.lastTau || 0,
      });
    }

    if (state.driveOn && !state.exploded && view.centers[0]) {
      LIB.GearRender.drawDriveArrow(ctx, view.centers[0], state.lastT || 0);
    }

    if (view.centers.length > 0) {
      const c0 = view.centers[0];
      const r0 = c0.rPx;
      const E = state.thermal || 0;
      if (E > 0.4 && !state.exploded) {
        const t = Math.min(1, (E - 0.4) / 0.6);
        const haloColor = E > 0.7 ? "#ef5350" : "#f6c945";
        ctx.save();
        ctx.globalAlpha = 0.18 + 0.45 * t;
        ctx.fillStyle = haloColor;
        ctx.beginPath();
        ctx.arc(c0.cx, c0.cy, r0 + 8 + 14 * t, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (state.exploded) LIB.Thermal.drawExplosion(ctx, c0.cx, c0.cy, r0, state);
      LIB.Thermal.drawGauge(ctx, c0.cx, c0.cy + r0 + 18, Math.max(40, r0 * 1.4), E);
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
      grp.push({ key: `r_${i}`, label: `r #${i}`, min: 0.05, max: 3.0, step: 0.005,
                 value: w.r, onChange: (v) => { w.r = v; } });
      if (i !== 0) {
        grp.push({ key: `J_${i}`, label: `J #${i}`, min: 0.001, max: 5.0,
                   step: 0.001, value: w.J, log: true,
                   onChange: (v) => { w.J = v; } });
      }
      groups.push(grp);
    }
    return groups;
  }

  function sliderSpec(state) {
    const w0 = state.wheels[0];
    return {
      Drive: [
        { key: "wTarget", label: "ω_tgt @ load", min: -30, max: 30, step: 0.01,
          value: 4.0,
          tip: "Target ω at the rightmost wheel (rad/s). PID drives the motor so the load wheel hits this." },
        { key: "Tmax",    label: "τ_max", min: 0.05, max: 50, step: 0.01,
          value: 1.5, log: true,
          tip: "Peak motor torque (N·m). Sustaining ±τ_max from cold cooks the motor in 5 s." },
        { key: "Kp",      label: "K_p",   min: 0.01, max: 200, step: 0.01,
          value: 5.0, log: true,
          tip: "Velocity-loop proportional gain (N·m·s/rad)." },
        { key: "Jmotor",  label: "J_motor", min: 0.001, max: 5.0, step: 0.001,
          value: w0.J, log: true,
          tip: "Motor rotor inertia (kg·m²).",
          onChange: (v) => { w0.J = v; } },
      ],
      Mechanism: [
        { key: "drag", label: "c", min: 0, max: 2, step: 0.001, value: 0.02,
          tip: "Viscous damping per wheel (N·m·s/rad)." },
      ],
      Wheels: {
        kind: "dynamic",
        title: "Wheels",
        items: wheelRows,
        actions: [
          { label: "+ Add wheel",
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
      { title: "ω per wheel (rad/s) — yellow = target",
        yFmt: (v) => v.toFixed(1),
        series: [
          { label: "target", color: "#f6c945", lw: 1.4,
            source: (s, p) => p.wTarget },
        ].concat(state.wheels.map((_, i) => ({
          label: `w${i}`, color: LIB.WheelChainView.color(i), lw: i === 0 ? 2.4 : 1.6,
          source: (s) => +s[`omega_${i}`] || 0,
        }))) },
      { title: "τ motor (N·m) — orange = thermal load",
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "tau",        color: "#4ea1ff", lw: 2.0,
            source: (s) => s.lastT || 0 },
          { label: "thermal × τ_max", color: "#f6a623", lw: 1.4,
            source: (s, p) => (s.thermal || 0) * p.Tmax },
        ] },
    ];
  }

  function readoutsSpec(state) {
    const fixed = [
      { label: "τ applied", units: "N·m",
        value: (s) => (s.lastT || 0).toFixed(3) },
      { label: "Power",     units: "W",
        value: (s) => ((s.lastT || 0) * s.omega_0).toFixed(3) },
      { label: "Motor T",   units: "°C",
        value: (s) => LIB.Thermal.tempFromE(s.thermal || 0).toFixed(0) },
      { label: "exploded",
        value: (s) => s.exploded ? "YES" : "no" },
      { label: "J_motor",   units: "kg·m²",
        value: (s) => s.wheels[0].J.toFixed(4) },
      { label: "J_load,refl", units: "kg·m²",
        value: (s) => Math.max(0,
          LIB.WheelChain.reflectedJ(s.wheels, MODE) - s.wheels[0].J).toFixed(4) },
      { label: "J_eff @ motor", units: "kg·m²",
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
    id: "rotational-whole-system",
    title: "Whole system — rotational",
    subtitle: "PID-driven motor + thermal model + reflected inertia",
    description:
      "<b>whole-system rotational</b> — a PID drives the motor (wheel #0) so " +
      "that the <i>rightmost</i> wheel's ω matches the target. The reflected " +
      "inertia of the entire chain shows up in the motor's effective J. Crank " +
      "the gear ratio so the motor must spin much faster than the load — torque " +
      "demand drops, but if the motor can't keep up, the controller saturates " +
      "against τ<sub>max</sub>. The motor sits in a 25 °C room and dumps copper " +
      "losses (∝ τ²) into a Newton-cooling lump with thermal time constant " +
      "τ<sub>th</sub>=12 s; sustained τ<sub>max</sub> from a cold start cooks " +
      "it to 180 °C in 5 s and it explodes. Below saturation the time-to-blow " +
      "scales like a fuse equation against current; a torque demand whose " +
      "steady-state temperature stays under 180 °C runs cool indefinitely. " +
      "Hit Reset to bring it back. Pedagogical takeaway: gearing is a thermal-" +
      "budget choice, not just a kinematic one.<br><br>" +
      "<b>Inertia matching demo</b> — for a fixed τ<sub>max</sub>, the load " +
      "accelerates fastest when M = J<sub>load,refl</sub>/J<sub>motor</sub> ≈ 1. " +
      "Sweep the ratio: tiny ratios leave M ≪ 1 (motor torque wasted spinning " +
      "the rotor); huge ratios drive M ≫ 1 (motor saturates, load crawls and " +
      "cooks). M ≈ 1 is the sweet spot — quickest settle, coolest motor.",

    state: defaultState,
    onReset: (s) => {
      s.thermal = 0;
      s.exploded = false;
      s.explosionT = 0;
      s.pidI = 0;
    },

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

    headerButtons: [LIB.HeaderButtons.driveToggle()],

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.RotationalLessons = window.RotationalLessons || {}).wholeSystem = SPEC;
})();
