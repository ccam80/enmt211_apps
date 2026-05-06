"use strict";

// =============================================================================
//  Backlash lesson — gear chain with finite tooth lash.
//
//  Each mesh has a free-play arc B = `lash` at the pitch circle. Inside the
//  arc, gears coast independently; at the boundary, the loaded flank carries
//  torque rigidly via a stiff penalty spring (same shape as lead-screw's lash
//  but applied N−1 times across the chain).
//
//  Per-mesh state (state.meshEngaged[i] ∈ {-1, 0, +1}, state.meshPsiOffset[i])
//  is latched by LIB.Lash.latchEngagement in preStep. Release predicate is
//  the same "free acceleration of ψ pushes apart" test the original stateless
//  detector used; latching it removes the chatter near boundaries.
//
//  Tooth count is the primary parameter — radii are derived from N so all
//  gears in the chain share the same module (real teeth must be the same
//  size to mesh).
// =============================================================================

(function () {

  const PHYS_HZ   = 240;
  const HIST_HZ   = 60;
  const MODE      = "backlash";
  const PITCH_ARC = LIB.GearRender.PITCH_ARC;
  const N_MIN     = 6, N_MAX = 60;
  const K_LASH    = LIB.WheelChain.K_RIGID;     // 2.0e5
  const C_LASH    = LIB.WheelChain.C_RIGID;     // 1.0e3
  const K_DRAG    = 2.0e5;
  const C_DRAG    = 1.0e3;
  const SLIP_TOL  = 1e-9;

  function snappedR() {
    return LIB.GearRender.snapRadiusToTeeth(0.5, N_MIN, N_MAX, PITCH_ARC);
  }

  function defaultState() {
    const s = LIB.WheelChain.makeState(2, {
      defaults: () => ({ r: snappedR() }),
    });
    s.driveOn = false;
    s.lastT   = 0;
    s.mode    = MODE;
    LIB.WheelChain.recomputePsiOffsets(s, MODE);
    return s;
  }

  // ---------------------------------------------------------------------------
  //  Drive
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
  //  Per-mesh latched engagement update
  //
  //  Release predicate matches the original stateless detector's
  //  "stay-engaged" criterion inverted: release when ψ̇ has gone the wrong
  //  way AND the free acceleration of ψ would also pull apart.
  // ---------------------------------------------------------------------------

  function meshFreeAcc(state, params, i) {
    const wA = state.wheels[i];
    const wB = state.wheels[i + 1];
    const omA = state[`omega_${i}`];
    const omB = state[`omega_${i + 1}`];
    let T_A = -params.drag * omA;
    let T_B = -params.drag * omB;
    if (i === 0) T_A += driveTorque(state, params);
    // ψ = rA·θA + ms·rB·θB → ψ̈_free = rA·αA + ms·rB·αB
    //   For backlash mode, ms = +1.
    const rA = wA.r, rB = wB.r;
    return rA * (T_A / Math.max(1e-9, wA.J))
         + rB * (T_B / Math.max(1e-9, wB.J));
  }

  function updateEngagement(state, params, dt) {
    const N = state.N;
    const H = params.lash / 2;
    for (let i = 0; i < N - 1; i++) {
      const psi    = LIB.WheelChain.meshPsi   (state, MODE, i);
      const psiDot = LIB.WheelChain.meshPsiDot(state, MODE, i);
      const ddFree = meshFreeAcc(state, params, i);
      // Predicted ψ at end of step under free acc (same look-ahead lead-screw uses).
      const psiEnd = psi + psiDot * dt + 0.5 * ddFree * dt * dt;

      state.meshEngaged[i] = LIB.Lash.latchEngagement(state.meshEngaged[i] || 0, {
        psi, psiDot, psiEnd, H,
        releaseAtPos: () => (psiDot <=  1e-6) && (ddFree <= -SLIP_TOL),
        releaseAtNeg: () => (psiDot >= -1e-6) && (ddFree >=  SLIP_TOL),
      });
    }
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
      meshK: K_LASH, meshC: C_LASH,
      meshH: params.lash / 2,
      drive: driveTorque,
      extraTorque: (s, p, i) => dragger.springTheta(s, i, K_DRAG, C_DRAG),
    });
  }
  function jacobian(state, params, t) {
    const J  = LIB.WheelChain.contactJacobian(state, params, t, {
      mode: MODE, c: params.drag,
      meshK: K_LASH, meshC: C_LASH,
    });
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
  function preStep(state, params, dt) {
    dragger.preStep(state, dt);
    updateEngagement(state, params, dt);
  }
  function postStep(state, params) {
    state.lastT = driveTorque(state, params);
  }

  function onPointer(type, mx, my, L, state, params) {
    return dragger.handle(type, mx, my, L, state, params);
  }

  // ---------------------------------------------------------------------------
  //  Render — involute teeth
  // ---------------------------------------------------------------------------

  function render(ctx, L, state, p) {
    cachedView = LIB.WheelChainView.buildView(L, state.wheels, MODE);
    const view = cachedView;
    const phases = LIB.GearRender.gearPhases(
      state.wheels,
      LIB.WheelChain.layoutCenters(state.wheels, MODE, 0),
      PITCH_ARC);

    for (let i = 0; i < state.N; i++) {
      const w = state.wheels[i];
      const c = view.centers[i];
      LIB.GearRender.drawGearShape(ctx, c, w, LIB.WheelChainView.color(i), {
        scale:      view.scale,
        phase:      phases[i],
        lashM:      p.lash,
        isDragging: dragger.isActive(state) && dragger.activeIndex(state) === i,
        pitchArc:   PITCH_ARC,
      });
      // Hub dot + indicator + annotation (drawWheel paints these but only
      // alongside its disc body — here we drew teeth already, so paint the
      // indicator manually).
      ctx.fillStyle = "#6a7384";
      ctx.beginPath(); ctx.arc(c.cx, c.cy, 3, 0, Math.PI * 2); ctx.fill();
      const dotR = Math.max(3, c.rPx * 0.08);
      const dx = Math.cos(w.theta) * (c.rPx - dotR - 2);
      const dy = -Math.sin(w.theta) * (c.rPx - dotR - 2);
      ctx.strokeStyle = LIB.WheelChainView.color(i);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c.cx, c.cy); ctx.lineTo(c.cx + dx, c.cy + dy); ctx.stroke();
      ctx.fillStyle = LIB.WheelChainView.color(i);
      ctx.beginPath(); ctx.arc(c.cx + dx, c.cy + dy, dotR, 0, Math.PI * 2); ctx.fill();

      // Annotation
      const titleFs = 19, valFs = 17, lineH = 22;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `700 ${titleFs}px ui-sans-serif`;
      ctx.fillStyle = i === 0 ? "#fff" : LIB.WheelChainView.color(i);
      ctx.fillText(i === 0 ? `#${i} (drive)` : `#${i}`, c.cx, c.cy - lineH);
      ctx.font = `600 ${valFs}px ui-sans-serif`;
      ctx.fillStyle = "#e6e9ef";
      ctx.fillText(`ω=${w.omega.toFixed(2)} rad/s`, c.cx, c.cy + 2);
      ctx.fillStyle = "#c0c9d8";
      ctx.fillText(`τ=${(w.lastTau || 0).toFixed(2)} N·m`, c.cx, c.cy + 2 + lineH);
    }
    if (state.driveOn && view.centers[0]) {
      LIB.GearRender.drawDriveArrow(ctx, view.centers[0], state.lastT || 0);
    }
  }

  // ---------------------------------------------------------------------------
  //  Sliders
  // ---------------------------------------------------------------------------

  function snapAndZeroState(state) {
    for (let i = 0; i < state.N; i++) {
      const w = state.wheels[i];
      w.r = LIB.GearRender.snapRadiusToTeeth(w.r, N_MIN, N_MAX, PITCH_ARC);
      w.theta = 0; w.omega = 0;
    }
    LIB.WheelChain.recomputePsiOffsets(state, MODE);
    for (let i = 0; i < state.meshEngaged.length; i++) state.meshEngaged[i] = 0;
  }

  function wheelRows(state) {
    const groups = [];
    for (let i = 0; i < state.N; i++) {
      const grp = [];
      const w = state.wheels[i];
      grp.push({
        key: `N_${i}`, label: `N #${i}`, min: N_MIN, max: N_MAX, step: 1,
        value: LIB.GearRender.teethCount(w.r, PITCH_ARC),
        tip: "Tooth count. Radius is derived so all gears share the same module.",
        onChange: (v, s) => {
          w.r = (Math.max(N_MIN, Math.min(N_MAX, Math.round(v))) * PITCH_ARC) / (2 * Math.PI);
          snapAndZeroState(s);
        },
      });
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
        { key: "wTarget", label: "ω_tgt",  min: -30, max: 30, step: 0.01, value: 6.0,
          tip: "Target ω for wheel #0 (rad/s)." },
        { key: "Tmax",    label: "τ_max",  min: 0.01, max: 50, step: 0.01, value: 2.0, log: true,
          tip: "Peak drive torque (N·m)." },
        { key: "Kp",      label: "K_p",    min: 0.01, max: 200, step: 0.01, value: 5.0, log: true,
          tip: "Drive-loop gain." },
        { key: "Jmotor",  label: "J #0",   min: 0.001, max: 5.0, step: 0.001,
          value: w0.J, log: true,
          onChange: (v) => { w0.J = v; } },
      ],
      Mechanism: [
        { key: "drag", label: "c", min: 0, max: 2, step: 0.001, value: 0.02,
          tip: "Viscous damping per wheel (N·m·s/rad)." },
        { key: "lash", label: "lash", min: 0, max: 0.30, step: 0.001, value: 0.04,
          tip: "Free-play arc per mesh at the pitch circle (m). Reverse direction → chain crosses every mesh's lash before the far end moves." },
      ],
      Wheels: {
        kind: "dynamic",
        title: "Gears",
        items: wheelRows,
        actions: [
          { label: "+ Add gear",
            run: (s) => {
              if (s.N >= 8) return;
              LIB.WheelChain.addWheel(s, MODE, { r: snappedR() });
              snapAndZeroState(s);
            } },
          { label: "− Remove last",
            run: (s) => {
              if (s.N <= 1) return;
              LIB.WheelChain.removeLast(s, MODE);
              if (s.drag && s.drag.i >= s.N) s.drag = null;
              snapAndZeroState(s);
            } },
        ],
      },
    };
  }

  function plotsSpec(state) {
    return [
      { title: "ω per wheel (rad/s)",
        yFmt: (v) => v.toFixed(1),
        series: state.wheels.map((_, i) => ({
          label: `w${i}`, color: LIB.WheelChainView.color(i),
          lw: i === 0 ? 2.4 : 1.6,
          source: (s) => +s[`omega_${i}`] || 0,
        })) },
      { title: "ψ per mesh (m) — clamped to ±lash/2",
        yFmt: (v) => v.toFixed(3),
        series: state.wheels.slice(0, -1).map((_, i) => ({
          label: `psi${i}`, color: LIB.WheelChainView.color(i + 1), lw: 1.6,
          source: (s) => s.N > i + 1 ? LIB.WheelChain.meshPsi(s, MODE, i) : 0,
        })) },
    ];
  }

  function readoutsSpec(state) {
    const fixed = [
      { label: "τ applied", units: "N·m", value: (s) => (s.lastT || 0).toFixed(3) },
      { label: "J_motor",   units: "kg·m²", value: (s) => s.wheels[0].J.toFixed(4) },
      { label: "sim t",     units: "s", value: (s) => s.t.toFixed(2) },
    ];
    const meshes = state.wheels.slice(0, -1).map((_, i) => ({
      label: `mesh ${i}-${i + 1}`,
      value: (s) => {
        const psi = LIB.WheelChain.meshPsi(s, MODE, i);
        const eng = (s.meshEngaged && s.meshEngaged[i]) || 0;
        const tag = eng > 0 ? "+H" : eng < 0 ? "−H" : "free";
        return `ψ=${psi.toFixed(4)} ${tag}`;
      },
    }));
    return fixed.concat(meshes);
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "rotational-backlash",
    title: "Backlash",
    subtitle: "gear chain with finite tooth lash",
    description:
      "<b>backlash</b> — real gear teeth never mesh perfectly: there is always " +
      "a small gap between the trailing flank of one tooth and the leading flank " +
      "of the next. While the drive is pushing one way the loaded flanks stay " +
      "in contact and the chain transmits torque rigidly, but on a direction " +
      "reversal each mesh has to cross its own gap before the opposite flank " +
      "picks up motion. Drag any wheel and reverse — you can feel the slack " +
      "absorb at every mesh along the chain before the far end starts moving. " +
      "This is why backlash is critical in positioning systems: every reversal " +
      "loses position by the cumulative lash.",

    state: defaultState,
    onReset: snapAndZeroState,

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

  (window.RotationalLessons = window.RotationalLessons || {}).backlash = SPEC;
})();
