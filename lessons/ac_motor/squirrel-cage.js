"use strict";

// =============================================================================
//  Squirrel-cage rotor — N discrete bars + 2 end rings, single-phase AC stator.
//
//  Extends the coaxial-loops physics: replaces the rotor's single short-
//  circuited loop with N axial bars closed by two end rings. The bars stay
//  visible as individual conductors; for circuit purposes the cage is modelled
//  as N/2 diametral-pair rectangular loops (bar k paired with bar k+N/2),
//  each represented by an equivalent circular loop with the same rotor radius
//  and a normal rotated by 2π·k/N around the rotor's rotation axis (world-x)
//  from loop 0.
//
//  Torque physics — same co-energy formula as coaxial-loops:
//      τ = ½·iᵀ·(dL/dθ)·i
//  Verified against the 2×2 case where it reduces to τ = i_s·i_r·dM/dθ
//  (standard two-coupled-coils result). For the cage's (1+M)×(1+M) matrix
//  with non-zero entries only at (s,k) and (k,s), this expands to
//      τ = i_s · Σ_k i_k · (dM_k/dθ)
//  i.e. each loop contributes additively.
//
//  Mutual-inductance approximation:
//      M_k(θ) = M_0 · cos(θ_r + 2π·k/N)
//      dM_k/dθ = −M_0 · sin(θ_r + 2π·k/N)
//  M_0 is the geometric peak, computed once per dxdt via LIB.EM.Mneumann at
//  α=0. For two coplanar loops rotating about a common diameter the cosine
//  law is exact in the equivalent-circular-loop limit, and is a good
//  approximation for the nested geometries this lesson uses (r_r < r_s).
//  Inter-loop mutuals are neglected (decoupled cage windings — the standard
//  pedagogical simplification).
//
//  At N=2 the cage reduces to the single-loop rotor of coaxial-loops; turning
//  N up smooths the torque ripple but does NOT add rotation bias — single-
//  phase still has no preferred direction, so the rotor still oscillates
//  rather than runs.
//
//  DOF layout: i_s, θ_r, ω_r, i_r_0 .. i_r_{MAX_LOOPS-1}. We always integrate
//  the full 1+MAX_LOOPS electrical state; loops with k ≥ N/2 keep zero
//  coupling to the stator so their currents simply decay via R_r/L_r.
// =============================================================================

(function () {

  // ---- physics constants ----
  const PHYS_HZ        = 480;
  const HIST_HZ        = 60;
  const NEUMANN_K      = 20;
  const N_BARS_MIN     = 2;
  const N_BARS_MAX     = 24;
  const MAX_LOOPS      = N_BARS_MAX / 2;       // 12

  const K_ROTOR_DRAG   = 50;
  const C_ROTOR_DRAG   = 0.8;
  const ROTOR_RAD_PER_PX = 0.012;

  const ROTOR_HALF_LENGTH = 0.45;              // half-extent of bars along world-x
  const BAR_K          = 8;                    // sample points per bar (hit-test + dots)
  const RING_K         = 64;                   // sample points per end ring

  // ---- helpers ----

  // Snap to even, clamp to [N_BARS_MIN, N_BARS_MAX].
  function nBars(p) {
    let N = Math.round(+p.N_bars || 6);
    if (N < N_BARS_MIN) N = N_BARS_MIN;
    if (N > N_BARS_MAX) N = N_BARS_MAX;
    if (N % 2) N -= 1;
    return N;
  }

  function makeStator(p) {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      axis_u: { x: 1, y: 0, z: 0 },
      radius: p.r_s, N: Math.max(1, Math.round(+p.N_s || 50)),
      R: p.R_s, L: p.L_s,
    });
  }

  // Equivalent circular loop for one cage diametral pair, with the loop's
  // normal at angle α from world-z (in the y-z plane). Matches the existing
  // single-loop rotor pose so that at α=0 it coincides with the coaxial-loops
  // rotor at θ=0.
  function makeCageLoop(p, alpha) {
    return LIB.EM.loop({
      center: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: Math.sin(alpha), z: Math.cos(alpha) },
      axis_u: { x: 1, y: 0, z: 0 },
      radius: p.r_r,
      // N_r is a pedagogical fudge: a real cage has 1 turn per diametral pair,
      // but with that the air-core M is ~1e-3 of √(L_s·L_r), and the resulting
      // running torque is six orders of magnitude below mechanical damping.
      // Treating each equivalent loop as N_r turns scales M (and therefore τ)
      // by N_r — the same trick the coaxial-loops lesson uses for its rotor.
      // It stands in for the missing ferromagnetic-core flux channelling.
      N: Math.max(1, Math.round(+p.N_r || 50)),
      R: p.R_r, L: p.L_r,
    });
  }

  // Geometric peak mutual inductance. M_k(θ) = M_0·cos(θ_r + 2π·k/N).
  function mutualPeak(p) {
    return LIB.EM.Mneumann(makeStator(p), makeCageLoop(p, 0), NEUMANN_K);
  }

  // Cross-section position of bar k_bar in the y-z plane perpendicular to the
  // rotor axis (world-x). Used by both rendering and pointer hit-test.
  function barYZ(p, theta_r, k_bar, N) {
    const a = (2 * Math.PI * k_bar) / N + theta_r;
    return { y: p.r_r * Math.cos(a), z: p.r_r * Math.sin(a) };
  }

  // K sample points along bar k_bar in 3D, evenly spaced over its axial extent.
  function barPoints(p, theta_r, N, k_bar, K) {
    const yz = barYZ(p, theta_r, k_bar, N);
    const out = new Array(K);
    for (let i = 0; i < K; i++) {
      const t = -ROTOR_HALF_LENGTH + (2 * ROTOR_HALF_LENGTH) * (i / (K - 1));
      out[i] = { x: t, y: yz.y, z: yz.z };
    }
    return out;
  }

  function endRingPoints(p, x, K) {
    const out = new Array(K);
    for (let i = 0; i < K; i++) {
      const a = (2 * Math.PI * i) / K;
      out[i] = { x, y: p.r_r * Math.cos(a), z: p.r_r * Math.sin(a) };
    }
    return out;
  }

  // ---- physics ----

  // Reusable scratch buffers, sized to max. Inactive loops keep zero coupling
  // so the (1+MAX_LOOPS) solve handles them automatically (they decay via R/L).
  const NMAT  = 1 + MAX_LOOPS;
  const Lmat  = new Float64Array(NMAT * NMAT);
  const dLdt  = new Float64Array(NMAT * NMAT);
  const dLdth = new Float64Array(NMAT * NMAT);
  const Rvec  = new Float64Array(NMAT);
  const Vvec  = new Float64Array(NMAT);
  const Ivec  = new Float64Array(NMAT);

  function dxdt(state, p, t) {
    const N = nBars(p);
    const M = N / 2;
    const omegaDrive = 2 * Math.PI * p.f_drive;
    const Vs = LIB.EM.acVoltage(t, p.V_amp, omegaDrive, 0);
    const M0 = mutualPeak(p);

    Lmat.fill(0);
    dLdt.fill(0);
    dLdth.fill(0);

    // Stator (index 0).
    Lmat[0]  = p.L_s;
    Rvec[0]  = p.R_s;
    Vvec[0]  = Vs;
    Ivec[0]  = state.i_s;

    // Cage loops (indices 1..MAX_LOOPS). Loops with k >= M stay decoupled.
    for (let k = 0; k < MAX_LOOPS; k++) {
      const idx = k + 1;
      Lmat[idx * NMAT + idx] = p.L_r;
      Rvec[idx] = p.R_r;
      Vvec[idx] = 0;
      Ivec[idx] = state[`i_r_${k}`] || 0;
      if (k < M) {
        const a   = state.theta_r + (2 * Math.PI * k) / N;
        const Mk  = M0 * Math.cos(a);
        const dMk = -M0 * Math.sin(a);
        Lmat [0   * NMAT + idx] = Mk;
        Lmat [idx * NMAT + 0  ] = Mk;
        dLdt [0   * NMAT + idx] = dMk * state.omega_r;
        dLdt [idx * NMAT + 0  ] = dMk * state.omega_r;
        dLdth[0   * NMAT + idx] = dMk;
        dLdth[idx * NMAT + 0  ] = dMk;
      }
    }

    const di  = LIB.EM.solveCurrentRates(Lmat, Rvec, Vvec, dLdt, Ivec);
    const tau = LIB.EM.coenergyTorque(dLdth, Ivec);

    state.lastTau = tau;
    state.lastVs  = Vs;
    state.lastM0  = M0;

    const tauDrag = rotorDragger.spring1D(state, state.theta_r, state.omega_r,
                                          K_ROTOR_DRAG, C_ROTOR_DRAG);
    const J = Math.max(1e-9, p.J_r);

    const out = {
      i_s:     di[0],
      theta_r: state.omega_r,
      omega_r: (tau + tauDrag - p.b_r * state.omega_r) / J,
    };
    for (let k = 0; k < MAX_LOOPS; k++) out[`i_r_${k}`] = di[k + 1];
    return out;
  }

  function preStep(state, params, dt) { dragMux.preStep(state, dt); }

  // ---- pointer ----

  let cachedL3        = null;
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

  const kickBtn = {
    id: "kick",
    label: "Kick rotor +5°",
    style: { color: LIB.Util.getVar("--cI"), borderColor: LIB.Util.getVar("--cI") },
    onClick: (state) => { state.theta_r += 5 * Math.PI / 180; },
  };

  // "Spin +" gives the rotor an initial angular velocity in the +ω direction.
  // Single-phase has no starting torque from rest (the dx/dt-vs-ω torque
  // function is odd in ω with f(0)=0), but once ω_r ≠ 0 the cage develops a
  // net running torque biased in the direction of motion — the textbook
  // double-revolving-field result. Click the button (repeatedly if needed)
  // to push past the saddle at ω_r=0; if rotor R/L and damping are in the
  // right window the rotor will sustain rotation under single-phase drive
  // alone. Cumulative clicks are useful for exploring the torque-vs-slip
  // curve from below and above synchronous speed.
  const spinBtn = {
    id: "spin",
    label: "Spin +5 rad/s",
    style: { color: LIB.Util.getVar("--good"), borderColor: LIB.Util.getVar("--good") },
    onClick: (state) => { state.omega_r += 5; },
  };
  const spinNegBtn = {
    id: "spin-neg",
    label: "Spin −5 rad/s",
    style: { color: LIB.Util.getVar("--good"), borderColor: LIB.Util.getVar("--good") },
    onClick: (state) => { state.omega_r -= 5; },
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
    const Zs = Math.hypot(p.R_s, w * p.L_s);
    return Math.max(1e-6, p.V_amp / Math.max(0.01, Zs));
  }
  function rotorPeakI(p, M0, IsRef) {
    const w    = 2 * Math.PI * p.f_drive;
    const emfR = Math.abs(M0) * w * IsRef;
    const Zr   = Math.hypot(p.R_r, w * p.L_r);
    return Math.max(1e-9, emfR / Math.max(0.01, Zr));
  }

  function render(ctx, layout, state, p) {
    const W = layout.W, H = layout.H;
    const L3 = LIB.Layout3D.orbital(W, H, {
      yaw: state.cam.yaw, pitch: state.cam.pitch, dist: state.cam.dist, fov: Math.PI / 4,
    });
    cachedL3 = L3;

    const N      = nBars(p);
    const M      = N / 2;
    const stator = makeStator(p);
    const M0     = mutualPeak(p);
    const IsRef  = statorPeakI(p);
    const IrRef  = rotorPeakI(p, M0, IsRef);

    if (state.showAxes) {
      drawWorldAxes(ctx, L3, 0.6);
      drawRotorAxis(ctx, L3);
    }

    // Per-loop field visualisation. Each cage loop is drawn as an equivalent
    // circular loop with the appropriate normal; lines fade with that loop's
    // instantaneous current relative to the per-loop reference.
    if (state.showLines) {
      const dS = Math.min(1, Math.abs(state.i_s) / IsRef);
      LIB.FieldRender.drawLoopFieldLines(ctx, L3, stator, {
        color: "#4ea1ff", density: dS, alpha: 0.75,
        azSlices: 6, alphaScales: [1.6, 2.4, 3.4, 4.4],
      });
      for (let k = 0; k < M; k++) {
        const a  = state.theta_r + (2 * Math.PI * k) / N;
        const lp = makeCageLoop(p, a);
        const ik = state[`i_r_${k}`] || 0;
        const dR = Math.min(1, Math.abs(ik) / IrRef);
        LIB.FieldRender.drawLoopFieldLines(ctx, L3, lp, {
          color: "#ef5350", density: dR, alpha: 0.45,
          azSlices: 4, alphaScales: [1.6, 2.4],
        });
      }
    }
    if (state.showMagnets) {
      LIB.FieldRender.drawBarMagnet(ctx, L3, stator, state.i_s, {});
      for (let k = 0; k < M; k++) {
        const a  = state.theta_r + (2 * Math.PI * k) / N;
        const lp = makeCageLoop(p, a);
        const ik = state[`i_r_${k}`] || 0;
        LIB.FieldRender.drawBarMagnet(ctx, L3, lp, ik, {});
      }
    }
    if (state.showArrows) {
      LIB.FieldRender.drawMomentArrow(ctx, L3, stator, state.i_s, {
        color: "#4ea1ff", imax: IsRef, label: "B_s",
      });
      for (let k = 0; k < M; k++) {
        const a  = state.theta_r + (2 * Math.PI * k) / N;
        const lp = makeCageLoop(p, a);
        const ik = state[`i_r_${k}`] || 0;
        LIB.FieldRender.drawMomentArrow(ctx, L3, lp, ik, {
          color: "#ef5350", imax: IrRef,
        });
      }
    }
    if (state.showTau) {
      LIB.FieldRender.drawTorqueArrow(ctx, L3, state.lastTau, { tauRef: 2e-6 });
    }

    // Stator wire + dots.
    const lineW = state.showVoltage ? 6 : 4;
    LIB.CoilRender.drawLoopWire(ctx, L3, stator, {
      color: state.showVoltage ? null : "#4ea1ff",
      voltageMode: !!state.showVoltage,
      voltage: state.lastVs, vMax: p.V_amp,
      lineWidth: lineW, K: 80, outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawLoopCurrentDots(ctx, L3, stator, state.i_s,
      state.dotPhaseS, {
        dotCount: 12, dotSize: 4.5, dt: 1 / HIST_HZ,
        gain: 1.0 / IsRef, dotColor: "#ffd54a",
      });

    // End rings — drawn as dim grey conductors; they belong to all loops so
    // we don't voltage-tint them. The end-ring CURRENT is the algebraic sum
    // of bar currents and is not directly tracked at this fidelity.
    const ringPos = endRingPoints(p, +ROTOR_HALF_LENGTH, RING_K);
    const ringNeg = endRingPoints(p, -ROTOR_HALF_LENGTH, RING_K);
    LIB.CoilRender.drawConductor3D(ctx, L3, ringPos, {
      color: "#7f8a99", lineWidth: 2.5, closed: true,
      outlineColor: "rgba(0,0,0,0.55)",
    });
    LIB.CoilRender.drawConductor3D(ctx, L3, ringNeg, {
      color: "#7f8a99", lineWidth: 2.5, closed: true,
      outlineColor: "rgba(0,0,0,0.55)",
    });

    // Bars. Bar k_bar lives in loop (k_bar mod M); the second leg of the
    // diametral pair (k_bar >= M) carries the loop current with the opposite
    // sign so dots flow in opposite directions on the two bars of a pair.
    cachedBarScreen.length = 0;
    const vMaxBar = Math.max(1e-9, p.R_r * IrRef);
    for (let kb = 0; kb < N; kb++) {
      const loopIdx = kb % M;
      const sign    = (kb < M) ? +1 : -1;
      const ik      = (state[`i_r_${loopIdx}`] || 0) * sign;
      const pts     = barPoints(p, state.theta_r, N, kb, BAR_K);
      LIB.CoilRender.drawConductor3D(ctx, L3, pts, {
        color: state.showVoltage ? null : "#ef5350",
        voltageMode: !!state.showVoltage,
        voltage: p.R_r * ik, vMax: vMaxBar,
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

  const PLOT_PALETTE = ["#ef5350", "#ff9800", "#ffd54a", "#66bb6a"];
  const PLOT_LOOPS_SHOWN = PLOT_PALETTE.length;   // first 4 loops on the per-loop plot

  const SPEC = {
    id: "ac-squirrel-cage",
    title: "Squirrel-cage rotor",
    subtitle: "single-phase AC stator + N-bar cage rotor",
    description:
      "<b>Squirrel-cage rotor</b> — replaces the single-loop rotor of the previous " +
      "lesson with N short-circuited axial bars closed by two end rings. The bars " +
      "stay visible as discrete conductors; for circuit purposes the cage is " +
      "modelled as N/2 diametral-pair rectangular loops (bar k paired with bar " +
      "k+N/2), each represented by an equivalent circular loop with the same rotor " +
      "radius and a normal rotated by 2π·k/N from loop 0. Mutual inductance to the " +
      "stator: <i>M_k(θ) = M_0·cos(θ_r + 2π·k/N)</i>, so the loops are out of phase " +
      "with each other and the rotor experiences torque contributions from many " +
      "loops simultaneously. The torque physics is the same co-energy formula as " +
      "the coaxial-loops lesson: <i>τ = ½·iᵀ·(dL/dθ)·i = i_s · Σ_k i_k · dM_k/dθ</i>. " +
      "<br><br>" +
      "<b>Single-phase running.</b> From rest the cage develops <i>zero</i> net " +
      "starting torque (the τ-vs-ω curve is odd in ω, with τ(0)=0 — the saddle that " +
      "auxiliary windings exist to break). But once ω_r ≠ 0 the rotor sees the two " +
      "counter-rotating components of the pulsating stator field at different slips " +
      "and the cage's R/L phase lag turns the imbalance into a net running torque " +
      "biased in the direction of motion. Click <b>Spin +/− 5 rad/s</b> to push past " +
      "the saddle and watch the cage hold its rotation. Running torque needs a " +
      "non-trivial slip-frequency reactance ω_slip·L_r/R_r — if the rotor is too " +
      "resistive (or the drive too slow) the phase lag collapses and the rotor just " +
      "decays back to rest. Crank N up to smooth the torque ripple.",

    state: () => {
      const s = {
        cam: { yaw: 0.55, pitch: 0.30, dist: 3.4 },
        i_s: 0,
        theta_r: 0, omega_r: 0,
        dotPhaseS:  { phase: 0 },
        dotPhasesR: [],
        drag: null,
        showLines:   true,
        showMagnets: false,
        showArrows:  true,
        showTau:     true,
        showAxes:    false,
        showVoltage: true,
        lastTau: 0, lastM0: 0, lastVs: 0,
        lastIsRef: 1, lastIrRef: 1,
        t: 0,
      };
      for (let k = 0; k < MAX_LOOPS;   k++) s[`i_r_${k}`] = 0;
      for (let k = 0; k < N_BARS_MAX;  k++) s.dotPhasesR.push({ phase: 0 });
      return s;
    },

    onReset: (s) => {
      s.drag = null;
      s.dotPhaseS.phase = 0;
      for (const r of s.dotPhasesR) r.phase = 0;
    },

    sliders: {
      Drive: [
        { key: "V_amp",   label: "V̂",   min: 0,   max: 50,  step: 0.1,  value: 12,
          tip: "Stator terminal-voltage amplitude (V)." },
        { key: "f_drive", label: "f",   min: 0.1, max: 10,  step: 0.05, value: 3.0,
          tip: "Stator drive frequency (Hz). Slow enough to see each cycle play out in the field/current animations; high enough that ω·L_r ≳ R_r at default rotor parameters so a kick can sustain rotation." },
      ],
      Stator: [
        { key: "r_s", label: "r_s",  min: 0.1,  max: 1.0,  step: 0.005, value: 0.55,
          tip: "Stator coil radius (m)." },
        { key: "R_s", label: "R_s",  min: 0.1,  max: 50,   step: 0.05,  value: 4.0, log: true,
          tip: "Stator winding resistance (Ω)." },
        { key: "L_s", label: "L_s",  min: 1e-4, max: 1.0,  step: 1e-4,  value: 0.012, log: true,
          tip: "Stator self-inductance (H)." },
        { key: "N_s", label: "N_s",  min: 1,    max: 200,  step: 1,     value: 50,
          tip: "Stator turn count." },
      ],
      "Cage rotor": [
        { key: "N_bars", label: "N bars", min: N_BARS_MIN, max: N_BARS_MAX, step: 2, value: 6,
          onChange: (v, state) => {
            // Zero loop currents that just dropped out of the active range so
            // the integrator's electrical state stays clean.
            const M = Math.floor(v / 2);
            for (let k = M; k < MAX_LOOPS; k++) state[`i_r_${k}`] = 0;
          },
          tip: "Number of axial bars in the cage. Cage is modelled as N/2 diametral-pair loops; even values only. N=2 reduces to the single-loop rotor of coaxial-loops." },
        { key: "r_r", label: "r_r",  min: 0.05, max: 0.7,  step: 0.005, value: 0.30,
          tip: "Rotor cage radius (m). Must be < r_s for nested geometry." },
        { key: "R_r", label: "R_r",  min: 0.05, max: 50,   step: 0.05,  value: 0.30, log: true,
          tip: "Per-loop resistance (Ω) — bar pair plus end-ring closure. Running torque needs ω_slip·L_r ≳ R_r; raising R_r past that ratio collapses the phase lag and the cage stops sustaining rotation." },
        { key: "L_r", label: "L_r",  min: 1e-4, max: 1.0,  step: 1e-4,  value: 0.030, log: true,
          tip: "Per-loop self-inductance (H). Combined with R_r sets the rotor's slip-frequency Q; default L_r/R_r ≈ 100 ms gives a useful phase lag at the default 3 Hz drive." },
        { key: "N_r", label: "N_r",  min: 1,    max: 200,  step: 1,     value: 50,
          tip: "Equivalent turns per cage loop. A real cage has 1 turn per diametral pair, but with that the air-core mutual inductance is too weak (M/√(L_s·L_r) ~ 1e-3) for running torque to overcome any practical mechanical damping. This slider scales M by N_r as a stand-in for the missing ferromagnetic-core flux channelling — same trick coaxial-loops uses." },
        { key: "J_r", label: "J_r",  min: 1e-4, max: 1.0,  step: 1e-4,  value: 0.001, log: true,
          tip: "Rotor moment of inertia (kg·m²). Lower → quicker spin-up under the (small) running torque." },
        { key: "b_r", label: "b_r",  min: 0,    max: 1.0,  step: 1e-4,  value: 5e-4, log: true,
          tip: "Rotor viscous damping (N·m·s/rad). Default low so single-phase running torque (small fraction of the peak τ) is enough to maintain rotation after a kick." },
      ],
    },

    plots: [
      { title: "τ rotor (N·m)",
        yFmt: (v) => v.toExponential(2),
        yFloor: { lo: -1e-6, hi: 1e-6 }, yChunk: 1e-6,
        series: [
          { label: "tau", color: "#ffd54a", lw: 2.0,
            source: (s) => s.lastTau || 0 },
        ] },
      { title: "i_s stator (A)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -0.5, hi: 0.5 }, yChunk: 0.5,
        series: [
          { label: "i_s", color: "#4ea1ff", lw: 2.0,
            source: (s) => s.i_s || 0 },
        ] },
      { title: `i_k cage loops (A) — first ${PLOT_LOOPS_SHOWN}`,
        yFmt: (v) => v.toExponential(2),
        yFloor: { lo: -1e-3, hi: 1e-3 }, yChunk: 1e-3,
        series: PLOT_PALETTE.map((color, k) => ({
          label: `i_${k}`, color, lw: 1.6,
          source: (s, pp) => {
            const M = Math.floor(nBars(pp) / 2);
            return (k < M) ? (s[`i_r_${k}`] || 0) : 0;
          },
        })),
      },
    ],

    readouts: [
      { label: "θ rotor",  units: "°",
        value: (s) => (s.theta_r * 180 / Math.PI).toFixed(1) },
      { label: "ω rotor",  units: "rad/s",
        value: (s) => (s.omega_r || 0).toFixed(3) },
      { label: "τ rotor",  units: "N·m",
        value: (s) => (s.lastTau || 0).toExponential(3) },
      { label: "N bars",
        value: (s, p) => `${nBars(p)}` },
      { label: "loops (N/2)",
        value: (s, p) => `${nBars(p) / 2}` },
      { label: "i_s",      units: "A",
        value: (s) => (s.i_s || 0).toFixed(4) },
      { label: "Σ|i_k|",   units: "A",
        value: (s, p) => {
          const M = Math.floor(nBars(p) / 2);
          let sum = 0;
          for (let k = 0; k < M; k++) sum += Math.abs(s[`i_r_${k}`] || 0);
          return sum.toExponential(3);
        } },
      { label: "max |i_k|", units: "A",
        value: (s, p) => {
          const M = Math.floor(nBars(p) / 2);
          let mx = 0;
          for (let k = 0; k < M; k++) {
            const a = Math.abs(s[`i_r_${k}`] || 0);
            if (a > mx) mx = a;
          }
          return mx.toExponential(3);
        } },
      { label: "V_s applied", units: "V",
        value: (s) => (s.lastVs || 0).toFixed(2) },
      { label: "I_s ref",  units: "A",
        value: (s) => (s.lastIsRef || 0).toFixed(3) },
      { label: "I_r ref",  units: "A",
        value: (s) => (s.lastIrRef || 0).toExponential(3) },
      { label: "M_0",      units: "H",
        value: (s) => (s.lastM0 || 0).toExponential(3) },
      { label: "cam yaw",  units: "°",
        value: (s) => (s.cam.yaw * 180 / Math.PI).toFixed(0) },
      { label: "cam pitch",units: "°",
        value: (s) => (s.cam.pitch * 180 / Math.PI).toFixed(0) },
    ],

    physics: {
      // Static DOF list: 3 mech/stator DOFs + MAX_LOOPS rotor-loop currents.
      // Inactive loops (k >= N/2) have zero coupling so their currents simply
      // decay through their own R/L; no special handling required.
      dof: (() => {
        const arr = ["i_s", "theta_r", "omega_r"];
        for (let k = 0; k < MAX_LOOPS; k++) arr.push(`i_r_${k}`);
        return arr;
      })(),
      dxdt, preStep,
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
      kickBtn,
      spinBtn,
      spinNegBtn,
      toggleBtn("showLines",   "Lines: ON",    "Lines: OFF"),
      toggleBtn("showArrows",  "B-arrows: ON", "B-arrows: OFF"),
      toggleBtn("showTau",     "τ-arrow: ON",  "τ-arrow: OFF"),
      toggleBtn("showMagnets", "Magnets: ON",  "Magnets: OFF"),
      toggleBtn("showVoltage", "V-tint: ON",   "V-tint: OFF"),
      toggleBtn("showAxes",    "Axes: ON",     "Axes: OFF"),
    ],

    icon: (ctx, W, H) => {
      const cx = W / 2, cy = H / 2;
      const S  = Math.min(W, H);
      // Outer (stator) loop.
      ctx.strokeStyle = "#4ea1ff"; ctx.lineWidth = Math.max(2, S * 0.025);
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * 0.32, S * 0.32, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Cage end ring (foreshortened).
      ctx.strokeStyle = "#ef5350"; ctx.lineWidth = Math.max(2, S * 0.018);
      ctx.beginPath();
      ctx.ellipse(cx, cy, S * 0.18, S * 0.10, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Bars (dots around the end ring).
      ctx.fillStyle = "#ef5350";
      const Nicon = 10;
      for (let k = 0; k < Nicon; k++) {
        const a = (k / Nicon) * 2 * Math.PI;
        const x = cx + Math.cos(a) * S * 0.18;
        const y = cy + Math.sin(a) * S * 0.10;
        ctx.beginPath(); ctx.arc(x, y, S * 0.018, 0, Math.PI * 2); ctx.fill();
      }
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).squirrelCage = SPEC;
})();
