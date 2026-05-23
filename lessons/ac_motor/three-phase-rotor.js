"use strict";

// =============================================================================
//  Three-phase rotor — single closed rotor loop in a rotating stator field.
//
//  The natural extension of coaxial-loops: replaces the single AC stator coil
//  with three coils at 120° intervals around the rotor axis, each driven by
//  its own phase of a three-phase supply. The vector sum of the three stator
//  fields is the rotating field of `rotating-field` (eq. 26 of the notes);
//  the rotor loop's induced EMF therefore tracks a moving target and the
//  cycle-averaged co-energy torque survives the time-average — equation 28.
//
//  DOF: i_sa, i_sb, i_sc, i_r, θ_r, ω_r. Drive phase φ is integrated
//  separately (and is NOT a DOF of the integrator — it advances kinematically
//  in preStep so that scrubbing f never teleports the field).
//
//  Stator-stator mutuals are taken as zero: the three phase windings are
//  treated as magnetically decoupled. Real motors couple them, but for the
//  pedagogy of "why three-phase produces a starting torque" the decoupled
//  model gives the same qualitative behaviour with a much smaller circuit.
//
//  Stator-to-rotor mutual: with stator k's normal u_k = (0, cos(αk), sin(αk))
//  (LIB.ThreePhase.axisInYZ) and the rotor's normal (0, sin(θ_r), cos(θ_r)),
//      M_k(θ_r) = M_0 · sin(θ_r + αk),
//      dM_k/dθ_r = M_0 · cos(θ_r + αk).
//  M_0 is the geometric peak, computed once per dxdt via LIB.EM.Mneumann at
//  θ_r = π/2 (where stator k=0 and rotor are aligned). Same Neumann backbone
//  as coaxial-loops and squirrel-cage — single source of EM truth.
// =============================================================================

(function () {

  const PHYS_HZ   = 480;
  const HIST_HZ   = 60;
  const NEUMANN_K = 20;

  const K_ROTOR_DRAG     = 50;
  const C_ROTOR_DRAG     = 0.8;
  const ROTOR_RAD_PER_PX = 0.012;

  // ---- hardcoded machine constants ----
  // Tuned so spin-up to near-synchronous takes ~10 s at the default f.
  // Lesson exposes only the supply knobs (V̂, f) as sliders; everything below
  // is baked in. Same N_r-fudge convention as coaxial-loops/squirrel-cage:
  // the geometric mutual M_0 is tiny for air-core coils, so N_s and N_r stand
  // in for ferromagnetic flux channelling rather than literal turn counts.
  const R_S = 4.0;            // stator R (Ω)
  const L_S = 0.012;          // stator self-inductance (H)
  const N_S = 50;             // stator turns
  const r_S = 0.55;           // stator radius (m)
  const R_R = 0.30;           // rotor R (Ω)
  const L_R = 0.030;          // rotor self-inductance (H)
  const N_R = 50;             // rotor turns
  const r_R = 0.30;           // rotor radius (m)
  const J_R = 1e-4;           // rotor inertia (kg·m²)
  // Mechanical load is now a slider (p.b_r); see the "Load" panel below.

  // τ reference for the rotational-axis arrow. Roughly the peak rotor torque
  // at locked rotor for the default supply, so a full-length arrow == peak.
  const TAU_REF = 1.5e-4;

  // ---- helpers ----

  // Stator coil k's pose. Centre at origin, normal in y-z plane at angle αk
  // around world-x. axis_u along world-x so the coil's "plane" contains the
  // rotor's rotation axis (matches the geometry the notes describe in §3).
  function makeStator(k) {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: LIB.ThreePhase.axisInYZ(k),
      axis_u: { x: 1, y: 0, z: 0 },
      radius: r_S, N: N_S, R: R_S, L: L_S,
    });
  }

  function makeRotor(theta) {
    const sn = Math.sin(theta), cs = Math.cos(theta);
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: sn, z: cs },
      axis_u: { x: 1, y: 0, z: 0 },
      radius: r_R, N: N_R, R: R_R, L: L_R,
    });
  }

  // Peak mutual: stator k=0 aligned with rotor at θ=π/2 → max |M|. Constant
  // (no slider dependence), so evaluate once and cache.
  const M0_PEAK = LIB.EM.Mneumann(makeStator(0), makeRotor(Math.PI / 2),
                                   NEUMANN_K);

  // ---- physics ----

  const NMAT = 4;                             // 3 stator + 1 rotor
  const Lmat = new Float64Array(NMAT * NMAT);
  const dLdt = new Float64Array(NMAT * NMAT);
  const dLdth = new Float64Array(NMAT * NMAT);
  const Rvec = new Float64Array(NMAT);
  const Vvec = new Float64Array(NMAT);
  const Ivec = new Float64Array(NMAT);

  function dxdt(state, p, t) {
    Lmat.fill(0); dLdt.fill(0); dLdth.fill(0);

    // Stator diagonals.
    for (let k = 0; k < 3; k++) {
      Lmat[k * NMAT + k] = L_S;
      Rvec[k] = R_S;
      Vvec[k] = LIB.ThreePhase.signal(k, state.phi, state.swap, p.V_amp);
      Ivec[k] = state[`i_s${k}`] || 0;
    }
    // Rotor.
    const rIdx = 3;
    Lmat[rIdx * NMAT + rIdx] = L_R;
    Rvec[rIdx] = R_R;
    Vvec[rIdx] = 0;
    Ivec[rIdx] = state.i_r || 0;

    // Stator–rotor mutuals. Physical αk only — swap reorders the drive
    // signals (above), not the physical coil positions, so the mutual
    // geometry is independent of swap.
    for (let k = 0; k < 3; k++) {
      const ak = (2 * Math.PI / 3) * k;
      const Mk  = M0_PEAK * Math.sin(state.theta_r + ak);
      const dMk = M0_PEAK * Math.cos(state.theta_r + ak);
      Lmat [k    * NMAT + rIdx] = Mk;
      Lmat [rIdx * NMAT + k   ] = Mk;
      dLdt [k    * NMAT + rIdx] = dMk * state.omega_r;
      dLdt [rIdx * NMAT + k   ] = dMk * state.omega_r;
      dLdth[k    * NMAT + rIdx] = dMk;
      dLdth[rIdx * NMAT + k   ] = dMk;
    }

    const di  = LIB.EM.solveCurrentRates(Lmat, Rvec, Vvec, dLdt, Ivec);
    const tau = LIB.EM.coenergyTorque(dLdth, Ivec);

    state.lastTau   = tau;
    state.lastV[0]  = Vvec[0];
    state.lastV[1]  = Vvec[1];
    state.lastV[2]  = Vvec[2];
    state.lastVemfR = R_R * Ivec[rIdx];

    const tauDrag = rotorDragger.spring1D(state, state.theta_r, state.omega_r,
                                          K_ROTOR_DRAG, C_ROTOR_DRAG);

    return {
      i_s0:    di[0],
      i_s1:    di[1],
      i_s2:    di[2],
      i_r:     di[3],
      theta_r: state.omega_r,
      omega_r: (tau + tauDrag - p.b_r * state.omega_r) / J_R,
    };
  }

  function preStep(state, p, dt) {
    // Integrate the drive phase — scrubbing f never teleports the supply,
    // matching the rotating-field lesson's convention.
    const omega = 2 * Math.PI * p.f_drive;
    state.phi += omega * dt;
    if (state.phi >  Math.PI * 4) state.phi -= Math.PI * 2;
    if (state.phi < -Math.PI * 4) state.phi += Math.PI * 2;
    dragMux.preStep(state, dt);
  }

  // ---- pointer / camera ----

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
      value: state.theta_r,
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

  // ---- header buttons ----

  function toggleBtn(field, labelOn, labelOff) {
    return LIB.HeaderButtons.toggle({
      field, labelOn, labelOff,
      styleOn:  { color: LIB.Util.getVar("--good"),  borderColor: LIB.Util.getVar("--good")  },
      styleOff: { color: LIB.Util.getVar("--muted"), borderColor: "#2e3642" },
    });
  }

  const swapBtn = LIB.HeaderButtons.toggle({
    field: "swap", labelOn: "Phase order: a-c-b", labelOff: "Phase order: a-b-c",
    styleOn:  { color: LIB.Util.getVar("--cI"),     borderColor: LIB.Util.getVar("--cI")     },
    styleOff: { color: LIB.Util.getVar("--accent"), borderColor: LIB.Util.getVar("--accent") },
  });

  const kickBtn = {
    id: "kick",
    label: "Kick rotor +15°",
    style: { color: LIB.Util.getVar("--cI"), borderColor: LIB.Util.getVar("--cI") },
    onClick: (state) => { state.theta_r += 15 * Math.PI / 180; },
  };

  // ---- render ----

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

  function statorPeakI(p) {
    const w  = 2 * Math.PI * p.f_drive;
    const Zs = Math.hypot(R_S, w * L_S);
    return Math.max(1e-6, p.V_amp / Math.max(0.01, Zs));
  }
  function rotorPeakI(p, IsRef) {
    const w    = 2 * Math.PI * p.f_drive;
    const emfR = Math.abs(M0_PEAK) * w * IsRef;
    const Zr   = Math.hypot(R_R, w * L_R);
    return Math.max(1e-9, emfR / Math.max(0.01, Zr));
  }

  // Resultant stator moment direction (vector sum of per-winding contributions).
  // Returns a 3D vector in the y–z plane whose magnitude is Σ_k i_k along the
  // winding-axis direction. Drawn as the "B" rotating-field arrow.
  function resultantStatorMomentDir(state) {
    let y = 0, z = 0;
    for (let k = 0; k < 3; k++) {
      const u = LIB.ThreePhase.axisInYZ(k);
      const ik = state[`i_s${k}`] || 0;
      y += u.y * ik;
      z += u.z * ik;
    }
    return { x: 0, y, z };
  }

  // Stator colours: red/green/blue mirroring the rotating-field lesson, so a
  // student switching between the two tabs sees consistent phase identities.
  const SCOL = ["#ef5350", "#66bb6a", "#4ea1ff"];

  function render(ctx, layout, state, p) {
    const W = layout.W, H = layout.H;
    const L3 = LIB.Layout3D.orbital(W, H, {
      yaw: state.cam.yaw, pitch: state.cam.pitch, dist: state.cam.dist, fov: Math.PI / 4,
    });
    cachedL3 = L3;

    const stators = [makeStator(0), makeStator(1), makeStator(2)];
    const rotor   = makeRotor(state.theta_r);
    const IsRef   = statorPeakI(p);
    const IrRef   = rotorPeakI(p, IsRef);

    if (state.showAxes) {
      drawWorldAxes(ctx, L3, 0.6);
      drawRotorAxis(ctx, L3);
    }

    if (state.showLines) {
      for (let k = 0; k < 3; k++) {
        const ik = state[`i_s${k}`] || 0;
        const dS = Math.min(1, Math.abs(ik) / IsRef);
        LIB.FieldRender.drawLoopFieldLines(ctx, L3, stators[k], {
          color: SCOL[k], density: dS, alpha: 0.55,
          azSlices: 4, alphaScales: [1.6, 2.4],
        });
      }
      const dR = Math.min(1, Math.abs(state.i_r || 0) / IrRef);
      LIB.FieldRender.drawLoopFieldLines(ctx, L3, rotor, {
        color: "#ffd54a", density: dR, alpha: 0.75,
        azSlices: 6, alphaScales: [1.6, 2.4, 3.4, 4.4],
      });
    }
    if (state.showMagnets) {
      for (let k = 0; k < 3; k++) {
        LIB.FieldRender.drawBarMagnet(ctx, L3, stators[k], state[`i_s${k}`] || 0, {});
      }
      LIB.FieldRender.drawBarMagnet(ctx, L3, rotor, state.i_r || 0, {});
    }
    if (state.showStatorArrows) {
      for (let k = 0; k < 3; k++) {
        LIB.FieldRender.drawMomentArrow(ctx, L3, stators[k], state[`i_s${k}`] || 0, {
          color: SCOL[k], imax: IsRef, label: ["B_a", "B_b", "B_c"][k],
        });
      }
    }
    if (state.showRotorArrow) {
      LIB.FieldRender.drawMomentArrow(ctx, L3, rotor, state.i_r || 0, {
        color: "#ffd54a", imax: IrRef, label: "B_r",
      });
    }
    if (state.showResultant) {
      // Resultant stator B = vector sum of per-winding moments. Reference
      // magnitude is 3/2·IsRef (the peak |Σ| for balanced three-phase, eq. 26).
      // Draw using the same per-winding arrow length convention so visually
      // the resultant sits in the same scale family as the per-stator arrows.
      const refLen = r_S * 1.8;
      const vec    = resultantStatorMomentDir(state);
      LIB.FieldRender.drawVectorArrow(ctx, L3, vec, {
        refMag: 1.5 * IsRef, refLen,
        color:  "#e1bee7", lineWidth: 4, head: 14, label: "B",
      });
    }
    if (state.showTau) {
      LIB.FieldRender.drawTorqueArrow(ctx, L3, state.lastTau, { tauRef: TAU_REF });
    }

    // Stator wires + dots.
    const lineW = state.showVoltage ? 6 : 4;
    for (let k = 0; k < 3; k++) {
      LIB.CoilRender.drawLoopWire(ctx, L3, stators[k], {
        color: state.showVoltage ? null : SCOL[k],
        voltageMode: !!state.showVoltage,
        voltage: state.lastV[k], vMax: p.V_amp,
        lineWidth: lineW, K: 64, outlineColor: "rgba(0,0,0,0.55)",
      });
      LIB.CoilRender.drawLoopCurrentDots(ctx, L3, stators[k], state[`i_s${k}`] || 0,
        state.dotPhasesS[k], {
          dotCount: 10, dotSize: 4.5, dt: 1 / HIST_HZ,
          gain: 1.0 / IsRef, dotColor: "#ffd54a",
        });
    }

    // Rotor wire + dots.
    LIB.CoilRender.drawLoopWire(ctx, L3, rotor, {
      color: state.showVoltage ? null : "#ffd54a",
      voltageMode: !!state.showVoltage,
      voltage: state.lastVemfR, vMax: Math.max(1e-9, R_R * IrRef),
      lineWidth: lineW, K: 64, outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawLoopCurrentDots(ctx, L3, rotor, state.i_r || 0,
      state.dotPhaseR, {
        dotCount: 10, dotSize: 4.5, dt: 1 / HIST_HZ,
        gain: 1.0 / IrRef, dotColor: "#ffd54a",
      });

    const rotorPts = LIB.EM.sampleLoopPoints(rotor, 32);
    cachedRotorScreen = rotorPts.map((p3) => L3.project(p3));

    state.lastIsRef = IsRef;
    state.lastIrRef = IrRef;
  }

  // ---- spec ----

  const SPEC = {
    id: "ac-three-phase-rotor",
    title: "Three-phase rotor",
    subtitle: "single closed rotor loop in a rotating stator field",

    state: () => ({
      cam: { yaw: 0.55, pitch: 0.30, dist: 3.2 },
      phi: 0,
      swap: false,
      i_s0: 0, i_s1: 0, i_s2: 0,
      i_r: 0,
      theta_r: 0, omega_r: 0,
      dotPhasesS: [{ phase: 0 }, { phase: 0 }, { phase: 0 }],
      dotPhaseR:   { phase: 0 },
      drag: null,
      showLines:        false,
      showMagnets:      false,
      showStatorArrows: false,
      showResultant:    true,
      showRotorArrow:   true,
      showTau:          true,
      showAxes:         false,
      showVoltage:      false,
      lastTau: 0, lastV: [0, 0, 0], lastVemfR: 0,
      lastIsRef: 1, lastIrRef: 1,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      s.phi  = 0;
      s.dotPhasesS.forEach((d) => (d.phase = 0));
      s.dotPhaseR.phase = 0;
    },

    sliders: {
      Drive: [
        { key: "V_amp",   label: "V̂",   min: 0,    max: 50,  step: 0.1,  value: 12,
          tip: "Per-phase peak terminal voltage (V)." },
        { key: "f_drive", label: "f",   min: 0.05, max: 5,   step: 0.01, value: 0.8,
          tip: "Supply frequency (Hz). Synchronous speed ω_syn = 2π·f for the single-pole-pair stator geometry here. Slow enough to see each cycle play out; fast enough for the rotor to spin up visibly within a few seconds." },
      ],
      Load: [
        { key: "b_r", label: "b", min: 1e-7, max: 1e-3, step: 1e-7, value: 1e-6, log: true,
          tip: "Mechanical load — rotor viscous damping (N·m·s/rad). At the default 1e-6 the rotor runs essentially unloaded: it climbs to near ω_syn, slip → 0, rotor current vanishes, mean torque collapses to zero, and the 2·slip-frequency ripple from eq. (32) collapses with it (ripple frequency → 0, amplitude → 0). Raise b to load the shaft: the rotor settles at finite slip and the ripple becomes visible riding on a positive mean. Past breakdown (around b ≈ 1e-4 at default supply) the rotor stalls." },
      ],
    },

    plots: [
      { title: "ω rotor vs ω_syn (rad/s)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -2, hi: 8 }, yChunk: 2,
        series: [
          { label: "ω_syn", color: "rgba(102,187,106,0.55)", lw: 1.4, dash: [4, 4],
            source: (s, p) => 2 * Math.PI * p.f_drive },
          { label: "ω_r",   color: "#4ea1ff", lw: 2.0,
            source: (s) => s.omega_r || 0 },
        ] },
      { title: "τ rotor (N·m)",
        yFmt: (v) => v.toExponential(2),
        yFloor: { lo: -3e-4, hi: 3e-4 }, yChunk: 1e-4,
        series: [
          { label: "τ", color: "#ffd54a", lw: 2.0,
            source: (s) => s.lastTau || 0 },
        ] },
      { title: "i_a, i_b, i_c (A)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -3, hi: 3 }, yChunk: 1,
        series: [
          { label: "i_a", color: SCOL[0], lw: 1.6, source: (s) => s.i_s0 || 0 },
          { label: "i_b", color: SCOL[1], lw: 1.6, source: (s) => s.i_s1 || 0 },
          { label: "i_c", color: SCOL[2], lw: 1.6, source: (s) => s.i_s2 || 0 },
        ] },
    ],

    readouts: [
      { label: "θ rotor", units: "°",
        value: (s) => (s.theta_r * 180 / Math.PI).toFixed(1) },
      { label: "ω rotor", units: "rad/s",
        value: (s) => (s.omega_r || 0).toFixed(3) },
      { label: "ω_syn",   units: "rad/s",
        value: (s, p) => (2 * Math.PI * p.f_drive).toFixed(3) },
      { label: "slip s",
        value: (s, p) => {
          const wsyn = 2 * Math.PI * p.f_drive;
          if (Math.abs(wsyn) < 1e-9) return "—";
          return ((wsyn - s.omega_r) / wsyn).toFixed(3);
        } },
      { label: "τ rotor", units: "N·m",
        value: (s) => (s.lastTau || 0).toExponential(3) },
      { label: "i_a", units: "A", value: (s) => (s.i_s0 || 0).toFixed(3) },
      { label: "i_b", units: "A", value: (s) => (s.i_s1 || 0).toFixed(3) },
      { label: "i_c", units: "A", value: (s) => (s.i_s2 || 0).toFixed(3) },
      { label: "i_r", units: "A", value: (s) => (s.i_r  || 0).toExponential(3) },
    ],

    physics: {
      dof: ["i_s0", "i_s1", "i_s2", "i_r", "theta_r", "omega_r"],
      dxdt, preStep,
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
      swapBtn,
      kickBtn,
      toggleBtn("showStatorArrows", "Stator Bs: ON",   "Stator Bs: OFF"),
      toggleBtn("showResultant",    "Resultant B: ON", "Resultant B: OFF"),
      toggleBtn("showRotorArrow",   "Rotor B: ON",     "Rotor B: OFF"),
      toggleBtn("showTau",          "τ-arrow: ON",     "τ-arrow: OFF"),
      toggleBtn("showLines",        "Lines: ON",       "Lines: OFF"),
      toggleBtn("showMagnets",      "Magnets: ON",     "Magnets: OFF"),
      toggleBtn("showVoltage",      "V-tint: ON",      "V-tint: OFF"),
      toggleBtn("showAxes",         "Axes: ON",        "Axes: OFF"),
    ],

    icon: (ctx, W, H) => {
      const cx = W / 2, cy = H / 2;
      const S  = Math.min(W, H);
      const colors = ["#ef5350", "#66bb6a", "#4ea1ff"];
      for (let k = 0; k < 3; k++) {
        const a = (2 * Math.PI / 3) * k - Math.PI / 2;
        ctx.strokeStyle = colors[k];
        ctx.lineWidth = Math.max(2, S * 0.022);
        ctx.beginPath();
        ctx.ellipse(cx, cy, S * 0.30, S * 0.12, a, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = Math.max(2, S * 0.024);
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * 0.16, S * 0.08, Math.PI / 5, 0, Math.PI * 2);
      ctx.stroke();
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).threePhaseRotor = SPEC;
})();
