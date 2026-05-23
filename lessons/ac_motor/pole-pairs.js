"use strict";

// =============================================================================
//  Pole pairs — multi-pole stator + cage rotor, 2D end view.
//
//  Two pedagogical points live in one lesson:
//
//    1. ω_syn = ω_AC / p.  Slider p ∈ {1..4} duplicates the three-winding
//       pattern around the cavity. The field still cycles at ω_AC but its
//       spatial period collapses to 2π/p, so one electrical cycle sweeps the
//       field through 1/p of a mechanical revolution — and the cage rotor
//       tracks ω_AC/p instead of ω_AC.
//
//    2. Discrete windings → torque ripple.  Slider L ∈ {1..5} controls how
//       many "loops per phase per pole" are placed around the cavity; slider
//       δ controls the angular offset between successive loops in the same
//       phase. The physics integrates over each discrete coil, so a single
//       concentrated coil (L=1) produces a square-wave MMF whose 5th + 7th
//       spatial harmonics survive 3-phase summation and beat against the
//       fundamental at 6·ω_AC. Spreading the phase over L>1 coils with
//       δ ≠ 0 applies a Dirichlet-kernel suppression that cancels the higher
//       harmonics faster than the fundamental — the ripple shrinks, the mean
//       torque barely changes. That's the textbook reason real machines use
//       distributed windings.
//
//  Mutual model. Each stator coil at angle α_c is treated as a concentrated
//  pair of wires producing a square-wave radial-B distribution around the
//  cavity. Flux through a rotor loop at angle θ_n is then a triangle wave in
//  (θ_n − α_c). Truncated Fourier series (h ∈ {1, 3, 5, 7}; the h=3 term
//  cancels under 3-phase summation but is kept in the per-coil mutual so the
//  field-rim heatmap visualises it correctly):
//
//      M(Δ)     = M_0 · [ sin(p·Δ) − sin(3p·Δ)/9 + sin(5p·Δ)/25
//                                                   − sin(7p·Δ)/49 ]
//      dM/dΔ_n  = M_0·p · [ cos(p·Δ) − cos(3p·Δ)/3 + cos(5p·Δ)/5
//                                                   − cos(7p·Δ)/7 ]
//
//  Stator currents are imposed (no electrical DOF on stator):
//      i_k(t) = I_amp · cos(φ − 2π·k_eff/3),    k ∈ {a, b, c}
//  where φ is integrated in preStep so dragging f never teleports the field.
//  The "swap" toggle reverses b↔c (= reverses the field's sense of rotation).
//
//  Rotor cage. Same simplification as squirrel-cage.js: N_BARS bars closed by
//  two end rings, treated as M_LOOPS = N_BARS/2 diametral-pair loops with
//  zero inter-loop mutual. Each loop has self-inductance L_r and resistance
//  R_r. DOFs are θ_r, ω_r, i_r_0 .. i_r_{M_LOOPS−1}.
// =============================================================================

(function () {

  // ---- constants ----
  const PHYS_HZ        = 240;
  const HIST_HZ        = 60;

  // Cage geometry (visual + electrical). Bars per cage are fixed so the
  // student's attention stays on p and L; squirrel-cage.js already explores
  // the N-bars knob in 3D for the "ripple from few bars" angle.
  const N_BARS         = 16;
  const M_LOOPS        = N_BARS / 2;       // diametral-pair loops

  // Geometric radii in world units (cavity outer = 1.0). The world bbox of
  // 2.6 below leaves room for N/S labels just outside the bore.
  const R_YOKE         = 1.20;             // outer stator iron
  const R_CAVITY       = 1.00;             // stator inner bore
  const R_WIRE         = 0.93;             // wire-bundle dots on the bore
  const R_ROTOR        = 0.82;             // rotor outer
  const R_BAR          = 0.76;             // bar centreline on the rotor
  const R_SHAFT        = 0.10;

  // Electrical machine constants. Tuned so default settings give a visible
  // spin-up over ~3 s, a useful slip at default load, and a torque-ripple
  // amplitude that's a meaningful fraction of mean torque at L=1.
  const I_AMP          = 2.0;              // imposed phase current amplitude (A)
  const M0             = 2.0e-3;           // mutual prefactor (H)
  const R_R            = 0.05;             // per-loop rotor resistance (Ω)
  const L_R            = 5.0e-4;           // per-loop rotor self-inductance (H)
  const J_R            = 3.0e-4;           // rotor inertia (kg·m²)

  // Drag-handle spring (lets the user grab the rotor and force it around).
  const K_ROTOR_DRAG   = 0.05;
  const C_ROTOR_DRAG   = 0.005;

  // Harmonic series for the per-coil mutual. The full 4-term truncation is
  // used by the field-heatmap visualisation so the student can see the
  // square-wave shape at L=1 and watch it flatten as L·δ grows. The rotor
  // cage, however, is modelled as a set of independent diametral loops with
  // no inter-loop mutual — a real cage's end rings short-circuit harmonic
  // bar currents the rings can't accommodate, but this model can't.
  // Coupling the cage to the full harmonic spectrum produces unphysically
  // large 5th/7th-driven loop currents at near-synchronous speed. We
  // therefore restrict the rotor coupling to the fundamental (HARMONICS_ROTOR)
  // while keeping the full series for the visualisation (HARMONICS).
  const HARMONICS = [
    { h: 1, sign: +1 },
    { h: 3, sign: -1 },
    { h: 5, sign: +1 },
    { h: 7, sign: -1 },
  ];
  const HARMONICS_ROTOR = [
    { h: 1, sign: +1 },
  ];

  // Phase colours match the rotating-field / three-phase lessons exactly so
  // a student switching tabs sees consistent identities for a/b/c.
  const WCOL = ["#ef5350", "#66bb6a", "#4ea1ff"];
  const WLBL = ["a", "b", "c"];

  // Slider clamping.
  const P_MIN = 1, P_MAX = 4;
  const L_MIN = 1, L_MAX = 5;

  function clampInt(v, lo, hi) {
    let x = Math.round(+v || lo);
    if (x < lo) x = lo;
    if (x > hi) x = hi;
    return x;
  }

  // ---- per-coil geometry ----

  // Angular position of phase-k pole-pair-copy-j loop-l, measured from +x
  // CCW. Each phase has L copies offset symmetrically around the nominal
  // pole-pair position; the L copies are physically in series so they all
  // carry the same instantaneous phase current.
  function coilAngle(k, j, l, p, L, delta) {
    const nominal = (2 * Math.PI * k) / (3 * p) + (2 * Math.PI * j) / p;
    const offset  = delta * (l - (L - 1) / 2);
    return nominal + offset;
  }

  // Mutual and its θ_n-derivative for one stator coil at α_c interacting
  // with a rotor loop at angle θ_n. Returns [M, dM/dθ_n] in units of M_0.
  // `harmonics` selects which terms of the truncated Fourier series to
  // include — typically HARMONICS for the field heatmap, HARMONICS_ROTOR
  // (fundamental only) for the rotor coupling. See the comment block at
  // HARMONICS for the rationale.
  function mutualPair(p, dTheta, harmonics) {
    let M = 0, dM = 0;
    for (const term of harmonics) {
      const h = term.h;
      const x = h * p * dTheta;
      M  += (term.sign / (h * h)) * Math.sin(x);
      dM += (term.sign / h)       * p * Math.cos(x);
    }
    return [M, dM];
  }

  // Phase-k imposed signal, observing the swap convention used everywhere
  // else in the ac_motor family.
  function phaseEff(k, swap) {
    if (!swap) return k;
    if (k === 1) return 2;
    if (k === 2) return 1;
    return 0;
  }
  function phaseSignal(k, phi, swap) {
    return Math.cos(phi - (2 * Math.PI / 3) * phaseEff(k, swap));
  }

  // Radial-B-field magnitude at azimuth φ around the cavity at drive phase
  // φ_d. Computed from the same Fourier kernel as the mutual but with each
  // discrete coil contributing only one term (the per-coil flux as a function
  // of cavity-azimuth, not loop-normal-angle). Used by the field heatmap.
  function fieldAt(phi_pos, phi_d, p, L, delta, swap) {
    let B = 0;
    for (let k = 0; k < 3; k++) {
      const ik = phaseSignal(k, phi_d, swap) * I_AMP;
      for (let j = 0; j < p; j++) {
        for (let l = 0; l < L; l++) {
          const a = coilAngle(k, j, l, p, L, delta);
          // dM/d(phi_pos − a) gives the B-radial-like kernel; gives the same
          // square-wave shape we want to visualise. Divide by L so swapping
          // L just changes the harmonic spectrum, not the overall envelope.
          const [, dM] = mutualPair(p, phi_pos - a, HARMONICS);
          B += ik * dM / L;
        }
      }
    }
    return B;
  }

  // ---- physics ----

  // Working buffer for di/dt assignments (allocated once, reused each call).
  const diDt = new Float64Array(M_LOOPS);

  function dxdt(state, params, t) {
    const p     = clampInt(params.p, P_MIN, P_MAX);
    const L     = clampInt(params.L_loops, L_MIN, L_MAX);
    const delta = (+params.delta_deg || 0) * Math.PI / 180;
    const swap  = state.swap;

    const omegaAC = 2 * Math.PI * (+params.f_drive || 0);

    // Imposed phase currents and their time-derivatives. Field-direction
    // sign (set by swap) is folded into the per-phase argument so the
    // rest of the code stays direction-agnostic.
    const i_k    = state.lastI_k;
    const di_dt  = state.lastDi_k;
    for (let k = 0; k < 3; k++) {
      const arg = state.phi - (2 * Math.PI / 3) * phaseEff(k, swap);
      i_k[k]   = I_AMP * Math.cos(arg);
      di_dt[k] = -I_AMP * omegaAC * Math.sin(arg);
    }

    // Loop over rotor loops; each gets a flux/torque contribution from every
    // discrete stator coil.
    let tauTotal = 0;
    const inv_L = 1 / L;

    for (let n = 0; n < M_LOOPS; n++) {
      const theta_n = state.theta_r + (2 * Math.PI * n) / N_BARS;
      let dPhi_dt = 0;
      let tau_n_per_in = 0;   // Σ_coils dM/dθ_r · i_coil  (× M_0 below)

      for (let k = 0; k < 3; k++) {
        const ik = i_k[k];
        const dik = di_dt[k];
        for (let j = 0; j < p; j++) {
          for (let l = 0; l < L; l++) {
            const alpha = coilAngle(k, j, l, p, L, delta);
            const [M_c, dM_c] = mutualPair(p, theta_n - alpha, HARMONICS_ROTOR);
            // Per-coil contribution to dΦ_n/dt. (1/L) so total ampere-turns
            // per phase scale with L matches a real distributed winding.
            dPhi_dt    += inv_L * (dM_c * state.omega_r * ik + M_c * dik);
            tau_n_per_in += inv_L *  dM_c * ik;
          }
        }
      }

      dPhi_dt      *= M0;
      tau_n_per_in *= M0;

      const i_n = state[`i_r_${n}`] || 0;
      tauTotal += tau_n_per_in * i_n;

      // KVL: L_r·di_n/dt = −R_r·i_n − dΦ_n/dt
      diDt[n] = (-R_R * i_n - dPhi_dt) / L_R;
    }

    const tauDrag = rotorDragger.springTheta(
      state, state.theta_r, state.omega_r, K_ROTOR_DRAG, C_ROTOR_DRAG);

    state.lastTau     = tauTotal;
    state.lastOmegaSyn = (swap ? -1 : +1) * omegaAC / p;

    const out = {
      theta_r: state.omega_r,
      omega_r: (tauTotal + tauDrag - (+params.b_r || 0) * state.omega_r) / J_R,
    };
    for (let n = 0; n < M_LOOPS; n++) out[`i_r_${n}`] = diDt[n];
    return out;
  }

  function preStep(state, params, dt) {
    // Integrate drive phase separately (not a DOF) — same trick the
    // rotating-field and three-phase-* lessons use so dragging f doesn't
    // teleport ωt.
    const omega = 2 * Math.PI * (+params.f_drive || 0);
    state.phi += omega * dt;
    if (state.phi >  Math.PI * 4) state.phi -= Math.PI * 2;
    if (state.phi < -Math.PI * 4) state.phi += Math.PI * 2;
    rotorDragger.preStep(state, dt);
  }

  function postStep(state, params, dt) {
    // Keep θ_r wrapped so the rotor's render doesn't accumulate huge angles
    // (and so the readout stays useful).
    if (!Number.isFinite(state.theta_r)) state.theta_r = 0;
    state.theta_r = Math.atan2(Math.sin(state.theta_r), Math.cos(state.theta_r));
  }

  // ---- pointer / rotor drag ----

  function rotorHit(state, params, layout, mx, my) {
    const c = layout.toPx({ x: 0, y: 0 });
    const dx = mx - c.px, dy = my - c.py;
    const r  = Math.hypot(dx, dy);
    return r < layout.scale * R_ROTOR;
  }

  const rotorDragger = LIB.Drag.angular({
    kind:   "rotor",
    hitTest: rotorHit,
    centerPx: (state, params, layout) => {
      const c = layout.toPx({ x: 0, y: 0 });
      return { x: c.px, y: c.py };
    },
    thetaOf: (state) => state.theta_r,
    onSeedW: (state) => state.omega_r,
    windowSec: 0.04,
  });

  function onPointer(type, mx, my, layout, state, params) {
    return rotorDragger.handle(type, mx, my, layout, state, params);
  }

  // ---- rendering ----

  function drawStatorCore(ctx, layout) {
    const c = layout.toPx({ x: 0, y: 0 });
    ctx.save();
    // Yoke fill (laminated iron).
    ctx.fillStyle = "#1c2026";
    ctx.beginPath();
    ctx.arc(c.px, c.py, layout.scale * R_YOKE, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,200,220,0.4)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Cavity (air gap + bore).
    ctx.fillStyle = "#0e1116";
    ctx.beginPath();
    ctx.arc(c.px, c.py, layout.scale * R_CAVITY, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,200,220,0.55)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  // Heat-map ring inside the cavity wall showing B(φ, t). Red for +B,
  // blue for −B. Sampled at K segments around the rim.
  function drawFieldRing(ctx, layout, state, params, p, L) {
    if (!state.showField) return;
    const delta = (+params.delta_deg || 0) * Math.PI / 180;
    const c = layout.toPx({ x: 0, y: 0 });
    const rO = layout.scale * (R_CAVITY - 0.005);
    const rI = layout.scale * (R_ROTOR  + 0.005);
    const K  = 240;
    // Estimate the field's peak for normalisation. The mean magnitude scales
    // with the fundamental amplitude; harmonics push the peak above the
    // fundamental at L=1. Compute the max over K samples at this instant so
    // the ring uses the full red/blue range.
    let peak = 1e-9;
    const samples = new Float64Array(K);
    for (let i = 0; i < K; i++) {
      const phi = (i / K) * 2 * Math.PI;
      const B = fieldAt(phi, state.phi, p, L, delta, state.swap);
      samples[i] = B;
      const ab = Math.abs(B);
      if (ab > peak) peak = ab;
    }
    ctx.save();
    for (let i = 0; i < K; i++) {
      const a0 = (i        / K) * 2 * Math.PI;
      const a1 = ((i + 1)  / K) * 2 * Math.PI;
      const B  = samples[i] / peak;
      const intensity = Math.min(1, Math.abs(B));
      const r = B > 0 ? 239 :  60;
      const g = B > 0 ?  83 :  90;
      const b = B > 0 ?  80 : 230;
      ctx.fillStyle = `rgba(${r},${g},${b},${intensity * 0.55})`;
      // Annular sector (a0, a1) between rI and rO. Canvas arc uses screen-y-
      // down so we negate the world angles when calling arc().
      ctx.beginPath();
      ctx.moveTo(c.px + Math.cos(a0) * rI, c.py - Math.sin(a0) * rI);
      ctx.lineTo(c.px + Math.cos(a0) * rO, c.py - Math.sin(a0) * rO);
      ctx.arc(c.px, c.py, rO, -a0, -a1, true);
      ctx.lineTo(c.px + Math.cos(a1) * rI, c.py - Math.sin(a1) * rI);
      ctx.arc(c.px, c.py, rI, -a1, -a0, false);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    state.lastFieldPeak = peak;
  }

  // N / S markers at the maxima of the fundamental rotating field component.
  // With p pole pairs there are p of each, equally spaced 2π/p apart.
  function drawPoleMarkers(ctx, layout, state, p) {
    if (!state.showPoles) return;
    const c = layout.toPx({ x: 0, y: 0 });
    const sign = state.swap ? -1 : +1;
    // Fundamental "north" satisfies p·φ − ω_AC·t = 0 (modulo 2π).
    const baseN = sign * state.phi / p;
    const rLab  = layout.scale * 1.10;
    const T = LIB.Type.current;
    ctx.save();
    ctx.font = `bold ${T.lg}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let j = 0; j < p; j++) {
      const aN = baseN + (2 * Math.PI * j) / p;
      const aS = aN + Math.PI / p;
      const pxN = c.px + Math.cos(aN) * rLab;
      const pyN = c.py - Math.sin(aN) * rLab;
      const pxS = c.px + Math.cos(aS) * rLab;
      const pyS = c.py - Math.sin(aS) * rLab;
      ctx.fillStyle = "#ef5350";
      ctx.fillText("N", pxN, pyN);
      ctx.fillStyle = "#4ea1ff";
      ctx.fillText("S", pxS, pyS);
    }
    ctx.restore();
  }

  // One wire bundle (current-carrying conductor seen end-on) at canvas pos
  // (px, py). sign = +1 (out of page, dot), −1 (into page, ×), 0 (no current).
  function drawWireDot(ctx, px, py, r, sign, color) {
    ctx.save();
    ctx.fillStyle = "#0e1116";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (sign > 0) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, r * 0.32, 0, Math.PI * 2);
      ctx.fill();
    } else if (sign < 0) {
      ctx.beginPath();
      ctx.moveTo(px - r * 0.55, py - r * 0.55);
      ctx.lineTo(px + r * 0.55, py + r * 0.55);
      ctx.moveTo(px + r * 0.55, py - r * 0.55);
      ctx.lineTo(px - r * 0.55, py + r * 0.55);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Stator wires. Each coil at angle α_c (a dipole axis direction) is drawn
  // as two wire bundles on the bore wall, on the line perpendicular to α_c
  // at the appropriate angular distance for p pole pairs. The pair carries
  // currents +i_k and −i_k respectively.
  function drawStatorWires(ctx, layout, state, params, p, L) {
    if (!state.showWires) return;
    const delta = (+params.delta_deg || 0) * Math.PI / 180;
    const c  = layout.toPx({ x: 0, y: 0 });
    const rW = layout.scale * R_WIRE;
    // Wire size shrinks as we pack more wires onto the rim (3·p·L per phase
    // pair × 2 wires per pair = 6·p·L conductors).
    const scale = layout.scale * 0.05;
    const SIZE  = Math.max(4, scale / Math.sqrt(p * L));
    for (let k = 0; k < 3; k++) {
      const ik = state.lastI_k[k];
      const color = WCOL[k];
      for (let j = 0; j < p; j++) {
        for (let l = 0; l < L; l++) {
          const a   = coilAngle(k, j, l, p, L, delta);
          // The two wire bundles of a coil sit a quarter-pole-pitch on each
          // side of its dipole axis: φ_wire = α_c ± π/(2p).
          const half = Math.PI / (2 * p);
          const aP = a + half;
          const aN = a - half;
          const xP = c.px + Math.cos(aP) * rW;
          const yP = c.py - Math.sin(aP) * rW;
          const xN = c.px + Math.cos(aN) * rW;
          const yN = c.py - Math.sin(aN) * rW;
          const sP = ik >  1e-4 ? +1 : ik < -1e-4 ? -1 : 0;
          drawWireDot(ctx, xP, yP, SIZE,  sP, color);
          drawWireDot(ctx, xN, yN, SIZE, -sP, color);
        }
      }
      // Phase label outboard of the first j=0, l=0 coil so the student can
      // tell which colour is which without counting.
      const aLab = coilAngle(k, 0, Math.floor(L / 2), p, L, delta) +
                   Math.PI / (2 * p);
      const rLab = layout.scale * (R_CAVITY + 0.07);
      const T = LIB.Type.current;
      ctx.save();
      ctx.fillStyle = color;
      ctx.font = `bold ${T.md}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(WLBL[k],
        c.px + Math.cos(aLab) * rLab,
        c.py - Math.sin(aLab) * rLab);
      ctx.restore();
    }
  }

  function drawRotor(ctx, layout, state) {
    const c   = layout.toPx({ x: 0, y: 0 });
    const rR  = layout.scale * R_ROTOR;
    const rB  = layout.scale * R_BAR;
    const rS  = layout.scale * R_SHAFT;
    ctx.save();

    // Rotor iron.
    ctx.fillStyle = "#1d2026";
    ctx.beginPath();
    ctx.arc(c.px, c.py, rR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,200,220,0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // End ring — single circle in end-view (the two physical rings stack).
    ctx.strokeStyle = "#9aa4b2";
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.arc(c.px, c.py, rB + layout.scale * 0.025, 0, Math.PI * 2);
    ctx.stroke();

    // Bars. Bar n_bar carries the loop current of (n_bar mod M_LOOPS), with
    // opposite sign on the diametral sibling (n_bar ≥ M_LOOPS). Colour is
    // a continuous lerp from the rotor-iron background through to yellow
    // (positive, out-of-page) or purple (negative, into-page), so a bar
    // whose loop current is near zero fades to the iron tone instead of
    // flipping hue at every zero crossing. The wave of induced current
    // around the cage then reads as a smooth gradient.
    let iMax = 1e-6;
    for (let n = 0; n < M_LOOPS; n++) {
      const v = Math.abs(state[`i_r_${n}`] || 0);
      if (v > iMax) iMax = v;
    }
    const sR = layout.scale * 0.04;
    const BG  = [29, 32, 38];     // rotor-iron #1d2026
    const POS = [255, 213, 74];   // yellow — out of page
    const NEG = [180, 80, 200];   // purple — into page
    for (let nb = 0; nb < N_BARS; nb++) {
      const a = state.theta_r + (2 * Math.PI * nb) / N_BARS;
      const x = c.px + Math.cos(a) * rB;
      const y = c.py - Math.sin(a) * rB;
      const loopIdx = nb % M_LOOPS;
      const sign    = (nb < M_LOOPS) ? +1 : -1;
      const ik      = (state[`i_r_${loopIdx}`] || 0) * sign;
      const t       = Math.max(-1, Math.min(1, ik / iMax));
      const m       = Math.abs(t);
      const target  = t >= 0 ? POS : NEG;
      const cr = (BG[0] + (target[0] - BG[0]) * m) | 0;
      const cg = (BG[1] + (target[1] - BG[1]) * m) | 0;
      const cb = (BG[2] + (target[2] - BG[2]) * m) | 0;
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.beginPath();
      ctx.arc(x, y, sR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Fiducial — a yellow spoke from centre to one bar so rotation is
    // obvious even when bars are all near-identical shade.
    const aF = state.theta_r;
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(c.px, c.py);
    ctx.lineTo(c.px + Math.cos(aF) * rB * 0.85,
               c.py - Math.sin(aF) * rB * 0.85);
    ctx.stroke();

    // Shaft.
    ctx.fillStyle = "#2a3038";
    ctx.beginPath();
    ctx.arc(c.px, c.py, rS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(180,200,220,0.4)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
  }

  function render(ctx, layout, state, params) {
    const p = clampInt(params.p,       P_MIN, P_MAX);
    const L = clampInt(params.L_loops, L_MIN, L_MAX);
    drawStatorCore(ctx, layout);
    drawFieldRing (ctx, layout, state, params, p, L);
    drawStatorWires(ctx, layout, state, params, p, L);
    drawRotor     (ctx, layout, state);
    drawPoleMarkers(ctx, layout, state, p);
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
    field: "swap",
    labelOn:  "Phase order: a-c-b",
    labelOff: "Phase order: a-b-c",
    styleOn:  { color: LIB.Util.getVar("--cI"),     borderColor: LIB.Util.getVar("--cI")     },
    styleOff: { color: LIB.Util.getVar("--accent"), borderColor: LIB.Util.getVar("--accent") },
  });

  const kickBtn = {
    id: "kick",
    label: "Kick rotor +30°",
    style: { color: LIB.Util.getVar("--cI"), borderColor: LIB.Util.getVar("--cI") },
    onClick: (state) => { state.theta_r += 30 * Math.PI / 180; },
  };

  // ---- spec ----

  const SPEC = {
    id: "ac-pole-pairs",
    title: "Pole pairs — synchronous speed",
    subtitle: "ω_syn = ω_AC / p; field heatmap shows distributed-winding harmonic suppression",
    description:
      "<b>Multi-pole stator + cage rotor</b> — end view. " +
      "Slide <i>p</i> to put more copies of the three-winding pattern around " +
      "the cavity. The supply still cycles at <i>ω_AC</i>, but the field's " +
      "spatial period collapses to 2π/p, so one electrical cycle sweeps the " +
      "field through 1/p of a turn. The rotor's synchronous speed drops " +
      "with it: <i>ω_syn = ω_AC / p</i>. (At 50 Hz mains: p=1 gives 3000 " +
      "rpm, p=2 gives 1500 rpm, p=4 gives 750 rpm — standard catalogue " +
      "speeds.)" +
      "<br><br>" +
      "<b>Discrete windings.</b> Slide <i>L</i> from 1 upward to add more " +
      "winding copies per phase per pole, each offset from its neighbour by " +
      "<i>δ</i>°. Watch the field heatmap on the bore: at L=1 each phase is " +
      "a single concentrated coil, and the airgap field has a near-square " +
      "shape with strong 5th and 7th spatial harmonics. As L grows and δ " +
      "spreads the coils, a Dirichlet-kernel sum — sin(L·h·p·δ/2) / " +
      "sin(h·p·δ/2) — suppresses the higher harmonics faster than the " +
      "fundamental, and the field collapses to a clean rotating sinusoid. " +
      "That's the textbook reason real machines distribute their windings " +
      "across many slots. (In a real cage those harmonics also drive 6·ω_AC " +
      "torque ripple by coupling into the bars; this simplified rotor model " +
      "couples only to the fundamental, so the τ plot stays smooth and the " +
      "L/δ effect is visible in the field heatmap, not the torque trace.)" +
      "<br><br>" +
      "Drag the rotor to scrub it manually (you'll see the cage develop " +
      "induced currents in opposition); release and the field drags it " +
      "back toward ω_syn.",

    state: () => {
      const s = {
        t:       0,
        phi:     0,
        swap:    false,
        theta_r: 0,
        omega_r: 0,
        drag:    null,
        showField: true,
        showPoles: true,
        showWires: true,
        lastI_k:   [0, 0, 0],
        lastDi_k:  [0, 0, 0],
        lastTau:   0,
        lastOmegaSyn: 0,
        lastFieldPeak: 1,
      };
      for (let n = 0; n < M_LOOPS; n++) s[`i_r_${n}`] = 0;
      return s;
    },

    onReset: (s) => {
      s.drag = null;
      s.phi  = 0;
    },

    sliders: {
      Drive: [
        { key: "f_drive", label: "f", min: 0.05, max: 2.0, step: 0.01, value: 0.5,
          tip: "Supply frequency (Hz). Slowed below mains so each AC cycle plays out over ~2 s." },
      ],
      Stator: [
        { key: "p", label: "p (pole pairs)", min: P_MIN, max: P_MAX, step: 1, value: 1,
          tip: "Pole-pair count. The three-winding pattern is duplicated p times around the cavity, so the field has p N-poles and p S-poles. Synchronous speed scales as ω_syn = ω_AC / p — same field rate, divided across p times more mechanical structure." },
        { key: "L_loops", label: "L (loops/phase)", min: L_MIN, max: L_MAX, step: 1, value: 1,
          tip: "Coils per phase per pole. L=1 = concentrated single coil with strong 5th and 7th spatial harmonics, visible as a near-square airgap field on the heatmap. Increase L to spread the phase across more coils; combined with δ > 0 the higher harmonics get Dirichlet-kernel cancellation and the field heatmap becomes a clean rotating sinusoid." },
        { key: "delta_deg", label: "δ (°)", min: 0, max: 30, step: 0.5, value: 5,
          tip: "Angular offset between adjacent L copies of the same phase, in degrees. Zero stacks them on top of each other (no benefit). 5° is a small mock-distributed winding; 15–30° gets enough spread to clearly suppress the 5th/7th harmonics at L≥3." },
      ],
      Load: [
        { key: "b_r", label: "b", min: 1e-6, max: 1e-2, step: 1e-6, value: 5e-4, log: true,
          tip: "Mechanical load — rotor viscous damping (N·m·s/rad). Default is loaded enough that the rotor settles at a useful slip (a few percent). Drop b toward zero to run unloaded (rotor approaches ω_syn, slip → 0, current and ripple collapse). Past breakdown the rotor stalls." },
      ],
    },

    plots: [
      { title: "ω rotor vs ω_syn (rad/s) — note ω_syn ∝ 1/p",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -2, hi: 8 }, yChunk: 2,
        series: [
          { label: "ω_syn", color: "rgba(102,187,106,0.55)", lw: 1.4, dash: [4, 4],
            source: (s, pp) => {
              const p = clampInt(pp.p, P_MIN, P_MAX);
              return (s.swap ? -1 : +1) * 2 * Math.PI * pp.f_drive / p;
            } },
          { label: "ω_r", color: "#4ea1ff", lw: 2.0,
            source: (s) => s.omega_r || 0 },
        ] },
      { title: "τ rotor (N·m)",
        yFmt: (v) => v.toExponential(2),
        yFloor: { lo: -2e-4, hi: 2e-4 }, yChunk: 1e-4,
        series: [
          { label: "τ", color: "#ffd54a", lw: 2.0,
            source: (s) => s.lastTau || 0 },
        ] },
      { title: "i_a, i_b, i_c (A)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -2.5, hi: 2.5 }, yChunk: 1,
        series: [
          { label: "i_a", color: WCOL[0], lw: 1.6, source: (s) => s.lastI_k[0] || 0 },
          { label: "i_b", color: WCOL[1], lw: 1.6, source: (s) => s.lastI_k[1] || 0 },
          { label: "i_c", color: WCOL[2], lw: 1.6, source: (s) => s.lastI_k[2] || 0 },
        ] },
    ],

    readouts: [
      { label: "p", value: (s, pp) => `${clampInt(pp.p, P_MIN, P_MAX)}` },
      { label: "L coils/phase", value: (s, pp) => `${clampInt(pp.L_loops, L_MIN, L_MAX)}` },
      { label: "coils total",
        value: (s, pp) => {
          const p = clampInt(pp.p, P_MIN, P_MAX);
          const L = clampInt(pp.L_loops, L_MIN, L_MAX);
          return `${3 * p * L}`;
        } },
      { label: "ω_AC", units: "rad/s",
        value: (s, pp) => (2 * Math.PI * pp.f_drive).toFixed(2) },
      { label: "ω_syn", units: "rad/s",
        value: (s, pp) => {
          const p = clampInt(pp.p, P_MIN, P_MAX);
          return ((s.swap ? -1 : +1) * 2 * Math.PI * pp.f_drive / p).toFixed(2);
        } },
      { label: "ω rotor", units: "rad/s",
        value: (s) => (s.omega_r || 0).toFixed(3) },
      { label: "slip s",
        value: (s, pp) => {
          const p = clampInt(pp.p, P_MIN, P_MAX);
          const wsyn = (s.swap ? -1 : +1) * 2 * Math.PI * pp.f_drive / p;
          if (Math.abs(wsyn) < 1e-9) return "—";
          return ((wsyn - s.omega_r) / wsyn).toFixed(3);
        } },
      { label: "θ rotor", units: "°",
        value: (s) => (s.theta_r * 180 / Math.PI).toFixed(1) },
      { label: "τ rotor", units: "N·m",
        value: (s) => (s.lastTau || 0).toExponential(3) },
      { label: "max |i_loop|", units: "A",
        value: (s) => {
          let mx = 0;
          for (let n = 0; n < M_LOOPS; n++) {
            const a = Math.abs(s[`i_r_${n}`] || 0);
            if (a > mx) mx = a;
          }
          return mx.toExponential(3);
        } },
    ],

    physics: {
      dof: (() => {
        const arr = ["theta_r", "omega_r"];
        for (let n = 0; n < M_LOOPS; n++) arr.push(`i_r_${n}`);
        return arr;
      })(),
      dxdt, preStep, postStep,
      integrator: "rk4",
    },

    layout: (W, H) => LIB.Layout.world2D(W, H, {
      worldW: 2.7, worldH: 2.7, padPx: 30,
    }),

    render,
    onPointer,

    dragControls: [
      { label: "Rotor", desc: "drag in a circle to spin the cage" },
    ],

    headerButtons: [
      swapBtn,
      kickBtn,
      toggleBtn("showField", "Field: ON", "Field: OFF"),
      toggleBtn("showPoles", "N/S poles: ON", "N/S poles: OFF"),
      toggleBtn("showWires", "Wires: ON", "Wires: OFF"),
    ],

    icon: (ctx, W, H) => {
      const cx = W / 2, cy = H / 2;
      const S  = Math.min(W, H);
      // Stator bore.
      ctx.strokeStyle = "rgba(180,200,220,0.5)";
      ctx.lineWidth = Math.max(1.5, S * 0.02);
      ctx.beginPath();
      ctx.arc(cx, cy, S * 0.40, 0, Math.PI * 2);
      ctx.stroke();
      // Two pole-pairs worth of N/S dots.
      const colors = ["#ef5350", "#4ea1ff", "#ef5350", "#4ea1ff"];
      for (let k = 0; k < 4; k++) {
        const a = (Math.PI / 2) * k;
        ctx.fillStyle = colors[k];
        ctx.beginPath();
        ctx.arc(cx + Math.cos(a) * S * 0.32,
                cy - Math.sin(a) * S * 0.32,
                S * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
      // Cage rotor dots.
      ctx.fillStyle = "#ffd54a";
      const Nicon = 10;
      for (let k = 0; k < Nicon; k++) {
        const a = (k / Nicon) * 2 * Math.PI;
        const x = cx + Math.cos(a) * S * 0.18;
        const y = cy - Math.sin(a) * S * 0.18;
        ctx.beginPath();
        ctx.arc(x, y, S * 0.022, 0, Math.PI * 2);
        ctx.fill();
      }
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).polePairs = SPEC;
})();
