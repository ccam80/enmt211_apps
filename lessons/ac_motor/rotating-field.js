"use strict";

// =============================================================================
//  Rotating field — three windings driven by three phases sum to a rotating B.
//
//  Pure kinematic visualisation. No coupled-circuit ODE — the three winding
//  currents are written analytically as i_k(t) = I_max·cos(ωt - 2π·k/3), each
//  contributes a field along its own dipole axis, and the vector sum is drawn
//  alongside. With balanced 120°-phased excitation the sum has constant
//  magnitude (3/2)·B_max and angular position ωt — the textbook "rotating
//  magnetic field" result, eq. (26) of the notes.
//
//  No rotor. The lesson immediately after this one (three-phase-rotor) drops
//  a closed loop into the same cavity and watches it accelerate; this one
//  isolates the field-construction step from any mechanical dynamics.
// =============================================================================

(function () {

  const PHYS_HZ  = 240;
  const HIST_HZ  = 60;
  const TRAIL_HZ = 60;
  const TRAIL_S  = 4.0;        // seconds of resultant-tip trail kept

  const I_MAX   = 1.0;         // per-winding peak current (arbitrary units)
  const B_PER_I = 1.0;         // per-winding field-per-current (arbitrary)
  const R_TIP   = 0.6;         // world-unit scale: resultant tip at |i|=1 sits
                               //   here, so |B|=3/2 lands well inside the cavity
  const R_CAVITY = 1.05;       // cavity outline radius (world units)
  const R_WIRE   = 0.95;       // winding-bundle dots on the cavity wall

  // Winding colours match the supply-phase plot.
  const WCOL = ["#ef5350", "#66bb6a", "#4ea1ff"];
  const WLBL = ["a", "b", "c"];

  // Winding indexing, per-winding signals, and the b↔c swap convention all
  // live in LIB.ThreePhase. This file uses i_k(φ) = I_max·cos(φ − 2π·k/3) as
  // the per-winding current and u_k = (cos(2π·k/3), sin(2π·k/3)) as the
  // dipole axis in the cavity end-view.

  function resultantField(phi, swap) {
    let Bx = 0, By = 0;
    for (let k = 0; k < 3; k++) {
      const u  = LIB.ThreePhase.axis2D(k);
      const ik = LIB.ThreePhase.signal(k, phi, swap, I_MAX);
      Bx += B_PER_I * ik * u.x;
      By += B_PER_I * ik * u.y;
    }
    return { x: Bx, y: By };
  }

  // ---------------------------------------------------------------------------
  //  rendering
  // ---------------------------------------------------------------------------

  function drawCavity(ctx, layout) {
    const c = layout.toPx({ x: 0, y: 0 });
    const r = layout.scale * R_CAVITY;
    ctx.save();
    ctx.strokeStyle = "rgba(180,200,220,0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawAxisLine(ctx, layout, u, color) {
    const p1 = layout.toPx({ x:  u.x * R_CAVITY, y:  u.y * R_CAVITY });
    const p2 = layout.toPx({ x: -u.x * R_CAVITY, y: -u.y * R_CAVITY });
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(p1.px, p1.py);
    ctx.lineTo(p2.px, p2.py);
    ctx.stroke();
    ctx.restore();
  }

  function drawWireSymbol(ctx, px, py, size, sign, color) {
    ctx.save();
    ctx.fillStyle = "#0e1116";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (sign === 0) { ctx.restore(); return; }
    if (sign < 0) {
      // Current INTO page: ×.
      ctx.beginPath();
      ctx.moveTo(px - size * 0.55, py - size * 0.55);
      ctx.lineTo(px + size * 0.55, py + size * 0.55);
      ctx.moveTo(px + size * 0.55, py - size * 0.55);
      ctx.lineTo(px - size * 0.55, py + size * 0.55);
      ctx.stroke();
    } else {
      // Current OUT of page: filled dot.
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, size * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // The two wire bundles of winding k sit on the cavity wall on the line
  // perpendicular to the dipole axis — that's the geometry of a coil whose
  // axis is u. With current i_k > 0, the right-hand rule fixes which bundle
  // carries current OUT of the page and which carries it IN.
  function drawWindingPair(ctx, layout, k, ik) {
    const u    = LIB.ThreePhase.axis2D(k);
    const perp = { x: -u.y, y: u.x };
    const p1   = layout.toPx({ x:  perp.x * R_WIRE, y:  perp.y * R_WIRE });
    const p2   = layout.toPx({ x: -perp.x * R_WIRE, y: -perp.y * R_WIRE });
    const SIZE = Math.max(7, layout.scale * 0.055);
    const sgn  = ik > 1e-6 ? +1 : ik < -1e-6 ? -1 : 0;
    drawWireSymbol(ctx, p1.px, p1.py, SIZE,  sgn, WCOL[k]);
    drawWireSymbol(ctx, p2.px, p2.py, SIZE, -sgn, WCOL[k]);

    // Phase label outboard of one bundle.
    ctx.save();
    ctx.fillStyle = WCOL[k];
    ctx.font = `bold ${Math.max(11, SIZE * 1.4)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lab = layout.toPx({ x: perp.x * (R_WIRE + 0.12),
                              y: perp.y * (R_WIRE + 0.12) });
    ctx.fillText(WLBL[k], lab.px, lab.py);
    ctx.restore();
  }

  function drawPerWindingContribs(ctx, layout, state) {
    const o = layout.toPx({ x: 0, y: 0 });
    for (let k = 0; k < 3; k++) {
      const u  = LIB.ThreePhase.axis2D(k);
      const ik = state.lastI[k];
      const tipW = { x: u.x * ik * R_TIP, y: u.y * ik * R_TIP };
      const tip  = layout.toPx(tipW);
      if (Math.hypot(tip.px - o.px, tip.py - o.py) < 6) continue;
      LIB.Draw.arrow(ctx, o.px, o.py, tip.px, tip.py, {
        color: WCOL[k] + "cc",
        width: 2.2, head: 10,
      });
    }
  }

  function drawTrail(ctx, layout, trail) {
    if (trail.length < 2) return;
    ctx.save();
    ctx.strokeStyle = "rgba(255,213,74,0.5)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < trail.length; i++) {
      const sp = layout.toPx({ x: trail[i].x * R_TIP, y: trail[i].y * R_TIP });
      if (i === 0) ctx.moveTo(sp.px, sp.py);
      else         ctx.lineTo(sp.px, sp.py);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawResultant(ctx, layout, Bx, By) {
    const o   = layout.toPx({ x: 0, y: 0 });
    const tip = layout.toPx({ x: Bx * R_TIP, y: By * R_TIP });
    if (Math.hypot(tip.px - o.px, tip.py - o.py) < 4) return;
    LIB.Draw.arrow(ctx, o.px, o.py, tip.px, tip.py, {
      color: "rgba(0,0,0,0.55)", width: 8, head: 18,
    });
    LIB.Draw.arrow(ctx, o.px, o.py, tip.px, tip.py, {
      color: "#ffd54a", width: 4, head: 14, label: "B",
    });
  }

  // ---------------------------------------------------------------------------
  //  physics — pure kinematics. No DOF, just cache values for plots/readouts.
  // ---------------------------------------------------------------------------

  function step(state, p, dt) {
    // Integrate phase instead of computing ωt directly. Keeps φ continuous
    // when the f slider is dragged — otherwise lowering f mid-stream
    // teleports ωt and the trail polyline draws chords across the circle.
    const omega = 2 * Math.PI * p.f_drive;
    state.phi += omega * dt;
    // Wrap to keep phi finite across long sessions; cos(φ) is 2π-periodic
    // so this is exact, and the trail's continuity is preserved because we
    // wrap *between* sample writes (no segment ever straddles the wrap).
    if (state.phi >  Math.PI * 4) state.phi -= Math.PI * 2;
    if (state.phi < -Math.PI * 4) state.phi += Math.PI * 2;
    const phi = state.phi;
    state.lastI[0] = LIB.ThreePhase.signal(0, phi, state.swap, I_MAX);
    state.lastI[1] = LIB.ThreePhase.signal(1, phi, state.swap, I_MAX);
    state.lastI[2] = LIB.ThreePhase.signal(2, phi, state.swap, I_MAX);
    const B = resultantField(phi, state.swap);
    state.lastBx = B.x;
    state.lastBy = B.y;

    if (state.showTrail) {
      const t = state.t;
      if (!state.lastTrailT || (t - state.lastTrailT) >= 1 / TRAIL_HZ) {
        state.trail.push({ x: B.x, y: B.y, t });
        state.lastTrailT = t;
        const cutoff = t - TRAIL_S;
        while (state.trail.length && state.trail[0].t < cutoff) state.trail.shift();
      }
    } else if (state.trail.length) {
      state.trail.length = 0;
    }
  }

  // ---------------------------------------------------------------------------
  //  header buttons
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  //  spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "ac-rotating-field",
    title: "Rotating field",
    subtitle: "vector sum of three 120°-phased windings",

    state: () => ({
      t: 0,
      phi: 0,                     // integrated drive phase (rad)
      swap: false,
      showPerWinding: true,
      showTrail:      true,
      showAxes:       true,
      trail: [],
      lastTrailT: 0,
      lastI:  [0, 0, 0],
      lastBx: 0, lastBy: 0,
    }),

    onReset: (s) => {
      s.phi = 0;
      s.trail.length = 0;
      s.lastTrailT = 0;
    },

    sliders: {
      Drive: [
        { key: "f_drive", label: "f", min: 0.0, max: 2.0, step: 0.005, value: 0.4,
          tip: "Supply frequency (Hz). Real mains is 50 Hz — slowed here so each cycle plays out over a couple of seconds. Drop to zero to freeze the field and step ωt manually with the slider." },
      ],
    },

    plots: [
      { title: "i_a, i_b, i_c (A)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -1.1, hi: 1.1 }, yChunk: 1.0,
        series: [
          { label: "i_a", color: WCOL[0], lw: 1.8,
            source: (s) => s.lastI[0] || 0 },
          { label: "i_b", color: WCOL[1], lw: 1.8,
            source: (s) => s.lastI[1] || 0 },
          { label: "i_c", color: WCOL[2], lw: 1.8,
            source: (s) => s.lastI[2] || 0 },
        ] },
    ],

    readouts: [
      { label: "φ", units: "rad",
        value: (s) => {
          let phi = s.phi || 0;
          phi -= 2 * Math.PI * Math.floor(phi / (2 * Math.PI));
          return phi.toFixed(2);
        } },
      { label: "|B|",
        value: (s) => Math.hypot(s.lastBx, s.lastBy).toFixed(3) },
      { label: "∠B", units: "°",
        value: (s) => (Math.atan2(s.lastBy, s.lastBx) * 180 / Math.PI).toFixed(1) },
      { label: "i_a", value: (s) => (s.lastI[0] || 0).toFixed(3) },
      { label: "i_b", value: (s) => (s.lastI[1] || 0).toFixed(3) },
      { label: "i_c", value: (s) => (s.lastI[2] || 0).toFixed(3) },
    ],

    physics: { step },

    layout: (W, H) => LIB.Layout.world2D(W, H, {
      worldW: 2.6, worldH: 2.6, padPx: 30,
    }),

    render: (ctx, layout, state, p) => {
      drawCavity(ctx, layout);

      if (state.showAxes) {
        for (let k = 0; k < 3; k++) {
          drawAxisLine(ctx, layout, LIB.ThreePhase.axis2D(k), WCOL[k] + "55");
        }
      }

      for (let k = 0; k < 3; k++) {
        drawWindingPair(ctx, layout, k, state.lastI[k]);
      }

      if (state.showPerWinding) drawPerWindingContribs(ctx, layout, state);
      if (state.showTrail)      drawTrail(ctx, layout, state.trail);

      drawResultant(ctx, layout, state.lastBx, state.lastBy);
    },

    headerButtons: [
      swapBtn,
      toggleBtn("showPerWinding", "Per-winding: ON", "Per-winding: OFF"),
      toggleBtn("showTrail",      "Trail: ON",       "Trail: OFF"),
      toggleBtn("showAxes",       "Axes: ON",        "Axes: OFF"),
    ],

    icon: (ctx, W, H) => {
      const cx = W / 2, cy = H / 2;
      const S  = Math.min(W, H);
      ctx.strokeStyle = "rgba(180,200,220,0.5)";
      ctx.lineWidth = Math.max(1.5, S * 0.02);
      ctx.beginPath();
      ctx.arc(cx, cy, S * 0.36, 0, Math.PI * 2);
      ctx.stroke();
      const colors = ["#ef5350", "#66bb6a", "#4ea1ff"];
      for (let k = 0; k < 3; k++) {
        const a = (2 * Math.PI / 3) * k;
        const ux = Math.cos(a), uy = Math.sin(a);
        ctx.strokeStyle = colors[k];
        ctx.lineWidth = Math.max(2, S * 0.022);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + ux * S * 0.28, cy + uy * S * 0.28);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffd54a";
      ctx.strokeStyle = "#ffd54a";
      ctx.lineWidth = Math.max(2, S * 0.026);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + S * 0.22, cy - S * 0.12);
      ctx.stroke();
    },

    physHz: PHYS_HZ,
    histRateHz: HIST_HZ,
  };

  (window.AcMotorLessons = window.AcMotorLessons || {}).rotatingField = SPEC;
})();
