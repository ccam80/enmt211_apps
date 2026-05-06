"use strict";

// =============================================================================
//  Gears lesson — N-wheel gear chain. Modes: simple / compound.
//
//   • simple — every wheel has one radius `r`. Adjacent wheels touch at
//              their pitch circles; each contact reverses direction.
//              Stage ratio: −r_i / r_{i+1}.
//   • compound — wheels 1..N−1 are stepped (r1 mates with the wheel on its
//              left, r2 with the wheel on its right). Both gears on the
//              same shaft turn together. Stage ratio: −r2_i / r1_{i+1}.
//
//  Drag any wheel's rim to rotate it manually; the chain propagates through
//  the contact springs in the integrator. Adds/removes wheels via panel-
//  level actions.
//
//  Physics is fully declarative — same shape as lead-screw.js — using
//  LIB.WheelChain.contactDxdt + LIB.WheelChain.contactJacobian against
//  rigid contact (no lash window: H=0, default engagement +1).
// =============================================================================

(function () {

  const PHYS_HZ = 240;
  const HIST_HZ = 60;
  const K_DRAG  = 2.0e5;
  const C_DRAG  = 1.0e3;

  function defaultState() {
    const s = LIB.WheelChain.makeState(2);
    s.driveOn = false;
    s.lastT   = 0;
    s.mode    = "simple";    // shell overwrites via spec.modes
    return s;
  }

  // ---------------------------------------------------------------------------
  //  Drive — clamped Kp velocity loop on wheel 0.
  // ---------------------------------------------------------------------------

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
  //  Pointer drag — any wheel rim
  // ---------------------------------------------------------------------------

  let cachedView = null;
  const dragger = LIB.Drag.chainWheel({
    kind: "wheel",
    hitTest: (state, params, layout, mx, my) => cachedView
      ? LIB.WheelChainView.hitTestWheel(cachedView, state.wheels, state.mode || "simple", mx, my)
      : -1,
    centerPxFor: (state, params, layout, i) => {
      const c = cachedView && cachedView.centers[i];
      return c ? { x: c.cx, y: c.cy } : { x: 0, y: 0 };
    },
  });

  // ---------------------------------------------------------------------------
  //  Physics — declarative
  // ---------------------------------------------------------------------------

  function dxdt(state, params, t) {
    return LIB.WheelChain.contactDxdt(state, params, t, {
      mode:  state.mode || "simple",
      c:     params.drag,
      drive: driveTorque,
      extraTorque: (s, p, i) => dragger.springTheta(s, i, K_DRAG, C_DRAG),
    });
  }

  function jacobian(state, params, t) {
    const mode = state.mode || "simple";
    const J    = LIB.WheelChain.contactJacobian(state, params, t,
                                                 { mode, c: params.drag });
    const n    = 2 * state.N;
    const wi   = (i) => 2 * i + 1;
    const ti   = (i) => 2 * i;
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
  //  Render
  // ---------------------------------------------------------------------------

  function render(ctx, L, state, p) {
    const mode = state.mode || "simple";
    cachedView = LIB.WheelChainView.buildView(L, state.wheels, mode);
    const view = cachedView;

    // Inter-wheel contact lines (simple mode only — compound concentric
    // contact is implicit in the stepped disc rendering).
    if (mode === "simple") {
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
    }

    const order = (mode === "compound")
      ? LIB.WheelChain.computeDrawOrder(state.wheels, mode)
      : state.wheels.map((_, i) => i);
    for (const i of order) {
      const w = state.wheels[i];
      const c = view.centers[i];
      LIB.GearRender.drawWheel(ctx, c, w, {
        color:      LIB.WheelChainView.color(i),
        isDrive:    i === 0,
        isDragging: dragger.isActive(state) && dragger.activeIndex(state) === i,
        compound:   LIB.WheelChain.isCompound(mode, i),
        scale:      view.scale,
        label:      i === 0 ? `#${i} (drive)` : `#${i}`,
        omega:      w.omega,
        tau:        w.lastTau || 0,
      });
    }

    if (state.driveOn && view.centers[0]) {
      LIB.GearRender.drawDriveArrow(ctx, view.centers[0], state.lastT || 0);
    }
  }

  // ---------------------------------------------------------------------------
  //  Sliders
  // ---------------------------------------------------------------------------

  function wheelRows(state) {
    const mode = state.mode || "simple";
    const groups = [];
    for (let i = 0; i < state.N; i++) {
      const grp = [];
      const w = state.wheels[i];
      if (LIB.WheelChain.isCompound(mode, i)) {
        grp.push({ key: `r1_${i}`, label: `r₁ #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r1, onChange: (v) => { w.r1 = v; } });
        grp.push({ key: `r2_${i}`, label: `r₂ #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r2, onChange: (v) => { w.r2 = v; } });
      } else {
        grp.push({ key: `r_${i}`, label: `r #${i}`, min: 0.05, max: 3.0, step: 0.005,
                   value: w.r, onChange: (v) => { w.r = v; } });
      }
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
        { key: "wTarget", label: "ω_tgt", min: -30, max: 30, step: 0.01, value: 6.0,
          tip: "Target angular velocity (rad/s) for wheel #0." },
        { key: "Tmax",    label: "τ_max", min: 0.01, max: 50, step: 0.01, value: 2.0, log: true,
          tip: "Peak drive torque on wheel #0 (N·m)." },
        { key: "Kp",      label: "K_p",   min: 0.01, max: 200, step: 0.01, value: 5.0, log: true,
          tip: "Drive-loop proportional gain (N·m·s/rad)." },
        { key: "Jmotor",  label: "J #0",  min: 0.001, max: 5.0, step: 0.001,
          value: w0.J, log: true,
          tip: "Wheel-#0 (motor) inertia (kg·m²).",
          onChange: (v) => { w0.J = v; } },
      ],
      Mechanism: [
        { key: "drag", label: "c", min: 0, max: 2, step: 0.001, value: 0.02,
          tip: "Viscous damping at each wheel (N·m·s/rad)." },
      ],
      Wheels: {
        kind: "dynamic",
        title: "Wheels",
        items: wheelRows,
        actions: [
          { label: "+ Add wheel",
            run: (s) => { if (s.N < 8) LIB.WheelChain.addWheel(s, s.mode || "simple"); } },
          { label: "− Remove last",
            run: (s) => {
              if (s.N > 1) LIB.WheelChain.removeLast(s, s.mode || "simple");
              if (s.drag && s.drag.i >= s.N) s.drag = null;
            } },
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  //  Plots / readouts
  // ---------------------------------------------------------------------------

  function plotsSpec(state) {
    return [
      { title: "ω per wheel (rad/s)",
        yFmt: (v) => v.toFixed(1),
        series: state.wheels.map((_, i) => ({
          label: `w${i}`,
          color: LIB.WheelChainView.color(i),
          lw: i === 0 ? 2.4 : 1.6,
          source: (s) => +s[`omega_${i}`] || 0,
        })) },
      { title: "τ per wheel (N·m)",
        yFmt: (v) => v.toFixed(2),
        series: state.wheels.map((_, i) => ({
          label: `t${i}`,
          color: LIB.WheelChainView.color(i),
          lw: i === 0 ? 2.4 : 1.6,
          source: (s) => (s.wheels[i] ? (s.wheels[i].lastTau || 0) : 0),
        })) },
    ];
  }

  function readoutsSpec(state) {
    const mode = state.mode || "simple";
    const fixed = [
      { label: "τ applied",  units: "N·m",
        value: (s) => (s.lastT || 0).toFixed(3) },
      { label: "Power",      units: "W",
        value: (s) => ((s.lastT || 0) * s.omega_0).toFixed(3) },
      { label: "J_motor",    units: "kg·m²",
        value: (s) => s.wheels[0].J.toFixed(4) },
      { label: "J_load,refl",units: "kg·m²",
        value: (s) => {
          const Jt = LIB.WheelChain.reflectedJ(s.wheels, s.mode || "simple");
          return Math.max(0, Jt - s.wheels[0].J).toFixed(4);
        } },
      { label: "J_eff @ drive", units: "kg·m²",
        value: (s) => LIB.WheelChain.reflectedJ(s.wheels, s.mode || "simple").toFixed(4) },
      { label: "Match M",
        value: (s) => {
          const Jt = LIB.WheelChain.reflectedJ(s.wheels, s.mode || "simple");
          const Jl = Math.max(0, Jt - s.wheels[0].J);
          const M  = (s.wheels[0].J > 1e-12) ? (Jl / s.wheels[0].J) : Infinity;
          return { text: Number.isFinite(M) ? M.toFixed(2) : "∞",
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
      { label: "sim t", units: "s", value: (s) => s.t.toFixed(2) },
    ];
    const R = LIB.WheelChain.cumRatios(state.wheels, mode);
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

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const NOTES = {
    simple:
      "<b>simple</b> — wheels in a line touch at their rims and roll without " +
      "slipping. Each contact reverses direction, so adjacent wheels spin " +
      "opposite ways. Stage ratio is −r<sub>i</sub>/r<sub>i+1</sub>: a big " +
      "wheel driving a small one speeds up the chain and divides the torque; " +
      "a small driving a big one slows it down and multiplies the torque.",
    compound:
      "<b>compound</b> — wheels 1..N are <i>compound gears</i>: two gears of " +
      "radii r<sub>1</sub> and r<sub>2</sub> rigidly fixed to one shaft, so " +
      "they always turn together. r<sub>1</sub> meshes with the wheel on " +
      "its left, r<sub>2</sub> with the wheel on its right, and the radii " +
      "can differ. Stage ratio is −r2<sub>i</sub>/r1<sub>i+1</sub>; cascading " +
      "stages multiply, so a few compound stages produce huge speed reductions " +
      "(and torque multiplications). This is how gearboxes work.",
  };

  const SPEC = {
    id: "rotational-gears",
    title: "Gears",
    subtitle: "N-wheel transmission chain — simple or compound",

    state: defaultState,

    sliders:  sliderSpec,
    plots:    plotsSpec,
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

    modes: {
      default: "simple",
      persistKey: "rot-gears-mode",
      list: [
        { id: "simple",   label: "simple-radius" },
        { id: "compound", label: "double-radius" },
      ],
      onChange: (state, newId) => {
        state.mode = newId;
        state.drag = null;
      },
    },

    headerButtons: [LIB.HeaderButtons.driveToggle()],

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  // Description follows the active mode — the shell rebuilds the slider panel
  // (which paints spec.description) on every mode change, so a getter suffices.
  Object.defineProperty(SPEC, "description", {
    enumerable: true, configurable: true,
    get() { return NOTES[(SPEC._stateRef && SPEC._stateRef.mode) || "simple"]; },
  });
  SPEC.init = (handle) => { SPEC._stateRef = handle.state; };

  (window.RotationalLessons = window.RotationalLessons || {}).gears = SPEC;
})();
