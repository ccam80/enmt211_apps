"use strict";

// =============================================================================
//  Conveyor-belt lesson — translating load on belt-driven flat surface.
//
//  Drive pulley spins; inextensible belt translates the load along its top
//  surface at v = ω · r_drive. Idler pulley sets visual loop only — speed
//  ratio is fixed by the inextensible-belt assumption. Reflected inertia at
//  the motor is m·r_drive² — the speed/force trade-off you tune via gearing.
//
//  Three pointer affordances:
//    • LOAD — drag the trapezoidal weight horizontally (hbar).
//    • PULLEY — click and rotate the drive pulley by its rim (angular).
//    • IDLER — click and rotate the idler pulley too — purely cosmetic since
//      the belt is inextensible, but it keeps both pulleys feeling alive.
//
//  Physics: rigid coupling between motor θ and load x via x = θ · r_drive.
//  Implemented with a stiff-spring penalty (target ψ = 0, no lash window).
//  End-stop bumper at ±X_LIMIT.
//
//  Renderer: LIB.BeltRender.drawScene handles motor + belt + pulleys +
//  phase marks.
// =============================================================================

(function () {

  const X_LIMIT          = 0.6;
  const LIN_DRAG_LOAD    = 1.5;
  const LIN_DRAG_MOTOR   = 0.005;
  const END_K_BUMP       = 5000;
  const END_C_BUMP       = 50;
  const K_RIGID          = 2.0e5;
  const C_RIGID          = 1.0e3;
  const K_LOAD_DRAG      = 2.0e5;
  const C_LOAD_DRAG      = 1.0e3;
  const K_PULLEY_DRAG    = 500;
  const C_PULLEY_DRAG    = 10;

  function reff(p)        { return p.rDrive; }
  function reflectedJ(p)  { const r = reff(p); return p.mLoad * r * r; }

  // ---------------------------------------------------------------------------
  //  Renderer
  // ---------------------------------------------------------------------------

  function drawScene(ctx, L, state, params) {
    const scene = LIB.BeltRender.drawScene(ctx, L, params, state);

    const wAccent = "#66bb6a";
    const trap = LIB.Draw.trapezoidWeight(ctx, scene.loadCx, scene.loadTopY, params.mLoad,
                                          { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, scene.loadCx, trap.topY, reflectedJ(params),
                                { color: wAccent });
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag
  // ---------------------------------------------------------------------------

  function loadHit(state, params, L, mx, my) {
    // Hit-test against the load body, which sits ABOVE the belt's top
    // tangent (g.loadTopY), not at the belt centre. The trapezoid extends
    // upward from loadTopY by ~40 px for a typical mass.
    const g = LIB.BeltRender.layout(L, params);
    const loadCy = g.loadTopY - 25;
    return Math.abs(mx - L.xToPx(state.x)) < 60
        && Math.abs(my - loadCy)           < 45;
  }

  function pulleyHit(which) {
    return function (state, params, L, mx, my) {
      const g = LIB.BeltRender.layout(L, params);
      const cx = (which === "drive") ? g.drivePulleyCx : g.idlerPulleyCx;
      const pr = (which === "drive") ? g.r1Px          : g.r2Px;
      const dist = Math.hypot(mx - cx, my - g.cy);
      // Annulus around the rim, plus a small inner deadzone so the pulley
      // hub doesn't overlap with belt-marker hits.
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
    kind: "load",
    hitTest: loadHit,
    worldX: (mx, L) => L.pxToX(mx),
    bounds: () => ({ min: -X_LIMIT, max: X_LIMIT }),
    onSeedV: (state) => state.v,
    windowSec: 0.02,
  });

  const drivePulleyDragger = LIB.Drag.angular({
    kind: "drivePulley",
    hitTest: pulleyHit("drive"),
    centerPx: pulleyCenter("drive"),
    thetaOf: (state) => state.theta,
    onSeedW: (state) => state.omega,
    windowSec: 0.02,
  });

  // Idler pulley — purely cosmetic feedback, but the spring routes through
  // the inverse ratio so dragging the idler still rotates the drive shaft.
  const idlerPulleyDragger = LIB.Drag.angular({
    kind: "idlerPulley",
    hitTest: pulleyHit("idler"),
    centerPx: pulleyCenter("idler"),
    thetaOf: (state) => state.theta,
    onSeedW: (state) => state.omega,
    windowSec: 0.02,
  });

  const dragMux = LIB.Drag.mux([loadDragger, drivePulleyDragger, idlerPulleyDragger]);

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

  function vDemand(state, p, vCap) {
    return LIB.PositionTorque.demand(state.posLoop,
      p.xTarget, state.x, state.v,
      { kp: p.KpPos, kd: p.KdPos, vCap });
  }

  function motorTorque(state, p) {
    if (!state.driveOn) return 0;
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

    const psi    = state.x - state.theta * r;
    const psiDot = state.v - state.omega * r;
    const Frigid = -K_RIGID * psi - C_RIGID * psiDot;

    const Fdrag    = loadDragger.spring1D(state, state.x, state.v,
                                          K_LOAD_DRAG, C_LOAD_DRAG);
    const tauPull  = pulleyDragTorque(state, p);

    const Fend = endStopForce(state);
    const tau  = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + Fend + Frigid + Fdrag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * Frigid + tauPull) / J,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    const dragLoadActive   = loadDragger.isActive(state);
    const dragDriveActive  = drivePulleyDragger.isActive(state);
    const dragIdlerActive  = idlerPulleyDragger.isActive(state);
    const dragPulleyActive = dragDriveActive || dragIdlerActive;
    const Kld = dragLoadActive   ? K_LOAD_DRAG    : 0;
    const Cld = dragLoadActive   ? C_LOAD_DRAG    : 0;
    const Kpu = dragPulleyActive ? K_PULLEY_DRAG  : 0;
    const Cpu = dragPulleyActive ? C_PULLEY_DRAG  : 0;

    let Kbx = 0, Cbv = 0;
    if (state.x < -X_LIMIT) { Kbx = -END_K_BUMP; if (state.v < 0) Cbv = -END_C_BUMP; }
    else if (state.x > +X_LIMIT) { Kbx = -END_K_BUMP; if (state.v > 0) Cbv = -END_C_BUMP; }

    let dTau_dx = 0, dTau_dv = 0, dTau_dom = 0;
    if (state.driveOn) {
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
    M[1*n+0] = (Kbx        - K_RIGID - Kld) / m;
    M[1*n+1] = (-LIN_DRAG_LOAD + Cbv - C_RIGID - Cld) / m;
    M[1*n+2] = ( K_RIGID * r) / m;
    M[1*n+3] = ( C_RIGID * r) / m;
    M[2*n+0] = 0; M[2*n+1] = 0; M[2*n+2] = 0; M[2*n+3] = 1;
    M[3*n+0] = (dTau_dx + r * K_RIGID) / J;
    M[3*n+1] = (dTau_dv + r * C_RIGID) / J;
    M[3*n+2] = (-r * r * K_RIGID - Kpu) / J;
    M[3*n+3] = (dTau_dom - LIN_DRAG_MOTOR - r * r * C_RIGID - Cpu) / J;

    return M;
  }

  function preStep(state, p, dt) {
    dragMux.preStep(state, dt);
    if (state.driveOn) {
      LIB.PositionTorque.advance(state.posLoop,
        p.xTarget, state.x, dt,
        { ki: p.KiPos, vCap: p.wTarget });
    }
    state.lastTau = motorTorque(state, p);
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const CONVEYOR = {
    id: "conveyor",
    title: "Conveyor belt",
    subtitle: "translating load on belt-driven flat surface",
    description: `<b>conveyor belt</b> — the drive pulley spins; a (locally) inextensible belt translates the load along its top surface at v = ω·r₁. Reflected inertia is m·r². Big drive pulleys give big v but huge effective inertia — exactly the speed/force trade-off you tune via gearing. Drag the load, or click either pulley and rotate it by its rim.`,

    state: () => ({
      x: 0, v: 0, theta: 0, omega: 0,
      posLoop: { I: 0, ePrev: 0 },
      lastTau: 0,
      drag: null,
      driveOn: false,
      t: 0,
    }),

    onReset: (s) => { s.drag = null; },

    sliders: {
      Target: { span: "full", items: [
        { key: "xTarget", label: "x_tgt", min: -X_LIMIT, max: X_LIMIT, step: 0.005, value: 0.30,
          tip: "Target load position (m) for the outer position PID." },
      ] },
      Drive: [
        { key: "Tmax",    label: "τ_max",  min: 0.05, max: 50,   step: 0.01, value: 2.0, log: true,
          tip: "Peak motor torque (N·m)." },
        { key: "wTarget", label: "ω_cap",  min: 0.5,  max: 40,   step: 0.01, value: 12.0,
          tip: "Velocity-loop saturation cap (rad/s)." },
        { key: "Kp",      label: "K_p",    min: 0.05, max: 200,  step: 0.01, value: 6.0, log: true,
          tip: "Velocity-loop proportional gain (N·m·s/rad)." },
        { key: "Jmotor",  label: "J_motor", min: 0.001, max: 5.0, step: 0.001, value: 0.012, log: true,
          tip: "Motor rotor inertia (kg·m²)." },
        { key: "KpPos",   label: "Kp_pos", min: 0.1,  max: 200,  step: 0.1,  value: 30, log: true,
          tip: "Position-loop proportional gain." },
        { key: "KdPos",   label: "Kd_pos", min: 0,    max: 100,  step: 0.1,  value: 8,
          tip: "Position-loop derivative gain." },
        { key: "KiPos",   label: "Ki_pos", min: 0,    max: 100,  step: 0.1,  value: 5,
          tip: "Position-loop integral gain." },
      ],
      Mechanism: [
        { key: "mLoad",  label: "load m", min: 0.1,  max: 200,  step: 0.1,  value: 8.0, log: true,
          tip: "Mass of the translating load (kg)." },
        { key: "rDrive", label: "r₁ drive", min: 0.05, max: 0.5, step: 0.005, value: 0.20,
          tip: "Radius of the driven pulley (m). Sets v = ω·r₁ for the belt." },
        { key: "rIdler", label: "r₂ idler", min: 0.05, max: 0.5, step: 0.005, value: 0.20,
          tip: "Radius of the idler pulley (m). Cosmetic — speed ratio is fixed by the inextensible belt." },
      ],
    },

    plots: [
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
    ],

    readouts: [
      { label: "τ applied",   units: "N·m",   value: (s) => (s.lastTau || 0).toFixed(3) },
      { label: "x (load)",    units: "m",     value: (s) => s.x.toFixed(3) },
      { label: "v (load)",    units: "m/s",   value: (s) => s.v.toFixed(3) },
      { label: "θ (motor)",   units: "rad",   value: (s) => s.theta.toFixed(2) },
      { label: "ω (motor)",   units: "rad/s", value: (s) => s.omega.toFixed(2) },
      { label: "r_eff",       units: "m",     value: (s, p) => reff(p).toFixed(3) },
      { label: "J_load,refl", units: "kg·m²", value: (s, p) => reflectedJ(p).toFixed(5) },
      { label: "Match M",
        value: (s, p) => {
          const M = reflectedJ(p) / Math.max(1e-9, p.Jmotor);
          return { text: M.toFixed(2),
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
    ],

    physics: {
      dof: ["x", "v", "theta", "omega"],
      dxdt, jacobian,
      integrator: "implicitEuler",
      preStep,
    },

    layout: { kind: "linearTrack", xMin: -X_LIMIT, xMax: X_LIMIT },

    // No spec.motor — and no `motor: true` passed to LIB.BeltRender either,
    // so the standalone conveyor lesson shows just the belt + pulleys.
    // The motor reappears in the whole-system lesson.

    // The belt sits 60 px above L.trackY (BeltRender's yMid default) and
    // the pulleys extend down to roughly L.trackY itself, so the default
    // 30 px gap to the rail leaves it tucked too close to the belt body.
    // Push it further down for clear separation.
    positionRail: { field: "x", target: "xTarget", yOffset: 60 },

    render: drawScene,

    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    headerButtons: [LIB.HeaderButtons.driveToggle()],
    physHz: 240,
  };

  (window.LinearLessons = window.LinearLessons || {}).conveyor = CONVEYOR;
})();
