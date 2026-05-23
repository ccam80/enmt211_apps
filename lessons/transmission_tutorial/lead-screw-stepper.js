"use strict";

// =============================================================================
//  Tutorial 2 / Q2 — lead-screw stepper.
//
//  A stepper drives a lead screw; the carriage translates. No PID, no
//  velocity caps — the lesson is about kinematic resolution, holding torque
//  against gravity, reflected inertia, and ways to increase peak
//  acceleration.
//
//  Drive — fixed-shape critically-damped motor PD whose gains auto-tune
//  from the live effective rotor inertia (so step size is repeatable across
//  slider regimes). "+ Step" / "− Step" bump θ_cmd by the live step slider.
//  The "Advance by" expression input bumps θ_cmd by an arbitrary radian
//  expression (accepts pi/π).
//
//  η — included asymmetrically as the textbook approximation: motor
//  reaction torque from the screw-nut coupling is scaled by 1/η. Gives
//  τ_hold = m·g·r/η in vertical orientation (Q2b).
//
//  Display scale — both modes use a vertical/horizontal linearTrack whose
//  ±xLimit is sized to exactly three rotations of the screw (xLim = 1.5 ·
//  pitch · starts), so the rendered shaft always shows three turns, the
//  visual pitch always equals the physical pitch (no clamp), and the load
//  travel is bounded to 3 turns of useful range. The vertical mode is a
//  full vertical linear-track layout (like the helicopter lesson) — all
//  text stays horizontal, the screw is drawn as a vertical strip, and
//  gravity points down on the canvas naturally.
// =============================================================================

(function () {

  const LIN_DRAG_LOAD    = 1.5;
  const LIN_DRAG_MOTOR   = 0.005;
  const END_K_BUMP       = 5000;
  const END_C_BUMP       = 50;
  const K_LOAD_DRAG      = 5.0e3;
  const C_LOAD_DRAG      = 800;
  const K_SHAFT_DRAG     = 500;
  const C_SHAFT_DRAG     = 10;
  const SHAFT_RAD_PER_PX = 0.03;

  const screwCoupling = LIB.ScrewPhysics.coupling();

  // Display ±xLimit is sized so exactly 3 screw rotations span the visible
  // track (lead = pitch · starts, so 3 turns = 3 · lead, half-window = 1.5 ·
  // lead). Travel is end-stopped at the same window so the load can't leave
  // the visible region.
  function xLimitOf(p) {
    const lead = (+p.pitch || 0) * (+p.starts || 1);
    return Math.max(0.001, 1.5 * lead);
  }

  function reff(p)        { return LIB.ScrewPhysics.reff(p.pitch, p.starts); }
  function jScrew(p)      { return 0.5 * (+p.mScrew || 0) * (+p.rScrew || 0) * (+p.rScrew || 0); }
  function jRotor(p)      { return (+p.Jmotor || 0) + jScrew(p); }
  function effectiveJ(p)  {
    return LIB.ScrewPhysics.effectiveJ({
      Jmotor: +p.Jmotor || 0, Jscrew: jScrew(p),
      m: +p.mAssembly, r: reff(p), eta: +p.eta,
    });
  }
  function holdingTorque(p) {
    return LIB.ScrewPhysics.holdingTorque(+p.mAssembly, reff(p), +p.eta,
                                          p.mode === "vertical");
  }

  // Sinusoidal-holding-torque stepper. The rotor only sees torque from the
  // currently energised "step" — there's no PD loop, no auto-tuned servo,
  // no infinite stiffness. Pull-out torque is at err = 1·step, and the
  // rotor must stay within the pull-out window to keep step (a real lost-
  // step regime is reachable by spinning ω_target too fast).
  const stepperDrive = LIB.StepperDrive.create({
    cmdField: "thetaCmd", posField: "theta", velField: "omega",
    damping: 0.7,
    J: (s, p) => Math.max(1e-9, jRotor(p)),
    deltaParam: "stepAngleDeg",
    deltaTransform: LIB.StepperDrive.DEG2RAD,
    electricalCycleSteps: 4,
  });

  // Latest params seen by the renderer / preStep — used by the "Advance by"
  // expression input so it can snap to integer steps using the live
  // step-angle slider value.
  let cachedParams = null;

  const SHAFT_HALF_HPX = 24;
  const MOTOR_R        = 28;

  // ---------------------------------------------------------------------------
  //  Layout — function form so we can switch between horizontal and a real
  //  vertical linearTrack (axis: "vertical") on mode change. Horizontal mode
  //  reserves marginLeftPx for the motor disc by hand because function-form
  //  layouts bypass the shell's auto-margin.
  // ---------------------------------------------------------------------------

  function buildLayout(W, H, state, params) {
    const xLim = xLimitOf(params);
    if (params.mode === "vertical") {
      return LIB.Layout.linearTrack(W, H, {
        axis: "vertical", xMin: -xLim, xMax: xLim,
        padY: 60, trackFrac: 0.45,
      });
    }
    const motorMargin = 2 * MOTOR_R + 16;
    const L = LIB.Layout.linearTrack(W, H, {
      xMin: -xLim, xMax: xLim, marginLeftPx: motorMargin,
    });
    const wrap = Object.assign({}, L);
    wrap.motorCx = L.padLeft - MOTOR_R - 8;
    wrap.motorCy = L.trackY;
    wrap.motorR  = MOTOR_R;
    return wrap;
  }

  function shaftCenterY(L) { return L.trackY - 40; }

  // Synthetic horizontal sub-layout for the screw axis when the page is in
  // vertical mode. The screw thread renderer is horizontal-only; we draw it
  // into this sub-layout, then rotate the canvas frame so it appears as a
  // vertical strip. mToPx is preserved so visual pitch = physical pitch.
  function verticalScrewSubLayout(L) {
    const yTop    = L.xToPx(L.xMax);
    const yBot    = L.xToPx(L.xMin);
    const usableY = Math.max(2, yBot - yTop);
    return {
      Lh: LIB.Layout.linearTrack(usableY, 200, {
        xMin: L.xMin, xMax: L.xMax,
        padX: 0, padY: 0, trackFrac: 0.5,
      }),
      yTop, yBot,
    };
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag — load + shaft, separate kinds for horizontal / vertical
  //  so the dragMux can route a click on the right axis.
  //
  //  HORIZONTAL: load slides along mx, shaft drag is a vertical pointer drag
  //              (vbar) where Δmy → Δθ.
  //  VERTICAL:   load slides along my (vbar with anchor), shaft drag is a
  //              horizontal pointer drag where Δmx → Δθ. We re-use vbar for
  //              the shaft drag and read mx out of the worldY callback's 5th
  //              arg so we get anchor support without writing a new helper.
  // ---------------------------------------------------------------------------

  function loadHitH(state, params, L, mx, my) {
    if (params.mode === "vertical") return false;
    return Math.abs(mx - L.xToPx(state.x)) < 65
        && Math.abs(my - shaftCenterY(L))  < 50;
  }
  function shaftHitH(state, params, L, mx, my) {
    if (params.mode === "vertical") return false;
    const x0 = L.xToPx(L.xMin) - 4;
    const x1 = L.xToPx(L.xMax) + 4;
    return mx >= x0 && mx <= x1
        && Math.abs(my - shaftCenterY(L)) < SHAFT_HALF_HPX + 4;
  }
  function loadHitV(state, params, L, mx, my) {
    if (params.mode !== "vertical") return false;
    return Math.abs(my - L.xToPx(state.x)) < 65
        && Math.abs(mx - L.trackX)         < 50;
  }
  function shaftHitV(state, params, L, mx, my) {
    if (params.mode !== "vertical") return false;
    const yTop = L.xToPx(L.xMax) - 4;
    const yBot = L.xToPx(L.xMin) + 4;
    return my >= yTop && my <= yBot
        && Math.abs(mx - L.trackX) < SHAFT_HALF_HPX + 4;
  }

  const loadDraggerH = LIB.Drag.hbar({
    kind: "load-h", hitTest: loadHitH,
    worldX: (mx, L) => L.pxToX(mx),
    bounds: (s, p) => { const x = xLimitOf(p); return { min: -x, max: x }; },
    onSeedV: (state) => state.v, windowSec: 0.02,
  });
  const shaftDraggerH = LIB.Drag.vbar({
    kind: "shaft-h", hitTest: shaftHitH,
    onStart: (state, mx, my) => ({
      value: state.theta,
      anchor: { my0: my, theta0: state.theta },
    }),
    worldY: (my, layout, state, params, mx, anchor) =>
      anchor.theta0 - (my - anchor.my0) * SHAFT_RAD_PER_PX,
    onSeedV: (state) => state.omega, windowSec: 0.02,
  });

  const loadDraggerV = LIB.Drag.vbar({
    kind: "load-v", hitTest: loadHitV,
    onStart: (state, mx, my) => ({
      value: state.x,
      anchor: { my0: my, x0: state.x },
    }),
    worldY: (my, L, state, params, mx, anchor) => L.pxToX(my),
    bounds: (s, p) => { const x = xLimitOf(p); return { min: -x, max: x }; },
    onSeedV: (state) => state.v, windowSec: 0.02,
  });
  // Vertical shaft drag — mx (not my) drives the angular delta. vbar's
  // worldY callback also receives mx, so we can ignore my and use mx for
  // the relative-to-grab mapping. Same SHAFT_RAD_PER_PX pixel→rad scale as
  // the horizontal-mode shaft drag, just along the orthogonal axis.
  const shaftDraggerV = LIB.Drag.vbar({
    kind: "shaft-v", hitTest: shaftHitV,
    onStart: (state, mx, my) => ({
      value: state.theta,
      anchor: { mx0: mx, theta0: state.theta },
    }),
    worldY: (my, layout, state, params, mx, anchor) =>
      anchor.theta0 + (mx - anchor.mx0) * SHAFT_RAD_PER_PX,
    onSeedV: (state) => state.omega, windowSec: 0.02,
  });

  const dragMux = LIB.Drag.mux([
    loadDraggerH, shaftDraggerH, loadDraggerV, shaftDraggerV,
  ]);

  function loadDragSpring(state) {
    return loadDraggerH.spring1D(state, state.x, state.v, K_LOAD_DRAG, C_LOAD_DRAG)
         + loadDraggerV.spring1D(state, state.x, state.v, K_LOAD_DRAG, C_LOAD_DRAG);
  }
  function shaftDragSpring(state) {
    return shaftDraggerH.spring1D(state, state.theta, state.omega, K_SHAFT_DRAG, C_SHAFT_DRAG)
         + shaftDraggerV.spring1D(state, state.theta, state.omega, K_SHAFT_DRAG, C_SHAFT_DRAG);
  }
  function loadDragActive(state) {
    return loadDraggerH.isActive(state) || loadDraggerV.isActive(state);
  }
  function shaftDragActive(state) {
    return shaftDraggerH.isActive(state) || shaftDraggerV.isActive(state);
  }

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

  function endStopForce(state, p) {
    const xLim = xLimitOf(p);
    return LIB.EndStop.force(state.x, state.v, -xLim, xLim,
                             END_K_BUMP, END_C_BUMP);
  }
  function motorTorque(state, p) {
    return stepperDrive.torque(state, p, {
      driveOn: !!state.driveOn, tauMax: +p.Tmax,
    });
  }
  function couplingForce(state, p) {
    const r     = reff(p);
    const lashH = (+p.lash || 0) / 2;
    return screwCoupling.force(state.x, state.v, state.theta, state.omega,
                                r, lashH);
  }

  function dxdt(state, p, t) {
    const r       = reff(p);
    const m       = Math.max(1e-9, +p.mAssembly);
    const J       = Math.max(1e-9, jRotor(p));
    const eta     = (+p.eta > 0) ? +p.eta : 1;

    const F_couple = couplingForce(state, p);
    const F_grav   = LIB.ScrewPhysics.gravityForce(+p.mAssembly,
                                                   p.mode === "vertical");
    const F_drag   = loadDragSpring(state);
    const tauShaft = shaftDragSpring(state);
    const F_end    = endStopForce(state, p);
    const tau      = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + F_end + F_couple + F_grav + F_drag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * F_couple / eta + tauShaft) / J,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r       = reff(p);
    const m       = Math.max(1e-9, +p.mAssembly);
    const J       = Math.max(1e-9, jRotor(p));
    const eta     = (+p.eta > 0) ? +p.eta : 1;
    const xLim    = xLimitOf(p);

    let Kc = screwCoupling.K, Cc = screwCoupling.C;
    const lashH = (+p.lash || 0) / 2;
    if (lashH > 1e-9) {
      const psi = state.x - state.theta * r;
      const inLashWin = (psi <= lashH) && (psi >= -lashH);
      if (inLashWin) { Kc = 0; Cc = 0; }
      else           { Kc = screwCoupling.K_LASH; Cc = screwCoupling.C_LASH; }
    }

    const Kld = loadDragActive(state)  ? K_LOAD_DRAG  : 0;
    const Cld = loadDragActive(state)  ? C_LOAD_DRAG  : 0;
    const Ksh = shaftDragActive(state) ? K_SHAFT_DRAG : 0;
    const Csh = shaftDragActive(state) ? C_SHAFT_DRAG : 0;

    let Kbx = 0, Cbv = 0;
    if (state.x < -xLim) { Kbx = -END_K_BUMP; if (state.v < 0) Cbv = -END_C_BUMP; }
    else if (state.x > +xLim) { Kbx = -END_K_BUMP; if (state.v > 0) Cbv = -END_C_BUMP; }

    const stepPart = stepperDrive.partials(state, p, {
      driveOn: !!state.driveOn, tauMax: +p.Tmax,
    });
    const dTau_dpos = stepPart ? stepPart.dTau_dpos : 0;
    const dTau_dvel = stepPart ? stepPart.dTau_dvel : 0;

    M[0*n+0] = 0;             M[0*n+1] = 1;                                    M[0*n+2] = 0;             M[0*n+3] = 0;
    M[1*n+0] = (Kbx - Kc - Kld) / m;
    M[1*n+1] = (-LIN_DRAG_LOAD + Cbv - Cc - Cld) / m;
    M[1*n+2] = (Kc * r) / m;
    M[1*n+3] = (Cc * r) / m;
    M[2*n+0] = 0;             M[2*n+1] = 0;                                    M[2*n+2] = 0;             M[2*n+3] = 1;
    M[3*n+0] = (r * Kc / eta) / J;
    M[3*n+1] = (r * Cc / eta) / J;
    M[3*n+2] = (dTau_dpos + (-r * r * Kc / eta) - Ksh) / J;
    M[3*n+3] = (dTau_dvel - LIN_DRAG_MOTOR + (-r * r * Cc / eta) - Csh) / J;
    return M;
  }

  function preStep(state, p, dt) {
    cachedParams = p;
    dragMux.preStep(state, dt);
    // Continuous-rotation: pulse θ_cmd at ω_target rad/s in discrete step
    // increments. The rotor follows through the sinusoidal holding torque,
    // visibly stepping at low rates and smoothing at high rates.
    stepperDrive.advanceContinuous(state, p, dt, {
      driveOn: !!state.driveOn,
      targetRate: +p.wTarget || 0,
    });
    state.lastTau = motorTorque(state, p);
  }

  // ---------------------------------------------------------------------------
  //  Render
  // ---------------------------------------------------------------------------

  function drawHorizontalScene(ctx, L, state, p) {
    const yMid = shaftCenterY(L);
    const nut  = LIB.ScrewRender.drawLeadNut(ctx, L, p, state,
                                             { yMid, shaftHpx: SHAFT_HALF_HPX * 2 });

    const wAccent = "#66bb6a";
    const trap = LIB.Draw.trapezoidWeight(ctx, nut.nutCx, nut.weightCyTop,
                                          p.mAssembly, { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, nut.nutCx, trap.topY, effectiveJ(p),
                                { color: wAccent });
  }

  function drawGravityIndicator(ctx, L) {
    const x = L.W - 36, y = 28;
    LIB.Draw.arrow(ctx, x, y, x, y + 60,
      { color: "#ef5350", width: 2.5, head: 11, label: "g", fontSize: 16 });
    ctx.fillStyle = "#ef5350";
    ctx.font = "600 13px ui-sans-serif";
    ctx.textAlign = "right"; ctx.textBaseline = "top";
    ctx.fillText("vertical", x - 8, y);
  }

  function drawVerticalScene(ctx, L, state, p) {
    const sub  = verticalScrewSubLayout(L);
    const Lh   = sub.Lh;
    const yMid = Lh.trackY - 40;

    // Rotate the canvas so the synthetic horizontal sub-layout appears as a
    // vertical strip on the page. Rotated +x → canvas −y (up); rotated +y →
    // canvas +x (right). After this transform we draw the screw normally.
    ctx.save();
    ctx.translate(L.trackX, sub.yBot);
    ctx.rotate(-Math.PI / 2);
    ctx.translate(0, -yMid);
    LIB.ScrewRender.drawLeadNut(ctx, Lh, p, state,
                                { yMid, shaftHpx: SHAFT_HALF_HPX * 2 });
    ctx.restore();

    // Chrome in canvas-natural orientation (text horizontal).
    const loadY  = L.xToPx(state.x);
    const wAccent = "#66bb6a";
    const trapCx = L.trackX + 100;
    const trapCyTop = loadY - 40;

    // Connection rod from nut to weight.
    ctx.strokeStyle = "#5a6275"; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L.trackX, loadY);
    ctx.lineTo(trapCx, loadY);
    ctx.stroke();

    const trap = LIB.Draw.trapezoidWeight(ctx, trapCx, trapCyTop,
                                          p.mAssembly, { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, trapCx, trap.topY, effectiveJ(p),
                                { color: wAccent });

    // Motor disc at the top of the shaft (the shell's motor painter is
    // disabled in vertical mode, so we draw it here).
    const motorY = sub.yTop - MOTOR_R - 4;
    LIB.Draw.motor(ctx, L.trackX, motorY, MOTOR_R,
      { theta: state.theta, label: "motor" });

    drawGravityIndicator(ctx, L);
  }

  function drawScene(ctx, L, state, p) {
    if (p.mode === "vertical") drawVerticalScene(ctx, L, state, p);
    else                       drawHorizontalScene(ctx, L, state, p);
  }

  // ---------------------------------------------------------------------------
  //  Sliders / plots / readouts
  // ---------------------------------------------------------------------------

  function buildSliders() {
    return {
      Drive: [
        { key: "Tmax", label: "τ_max", min: 0.001, max: 5, step: 0.001,
          value: 0.5, log: true,
          tip: "Pull-out torque (N·m). Peak of the sinusoidal holding-torque curve, reached when the rotor is exactly one step from θ_cmd. Holding the rotor against gravity (vertical mode) demands τ_max ≥ m·g·r/η." },
        { key: "stepAngleDeg", label: "step (°)", min: 0.1, max: 30, step: 0.1,
          value: 4.5,
          tip: "Step size per click of + Step / − Step. Carriage moves lead·step/360 per click." },
        { key: "wTarget", label: "ω_tgt", min: 0, max: 200, step: 0.1,
          value: 0,
          tip: "Continuous step rate (rad/s). When Drive is ON the driver emits step pulses at this rate; the rotor visibly steps at low rates and smooths at high rates. Push too high and the rotor falls outside the pull-out window and stalls (lost-step)." },
        { key: "advanceDeg", kind: "expr",
          label: "Advance by (°)", value: "360",
          button: "Advance",
          placeholder: "e.g. 90 or 360",
          tip: "Type any expression in degrees. Click Advance to bump θ_cmd; the value is snapped to the nearest integer step (real stepper drivers can only command discrete equilibria).",
          onSubmit: (deg, state) => {
            stepperDrive.advance(state, ((+deg) || 0) * Math.PI / 180,
                                 cachedParams);
          } },
      ],
      Mechanism: [
        { key: "pitch", label: "pitch (m)", min: 0.001, max: 0.05, step: 0.0005,
          value: 0.008, log: true,
          tip: "Distance the nut travels per revolution per start (m). Q2 uses 0.008 m. The visible track is sized to exactly 3 turns." },
        { key: "starts", label: "starts", min: 1, max: 6, step: 1, value: 1,
          tip: "Number of helical starts. Lead = pitch · starts." },
        { key: "eta", label: "η", min: 0.05, max: 1, step: 0.01, value: 0.15,
          tip: "Lead-screw efficiency. Holding torque scales as 1/η." },
        { key: "mAssembly", label: "m_assembly", min: 0.01, max: 5, step: 0.001,
          value: 0.122, log: true,
          tip: "Translating assembly mass (kg). Q2 uses 0.122 kg." },
        { key: "mScrew", label: "m_screw", min: 0.01, max: 5, step: 0.001,
          value: 0.243, log: true,
          tip: "Screw shaft mass (kg). Drives J_screw = ½·m_screw·r_screw²." },
        { key: "rScrew", label: "r_screw", min: 0.001, max: 0.05, step: 0.0005,
          value: 0.010, log: true,
          tip: "Screw shaft outer radius (m)." },
        { key: "Jmotor", label: "J_motor", min: 1e-5, max: 0.1, step: 1e-5,
          value: 5.56e-3, log: true,
          tip: "Motor rotor inertia (kg·m²). Q2 uses 5.56·10⁻³." },
        { key: "lash", label: "lash (m)", min: 0, max: 0.005, step: 0.0001,
          value: 0,
          tip: "Axial backlash between screw and nut (m). Default 0 = rigid coupling." },
      ],
    };
  }

  function buildPlots() {
    return [
      { title: "x(t) — carriage position (m)",
        yFmt: (v) => v.toFixed(3),
        yChunk: 0.005,
        series: [
          { label: "x", color: "#4ea1ff", lw: 2.2, source: (s) => s.x },
        ] },
      { title: "θ_motor — actual (blue), commanded (yellow)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -3.14, hi: 3.14 },
        yChunk: 3.14,
        series: [
          { label: "θ_cmd", color: "#f6c945", lw: 1.4, source: (s) => s.thetaCmd || 0 },
          { label: "θ",     color: "#4ea1ff", lw: 2.0, source: (s) => s.theta },
        ] },
      { title: "τ motor (N·m)",
        yFmt: (v) => v.toFixed(3),
        yFloor: { lo: -0.05, hi: 0.05 },
        yChunk: 0.05,
        series: [
          { label: "tau", color: "#4ea1ff", lw: 2.0, source: (s) => s.lastTau || 0 },
        ] },
    ];
  }

  function buildReadouts() {
    return [
      { label: "x", units: "m", value: (s) => s.x.toFixed(4) },
      { label: "θ_motor", units: "rev",
        value: (s) => (s.theta / (2 * Math.PI)).toFixed(2) },
      { label: "θ_cmd",   units: "rev",
        value: (s) => ((s.thetaCmd || 0) / (2 * Math.PI)).toFixed(2) },
      { label: "lead", units: "mm",
        value: (s, p) => (((+p.pitch || 0) * (+p.starts || 0)) * 1000).toFixed(2) },
      { label: "Δx per step", units: "mm",
        value: (s, p) => {
          const lead   = (+p.pitch || 0) * (+p.starts || 0);
          const stepRad = (+p.stepAngleDeg || 0) * Math.PI / 180;
          return ((lead * stepRad / (2 * Math.PI)) * 1000).toFixed(4);
        } },
      { label: "visible travel", units: "mm",
        value: (s, p) => (xLimitOf(p) * 2 * 1000).toFixed(2) },
      { label: "r_eff = lead/(2π)", units: "m",
        value: (s, p) => reff(p).toExponential(3) },
      { label: "J_screw", units: "kg·m²",
        value: (s, p) => jScrew(p).toExponential(3) },
      { label: "J_eff @ motor", units: "kg·m²",
        value: (s, p) => effectiveJ(p).toExponential(3) },
      { label: "τ_hold (Q2b, vertical)", units: "N·m",
        value: (s, p) => {
          const t = holdingTorque(p);
          if (!Number.isFinite(t)) return "∞";
          return p.mode === "vertical" ? t.toExponential(3) : "—";
        } },
      { label: "a_max (Q2d, horizontal)", units: "m/s²",
        value: (s, p) => {
          const r = reff(p);
          const J = effectiveJ(p);
          if (J < 1e-12 || r < 1e-12) return "0";
          const tauMax = +p.Tmax || 0;
          return (tauMax * r / J).toExponential(3);
        } },
      { label: "τ applied", units: "N·m",
        value: (s) => (s.lastTau || 0).toExponential(3) },
      { label: "Match M",
        value: (s, p) => {
          const M = (+p.mAssembly || 0) * reff(p) * reff(p) /
                    Math.max(1e-12, jRotor(p));
          return { text: M.toFixed(3),
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
    ];
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "tut2-lead-screw-stepper",
    title: "Q2 — lead-screw stepper",
    subtitle: "stepper-driven lead screw, with η and orientation",
    description: `<b>Q2 — lead-screw stepper</b> — a real-physics stepper. The driver maintains a discrete commanded equilibrium θ_cmd; the rotor experiences a sinusoidal holding-torque profile τ_max·sin(N·(θ_cmd−θ)) − D·ω, with N matched to a 4-phase electrical cycle and D auto-tuned for ζ ≈ 0.7 against the live rotor inertia. Pull-out torque sits at one full step from equilibrium, and pushing ω_target too fast drives the rotor outside the pull-out window so it stalls (a real lost-step). Each click of <b>+ Step</b> / <b>− Step</b> advances θ_cmd by exactly one step; <b>Advance by (°)</b> snaps to the nearest integer step; <b>ω_tgt</b> with Drive ON advances θ_cmd continuously in step pulses (so at low rates you see the rotor step-and-settle, at high rates it smooths into apparent continuous rotation). The track is sized to exactly three rotations of the screw, so the visual pitch always equals the physical pitch and you can count turns by eye. Watch <i>Δx per step</i> for Q2a. Switch to <i>vertical</i> to expose the holding-torque demand (Q2b: τ<sub>hold</sub> = m·g·r/η). The <i>J_eff @ motor</i> readout shows the textbook formula J_motor + J_screw + m·r²/η (Q2c). Then experiment: changing pitch, starts, η, mass, motor inertia each shift the maximum-acceleration scaling (Q2d).`,

    state: () => ({
      x: 0, v: 0, theta: 0, omega: 0,
      thetaCmd: 0,
      lastTau: 0, drag: null, driveOn: true,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      s.thetaCmd = 0;
    },

    modes: {
      // No persistKey — students should always land on the horizontal
      // orientation when reopening the lesson. Vertical is opt-in for the
      // holding-torque part of the question.
      default: "horizontal",
      list: [
        { id: "horizontal", label: "horizontal" },
        { id: "vertical",   label: "vertical" },
      ],
    },

    sliders:  buildSliders,
    plots:    buildPlots,
    readouts: buildReadouts,

    physics: {
      dof: ["x", "v", "theta", "omega"],
      dxdt, jacobian,
      integrator: "implicitEuler",
      preStep,
    },

    layout: buildLayout,

    // Shell-painted motor only in horizontal mode; the lesson paints its
    // own motor at the top of the shaft in vertical mode.
    motor: (state, params) => params.mode === "vertical" ? null : ({
      place: (L) => ({ cx: L.motorCx, cy: shaftCenterY(L) }),
      r: MOTOR_R,
    }),

    dragControls: [
      { label: "Load",    desc: "drag along the screw axis" },
      { label: "Shaft",   desc: "drag perpendicular to spin" },
      { label: "+ Step",  desc: "advance commanded θ" },
      { label: "Advance", desc: "type pi-aware radian expression" },
    ],

    render: drawScene,

    icon: (ctx, W, H) => {
      const S = Math.min(W, H);
      const accent = LIB.Util.getVar("--accent");
      const ink    = LIB.Util.getVar("--ink");
      const muted  = LIB.Util.getVar("--muted");
      const cI     = LIB.Util.getVar("--cI");
      const cy = H / 2;

      // Stepper motor — square stator with corner pole indicators.
      const motorSize = S * 0.30;
      const motorCx   = W * 0.18;
      ctx.fillStyle = "#2a313c";
      ctx.fillRect(motorCx - motorSize / 2, cy - motorSize / 2, motorSize, motorSize);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.006);
      ctx.strokeRect(motorCx - motorSize / 2, cy - motorSize / 2, motorSize, motorSize);
      // Pole notches at each side mid-edge
      ctx.fillStyle = cI;
      const pn = S * 0.04;
      ctx.fillRect(motorCx - motorSize / 2 - pn / 2, cy - pn / 2, pn, pn);
      ctx.fillRect(motorCx + motorSize / 2 - pn / 2, cy - pn / 2, pn, pn);
      ctx.fillRect(motorCx - pn / 2, cy - motorSize / 2 - pn / 2, pn, pn);
      ctx.fillRect(motorCx - pn / 2, cy + motorSize / 2 - pn / 2, pn, pn);
      // Shaft stub from the motor
      ctx.fillStyle = "#1f242c";
      const stubX0 = motorCx + motorSize / 2;
      const stubX1 = stubX0 + S * 0.05;
      const stubHalfH = S * 0.04;
      ctx.fillRect(stubX0, cy - stubHalfH, stubX1 - stubX0, stubHalfH * 2);
      ctx.strokeStyle = ink + "aa"; ctx.lineWidth = Math.max(1, S * 0.004);
      ctx.strokeRect(stubX0, cy - stubHalfH, stubX1 - stubX0, stubHalfH * 2);

      // Threaded shaft
      const shaftX0 = stubX1;
      const shaftX1 = W * 0.94;
      ctx.fillStyle = "#1f242c";
      ctx.fillRect(shaftX0, cy - stubHalfH, shaftX1 - shaftX0, stubHalfH * 2);
      ctx.strokeRect(shaftX0, cy - stubHalfH, shaftX1 - shaftX0, stubHalfH * 2);
      ctx.strokeStyle = muted;
      const pitch = S * 0.05;
      for (let x = shaftX0 + pitch * 0.5; x < shaftX1 - pitch * 0.2; x += pitch) {
        ctx.beginPath();
        ctx.moveTo(x, cy - stubHalfH);
        ctx.lineTo(x + pitch * 0.5, cy + stubHalfH);
        ctx.stroke();
      }

      // Lead nut + step-tick marks above the shaft to suggest discrete steps.
      const nutCx = W * 0.66;
      const nutW  = S * 0.16, nutH = S * 0.30;
      ctx.fillStyle = accent;
      ctx.fillRect(nutCx - nutW / 2, cy - nutH / 2, nutW, nutH);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.005);
      ctx.strokeRect(nutCx - nutW / 2, cy - nutH / 2, nutW, nutH);

      ctx.strokeStyle = cI;
      ctx.lineWidth = Math.max(1, S * 0.005);
      const tickY0 = cy - nutH * 0.85;
      const tickY1 = cy - nutH * 0.65;
      for (let x = shaftX0 + S * 0.04; x < shaftX1; x += S * 0.04) {
        ctx.beginPath();
        ctx.moveTo(x, tickY0); ctx.lineTo(x, tickY1);
        ctx.stroke();
      }
    },

    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    init: (handle) => { stepperDrive.ensure(handle.state); },

    headerButtons: [
      LIB.HeaderButtons.driveToggle({ labelOn: "Stepper: ON", labelOff: "Stepper: OFF" }),
    ].concat(stepperDrive.buttons()),

    physHz: 240,
  };

  (window.TutorialLessons = window.TutorialLessons || {}).leadScrewStepper = SPEC;
})();
