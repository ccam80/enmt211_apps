"use strict";

// =============================================================================
//  Lead-screw lesson — translating load via threaded screw + nut.
//
//  Spec-driven shell + LIB.Layout.linearTrack + LIB.Drag.{hbar, vbar, mux}
//  + LIB.ScrewRender for the shaft and lash-amplified nut.
//
//  Two pointer-drag affordances:
//    • LOAD — grab the nut housing and slide horizontally. Pointer x → x_load
//             via a stiff penalty spring in dxdt. The screw still evolves
//             under its own dynamics so it preserves angular momentum across
//             the drag (the drag-smoother feeds Fdrag's damping term so the
//             spring isn't fighting our own velocity).
//    • SHAFT — grab the screw shaft itself and drag the pointer up/down to
//             rotate it. Vertical pointer Δy maps to Δθ relative to the grab
//             point; the dragger hands us {value:θ_target, velocity:ω_target}
//             and dxdt applies a stiff spring on θ.
//
//  The unified-stiff-spring formulation collapses lash contact, end-stop
//  bumper, and pointer drag into one set of branched stiff terms in a single
//  dxdt + jacobian, integrated by linearly-implicit Euler. preStep latches
//  engagement and advances the position-PID integrator. postStep advances
//  the thermal model and exposes the bookkeeping the renderer wants.
// =============================================================================

(function () {

  const X_LIMIT          = 0.6;
  const LIN_DRAG_LOAD    = 1.5;          // viscous drag on the load (N·s/m)
  const LIN_DRAG_MOTOR   = 0.005;        // motor shaft drag (N·m·s/rad)
  const END_K_BUMP       = 5000;         // end-stop spring (N/m)
  const END_C_BUMP       = 50;           // end-stop damping (N·s/m)
  const K_LASH           = 2.0e5;        // lash contact spring (N/m)
  const C_LASH           = 1.0e3;        // lash contact damping (N·s/m)
  const K_LOAD_DRAG      = 2.0e5;        // pointer-on-load penalty spring (N/m)
  const C_LOAD_DRAG      = 1.0e3;        // pointer-on-load penalty damping (N·s/m)
  const K_SHAFT_DRAG     = 500;          // pointer-on-shaft penalty (N·m/rad)
  const C_SHAFT_DRAG     = 10;           //                          (N·m·s/rad)
  const SHAFT_RAD_PER_PX = 0.03;         // ~200 px per revolution

  function reff(p)        { return (p.pitch * p.starts) / (2 * Math.PI); }
  function reflectedJ(p)  { const r = reff(p); return p.mLoad * r * r; }

  // Centre-y of the shaft band — reused by the renderer AND by the shaft-
  // drag hit-test so they stay in sync.
  function shaftCenterY(L) { return L.trackY - 40; }
  const SHAFT_HALF_HPX = 24;

  // ---------------------------------------------------------------------------
  //  Renderer
  // ---------------------------------------------------------------------------

  let cachedCanvas = null;
  let currentStarts = 1;       // tracked via the starts-slider onChange callback

  function drawScene(ctx, L, state, params) {
    const yMid = shaftCenterY(L);
    const E = state.thermal || 0;

    const nut = LIB.ScrewRender.drawLeadNut(ctx, L, params, state,
                                            { yMid, shaftHpx: SHAFT_HALF_HPX * 2 });

    const wAccent = LIB.Thermal.tint("#66bb6a", E);
    const trap = LIB.Draw.trapezoidWeight(ctx, nut.nutCx, nut.weightCyTop, params.mLoad,
                                          { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, nut.nutCx, trap.topY, reflectedJ(params),
                                { color: wAccent });
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag — load + shaft
  // ---------------------------------------------------------------------------

  function loadHit(state, params, L, mx, my) {
    return Math.abs(mx - L.xToPx(state.x)) < 65
        && Math.abs(my - shaftCenterY(L))  < 50;
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
    if (!state.driveOn || state.exploded) return 0;
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

    const H      = p.lash / 2;
    const psi    = state.x - state.theta * r;
    const psiDot = state.v - state.omega * r;
    const Flash  = LIB.Lash.contactForce(psi, psiDot, state.engaged, H,
                                         K_LASH, C_LASH);

    const Fdrag    = loadDragger.spring1D (state, state.x,     state.v,
                                           K_LOAD_DRAG,  C_LOAD_DRAG);
    const tauShaft = shaftDragger.spring1D(state, state.theta, state.omega,
                                           K_SHAFT_DRAG, C_SHAFT_DRAG);

    const Fend  = endStopForce(state);
    const tau   = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + Fend + Flash + Fdrag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * Flash + tauShaft) / J,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r = reff(p);
    const m = Math.max(1e-9, p.mLoad);
    const J = Math.max(1e-9, p.Jmotor);

    const inLash = state.engaged !== 0;
    const Kl = inLash ? K_LASH : 0;
    const Cl = inLash ? C_LASH : 0;

    const Kld = loadDragger.isActive(state)  ? K_LOAD_DRAG  : 0;
    const Cld = loadDragger.isActive(state)  ? C_LOAD_DRAG  : 0;
    const Ksh = shaftDragger.isActive(state) ? K_SHAFT_DRAG : 0;
    const Csh = shaftDragger.isActive(state) ? C_SHAFT_DRAG : 0;

    let Kbx = 0, Cbv = 0;
    if (state.x < -X_LIMIT) { Kbx = -END_K_BUMP; if (state.v < 0) Cbv = -END_C_BUMP; }
    else if (state.x > +X_LIMIT) { Kbx = -END_K_BUMP; if (state.v > 0) Cbv = -END_C_BUMP; }

    let dTau_dx = 0, dTau_dv = 0, dTau_dom = 0;
    if (state.driveOn && !state.exploded) {
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
    M[1*n+0] = (Kbx        - Kl - Kld) / m;
    M[1*n+1] = (-LIN_DRAG_LOAD + Cbv - Cl - Cld) / m;
    M[1*n+2] = ( Kl * r) / m;
    M[1*n+3] = ( Cl * r) / m;
    M[2*n+0] = 0; M[2*n+1] = 0; M[2*n+2] = 0; M[2*n+3] = 1;
    M[3*n+0] = (dTau_dx + r * Kl) / J;
    M[3*n+1] = (dTau_dv + r * Cl) / J;
    M[3*n+2] = (-r * r * Kl - Ksh) / J;
    M[3*n+3] = (dTau_dom - LIN_DRAG_MOTOR - r * r * Cl - Csh) / J;

    return M;
  }

  function motorActive(state, p) {
    if (state.exploded) return false;
    return !!state.driveOn;
  }

  function preStep(state, p, dt) {
    dragMux.preStep(state, dt);

    if (motorActive(state, p)) {
      LIB.PositionTorque.advance(state.posLoop,
        p.xTarget, state.x, dt,
        { ki: p.KiPos, vCap: p.wTarget });
    }

    const r      = reff(p);
    const H      = p.lash / 2;
    const psi    = state.x - state.theta * r;
    const psiDot = state.v - state.omega * r;

    // Predicted ψ at end of step under free acceleration — drives the engage
    // test forward by one dt so a rapid reversal can't sail through the lash
    // window in a single tick.
    const tau       = motorTorque(state, p);
    const ddth      = (tau - LIN_DRAG_MOTOR * state.omega) / Math.max(1e-9, p.Jmotor);
    const dragging  = loadDragger.isActive(state);
    const omegaFree = state.omega + dt * ddth;
    const xFree     = dragging ? state.x : state.x + state.v * dt;
    const psiEnd    = xFree - (state.theta + omegaFree * dt) * r;

    // Release predicate: motor's commanded ω points opposite the engaged flank.
    const omegaTargetMotor = motorActive(state, p)
      ? vDemand(state, p, p.wTarget) : state.omega;
    const omegaWanted = (Math.abs(r) > 1e-9) ? state.v / r : 0;
    const SLIP_TOL = 0.05;

    state.engaged = LIB.Lash.latchEngagement(state.engaged || 0, {
      psi, psiDot, psiEnd, H,
      releaseAtPos: () => omegaTargetMotor > omegaWanted + SLIP_TOL,
      releaseAtNeg: () => omegaTargetMotor < omegaWanted - SLIP_TOL,
    });

    state.lastTau = motorTorque(state, p);
  }

  function postStep(state, p, dt) {
    if (state.driveOn && !state.exploded) {
      LIB.Thermal.step(state, dt, state.lastTau, p.Tmax);
    } else if (state.thermal > 0) {
      state.thermal = Math.max(0, state.thermal - dt / LIB.Thermal.TAU_S);
    }
    const r = reff(p);
    state.psi = state.x - state.theta * r;
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const LEAD_SCREW = {
    id: "lead-screw",
    title: "Lead screw",
    subtitle: "translating load via threaded screw + nut",
    description: `<b>lead screw</b> — the screw turns; the nut is constrained to translate. One revolution moves the nut by the <i>lead</i> = pitch · starts. Reflected inertia at the motor is m·(lead/2π)², so a fine pitch (small lead) hides a heavy load behind a tiny effective J. Backlash here is real: when you reverse direction, the screw spins through the lash window before the opposite thread flank catches the nut. Drag the load horizontally to push it; drag the screw shaft up/down to spin it. Pedagogical takeaway: lead screws trade speed for force, and lash for cost.`,

    state: () => ({
      x: 0, v: 0, theta: 0, omega: 0,
      posLoop: { I: 0, ePrev: 0 },
      engaged: 0,
      thermal: 0, exploded: false,
      lastTau: 0, psi: 0,
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
        { key: "starts", label: "starts", min: 1,    max: 6,    step: 1,    value: 1,
          tip: "Number of independent helical threads.",
          onChange: (v) => { currentStarts = v; } },
        { key: "pitch",  label: "pitch",  min: 0.002, max: 0.10, step: 0.0005, value: 0.05, log: true,
          tip: "Distance the nut travels per revolution per start (m).",
          dynMin: () => LIB.ScrewRender.minRenderablePitch(cachedCanvas, currentStarts, X_LIMIT, 0.002) },
        { key: "lash",   label: "lash",   min: 0,    max: 0.005, step: 0.0001, value: 0.0008,
          tip: "Axial backlash between the screw and nut threads (m)." },
      ],
    },

    plots: [
      { title: "x(t) — load position (m), yellow = target",
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "target", color: "#f6c945", lw: 1.4,
            source: (s, p) => p.xTarget },
          { label: "x",      color: "#4ea1ff", lw: 2.2,
            source: (s)    => s.x },
        ] },
      { title: "τ motor (N·m)",
        yFmt: (v) => v.toFixed(2),
        series: [
          { label: "tau", color: "#4ea1ff", lw: 2.0,
            source: (s) => s.lastTau || 0 },
        ] },
    ],

    readouts: [
      { label: "τ applied",   units: "N·m",   value: (s) => (s.lastTau || 0).toFixed(3) },
      { label: "x (load)",    units: "m",     value: (s) => s.x.toFixed(3) },
      { label: "v (load)",    units: "m/s",   value: (s) => s.v.toFixed(3) },
      { label: "θ (motor)",   units: "rad",   value: (s) => s.theta.toFixed(2) },
      { label: "ω (motor)",   units: "rad/s", value: (s) => s.omega.toFixed(2) },
      { label: "ψ (lash)",    units: "mm",    value: (s) => ((s.psi || 0) * 1000).toFixed(2) },
      { label: "engaged",                     value: (s) => s.engaged > 0 ? "+H" : (s.engaged < 0 ? "−H" : "free") },
      { label: "J_load,refl", units: "kg·m²",
        value: (s, p) => reflectedJ(p).toFixed(5) },
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
      preStep, postStep,
    },

    layout: { kind: "linearTrack", xMin: -X_LIMIT, xMax: X_LIMIT },

    // Plain motor disc anchored at the left of the track. The thermal
    // halo / explosion visuals live only in the whole-system lesson —
    // there the motor itself is the subject, here it's just a torque
    // source connected to the screw.
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

  (window.LinearLessons = window.LinearLessons || {}).leadScrew = LEAD_SCREW;
})();
