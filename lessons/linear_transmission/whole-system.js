"use strict";

// =============================================================================
//  Whole-system translational lesson — closed-loop position PID into a
//  selectable mechanical device, with a thermal model on the motor.
//
//  This lesson is the canary for the modes axis: spec.modes lets the user
//  swap which device pops in (lead-screw / ball-screw / conveyor). Motor θ,
//  load x, PID integrator, motor temperature, and load mass all PERSIST
//  across the device swap — that's the whole point of "whole system":
//  retune a device against a fixed motor and load and see what happens.
//
//  Renderers live in lib/screw-render.js and lib/belt-render.js — the
//  three standalone lessons (lead-screw, ball-screw, conveyor) use the
//  same helpers, so this lesson stays small.
//
//  Pointer affordances (mux'd, hit-tests gated by current mode):
//    • LOAD     — drag horizontally (all modes) (hbar)
//    • SHAFT    — drag the shaft up/down to spin it (lead/ball modes) (vbar)
//    • PULLEYS  — rotate either pulley by its rim (conveyor mode) (angular)
// =============================================================================

(function () {

  const X_LIMIT          = 0.6;
  const LIN_DRAG_LOAD    = 1.5;
  const LIN_DRAG_MOTOR   = 0.005;
  const END_K_BUMP       = 5000;
  const END_C_BUMP       = 50;
  const K_LASH           = 2.0e5;
  const C_LASH           = 1.0e3;
  const K_RIGID          = 2.0e5;
  const C_RIGID          = 1.0e3;
  const K_LOAD_DRAG      = 2.0e5;
  const C_LOAD_DRAG      = 1.0e3;
  const K_SHAFT_DRAG     = 500;
  const C_SHAFT_DRAG     = 10;
  const K_PULLEY_DRAG    = 500;
  const C_PULLEY_DRAG    = 10;
  const SHAFT_RAD_PER_PX = 0.03;

  function reff(p) {
    if (p.mode === "conv") return p.rDrive;
    return (p.pitch * p.starts) / (2 * Math.PI);
  }
  function reflectedJ(p) { const r = reff(p); return p.mLoad * r * r; }

  function shaftCenterY(L, mode) {
    if (mode === "conv") return L.trackY - 60;
    return mode === "ball" ? (L.trackY - 50) : (L.trackY - 40);
  }
  function shaftHalfHpx(mode) { return mode === "ball" ? 22 : 24; }

  let cachedCanvas = null;

  // ---------------------------------------------------------------------------
  //  Render dispatcher — one lesson, three device renderers, gated by mode
  // ---------------------------------------------------------------------------

  function drawScene(ctx, L, state, params) {
    const E = state.thermal || 0;

    let info;
    if (params.mode === "lead" || params.mode === "ball") {
      const yMid = shaftCenterY(L, params.mode);
      info = (params.mode === "lead")
        ? LIB.ScrewRender.drawLeadNut(ctx, L, params, state,
            { yMid, shaftHpx: shaftHalfHpx("lead") * 2 })
        : LIB.ScrewRender.drawBallNut(ctx, L, params, state,
            { yMid, shaftHpx: shaftHalfHpx("ball") * 2 });
    } else {
      // Whole-system shows the motor in conv mode too — opt BeltRender in
      // (the standalone conveyor lesson leaves it off).
      const scene = LIB.BeltRender.drawScene(ctx, L, params, state,
        { motor: true, motorOpts: LIB.Thermal.motorOpts(state, 28) });
      info = { nutCx: scene.loadCx, weightCyTop: scene.loadTopY };
    }

    const wAccent = LIB.Thermal.tint("#66bb6a", E);
    const trap = LIB.Draw.trapezoidWeight(ctx, info.nutCx, info.weightCyTop,
                                          params.mLoad, { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, info.nutCx, trap.topY, reflectedJ(params),
                                { color: wAccent });
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag — single mux, hit-tests gated by current mode
  // ---------------------------------------------------------------------------

  function loadHit(state, params, L, mx, my) {
    return Math.abs(mx - L.xToPx(state.x))           < 65
        && Math.abs(my - shaftCenterY(L, params.mode)) < 60;
  }
  function shaftHit(state, params, L, mx, my) {
    if (params.mode === "conv") return false;
    const x0 = L.xToPx(L.xMin) - 4, x1 = L.xToPx(L.xMax) + 4;
    return mx >= x0 && mx <= x1
        && Math.abs(my - shaftCenterY(L, params.mode)) < shaftHalfHpx(params.mode) + 4;
  }
  function pulleyHit(which) {
    return function (state, params, L, mx, my) {
      if (params.mode !== "conv") return false;
      const g = LIB.BeltRender.layout(L, params);
      const cx = (which === "drive") ? g.drivePulleyCx : g.idlerPulleyCx;
      const pr = (which === "drive") ? g.r1Px          : g.r2Px;
      const dist = Math.hypot(mx - cx, my - g.cy);
      return dist < pr + 6 && dist > pr * 0.15;
    };
  }
  function pulleyCenter(which) {
    return function (state, params, L) {
      const g = LIB.BeltRender.layout(L, params);
      const cx = (which === "drive") ? g.drivePulleyCx : g.idlerPulleyCx;
      return { x: cx, y: g.cy };
    };
  }

  const loadDragger = LIB.Drag.hbar({
    kind: "load", hitTest: loadHit,
    worldX: (mx, L) => L.pxToX(mx),
    bounds: () => ({ min: -X_LIMIT, max: X_LIMIT }),
    onSeedV: (state) => state.v, windowSec: 0.02,
  });
  const shaftDragger = LIB.Drag.vbar({
    kind: "shaft", hitTest: shaftHit,
    onStart: (state, mx, my) => ({
      value: state.theta,
      anchor: { my0: my, theta0: state.theta },
    }),
    worldY: (my, layout, state, params, mx, anchor) =>
      anchor.theta0 - (my - anchor.my0) * SHAFT_RAD_PER_PX,
    onSeedV: (state) => state.omega, windowSec: 0.02,
  });
  const drivePulleyDragger = LIB.Drag.angular({
    kind: "drivePulley", hitTest: pulleyHit("drive"),
    centerPx: pulleyCenter("drive"),
    thetaOf: (state) => state.theta,
    onSeedW: (state) => state.omega, windowSec: 0.02,
  });
  const idlerPulleyDragger = LIB.Drag.angular({
    kind: "idlerPulley", hitTest: pulleyHit("idler"),
    centerPx: pulleyCenter("idler"),
    thetaOf: (state) => state.theta,
    onSeedW: (state) => state.omega, windowSec: 0.02,
  });
  const dragMux = LIB.Drag.mux([loadDragger, shaftDragger,
                                drivePulleyDragger, idlerPulleyDragger]);

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

  function vDemand(state, p, vCap) {
    return LIB.PositionTorque.demand(state.posLoop,
      p.xTarget, state.x, state.v,
      { kp: p.KpPos, kd: p.KdPos, vCap });
  }
  function motorTorque(state, p) {
    if (state.exploded) return 0;
    const vD = vDemand(state, p, p.wTarget);
    let tau = p.Kp * (vD - state.omega);
    if (tau >  p.Tmax) tau =  p.Tmax;
    if (tau < -p.Tmax) tau = -p.Tmax;
    return tau;
  }
  function endStopForce(state) {
    return LIB.EndStop.force(state.x, state.v, -X_LIMIT, X_LIMIT,
                             END_K_BUMP, END_C_BUMP);
  }
  function pulleyDragTorque(state, p) {
    if (drivePulleyDragger.isActive(state)) {
      return drivePulleyDragger.springTheta(state, state.theta, state.omega,
                                            K_PULLEY_DRAG, C_PULLEY_DRAG);
    }
    if (idlerPulleyDragger.isActive(state) && state.drag) {
      const ratio = p.rIdler / Math.max(1e-9, p.rDrive);
      const targetTheta = state.drag.theta * ratio;
      const targetOmega = state.drag.omega * ratio;
      return -K_PULLEY_DRAG * (state.theta - targetTheta)
             -C_PULLEY_DRAG * (state.omega - targetOmega);
    }
    return 0;
  }

  function dxdt(state, p, t) {
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    let F_couple = 0;
    if (p.mode === "lead") {
      const H = p.lash / 2;
      const psiTarget = state.engaged > 0 ? +H : (state.engaged < 0 ? -H : 0);
      const inLash = state.engaged !== 0;
      const psi    = state.x - state.theta * r;
      const psiDot = state.v - state.omega * r;
      const Klash = inLash ? K_LASH : 0;
      const Clash = inLash ? C_LASH : 0;
      F_couple = -Klash * (psi - psiTarget) - Clash * psiDot;
    } else {
      const psi    = state.x - state.theta * r;
      const psiDot = state.v - state.omega * r;
      F_couple = -K_RIGID * psi - C_RIGID * psiDot;
    }

    const Fdrag    = loadDragger.spring1D (state, state.x, state.v,
                                           K_LOAD_DRAG, C_LOAD_DRAG);
    const tauShaft = shaftDragger.spring1D(state, state.theta, state.omega,
                                           K_SHAFT_DRAG, C_SHAFT_DRAG);
    const tauPull  = (p.mode === "conv") ? pulleyDragTorque(state, p) : 0;

    const Fend = endStopForce(state);
    const tau  = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + Fend + F_couple + Fdrag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * F_couple + tauShaft + tauPull) / J,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    let Kc, Cc;
    if (p.mode === "lead") {
      const inLash = state.engaged !== 0;
      Kc = inLash ? K_LASH : 0;
      Cc = inLash ? C_LASH : 0;
    } else {
      Kc = K_RIGID; Cc = C_RIGID;
    }

    const Kld = loadDragger.isActive(state)        ? K_LOAD_DRAG  : 0;
    const Cld = loadDragger.isActive(state)        ? C_LOAD_DRAG  : 0;
    const Ksh = shaftDragger.isActive(state)       ? K_SHAFT_DRAG : 0;
    const Csh = shaftDragger.isActive(state)       ? C_SHAFT_DRAG : 0;
    const Kpu = (drivePulleyDragger.isActive(state) || idlerPulleyDragger.isActive(state))
                  ? K_PULLEY_DRAG : 0;
    const Cpu = (drivePulleyDragger.isActive(state) || idlerPulleyDragger.isActive(state))
                  ? C_PULLEY_DRAG : 0;

    let Kbx = 0, Cbv = 0;
    if (state.x < -X_LIMIT) { Kbx = -END_K_BUMP; if (state.v < 0) Cbv = -END_C_BUMP; }
    else if (state.x > +X_LIMIT) { Kbx = -END_K_BUMP; if (state.v > 0) Cbv = -END_C_BUMP; }

    let dTau_dx = 0, dTau_dv = 0, dTau_dom = 0;
    if (!state.exploded) {
      const vCap = p.wTarget;
      const vDraw = p.KpPos * (p.xTarget - state.x) - p.KdPos * state.v
                  + (state.posLoop.I || 0);
      const vDemandSaturated = (vDraw >= vCap) || (vDraw <= -vCap);
      const vClamped = Math.max(-vCap, Math.min(vCap, vDraw));
      const tauRaw = p.Kp * (vClamped - state.omega);
      const tauSaturated = (tauRaw >= p.Tmax) || (tauRaw <= -p.Tmax);
      if (!tauSaturated) {
        dTau_dom = -p.Kp;
        if (!vDemandSaturated) {
          dTau_dx = p.Kp * (-p.KpPos);
          dTau_dv = p.Kp * (-p.KdPos);
        }
      }
    }

    M[0*n+0] = 0; M[0*n+1] = 1; M[0*n+2] = 0; M[0*n+3] = 0;
    M[1*n+0] = (Kbx        - Kc - Kld) / m;
    M[1*n+1] = (-LIN_DRAG_LOAD + Cbv - Cc - Cld) / m;
    M[1*n+2] = ( Kc * r) / m;
    M[1*n+3] = ( Cc * r) / m;
    M[2*n+0] = 0; M[2*n+1] = 0; M[2*n+2] = 0; M[2*n+3] = 1;
    M[3*n+0] = (dTau_dx + r * Kc) / J;
    M[3*n+1] = (dTau_dv + r * Cc) / J;
    M[3*n+2] = (-r * r * Kc - Ksh - Kpu) / J;
    M[3*n+3] = (dTau_dom - LIN_DRAG_MOTOR - r * r * Cc - Csh - Cpu) / J;

    return M;
  }

  function preStep(state, p, dt) {
    dragMux.preStep(state, dt);

    if (!state.exploded) {
      LIB.PositionTorque.advance(state.posLoop,
        p.xTarget, state.x, dt,
        { ki: p.KiPos, vCap: p.wTarget });
    }

    if (p.mode === "lead") {
      // Engagement latch (matches standalone lead-screw).
      const r = reff(p);
      const H = p.lash / 2;
      const psi    = state.x - state.theta * r;
      const psiDot = state.v - state.omega * r;
      let engaged = state.engaged || 0;
      const eps = Math.max(1e-7, H * 1e-3);
      if (H <= 1e-9) {
        engaged = (psiDot >= 0) ? +1 : -1;
      } else {
        const omegaTargetMotor = !state.exploded ? vDemand(state, p, p.wTarget) : state.omega;
        const omegaWanted = (Math.abs(r) > 1e-9) ? state.v / r : 0;
        const tau   = motorTorque(state, p);
        const ddth  = (tau - LIN_DRAG_MOTOR * state.omega) / Math.max(1e-9, p.Jmotor);
        const dragging = loadDragger.isActive(state);
        const omegaFree = state.omega + dt * ddth;
        const xFree     = dragging ? state.x : state.x + state.v * dt;
        const psiEnd    = xFree - (state.theta + omegaFree * dt) * r;
        if (engaged !== +1 && (psi >= H - eps || psiEnd >= H)) engaged = +1;
        else if (engaged !== -1 && (psi <= -H + eps || psiEnd <= -H)) engaged = -1;
        const tol = 0.05;
        if (engaged === -1) {
          if (omegaTargetMotor < omegaWanted - tol) engaged = 0;
          else if (psi > -H * 0.5) engaged = 0;
        } else if (engaged === +1) {
          if (omegaTargetMotor > omegaWanted + tol) engaged = 0;
          else if (psi < H * 0.5) engaged = 0;
        }
      }
      state.engaged = engaged;
    } else {
      state.engaged = 0;
    }

    state.lastTau = motorTorque(state, p);
  }

  function postStep(state, p, dt) {
    if (!state.exploded) {
      LIB.Thermal.step(state, dt, state.lastTau, p.Tmax);
    } else if (state.thermal > 0) {
      state.thermal = Math.max(0, state.thermal - dt / LIB.Thermal.TAU_S);
    }
    const r = reff(p);
    state.psi = state.x - state.theta * r;
  }

  // ---------------------------------------------------------------------------
  //  Mode-aware sliders / readouts
  // ---------------------------------------------------------------------------

  let currentStarts = 1;

  function buildSliders(state) {
    const Target = { span: "full", items: [
      { key: "xTarget", label: "x_tgt", min: -X_LIMIT, max: X_LIMIT, step: 0.005, value: 0.30 },
    ] };
    const Drive = [
      { key: "Tmax",    label: "τ_max",  min: 0.05, max: 50,   step: 0.01, value: 2.0, log: true },
      { key: "wTarget", label: "ω_cap",  min: 0.5,  max: 40,   step: 0.01, value: 12.0 },
      { key: "Kp",      label: "K_p",    min: 0.05, max: 200,  step: 0.01, value: 6.0, log: true },
      { key: "Jmotor",  label: "J_motor", min: 0.001, max: 5.0, step: 0.001, value: 0.012, log: true },
      { key: "KpPos",   label: "Kp_pos", min: 0.1,  max: 200,  step: 0.1,  value: 30, log: true },
      { key: "KdPos",   label: "Kd_pos", min: 0,    max: 100,  step: 0.1,  value: 8 },
      { key: "KiPos",   label: "Ki_pos", min: 0,    max: 100,  step: 0.1,  value: 5 },
    ];
    const Mech = [
      { key: "mLoad",  label: "load m", min: 0.1, max: 200, step: 0.1, value: 8.0, log: true },
    ];
    const mode = state.mode;
    if (mode === "lead") {
      Mech.push(
        { key: "starts", label: "starts", min: 1, max: 6, step: 1, value: 1,
          onChange: (v) => { currentStarts = v; } },
        { key: "pitch",  label: "pitch",  min: 0.002, max: 0.10, step: 0.0005, value: 0.05, log: true,
          dynMin: () => LIB.ScrewRender.minRenderablePitch(cachedCanvas, currentStarts, X_LIMIT, 0.002) },
        { key: "lash",   label: "lash",   min: 0, max: 0.005, step: 0.0001, value: 0.0008 },
      );
    } else if (mode === "ball") {
      Mech.push(
        { key: "starts", label: "starts", min: 1, max: 6, step: 1, value: 2,
          onChange: (v) => { currentStarts = v; } },
        { key: "pitch",  label: "pitch",  min: 0.002, max: 0.10, step: 0.0005, value: 0.04, log: true,
          dynMin: () => LIB.ScrewRender.minRenderablePitch(cachedCanvas, currentStarts, X_LIMIT, 0.002) },
      );
    } else if (mode === "conv") {
      Mech.push(
        { key: "rDrive", label: "r₁ drive", min: 0.05, max: 0.5, step: 0.005, value: 0.20 },
        { key: "rIdler", label: "r₂ idler", min: 0.05, max: 0.5, step: 0.005, value: 0.20 },
      );
    }
    return { Target, Drive, Mechanism: Mech };
  }

  function buildPlots(state) {
    return [
      { title: "x(t) — load position (m), yellow = target",
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "target", color: "#f6c945", lw: 1.4, source: (s, p) => p.xTarget },
          { label: "x",      color: "#4ea1ff", lw: 2.2, source: (s)    => s.x },
        ] },
      { title: "τ motor (N·m)",
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "tau", color: "#4ea1ff", lw: 2.0, source: (s) => s.lastTau || 0 },
        ] },
      { title: "Motor temperature (E, 0..1, 1 = blow)",
        yFmt: (v) => v.toFixed(2), yMin: 0, yMax: 1.05,
        series: [
          { label: "E", color: "#ef5350", lw: 2.0, source: (s) => s.thermal || 0 },
        ] },
    ];
  }

  function buildReadouts(state) {
    const r = [
      { label: "τ applied",   units: "N·m",   value: (s) => (s.lastTau || 0).toFixed(3) },
      { label: "x (load)",    units: "m",     value: (s) => s.x.toFixed(3) },
      { label: "v (load)",    units: "m/s",   value: (s) => s.v.toFixed(3) },
      { label: "θ (motor)",   units: "rad",   value: (s) => s.theta.toFixed(2) },
      { label: "ω (motor)",   units: "rad/s", value: (s) => s.omega.toFixed(2) },
      { label: "Motor E",     units: "0..1",  value: (s) => (s.thermal || 0).toFixed(2) },
      { label: "exploded",                    value: (s) => s.exploded ? "YES" : "no" },
    ];
    if (state.mode === "lead") {
      r.push(
        { label: "ψ (lash)", units: "mm", value: (s) => ((s.psi || 0) * 1000).toFixed(2) },
        { label: "engaged", value: (s) => s.engaged > 0 ? "+H" : (s.engaged < 0 ? "−H" : "free") },
      );
    } else if (state.mode === "conv") {
      r.push({ label: "r_eff", units: "m", value: (s, p) => reff(p).toFixed(3) });
    }
    r.push(
      { label: "J_load,refl", units: "kg·m²", value: (s, p) => reflectedJ(p).toFixed(5) },
      { label: "Match M",
        value: (s, p) => {
          const M = reflectedJ(p) / Math.max(1e-9, p.Jmotor);
          return { text: M.toFixed(2), color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
    );
    return r;
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const WHOLE_SYSTEM = {
    id: "whole-system",
    title: "Whole-system translational",
    subtitle: "position PID into a swappable device, with motor thermal model",
    description: `<b>whole-system translational</b> — pick a device, set a load mass and target. The motor runs an inner velocity loop; an outer position PID drives that velocity demand. Reflected inertia at the motor is the rotor J plus m·r_eff². A leaky-integrator thermal model (25 °C ambient, τ_th=12 s, copper losses ∝ τ², blow temp 180 °C reached after ~5 s of continuous τ_max from cold) means a poorly-matched device + load combination cooks the motor and explodes it. Optimal load acceleration occurs when M = J<sub>load,refl</sub>/J<sub>motor</sub> ≈ 1 — adjust pitch/starts/r₁ until M hits 1, OR match J<sub>motor</sub> to the transmission. Drag the load horizontally (any device); drag the screw shaft up/down (lead/ball); rotate either pulley by its rim (conveyor).`,

    state: () => ({
      x: 0, v: 0, theta: 0, omega: 0,
      posLoop: { I: 0, ePrev: 0 },
      engaged: 0,
      thermal: 0, exploded: false,
      lastTau: 0, psi: 0,
      drag: null,
      // mode field is initialised by the shell from spec.modes.default.
      t: 0,
    }),

    onReset: (s) => { s.drag = null; s.engaged = 0; s.exploded = false;
                      s.thermal = 0; s.posLoop = { I: 0, ePrev: 0 }; },

    modes: {
      default: "lead",
      persistKey: "wholesys-device",
      list: [
        { id: "lead", label: "lead-screw" },
        { id: "ball", label: "ball-screw" },
        { id: "conv", label: "conveyor" },
      ],
      onChange: (state) => {
        // Clear engagement so a stale lash latch isn't carried into a
        // device with no lash.
        state.engaged = 0;
        state.drag = null;
      },
    },

    sliders: buildSliders,
    plots:    buildPlots,
    readouts: buildReadouts,

    physics: {
      dof: ["x", "v", "theta", "omega"],
      dxdt, jacobian,
      integrator: "implicitEuler",
      preStep, postStep,
    },

    layout: { kind: "linearTrack", xMin: -X_LIMIT, xMax: X_LIMIT },

    // Mode-aware motor: in lead/ball modes the shell paints it pre-render;
    // in conv mode LIB.BeltRender draws its own (so we return null and let
    // drawScene hand BeltRender the same thermal motorOpts).
    motor: (state, params) => params.mode === "conv" ? null : ({
      place: (L) => ({ cx: L.xToPx(L.xMin) - 28 - 8,
                       cy: shaftCenterY(L, params.mode) }),
      r: 28,
      thermalAware: true,
    }),

    positionRail: { field: "x", target: "xTarget" },

    render: drawScene,

    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    init: (handle) => { cachedCanvas = handle.canvas; },

    physHz: 240,
  };

  (window.LinearLessons = window.LinearLessons || {}).wholeSystem = WHOLE_SYSTEM;
})();
