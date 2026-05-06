"use strict";

// =============================================================================
//  Ball-screw lesson — translating load via recirculating-ball nut.
//
//  Same kinematics as a lead screw (lead = pitch · starts), but the nut is
//  pre-loaded against backlash via balls rolling between matching helical
//  grooves on the screw and nut. There is therefore NO lash window — the
//  coupling is rigid. Reflected inertia at the motor is m·(lead/2π)², same
//  as a lead screw.
//
//  Two pointer affordances (same pattern as the lead-screw lesson):
//    • LOAD — drag the glass collar horizontally (hbar).
//    • SHAFT — drag the screw shaft up/down to spin it (vbar).
//
//  Physics: stiff penalty spring on ψ = x − θ·r forces the rigid coupling.
//  K_RIGID is large enough that any visible compression is sub-pixel. The
//  implicit-Euler integrator handles the stiff term.
//
//  Renderer: LIB.ScrewRender.drawBallNut handles the shaft + glass collar
//  + balls + per-start recirculation tubes.
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
  const K_SHAFT_DRAG     = 500;
  const C_SHAFT_DRAG     = 10;
  const SHAFT_RAD_PER_PX = 0.03;

  function reff(p)        { return (p.pitch * p.starts) / (2 * Math.PI); }
  function reflectedJ(p)  { const r = reff(p); return p.mLoad * r * r; }

  function shaftCenterY(L) { return L.trackY - 50; }
  const SHAFT_HALF_HPX = 22;

  let cachedCanvas = null;
  let currentStarts = 2;

  // ---------------------------------------------------------------------------
  //  Renderer
  // ---------------------------------------------------------------------------

  function drawScene(ctx, L, state, params) {
    const yMid = shaftCenterY(L);

    const nut = LIB.ScrewRender.drawBallNut(ctx, L, params, state,
                                            { yMid, shaftHpx: SHAFT_HALF_HPX * 2 });

    const wAccent = "#66bb6a";
    const trap = LIB.Draw.trapezoidWeight(ctx, nut.nutCx, nut.weightCyTop, params.mLoad,
                                          { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, nut.nutCx, trap.topY, reflectedJ(params),
                                { color: wAccent });
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag
  // ---------------------------------------------------------------------------

  function loadHit(state, params, L, mx, my) {
    return Math.abs(mx - L.xToPx(state.x)) < 65
        && Math.abs(my - shaftCenterY(L))  < 55;
  }
  function shaftHit(state, params, L, mx, my) {
    const x0 = L.xToPx(L.xMin) - 4;
    const x1 = L.xToPx(L.xMax) + 4;
    return mx >= x0 && mx <= x1
        && Math.abs(my - shaftCenterY(L)) < SHAFT_HALF_HPX + 4;
  }

  const loadDragger = LIB.Drag.hbar({
    kind: "load",
    hitTest: loadHit,
    worldX: (mx, L) => L.pxToX(mx),
    bounds: () => ({ min: -X_LIMIT, max: X_LIMIT }),
    onSeedV: (state) => state.v,
    windowSec: 0.02,
  });

  const shaftDragger = LIB.Drag.vbar({
    kind: "shaft",
    hitTest: shaftHit,
    onStart: (state, mx, my) => ({
      value: state.theta,
      anchor: { my0: my, theta0: state.theta },
    }),
    worldY: (my, layout, state, params, mx, anchor) =>
      anchor.theta0 - (my - anchor.my0) * SHAFT_RAD_PER_PX,
    onSeedV: (state) => state.omega,
    windowSec: 0.02,
  });

  const dragMux = LIB.Drag.mux([loadDragger, shaftDragger]);

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

  function dxdt(state, p, t) {
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    const psi    = state.x - state.theta * r;
    const psiDot = state.v - state.omega * r;
    const Frigid = -K_RIGID * psi - C_RIGID * psiDot;

    const Fdrag    = loadDragger.spring1D (state, state.x,     state.v,
                                           K_LOAD_DRAG,  C_LOAD_DRAG);
    const tauShaft = shaftDragger.spring1D(state, state.theta, state.omega,
                                           K_SHAFT_DRAG, C_SHAFT_DRAG);

    const Fend = endStopForce(state);
    const tau  = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + Fend + Frigid + Fdrag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * Frigid + tauShaft) / J,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    const Kld = loadDragger.isActive(state)  ? K_LOAD_DRAG  : 0;
    const Cld = loadDragger.isActive(state)  ? C_LOAD_DRAG  : 0;
    const Ksh = shaftDragger.isActive(state) ? K_SHAFT_DRAG : 0;
    const Csh = shaftDragger.isActive(state) ? C_SHAFT_DRAG : 0;

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
    M[3*n+2] = (-r * r * K_RIGID - Ksh) / J;
    M[3*n+3] = (dTau_dom - LIN_DRAG_MOTOR - r * r * C_RIGID - Csh) / J;

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

  const BALL_SCREW = {
    id: "ball-screw",
    title: "Ball screw",
    subtitle: "recirculating-ball nut, near-zero backlash",
    description: `<b>ball screw</b> — same kinematics as a lead screw, but balls roll between the screw and nut threads instead of sliding. The recirculation tube above the nut shows balls feeding back from the end of the working groove to the start. Ball screws are pre-loaded against backlash, so you can run a position loop tightly without lost motion. Reflected inertia is the same: m·(lead/2π)². Drag the load horizontally; drag the shaft up/down to spin it.`,

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
        { key: "starts", label: "starts", min: 1,    max: 6,    step: 1,    value: 2,
          tip: "Number of independent helical ball races.",
          onChange: (v) => { currentStarts = v; } },
        { key: "pitch",  label: "pitch",  min: 0.002, max: 0.10, step: 0.0005, value: 0.04, log: true,
          tip: "Distance the nut travels per revolution per start (m).",
          dynMin: () => LIB.ScrewRender.minRenderablePitch(cachedCanvas, currentStarts, X_LIMIT, 0.002) },
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
      { label: "lead",        units: "mm",    value: (s, p) => (p.pitch * p.starts * 1000).toFixed(1) },
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

    // Plain motor disc — see lead-screw.js for the rationale on why this
    // lesson doesn't enable thermal styling.
    motor: {
      place: (L) => ({ cx: L.xToPx(L.xMin) - 28 - 8, cy: shaftCenterY(L) }),
      r: 28,
    },

    positionRail: { field: "x", target: "xTarget" },

    render: drawScene,

    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    init: (handle) => { cachedCanvas = handle.canvas; },

    headerButtons: [LIB.HeaderButtons.driveToggle()],

    physHz: 240,
  };

  (window.LinearLessons = window.LinearLessons || {}).ballScrew = BALL_SCREW;
})();
