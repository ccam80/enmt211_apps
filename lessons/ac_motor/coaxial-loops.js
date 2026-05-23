"use strict";

// =============================================================================
//  Coaxial nested loops — the simplest AC induction demo.
//
//  Two single circular coils sharing a common axis. The outer one (the
//  "stator") is fixed and driven by a sinusoidal terminal voltage; the inner
//  one (the "rotor") is short-circuited and free to rotate about world-x.
//
//  Time-averaged AC physics. With V_s = V·sin(ωt), the stator current is
//  i_s ≈ V/|Z_s|·sin(ωt-φ_s), and at rest the rotor short-circuit forces
//  i_r ≈ -M·V·ω/(|Z_s|·|Z_r|)·cos(ωt-φ_s-φ_r) where φ_r = arctan(ωL_r/R_r).
//  Substituting into the co-energy torque τ = i_s·i_r·dM/dθ with
//  M(θ) = M_0·cos(θ) and time-averaging gives:
//
//      ⟨τ⟩ = (V²·ω²·L_r·M_0²) / (4·|Z_s|²·|Z_r|²) · sin(2θ)
//
//  The +sin(2θ) DC component flips the stability landscape relative to the
//  instantaneous "M is maximised at θ=0" intuition: θ=0 and θ=π are UNSTABLE,
//  and θ=±π/2 (rotor coil normal perpendicular to stator field) are the
//  STABLE equilibria. The rotor's coil PLANE ends up parallel to the stator
//  field axis at equilibrium — the usual "lay edge-on to flush out flux"
//  geometry of a damped short-circuited coil in an oscillating field.
//
//  Sliders are trimmed down to just the drive frequency f. Every other
//  electromagnetic parameter is hardcoded at a value chosen to make the
//  approach to the θ=π/2 equilibrium happen on a human timescale (a few
//  seconds) with visible 2ω torque ripple riding on top.
// =============================================================================

(function () {

  // ---- physics constants -----------------------------------------------------
  const PHYS_HZ   = 480;
  const HIST_HZ   = 60;
  const NEUMANN_K = 20;
  const DTHETA    = 1e-3;
  const MU0       = 4e-7 * Math.PI;

  // Axial B at the centre of a circular N-turn loop carrying current i,
  // radius r:  B = μ₀·N·i / (2·r).
  function Bcoil(N, i, r) { return MU0 * N * i / (2 * r); }

  // Drive: V fixed high enough that the time-averaged AC torque is large
  // compared to mechanical damping, so the rotor visibly settles at ±π/2
  // within a few seconds across the entire f-slider range.
  const V_AMP = 50.0;

  // Stator
  const R_S = 4.0;
  const L_S = 0.012;
  const N_S = 100;
  const r_S = 0.55;

  // Rotor. L_R is sized so that at f≈1 Hz the rotor sits well above the
  // ω·L_r > R_r threshold for self-sustained rotation. At rest the slip-
  // driving slope d⟨τ⟩/dω_r at ω_r=0 is much smaller than mechanical
  // damping, so a static angular kick still settles at θ=±π/2; but a
  // velocity-kick (drag the rotor wire fast) pushes the slip frequency
  // far enough off ω_d that the asymmetric rotor-current phase lag
  // produces a net DC torque larger than damping, and the rotor self-
  // sustains all the way up to near-synchronous speed.
  const R_R = 0.3;
  const L_R = 0.8;
  const N_R = 100;
  const r_R = 0.30;

  // Mechanical. Damping b_r is now a slider so the student can sweep
  // through the bistable regime: at b_r ~ 1e-5 the rotor catches a
  // velocity kick into self-sustained rotation; at b_r ~ 5e-3 even a
  // hard kick is crushed back to θ=π/2 within a fraction of a second.
  const J_R = 5e-4;

  // Pointer-drag spring on the rotor angle. K/J chosen so the spring's
  // natural period stays > 10·PHYS_DT (rk4 absolute-stability margin)
  // even at the new low J_R; otherwise fast pointer drags ring the
  // integrator and ω_r explodes when the gesture releases.
  const K_ROTOR_DRAG = 20;
  const C_ROTOR_DRAG = 0.4;
  const ROTOR_RAD_PER_PX = 0.012;

  // Physical-sanity bounds. The slip-driving torque has a real ceiling
  // near synchronous speed (slip → 0 ⇒ rotor EMF → 0), but explicit rk4
  // overshoots that ceiling during fast transients — once ω_r runs an
  // order of magnitude past sync, dM/dθ·ω_r feedback into the rotor EMF
  // becomes too stiff for the integrator and the state cascades to ±∞.
  // Clamping in postStep contains the divergence without changing the
  // physics inside the bistable regime we actually care about.
  const OMEGA_MAX = 25;          // rad/s — ~2× sync at f=2 Hz
  const I_MAX     = 100;         // A    — ~8× steady-state stator peak
  const THETA_WRAP_AT = 1e4;     // rad  — wrap before sin/cos lose precision

  // Torque arrow length normalisation. Picked visually to keep the arrow
  // proportional to a typical peak torque under the default slider state.
  const TAU_REF = 0.03;

  function rotorPose(theta_r) {
    const sn = Math.sin(theta_r), cs = Math.cos(theta_r);
    return {
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: sn, z: cs },
      axis_u: { x: 1, y: 0, z: 0 },
    };
  }

  function makeStator() {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      axis_u: { x: 1, y: 0, z: 0 },
      radius: r_S, N: N_S, R: R_S, L: L_S,
    });
  }
  function makeRotor(theta) {
    const pose = rotorPose(theta);
    return LIB.EM.loop({
      center: pose.center,
      normal: pose.normal,
      axis_u: pose.axis_u,
      radius: r_R, N: N_R, R: R_R, L: L_R,
    });
  }

  function mutualAndDeriv(theta) {
    const stator = makeStator();
    const rPlus  = makeRotor(theta + DTHETA);
    const rMinus = makeRotor(theta - DTHETA);
    const rZero  = makeRotor(theta);
    const M      = LIB.EM.Mneumann(stator, rZero, NEUMANN_K);
    const Mp     = LIB.EM.Mneumann(stator, rPlus, NEUMANN_K);
    const Mm     = LIB.EM.Mneumann(stator, rMinus, NEUMANN_K);
    return { M, dMdth: (Mp - Mm) / (2 * DTHETA) };
  }

  // ---- physics ---------------------------------------------------------------

  const Lmat       = new Float64Array(4);
  const dLdt       = new Float64Array(4);
  const dLdthFull  = new Float64Array(4);
  const Rvec       = new Float64Array(2);
  const Vvec       = new Float64Array(2);
  const Ivec       = new Float64Array(2);

  function dxdt(state, p, t) {
    const omegaDrive = 2 * Math.PI * p.f_drive;
    const Vs = LIB.EM.acVoltage(t, V_AMP, omegaDrive, 0);
    const { M, dMdth } = mutualAndDeriv(state.theta_r);

    Lmat[0] = L_S; Lmat[1] = M;
    Lmat[2] = M;   Lmat[3] = L_R;

    const term = dMdth * state.omega_r;
    dLdt[0] = 0;    dLdt[1] = term;
    dLdt[2] = term; dLdt[3] = 0;

    Rvec[0] = R_S; Rvec[1] = R_R;
    Vvec[0] = Vs;  Vvec[1] = 0;
    Ivec[0] = state.i_s; Ivec[1] = state.i_r;

    const di = LIB.EM.solveCurrentRates(Lmat, Rvec, Vvec, dLdt, Ivec);

    dLdthFull[0] = 0;     dLdthFull[1] = dMdth;
    dLdthFull[2] = dMdth; dLdthFull[3] = 0;
    const tau = LIB.EM.coenergyTorque(dLdthFull, Ivec);
    state.lastTau    = tau;
    state.lastM      = M;
    state.lastDM     = dMdth;
    state.lastVs     = Vs;
    state.lastVemfR  = R_R * state.i_r;

    const tauDrag = rotorDragger.spring1D(state, state.theta_r, state.omega_r,
                                          K_ROTOR_DRAG, C_ROTOR_DRAG);
    return {
      i_s:     di[0],
      i_r:     di[1],
      theta_r: state.omega_r,
      omega_r: (tau + tauDrag - p.b_r * state.omega_r) / J_R,
    };
  }

  function preStep(state, params, dt) {
    dragMux.preStep(state, dt);
  }

  // Numerical safety net. The continuous physics has a real terminal speed
  // near sync, but explicit rk4 can overshoot during fast transients and
  // then cascade. Clamp ω_r and the currents to physical-magnitude bounds
  // and wrap θ_r before it grows large enough to lose precision in sin/cos.
  function postStep(state, params, dt) {
    if (!Number.isFinite(state.omega_r)) state.omega_r = 0;
    if (state.omega_r >  OMEGA_MAX) state.omega_r =  OMEGA_MAX;
    if (state.omega_r < -OMEGA_MAX) state.omega_r = -OMEGA_MAX;
    if (!Number.isFinite(state.i_s)) state.i_s = 0;
    if (state.i_s >  I_MAX) state.i_s =  I_MAX;
    if (state.i_s < -I_MAX) state.i_s = -I_MAX;
    if (!Number.isFinite(state.i_r)) state.i_r = 0;
    if (state.i_r >  I_MAX) state.i_r =  I_MAX;
    if (state.i_r < -I_MAX) state.i_r = -I_MAX;
    if (!Number.isFinite(state.theta_r)) state.theta_r = 0;
    // Always wrap θ_r to (-π, π]. The physics doesn't care about absolute
    // angle (M, dM/dθ, sin(θ) are all 2π-periodic), and the readout/plot
    // become unreadable when θ_r climbs into the thousands.
    state.theta_r = Math.atan2(Math.sin(state.theta_r), Math.cos(state.theta_r));
  }

  // ---- pointer ---------------------------------------------------------------

  let cachedL3 = null;
  let cachedRotorScreen = null;

  function rotorHit(state, params, layout, mx, my) {
    if (!cachedRotorScreen) return false;
    const HITPX = 18;
    let best = Infinity;
    for (const sp of cachedRotorScreen) {
      if (sp.behind) continue;
      const d = Math.hypot(mx - sp.px, my - sp.py);
      if (d < best) best = d;
    }
    return best < HITPX;
  }

  const rotorDragger = LIB.Drag.vbar({
    kind: "rotor",
    hitTest: rotorHit,
    onStart: (state, mx, my) => ({
      value:  state.theta_r,
      anchor: { my0: my, theta0: state.theta_r },
    }),
    worldY: (my, layout, state, params, mx, anchor) =>
      anchor.theta0 + (my - anchor.my0) * ROTOR_RAD_PER_PX,
    onSeedV: (state) => state.omega_r,
    windowSec: 0.02,
  });

  const orbitDragger = LIB.Drag.orbit({
    cameraField: "cam",
    yawPerPx:    0.008,
    pitchPerPx:  0.006,
  });
  const dragMux = LIB.Drag.mux([rotorDragger, orbitDragger]);

  function onPointer(type, mx, my, layout, state, params) {
    return dragMux.handle(type, mx, my, layout, state, params);
  }

  // ---- header buttons --------------------------------------------------------

  function toggleBtn(field, labelOn, labelOff) {
    return LIB.HeaderButtons.toggle({
      field,
      labelOn:  labelOn,
      labelOff: labelOff,
      styleOn:  { color: LIB.Util.getVar("--good"),  borderColor: LIB.Util.getVar("--good")  },
      styleOff: { color: LIB.Util.getVar("--muted"), borderColor: "#2e3642" },
    });
  }

  // Re-perturb away from whatever equilibrium the rotor has settled at.
  // Useful for re-running the demo without hitting Reset.
  const kickBtn = {
    id: "kick",
    label: "Kick rotor",
    style: { color: LIB.Util.getVar("--cI"), borderColor: LIB.Util.getVar("--cI") },
    onClick: (state) => { state.theta_r += 15 * Math.PI / 180; },
  };

  // ---- render ---------------------------------------------------------------

  function drawWorldAxes(ctx, L3, len) {
    const o = L3.project({ x: 0, y: 0, z: 0 });
    if (o.behind) return;
    const ends = [
      { dir: { x: len, y: 0, z: 0 }, color: "#ef5350", label: "x" },
      { dir: { x: 0, y: len, z: 0 }, color: "#66bb6a", label: "y" },
      { dir: { x: 0, y: 0, z: len }, color: "#4ea1ff", label: "z" },
    ];
    for (const e of ends) {
      const tip = L3.project(e.dir);
      if (tip.behind) continue;
      LIB.Draw.arrow(ctx, o.px, o.py, tip.px, tip.py, {
        color: e.color, width: 1.4, head: 8, label: e.label,
      });
    }
  }

  function drawRotorAxis(ctx, L3) {
    const a = L3.project({ x: -1.4, y: 0, z: 0 });
    const b = L3.project({ x: +1.4, y: 0, z: 0 });
    if (a.behind || b.behind) return;
    ctx.save();
    ctx.strokeStyle = "rgba(239,83,80,0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py);
    ctx.stroke();
    ctx.restore();
  }

  // Torque arrow along world-x — shared LIB.FieldRender.drawTorqueArrow.

  function peakCurrents(p, M0) {
    const w  = 2 * Math.PI * p.f_drive;
    const Zs = Math.hypot(R_S, w * L_S);
    const Is = V_AMP / Math.max(0.01, Zs);
    const emfR = Math.abs(M0) * w * Is;
    const Zr  = Math.hypot(R_R, w * L_R);
    const Ir  = emfR / Math.max(0.01, Zr);
    return { Is: Math.max(1e-6, Is), Ir: Math.max(1e-9, Ir),
             EmfR: Math.max(1e-9, emfR) };
  }

  // Cached at f = f_REF so the rotor-B trace can be scaled by a single
  // constant. Rotor current at low f is ~100× smaller than stator current,
  // so without scaling the rotor B trace would be invisible alongside B_s.
  const F_REF      = 1.0;
  const M0_REF     = LIB.EM.Mneumann(makeStator(), makeRotor(0), NEUMANN_K);
  const PEAKS_REF  = peakCurrents({ f_drive: F_REF }, M0_REF);
  const B_S_PEAK   = Bcoil(N_S, PEAKS_REF.Is, r_S);
  const B_R_PEAK   = Bcoil(N_R, PEAKS_REF.Ir, r_R);
  const B_R_SCALE  = (B_R_PEAK > 1e-12) ? (B_S_PEAK / B_R_PEAK) : 1;

  function render(ctx, layout, state, p) {
    const W = layout.W, H = layout.H;
    const L3 = LIB.Layout3D.orbital(W, H, {
      yaw:   state.cam.yaw,
      pitch: state.cam.pitch,
      dist:  state.cam.dist,
      fov:   Math.PI / 4,
    });
    cachedL3 = L3;
    const stator = makeStator();
    const rotor  = makeRotor(state.theta_r);

    const rot0 = makeRotor(0);
    const M0   = LIB.EM.Mneumann(stator, rot0, NEUMANN_K);
    const refs = peakCurrents(p, M0);

    if (state.showAxes) {
      drawWorldAxes(ctx, L3, 0.6);
      drawRotorAxis(ctx, L3);
    }

    if (state.showLines) {
      const dS = Math.min(1, Math.abs(state.i_s) / refs.Is);
      const dR = Math.min(1, Math.abs(state.i_r) / refs.Ir);
      LIB.FieldRender.drawLoopFieldLines(ctx, L3, stator, {
        color: "#4ea1ff", density: dS, alpha: 0.75,
        azSlices: 6, alphaScales: [1.6, 2.4, 3.4, 4.4],
      });
      LIB.FieldRender.drawLoopFieldLines(ctx, L3, rotor, {
        color: "#ef5350", density: dR, alpha: 0.75,
        azSlices: 6, alphaScales: [1.6, 2.4, 3.4, 4.4],
      });
    }
    if (state.showMagnets) {
      LIB.FieldRender.drawBarMagnet(ctx, L3, stator, state.i_s, {});
      LIB.FieldRender.drawBarMagnet(ctx, L3, rotor,  state.i_r, {});
    }
    if (state.showArrows) {
      LIB.FieldRender.drawMomentArrow(ctx, L3, stator, state.i_s, {
        color: "#4ea1ff", imax: refs.Is, label: "B_s",
      });
      LIB.FieldRender.drawMomentArrow(ctx, L3, rotor, state.i_r, {
        color: "#ef5350", imax: refs.Ir, label: "B_r",
      });
    }
    if (state.showTau) {
      LIB.FieldRender.drawTorqueArrow(ctx, L3, state.lastTau, { tauRef: TAU_REF });
    }

    const lineW = state.showVoltage ? 6 : 4;
    LIB.CoilRender.drawLoopWire(ctx, L3, stator, {
      color: state.showVoltage ? null : "#4ea1ff",
      voltageMode: !!state.showVoltage,
      voltage: state.lastVs, vMax: V_AMP,
      lineWidth: lineW, K: 80, outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawLoopCurrentDots(ctx, L3, stator, state.i_s,
      state.dotPhaseS, {
        dotCount: 12, dotSize: 4.5, dt: 1 / HIST_HZ,
        gain: 1.0 / refs.Is,
        dotColor: "#ffd54a",
      });

    LIB.CoilRender.drawLoopWire(ctx, L3, rotor, {
      color: state.showVoltage ? null : "#ef5350",
      voltageMode: !!state.showVoltage,
      voltage: state.lastVemfR, vMax: refs.EmfR,
      lineWidth: lineW, K: 80, outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawLoopCurrentDots(ctx, L3, rotor, state.i_r,
      state.dotPhaseR, {
        dotCount: 10, dotSize: 4.5, dt: 1 / HIST_HZ,
        gain: 1.0 / refs.Ir,
        dotColor: "#ffd54a",
      });

    const rotorPts = LIB.EM.sampleLoopPoints(rotor, 32);
    cachedRotorScreen = rotorPts.map((p3) => L3.project(p3));
  }

  // ---- spec -----------------------------------------------------------------

  const SPEC = {
    id: "ac-coaxial-loops",
    title: "Coaxial loops",
    subtitle: "single AC stator + single short-circuited rotor",

    state: () => ({
      cam: { yaw: 0.55, pitch: 0.30, dist: 3.2 },
      i_s: 0, i_r: 0,
      // Start sitting on the θ=0 unstable equilibrium. Use the Kick button
      // (or drag the rotor wire) to perturb and watch it settle at θ=±π/2.
      theta_r: 0, omega_r: 0,
      dotPhaseS: { phase: 0 },
      dotPhaseR: { phase: 0 },
      drag: null,
      showLines:   false,
      showMagnets: false,
      showArrows:  true,
      showTau:     true,
      showAxes:    false,
      showVoltage: true,
      lastTau: 0, lastM: 0, lastDM: 0, lastVs: 0, lastVemfR: 0,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      s.dotPhaseS.phase = 0;
      s.dotPhaseR.phase = 0;
    },

    sliders: {
      Drive: [
        { key: "f_drive", label: "f", min: 0, max: 2, step: 0.01, value: 1.0,
          tip: "Stator drive frequency (Hz). At default f=1 Hz the rotor sits in a bistable regime: a static angle kick settles at θ=±90°, but a velocity kick (drag the rotor wire fast) crosses the saddle into self-sustained rotation near ω_d=2π·f rad/s." },
      ],
      Rotor: [
        { key: "b_r", label: "b", min: 1e-5, max: 5e-3, step: 1e-6, value: 1e-5, log: true,
          tip: "Rotor viscous damping (N·m·s/rad). Sweep upward to show how the bistable regime collapses: at b_r ≈ 1e-5 a velocity kick self-sustains near sync; by b_r ≈ 5e-3 even a hard kick is damped back to θ=π/2 in under a second." },
      ],
    },

    plots: [
      { title: `B (mT, B_r × ${B_R_SCALE.toFixed(0)})`,
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -2, hi: 2 }, yChunk: 1,
        series: [
          { label: "B_s", color: "#4ea1ff", lw: 2.0,
            source: (s) => Bcoil(N_S, s.i_s, r_S) * 1000 },
          { label: "B_r·k", color: "#ef5350", lw: 2.0,
            source: (s) => Bcoil(N_R, s.i_r, r_R) * B_R_SCALE * 1000 },
        ] },
      { title: "ω rotor (rad/s)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -1, hi: 1 }, yChunk: 1,
        series: [
          { label: "ω", color: "#66bb6a", lw: 2.0,
            source: (s) => s.omega_r || 0 },
        ] },
      { title: "τ rotor (mN·m)",
        yFmt: (v) => v.toFixed(1),
        yFloor: { lo: -20, hi: 20 }, yChunk: 20,
        series: [
          { label: "τ", color: "#ffd54a", lw: 2.0,
            source: (s) => (s.lastTau || 0) * 1000 },
        ] },
    ],

    readouts: [
      { label: "θ", units: "°",
        value: (s) => (s.theta_r * 180 / Math.PI).toFixed(1) },
      { label: "ω", units: "rad/s",
        value: (s) => (s.omega_r || 0).toFixed(3) },
      { label: "τ", units: "mN·m",
        value: (s) => ((s.lastTau || 0) * 1000).toFixed(3) },
    ],

    physics: {
      dof: ["i_s", "i_r", "theta_r", "omega_r"],
      dxdt, preStep, postStep,
      integrator: "rk4",
    },

    layout: (W, H) => ({ W, H }),
    render,
    onPointer,

    dragControls: [
      { label: "Rotor wire",  desc: "drag up/down to rotate" },
      { label: "Empty space", desc: "orbit the camera" },
      { label: "Scroll",      desc: "zoom in / out" },
    ],

    init: (handle) => {
      handle.canvas.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        const cam = handle.state.cam;
        const k = Math.exp(ev.deltaY * 0.0015);
        let d = cam.dist * k;
        if (d < 1.2) d = 1.2;
        if (d > 20)  d = 20;
        cam.dist = d;
      }, { passive: false });
    },

    headerButtons: [
      kickBtn,
      toggleBtn("showLines",   "Lines: ON",      "Lines: OFF"),
      toggleBtn("showArrows",  "B-arrows: ON",   "B-arrows: OFF"),
      toggleBtn("showTau",     "τ-arrow: ON",    "τ-arrow: OFF"),
      toggleBtn("showMagnets", "Magnets: ON",    "Magnets: OFF"),
      toggleBtn("showVoltage", "V-tint: ON",     "V-tint: OFF"),
      toggleBtn("showAxes",    "Axes: ON",       "Axes: OFF"),
    ],

    icon: (ctx, W, H) => {
      const cx = W / 2, cy = H / 2;
      const S  = Math.min(W, H);
      ctx.strokeStyle = "#4ea1ff"; ctx.lineWidth = Math.max(2, S * 0.025);
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * 0.32, S * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#ef5350"; ctx.lineWidth = Math.max(2, S * 0.022);
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * 0.18, S * 0.10, Math.PI / 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#ffd54a";
      const dots = 8;
      for (let k = 0; k < dots; k++) {
        const a = (k / dots) * 2 * Math.PI;
        const x = cx + Math.cos(a) * S * 0.32;
        const y = cy + Math.sin(a) * S * 0.32;
        ctx.beginPath(); ctx.arc(x, y, S * 0.012, 0, Math.PI * 2); ctx.fill();
      }
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).coaxialLoops = SPEC;
})();
