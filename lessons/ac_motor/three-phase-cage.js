"use strict";

// =============================================================================
//  Three-phase cage — three-phase stator field driving an N-bar squirrel cage.
//
//  Composes the three-phase stator of three-phase-rotor.js with the N-bar cage
//  rotor of squirrel-cage.js. The pedagogical arc is §5 of the notes:
//    • one rotor loop (N=2): same as three-phase-rotor — running torque has
//      a mean plus a 2·slip-frequency ripple from eq. (32).
//    • two rotor loops (N=4): two diametral pairs at 90° in space; their
//      ripples are 180° out of phase electrically and partially cancel.
//    • many loops (N=12, 24): per-loop ripples are evenly spread around the
//      slip cycle and sum to a near-flat mean torque — what a real squirrel-
//      cage rotor achieves with its many bars.
//
//  Cage circuit model is the same as squirrel-cage.js: N bars closed by two
//  end rings, treated for circuit purposes as M = N/2 diametral-pair loops
//  with negligible inter-loop mutuals. Each loop ℓ has its normal at angle
//  α_ℓ = θ_r + (2π/N)·ℓ from world-z in the y–z plane.
//
//  Mutual between stator k (axis u_k = (0, cos(2πk/3), sin(2πk/3))) and rotor
//  loop ℓ (normal (0, sin α_ℓ, cos α_ℓ)) is
//      M_{k,ℓ}(θ_r) = M_0 · sin(θ_r + (2π/N)·ℓ + (2π/3)·k),
//      dM/dθ_r      = M_0 · cos(θ_r + (2π/N)·ℓ + (2π/3)·k),
//  reducing to the single-loop expression of three-phase-rotor.js when N=2.
//
//  DOF: i_s0, i_s1, i_s2, θ_r, ω_r, i_r_0 .. i_r_{MAX_LOOPS-1}. Inactive
//  cage loops (ℓ ≥ N/2) keep zero coupling to every stator winding so their
//  currents simply decay through R_r/L_r — same trick squirrel-cage uses.
// =============================================================================

(function () {

  const PHYS_HZ        = 480;
  const HIST_HZ        = 60;
  const NEUMANN_K      = 20;
  const N_BARS_MIN     = 2;
  const N_BARS_MAX     = 24;
  const MAX_LOOPS      = N_BARS_MAX / 2;       // 12

  const K_ROTOR_DRAG     = 50;
  const C_ROTOR_DRAG     = 0.8;
  const ROTOR_RAD_PER_PX = 0.012;

  const ROTOR_HALF_LENGTH = 0.45;
  const BAR_K             = 8;
  const RING_K            = 64;

  // Machine constants — same family as three-phase-rotor.js. Cage loop R_r is
  // chosen so that with the default N=2 the behaviour reproduces three-phase-
  // rotor's spin-up to near-synchronous within a few seconds.
  const R_S = 4.0;
  const L_S = 0.012;
  const N_S = 50;
  const r_S = 0.55;

  const R_R = 0.30;
  const L_R = 0.030;
  const N_R = 50;
  const r_R = 0.30;
  const J_R = 1e-4;

  const TAU_REF = 1.5e-4;

  // Numerical safety net. Aggressive rotor-drag gestures push θ_r through
  // multiple turns in a few ms; the dM/dθ·ω_r coupling then drives the cage
  // currents into a stiff regime that explicit rk4 at PHYS_HZ overshoots,
  // and ω_r/τ cascade to ±∞ within a couple of frames. Hard-clamping ω_r
  // and the currents to physical-magnitude bounds in postStep contains the
  // divergence; once the drag releases the state recovers cleanly.
  const OMEGA_MAX = 100;       // rad/s — ~3× max ω_syn at f=5
  const I_MAX     = 1000;      // A    — ~100× steady-state peak

  // ---- helpers ----

  function nBars(p) {
    let N = Math.round(+p.N_bars || 2);
    if (N < N_BARS_MIN) N = N_BARS_MIN;
    if (N > N_BARS_MAX) N = N_BARS_MAX;
    if (N % 2) N -= 1;
    return N;
  }

  function makeStator(k) {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: LIB.ThreePhase.axisInYZ(k),
      axis_u: { x: 1, y: 0, z: 0 },
      radius: r_S, N: N_S, R: R_S, L: L_S,
    });
  }

  function makeCageLoop(alpha) {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: Math.sin(alpha), z: Math.cos(alpha) },
      axis_u: { x: 1, y: 0, z: 0 },
      radius: r_R, N: N_R, R: R_R, L: L_R,
    });
  }

  // Peak mutual: stator k=0 (normal +y) aligned with rotor loop at α=π/2
  // (normal +y). Constant, cached once.
  const M0_PEAK = LIB.EM.Mneumann(makeStator(0), makeCageLoop(Math.PI / 2),
                                   NEUMANN_K);

  // Cross-section position of bar k_bar in the y-z plane.
  function barYZ(theta_r, k_bar, N) {
    const a = (2 * Math.PI * k_bar) / N + theta_r;
    return { y: r_R * Math.cos(a), z: r_R * Math.sin(a) };
  }

  function barPoints(theta_r, N, k_bar, K) {
    const yz = barYZ(theta_r, k_bar, N);
    const out = new Array(K);
    for (let i = 0; i < K; i++) {
      const t = -ROTOR_HALF_LENGTH + (2 * ROTOR_HALF_LENGTH) * (i / (K - 1));
      out[i] = { x: t, y: yz.y, z: yz.z };
    }
    return out;
  }

  function endRingPoints(x, K) {
    const out = new Array(K);
    for (let i = 0; i < K; i++) {
      const a = (2 * Math.PI * i) / K;
      out[i] = { x, y: r_R * Math.cos(a), z: r_R * Math.sin(a) };
    }
    return out;
  }

  // ---- physics ----

  const NMAT  = 3 + MAX_LOOPS;
  const Lmat  = new Float64Array(NMAT * NMAT);
  const dLdt  = new Float64Array(NMAT * NMAT);
  const dLdth = new Float64Array(NMAT * NMAT);
  const Rvec  = new Float64Array(NMAT);
  const Vvec  = new Float64Array(NMAT);
  const Ivec  = new Float64Array(NMAT);

  function dxdt(state, p, t) {
    const N = nBars(p);
    const M = N / 2;

    Lmat.fill(0); dLdt.fill(0); dLdth.fill(0);

    // Stator diagonals (indices 0..2). Stator-stator mutuals are zero —
    // same decoupled approximation as three-phase-rotor.js.
    for (let k = 0; k < 3; k++) {
      Lmat[k * NMAT + k] = L_S;
      Rvec[k] = R_S;
      Vvec[k] = LIB.ThreePhase.signal(k, state.phi, state.swap, p.V_amp);
      Ivec[k] = state[`i_s${k}`] || 0;
    }
    // Cage rotor diagonals (indices 3..3+MAX_LOOPS-1). Inactive loops
    // (ℓ ≥ M) keep zero coupling to every stator → they just decay via R/L.
    for (let l = 0; l < MAX_LOOPS; l++) {
      const idx = 3 + l;
      Lmat[idx * NMAT + idx] = L_R;
      Rvec[idx] = R_R;
      Vvec[idx] = 0;
      Ivec[idx] = state[`i_r_${l}`] || 0;
    }

    // Stator–rotor mutuals. Only the first M cage loops couple.
    for (let l = 0; l < M; l++) {
      const ridx = 3 + l;
      const alphaL = state.theta_r + (2 * Math.PI / N) * l;
      for (let k = 0; k < 3; k++) {
        const a   = alphaL + (2 * Math.PI / 3) * k;
        const Mk  = M0_PEAK * Math.sin(a);
        const dMk = M0_PEAK * Math.cos(a);
        Lmat [k    * NMAT + ridx] = Mk;
        Lmat [ridx * NMAT + k   ] = Mk;
        dLdt [k    * NMAT + ridx] = dMk * state.omega_r;
        dLdt [ridx * NMAT + k   ] = dMk * state.omega_r;
        dLdth[k    * NMAT + ridx] = dMk;
        dLdth[ridx * NMAT + k   ] = dMk;
      }
    }

    const di  = LIB.EM.solveCurrentRates(Lmat, Rvec, Vvec, dLdt, Ivec);
    // Negate the co-energy torque so that positive ω_r tracks positive ω_syn
    // (rotor follows the rotating field in the SAME visual direction). The
    // raw co-energy result has the rotor accelerating in the opposite sense
    // to the field's y→z rotation because of the loop-normal convention.
    const tau = -LIB.EM.coenergyTorque(dLdth, Ivec);

    state.lastTau   = tau;
    state.lastV[0]  = Vvec[0];
    state.lastV[1]  = Vvec[1];
    state.lastV[2]  = Vvec[2];

    const tauDrag = rotorDragger.spring1D(state, state.theta_r, state.omega_r,
                                          K_ROTOR_DRAG, C_ROTOR_DRAG);

    const out = {
      i_s0:    di[0],
      i_s1:    di[1],
      i_s2:    di[2],
      theta_r: state.omega_r,
      omega_r: (tau + tauDrag - p.b_r * state.omega_r) / J_R,
    };
    for (let l = 0; l < MAX_LOOPS; l++) out[`i_r_${l}`] = di[3 + l];
    return out;
  }

  function preStep(state, p, dt) {
    const omega = 2 * Math.PI * p.f_drive;
    state.phi += omega * dt;
    if (state.phi >  Math.PI * 4) state.phi -= Math.PI * 2;
    if (state.phi < -Math.PI * 4) state.phi += Math.PI * 2;
    dragMux.preStep(state, dt);
  }

  function postStep(state, p, dt) {
    // Detect numerical excursion BEFORE clamping. If any DOF blew up, zero
    // the readout state too — otherwise the e^300 spike makes it into the
    // plot history, the auto-Y ratchet expands the τ axis out to the moon
    // and never returns (the plot only grows, never tightens).
    let excursion = !Number.isFinite(state.omega_r) ||
                    Math.abs(state.omega_r) > OMEGA_MAX;
    for (const k of ["i_s0", "i_s1", "i_s2"]) {
      if (!Number.isFinite(state[k]) || Math.abs(state[k]) > I_MAX) excursion = true;
    }
    for (let l = 0; l < MAX_LOOPS; l++) {
      const v = state[`i_r_${l}`];
      if (!Number.isFinite(v) || Math.abs(v) > I_MAX) excursion = true;
    }

    if (excursion) {
      state.lastTau = 0;
      state.lastV[0] = state.lastV[1] = state.lastV[2] = 0;
    }

    // Direct tau clamp. Currents can spike to ~I_MAX before the per-DOF
    // excursion check above fires, and τ = ½·iᵀ·(dL/dθ)·i is quadratic in
    // current — so τ can hit ~10 N·m (compared to a normal peak of ~1.5e-4)
    // even when no individual current is large enough to trip excursion.
    // Anything beyond ~100× normal peak is treated as numerical noise and
    // zeroed, so the auto-Y ratchet never sees the spike.
    if (!Number.isFinite(state.lastTau)) state.lastTau = 0;
    else if (Math.abs(state.lastTau) > 1.5e-2) state.lastTau = 0;

    if (!Number.isFinite(state.omega_r)) state.omega_r = 0;
    if (state.omega_r >  OMEGA_MAX) state.omega_r =  OMEGA_MAX;
    if (state.omega_r < -OMEGA_MAX) state.omega_r = -OMEGA_MAX;
    for (const k of ["i_s0", "i_s1", "i_s2"]) {
      if (!Number.isFinite(state[k])) state[k] = 0;
      if (state[k] >  I_MAX) state[k] =  I_MAX;
      if (state[k] < -I_MAX) state[k] = -I_MAX;
    }
    for (let l = 0; l < MAX_LOOPS; l++) {
      const k = `i_r_${l}`;
      if (!Number.isFinite(state[k])) state[k] = 0;
      if (state[k] >  I_MAX) state[k] =  I_MAX;
      if (state[k] < -I_MAX) state[k] = -I_MAX;
    }
    if (!Number.isFinite(state.theta_r)) state.theta_r = 0;
    state.theta_r = Math.atan2(Math.sin(state.theta_r), Math.cos(state.theta_r));
  }

  // ---- pointer / camera ----

  let cachedL3 = null;
  const cachedBarScreen = [];

  function rotorHit(state, params, layout, mx, my) {
    if (!cachedBarScreen.length) return false;
    const HITPX = 18;
    let best = Infinity;
    for (const sp of cachedBarScreen) {
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

  const SCOL = ["#ef5350", "#66bb6a", "#4ea1ff"];

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

  function render(ctx, layout, state, p) {
    const W = layout.W, H = layout.H;
    const L3 = LIB.Layout3D.orbital(W, H, {
      yaw: state.cam.yaw, pitch: state.cam.pitch, dist: state.cam.dist, fov: Math.PI / 4,
    });
    cachedL3 = L3;

    const N      = nBars(p);
    const M      = N / 2;
    const stators = [makeStator(0), makeStator(1), makeStator(2)];
    const IsRef   = statorPeakI(p);
    const IrRef   = rotorPeakI(p, IsRef);

    if (state.showAxes) {
      drawWorldAxes(ctx, L3, 0.6);
      drawRotorAxis(ctx, L3);
    }

    // Per-stator field viz.
    if (state.showLines) {
      for (let k = 0; k < 3; k++) {
        const ik = state[`i_s${k}`] || 0;
        const dS = Math.min(1, Math.abs(ik) / IsRef);
        LIB.FieldRender.drawLoopFieldLines(ctx, L3, stators[k], {
          color: SCOL[k], density: dS, alpha: 0.55,
          azSlices: 4, alphaScales: [1.6, 2.4],
        });
      }
      // Per-cage-loop field lines (drawn dimmer when many loops are active).
      const alphaScale = M >= 4 ? 0.30 : 0.45;
      for (let l = 0; l < M; l++) {
        const alpha = state.theta_r + (2 * Math.PI / N) * l;
        const lp    = makeCageLoop(alpha);
        const il    = state[`i_r_${l}`] || 0;
        const dR    = Math.min(1, Math.abs(il) / IrRef);
        LIB.FieldRender.drawLoopFieldLines(ctx, L3, lp, {
          color: "#ffd54a", density: dR, alpha: alphaScale,
          azSlices: 4, alphaScales: [1.6, 2.4],
        });
      }
    }
    if (state.showMagnets) {
      for (let k = 0; k < 3; k++) {
        LIB.FieldRender.drawBarMagnet(ctx, L3, stators[k], state[`i_s${k}`] || 0, {});
      }
      for (let l = 0; l < M; l++) {
        const alpha = state.theta_r + (2 * Math.PI / N) * l;
        const lp    = makeCageLoop(alpha);
        const il    = state[`i_r_${l}`] || 0;
        LIB.FieldRender.drawBarMagnet(ctx, L3, lp, il, {});
      }
    }
    if (state.showStatorArrows) {
      for (let k = 0; k < 3; k++) {
        LIB.FieldRender.drawMomentArrow(ctx, L3, stators[k], state[`i_s${k}`] || 0, {
          color: SCOL[k], imax: IsRef, label: ["B_a", "B_b", "B_c"][k],
        });
      }
    }
    if (state.showRotorArrows) {
      for (let l = 0; l < M; l++) {
        const alpha = state.theta_r + (2 * Math.PI / N) * l;
        const lp    = makeCageLoop(alpha);
        const il    = state[`i_r_${l}`] || 0;
        LIB.FieldRender.drawMomentArrow(ctx, L3, lp, il, {
          color: "#ffd54a", imax: IrRef,
        });
      }
    }
    if (state.showResultant) {
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

    // End rings — gray, unvoltaged.
    const ringPos = endRingPoints(+ROTOR_HALF_LENGTH, RING_K);
    const ringNeg = endRingPoints(-ROTOR_HALF_LENGTH, RING_K);
    LIB.CoilRender.drawConductor3D(ctx, L3, ringPos, {
      color: "#7f8a99", lineWidth: 2.5, closed: true,
      outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawConductor3D(ctx, L3, ringNeg, {
      color: "#7f8a99", lineWidth: 2.5, closed: true,
      outlineColor: "rgba(0,0,0,0.55)",
    });

    // Bars. Bar k_bar belongs to loop (k_bar mod M); the +M sibling carries
    // the loop current with the opposite sign.
    cachedBarScreen.length = 0;
    const vMaxBar = Math.max(1e-9, R_R * IrRef);
    for (let kb = 0; kb < N; kb++) {
      const loopIdx = kb % M;
      const sign    = (kb < M) ? +1 : -1;
      const ik      = (state[`i_r_${loopIdx}`] || 0) * sign;
      const pts     = barPoints(state.theta_r, N, kb, BAR_K);
      LIB.CoilRender.drawConductor3D(ctx, L3, pts, {
        color: state.showVoltage ? null : "#ffd54a",
        voltageMode: !!state.showVoltage,
        voltage: R_R * ik, vMax: vMaxBar,
        lineWidth: lineW, closed: false,
        outlineColor: "rgba(0,0,0,0.55)",
      });
      if (!state.dotPhasesR[kb]) state.dotPhasesR[kb] = { phase: 0 };
      LIB.CoilRender.drawCurrentDots3D(ctx, L3, pts, ik, state.dotPhasesR[kb], {
        dotCount: 4, dotSize: 4.5, dt: 1 / HIST_HZ,
        gain: 1.0 / IrRef, closed: false,
        dotColor: "#ffd54a",
      });
      for (const pp of pts) cachedBarScreen.push(L3.project(pp));
    }

    state.lastIsRef = IsRef;
    state.lastIrRef = IrRef;
  }

  // ---- spec ----

  const SPEC = {
    id: "ac-three-phase-cage",
    title: "Three-phase cage",
    subtitle: "three-phase stator + N-bar squirrel-cage rotor",
    description:
      "<b>Three-phase cage</b> — same three-phase stator as the previous lesson, " +
      "but now driving an N-bar squirrel-cage rotor instead of a single closed loop. " +
      "Slide <i>N</i> up to watch the per-loop 2·slip-frequency ripples (eq. (32)) " +
      "smooth into a near-constant mean torque as more loops add their contributions " +
      "around the slip cycle. At N=2 the cage reduces to a single diametral pair and " +
      "behaves identically to the three-phase-rotor lesson. Load the shaft with " +
      "<i>b</i> to make the ripple appear in the first place.",

    state: () => {
      const s = {
        cam: { yaw: 0.55, pitch: 0.30, dist: 3.4 },
        phi: 0,
        swap: false,
        i_s0: 0, i_s1: 0, i_s2: 0,
        theta_r: 0, omega_r: 0,
        dotPhasesS: [{ phase: 0 }, { phase: 0 }, { phase: 0 }],
        dotPhasesR: [],
        drag: null,
        showLines:        false,
        showMagnets:      false,
        showStatorArrows: false,
        showResultant:    true,
        showRotorArrows:  false,
        showTau:          true,
        showAxes:         false,
        showVoltage:      false,
        lastTau: 0, lastV: [0, 0, 0],
        lastIsRef: 1, lastIrRef: 1,
        t: 0,
      };
      for (let l = 0; l < MAX_LOOPS;  l++) s[`i_r_${l}`] = 0;
      for (let k = 0; k < N_BARS_MAX; k++) s.dotPhasesR.push({ phase: 0 });
      return s;
    },

    onReset: (s) => {
      s.drag = null;
      s.phi  = 0;
      s.dotPhasesS.forEach((d) => (d.phase = 0));
      for (const r of s.dotPhasesR) r.phase = 0;
    },

    sliders: {
      Drive: [
        { key: "V_amp",   label: "V̂",   min: 0,    max: 50,  step: 0.1,  value: 12,
          tip: "Per-phase peak terminal voltage (V)." },
        { key: "f_drive", label: "f",   min: 0.05, max: 5,   step: 0.01, value: 0.8,
          tip: "Supply frequency (Hz). Synchronous speed ω_syn = 2π·f for the single-pole-pair stator geometry here." },
      ],
      Load: [
        { key: "b_r", label: "b", min: 1e-7, max: 1e-3, step: 1e-7, value: 5e-5, log: true,
          tip: "Mechanical load — rotor viscous damping (N·m·s/rad). Default is loaded enough that the rotor settles at a useful slip and the per-loop ripple is visible at low N. Drop b toward zero to run unloaded (rotor approaches sync, ripple collapses). Past breakdown the rotor stalls." },
      ],
      Rotor: [
        { key: "N_bars", label: "N bars", min: N_BARS_MIN, max: N_BARS_MAX, step: 2, value: 2,
          onChange: (v, state) => {
            // Zero loop currents that just dropped out of the active range so
            // the integrator's electrical state stays clean.
            const M = Math.floor(v / 2);
            for (let l = M; l < MAX_LOOPS; l++) state[`i_r_${l}`] = 0;
          },
          tip: "Number of axial bars in the cage; even values only. N/2 diametral-pair loops sit at evenly spaced angles around the rotor. N=2 → one loop (= three-phase-rotor). N=4 → two perpendicular loops. N=12 onwards → near-flat torque." },
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
      { title: "τ rotor (N·m) — ripple shrinks with N",
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
      { label: "N bars",
        value: (s, p) => `${nBars(p)}` },
      { label: "loops (N/2)",
        value: (s, p) => `${nBars(p) / 2}` },
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
      { label: "max |i_loop|", units: "A",
        value: (s, p) => {
          const M = Math.floor(nBars(p) / 2);
          let mx = 0;
          for (let l = 0; l < M; l++) {
            const a = Math.abs(s[`i_r_${l}`] || 0);
            if (a > mx) mx = a;
          }
          return mx.toExponential(3);
        } },
    ],

    physics: {
      dof: (() => {
        const arr = ["i_s0", "i_s1", "i_s2", "theta_r", "omega_r"];
        for (let l = 0; l < MAX_LOOPS; l++) arr.push(`i_r_${l}`);
        return arr;
      })(),
      dxdt, preStep, postStep,
      integrator: "rk4",
    },

    layout: (W, H) => ({ W, H }),
    render,
    onPointer,

    dragControls: [
      { label: "Cage bars",   desc: "drag up/down to rotate" },
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
      toggleBtn("showRotorArrows",  "Rotor Bs: ON",    "Rotor Bs: OFF"),
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
      // Cage rotor: dots around an ellipse.
      ctx.fillStyle = "#ffd54a";
      const Nicon = 10;
      for (let k = 0; k < Nicon; k++) {
        const a = (k / Nicon) * 2 * Math.PI;
        const x = cx + Math.cos(a) * S * 0.16;
        const y = cy + Math.sin(a) * S * 0.08;
        ctx.beginPath(); ctx.arc(x, y, S * 0.018, 0, Math.PI * 2); ctx.fill();
      }
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).threePhaseCage = SPEC;
})();
