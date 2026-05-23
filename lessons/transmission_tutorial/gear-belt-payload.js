"use strict";

// =============================================================================
//  Tutorial 2 / Q1 — gear-pair driving a belt-and-pulley payload.
//
//  Layout: G1 (motor pinion) meshes with G2 at radius r_G2. G2 shares a
//  shaft with the drive pulley (r_pulley). A belt loops around the drive
//  pulley and an idler pulley of the same size, with a payload riding on
//  the top run of the belt.
//
//  The kinematic chain collapses to one motor angle and one payload x via
//          r_eff = (r_G1 / r_G2) · r_pulley         (signed positive)
//  The motor side carries J_G1 + (r_G1/r_G2)² · (J_G2 + 2·J_pulley) — both
//  pulleys spin (the idler is 1:1 belt-coupled to the drive pulley) — and
//  the payload reflects through r_eff² with a 1/η inflation as usual.
//
//  Drive — open-loop. Drive ON applies the τ_motor slider value to G1
//  directly so the load accelerates at the Q1d limit until it hits an end-
//  stop. No velocity loop, no tuning. The lesson is about kinematic ratio,
//  efficiency, and reflected inertia.
//
//  Pointer affordances:
//    • Payload  — drag horizontally along the belt span.
//    • G1 rim   — rotate G1 manually; chain propagates back to load.
//    • Drive pulley rim — rotate G2's shaft manually; reflected back to G1
//                         through the gear ratio.
//    • Idler pulley rim — same as drive (the belt is rigid, so the idler
//                         tracks the drive 1:1).
// =============================================================================

(function () {

  const X_LIMIT          = 0.20;     // ±20 cm payload travel for visual room
  const LIN_DRAG_LOAD    = 1.5;
  const LIN_DRAG_MOTOR   = 0.001;
  const END_K_BUMP       = 5000;
  const END_C_BUMP       = 50;
  const K_LOAD_DRAG      = 2.0e5;
  const C_LOAD_DRAG      = 1.0e3;
  const K_GEAR_DRAG      = 50;
  const C_GEAR_DRAG      = 2;
  const K_PULLEY_DRAG    = 200;     // pointer-on-pulley penalty (N·m/rad on G2 shaft)
  const C_PULLEY_DRAG    = 4;       //                          (N·m·s/rad)

  const rigidCoupling = LIB.RigidCoupling.create({ K: 2.0e5, C: 1.0e3 });

  // Helpers — derived per-frame from sliders. ratio is the magnitude of the
  // gear-pair speed ratio (ω_G2/ω_G1 in absolute terms). The signed form lives
  // in LIB.GearPair.speedRatio when needed; the simulator handles the sign
  // explicitly through −state.theta·k for G2's angle.
  function ratio(p)        { return LIB.GearPair.speedRatioMag(p.rG1, p.rG2); }
  function reff(p)         { return ratio(p) * (+p.rPulley || 0); }
  function jG1(p)          { return LIB.WheelChain.massToJ(p.rG1, p.mG1); }
  function jG2(p)          { return LIB.WheelChain.massToJ(p.rG2, p.mG2); }
  function jPulley(p)      { return LIB.WheelChain.massToJ(p.rPulley, p.mPulley); }

  // J seen by the shaft shared by G2 and the drive pulley (Q1c). The idler
  // pulley is rigidly coupled to the drive pulley by the inextensible belt at
  // 1:1 (same radius), so its inertia reflects directly. The payload's mass
  // reflects through r_pulley² because every metre of belt motion is
  // r_pulley·θ_shaft of shaft rotation.
  function jG2Shaft(p) {
    const r_p = +p.rPulley || 0;
    return jG2(p) + 2 * jPulley(p) + (+p.mPayload || 0) * r_p * r_p;
  }

  // Motor-side rotational inertia, reflected through the gear pair. Includes
  // both pulleys (drive on the G2 shaft, idler 1:1 belt-coupled to it). The
  // payload mass shows up as m·reff²/η on top of this when computing the full
  // J_eff @ motor — the extra 1/η models the textbook efficiency loss on the
  // forward-driven load reflection.
  function jMotorEff(p) {
    return LIB.GearPair.reflectedJ({
      Jin: jG1(p), Jout: jG2(p) + 2 * jPulley(p),
      rIn: +p.rG1, rOut: +p.rG2,
    });
  }
  function reflectedJ(p) {
    const eta = ((+p.eta) > 0) ? +p.eta : 1;
    return jMotorEff(p) + (+p.mPayload || 0) * reff(p) * reff(p) / eta;
  }

  // Forward-direction torque at the belt drum (Q1b). Going from the small
  // motor pinion (G1) to the larger driven gear (G2), torque is amplified by
  // the inverse speed ratio and attenuated by η_gear:
  //     |τ_out| = |τ_in| · η · r_out/r_in.
  function tauAtBelt(p, tauMotor) {
    return LIB.GearPair.torqueOutMag(tauMotor, p.eta, p.rG1, p.rG2);
  }

  // Payload's peak linear acceleration (Q1d). Uses the textbook simplification
  // explicitly invoked by Q1c ("ignoring G1 and the motor"): the maximum
  // belt-side torque divided by the inertia seen at the G2 shaft, scaled to
  // linear motion through r_pulley.
  function aMaxPayload(p) {
    const r_p = +p.rPulley || 0;
    if (r_p < 1e-9) return 0;
    const tauBeltMax = tauAtBelt(p, +p.Tmax || 0);
    const J         = jG2Shaft(p);
    if (J < 1e-12) return 0;
    return tauBeltMax * r_p / J;
  }

  // ---------------------------------------------------------------------------
  //  Drive — open-loop. Drive ON applies +τ_max to G1 directly so the load
  //  accelerates at the Q1d limit until it bumps the end-stop. No velocity
  //  loop, no tuning — Q1's material is kinematic ratio, torque transfer
  //  through η, reflected inertia, and peak acceleration. Students Reset to
  //  rerun.
  // ---------------------------------------------------------------------------

  function motorTorque(state, p) {
    if (!state.driveOn) return 0;
    return +p.Tmax || 0;
  }

  // ---------------------------------------------------------------------------
  //  Pointer drag — payload, G1 rim, drive pulley rim, idler pulley rim
  // ---------------------------------------------------------------------------

  // BeltRender expects params.rDrive / params.rIdler — synthesised each
  // frame from rPulley so its layout/scene line up without a second
  // renderer.
  function beltParams(p) {
    return { rDrive: +p.rPulley, rIdler: +p.rPulley };
  }

  // Module-level caches updated each render so the pointer hit-tests can run
  // outside the renderer's frame. Each cache holds the centre-pixel and rim
  // radius in pixels.
  const cachedG1     = { cx: 0, cy: 0, rPx: 0, valid: false };
  const cachedDrive  = { cx: 0, cy: 0, rPx: 0, valid: false };
  const cachedIdler  = { cx: 0, cy: 0, rPx: 0, valid: false };
  let   cachedRatio  = 1;          // ratio(p) at last render — used by thetaOf
  let   cachedReff   = 0;          // reff(p) at last render — used by Rotate-by

  function loadHit(state, params, L, mx, my) {
    const g = LIB.BeltRender.layout(L, beltParams(params));
    const loadCy = g.loadTopY - 25;
    return Math.abs(mx - g.loadXToPx(state.x)) < 60
        && Math.abs(my - loadCy)               < 45;
  }
  function ringHit(c, mx, my) {
    if (!c.valid) return false;
    const dist = Math.hypot(mx - c.cx, my - c.cy);
    return dist < c.rPx + 6 && dist > c.rPx * 0.15;
  }

  const loadDragger = LIB.Drag.hbar({
    kind: "load", hitTest: loadHit,
    worldX: (mx, L) => L.pxToX(mx),
    bounds: () => ({ min: -X_LIMIT, max: X_LIMIT }),
    onSeedV: (state) => state.v, windowSec: 0.02,
  });
  const g1Dragger = LIB.Drag.angular({
    kind: "g1",
    hitTest: (s, p, L, mx, my) => ringHit(cachedG1, mx, my),
    centerPx: () => ({ x: cachedG1.cx, y: cachedG1.cy }),
    thetaOf: (state) => state.theta,
    onSeedW: (state) => state.omega, windowSec: 0.02,
  });
  // Drive pulley sits on G2's shaft. Its angle is -k·θ_G1; ω is -k·ω_G1.
  // The angular dragger captures pointer-deltas around the pulley centre and
  // we reflect the drag-spring back to G1 through the same -k factor.
  const drivePulleyDragger = LIB.Drag.angular({
    kind: "drive-pulley",
    hitTest: (s, p, L, mx, my) => ringHit(cachedDrive, mx, my),
    centerPx: () => ({ x: cachedDrive.cx, y: cachedDrive.cy }),
    thetaOf: (state) => -state.theta * cachedRatio,
    onSeedW: (state) => -state.omega * cachedRatio,
    windowSec: 0.02,
  });
  // Idler pulley is rigidly coupled to the drive pulley by the inextensible
  // belt (same radius → same ω). Treat a pointer drag on the idler as another
  // way to drive the same physical angle as the drive pulley.
  const idlerPulleyDragger = LIB.Drag.angular({
    kind: "idler-pulley",
    hitTest: (s, p, L, mx, my) => ringHit(cachedIdler, mx, my),
    centerPx: () => ({ x: cachedIdler.cx, y: cachedIdler.cy }),
    thetaOf: (state) => -state.theta * cachedRatio,
    onSeedW: (state) => -state.omega * cachedRatio,
    windowSec: 0.02,
  });
  const dragMux = LIB.Drag.mux([
    loadDragger, g1Dragger, drivePulleyDragger, idlerPulleyDragger,
  ]);

  // Drag torque on either pulley reflects to G1 through the gear-mesh
  // inversion: tau_on_G1 = -k · tau_on_G2_shaft (power conservation,
  // ω_G2 = -k · ω_G1, so tau cancels by a -k factor).
  function pulleyDragTauOnG1(state, p) {
    const k        = ratio(p);
    const drivAng  = -state.theta * k;
    const drivOmg  = -state.omega * k;
    const tauDrive = drivePulleyDragger.springTheta(state, drivAng, drivOmg,
                                                    K_PULLEY_DRAG, C_PULLEY_DRAG);
    const tauIdler = idlerPulleyDragger.springTheta(state, drivAng, drivOmg,
                                                    K_PULLEY_DRAG, C_PULLEY_DRAG);
    return -k * (tauDrive + tauIdler);
  }

  // ---------------------------------------------------------------------------
  //  Physics
  // ---------------------------------------------------------------------------

  function endStopForce(state) {
    return LIB.EndStop.force(state.x, state.v, -X_LIMIT, X_LIMIT,
                             END_K_BUMP, END_C_BUMP);
  }

  function dxdt(state, p, t) {
    const r       = reff(p);
    const m       = Math.max(1e-9, +p.mPayload);
    const Jrot    = Math.max(1e-9, jMotorEff(p));
    const eta     = (+p.eta > 0) ? +p.eta : 1;

    const F_couple = rigidCoupling.force(state.theta, state.omega,
                                         state.x, state.v, r);
    const F_drag   = loadDragger.spring1D(state, state.x, state.v,
                                          K_LOAD_DRAG, C_LOAD_DRAG);
    const tauG1    = g1Dragger.springTheta(state, state.theta, state.omega,
                                           K_GEAR_DRAG, C_GEAR_DRAG);
    const tauPul   = pulleyDragTauOnG1(state, p);
    const F_end    = endStopForce(state);
    const tau      = motorTorque(state, p);

    return {
      x:     state.v,
      v:     (-LIN_DRAG_LOAD * state.v + F_end + F_couple + F_drag) / m,
      theta: state.omega,
      omega: (tau - LIN_DRAG_MOTOR * state.omega - r * F_couple / eta
              + tauG1 + tauPul) / Jrot,
    };
  }

  function jacobian(state, p, t) {
    const n = 4;
    const M = new Float64Array(n * n);
    const r       = reff(p);
    const k       = ratio(p);
    const m       = Math.max(1e-9, +p.mPayload);
    const Jrot    = Math.max(1e-9, jMotorEff(p));
    const eta     = (+p.eta > 0) ? +p.eta : 1;
    const Kc      = rigidCoupling.K;
    const Cc      = rigidCoupling.C;

    const Kld = loadDragger.isActive(state) ? K_LOAD_DRAG : 0;
    const Cld = loadDragger.isActive(state) ? C_LOAD_DRAG : 0;
    const Kg1 = g1Dragger.isActive(state)   ? K_GEAR_DRAG : 0;
    const Cg1 = g1Dragger.isActive(state)   ? C_GEAR_DRAG : 0;
    // Pulley draggers act on -k·θ, -k·ω; reflecting the spring to state.theta
    // contributes -K·k² to ∂(τ_pulley_on_G1)/∂θ and -C·k² to ∂/∂ω.
    const pulleyActive = drivePulleyDragger.isActive(state) || idlerPulleyDragger.isActive(state);
    const Kpu = pulleyActive ? K_PULLEY_DRAG * k * k : 0;
    const Cpu = pulleyActive ? C_PULLEY_DRAG * k * k : 0;

    let Kbx = 0, Cbv = 0;
    if (state.x < -X_LIMIT) { Kbx = -END_K_BUMP; if (state.v < 0) Cbv = -END_C_BUMP; }
    else if (state.x > +X_LIMIT) { Kbx = -END_K_BUMP; if (state.v > 0) Cbv = -END_C_BUMP; }

    M[0*n+0] = 0;             M[0*n+1] = 1;                                    M[0*n+2] = 0;             M[0*n+3] = 0;
    M[1*n+0] = (Kbx        - Kc - Kld) / m;
    M[1*n+1] = (-LIN_DRAG_LOAD + Cbv - Cc - Cld) / m;
    M[1*n+2] = ( Kc * r) / m;
    M[1*n+3] = ( Cc * r) / m;
    M[2*n+0] = 0;             M[2*n+1] = 0;                                    M[2*n+2] = 0;             M[2*n+3] = 1;
    M[3*n+0] = ( r * Kc / eta) / Jrot;
    M[3*n+1] = ( r * Cc / eta) / Jrot;
    M[3*n+2] = ((-r * r * Kc / eta) - Kg1 - Kpu) / Jrot;
    M[3*n+3] = (-LIN_DRAG_MOTOR + (-r * r * Cc / eta) - Cg1 - Cpu) / Jrot;
    return M;
  }

  function preStep(state, p, dt) {
    dragMux.preStep(state, dt);
    state.lastTau = motorTorque(state, p);
  }

  // ---------------------------------------------------------------------------
  //  Render — belt scene + G1 + G2 painted to its left
  // ---------------------------------------------------------------------------

  function drawScene(ctx, L, state, p) {
    const bp    = beltParams(p);
    const sx    = L.mToPx;
    const k     = ratio(p);
    cachedRatio = k;
    cachedReff  = reff(p);
    const thetaPulley = -state.theta * k;

    const scene = LIB.BeltRender.drawScene(ctx, L, bp, state,
      { pulleyTheta: thetaPulley });
    const g     = scene.geom;

    // Cache the drive- and idler-pulley centres for pointer hit-tests.
    cachedDrive.cx = g.drivePulleyCx;  cachedDrive.cy = g.cy;  cachedDrive.rPx = g.r1Px;  cachedDrive.valid = true;
    cachedIdler.cx = g.idlerPulleyCx;  cachedIdler.cy = g.cy;  cachedIdler.rPx = g.r2Px;  cachedIdler.valid = true;

    const G2_cx = g.drivePulleyCx;
    const G2_cy = g.cy;
    const r_G2_px = (+p.rG2) * sx;
    LIB.GearRender.drawWheel(
      ctx,
      { cx: G2_cx, cy: G2_cy, rPx: r_G2_px },
      { r: +p.rG2, theta: thetaPulley, lastTau: 0 },
      { color: "#ce93d8", scale: sx,
        isDragging: drivePulleyDragger.isActive(state),
        isDrive: false, label: "G2",
        omega: -state.omega * k, tau: 0 });

    const G1_cx = G2_cx - (+p.rG1 + +p.rG2) * sx;
    const G1_cy = G2_cy;
    const r_G1_px = (+p.rG1) * sx;
    cachedG1.cx = G1_cx;
    cachedG1.cy = G1_cy;
    cachedG1.rPx = r_G1_px;
    cachedG1.valid = true;
    LIB.GearRender.drawWheel(
      ctx,
      { cx: G1_cx, cy: G1_cy, rPx: r_G1_px },
      { r: +p.rG1, theta: state.theta, lastTau: state.lastTau || 0 },
      { color: "#4ea1ff", scale: sx,
        isDragging: g1Dragger.isActive(state),
        isDrive: true, label: "G1 (motor)",
        omega: state.omega, tau: state.lastTau || 0 });

    // Highlight the idler when it's being dragged — re-stroke its rim with
    // the standard "isDragging" white outline so the affordance is visible.
    if (idlerPulleyDragger.isActive(state)) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(g.idlerPulleyCx, g.cy, g.r2Px, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Mesh tick — short bar between gears at the contact point.
    ctx.strokeStyle = "#3a4453"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(G1_cx + r_G1_px, G2_cy - 12);
    ctx.lineTo(G1_cx + r_G1_px, G2_cy + 12);
    ctx.stroke();

    // Trapezoidal payload over the belt + reflected-inertia callout.
    const wAccent = "#66bb6a";
    const trap = LIB.Draw.trapezoidWeight(ctx, scene.loadCx, scene.loadTopY,
                                          +p.mPayload,
                                          { accentColor: wAccent });
    LIB.Draw.jReflectedCallout(ctx, scene.loadCx, trap.topY, reflectedJ(p),
                                { color: wAccent });
  }

  // ---------------------------------------------------------------------------
  //  Sliders / plots / readouts
  // ---------------------------------------------------------------------------

  function buildSliders() {
    return {
      Drive: [
        { key: "rotateDeg", kind: "expr",
          label: "Rotate by (°)", value: "1080",
          button: "Rotate",
          placeholder: "e.g. 90 or 1080",
          tip: "Type any expression in degrees of G1 rotation. Click Rotate to advance G1 (and the load + pulleys, through the kinematic chain) by that angle in one shot. Q1a uses 3 revolutions = 1080°.",
          onSubmit: (deg, state) => {
            const rad = ((+deg) || 0) * Math.PI / 180;
            state.theta += rad;
            const newX = state.x + rad * cachedReff;
            state.x = Math.max(-X_LIMIT, Math.min(X_LIMIT, newX));
          } },
        { key: "Tmax", label: "τ_motor", min: 0.05, max: 50, step: 0.01,
          value: 2.0, log: true,
          tip: "Motor torque (N·m). Q1b/Q1d use 2 N·m. Drive ON applies this torque open-loop so the load accelerates at the Q1d limit." },
        { key: "eta", label: "η_gears", min: 0.1, max: 1, step: 0.01,
          value: 0.8,
          tip: "Gear-mesh efficiency. Q1 uses 0.8." },
      ],
      Mechanism: [
        { key: "rG1", label: "r_G1 (m)", min: 0.005, max: 0.10, step: 0.0005,
          value: 0.015, log: true,
          tip: "Motor-pinion radius. Q1 uses 0.015 m (15 mm)." },
        { key: "rG2", label: "r_G2 (m)", min: 0.005, max: 0.20, step: 0.0005,
          value: 0.040, log: true,
          tip: "Idler-gear radius (rigid on the pulley shaft). Q1 uses 0.040 m." },
        { key: "rPulley", label: "r_pulley (m)", min: 0.005, max: 0.20, step: 0.0005,
          value: 0.045, log: true,
          tip: "Drive- and idler-pulley radius. Q1 uses 0.045 m." },
        { key: "mG1", label: "m_G1 (kg)", min: 0.001, max: 5, step: 0.001,
          value: 0.057, log: true, tip: "G1 mass." },
        { key: "mG2", label: "m_G2 (kg)", min: 0.001, max: 5, step: 0.001,
          value: 0.402, log: true, tip: "G2 mass." },
        { key: "mPulley", label: "m_pulley (kg)", min: 0.001, max: 5, step: 0.001,
          value: 0.171, log: true, tip: "Mass of one pulley (drive and idler treated as identical)." },
        { key: "mPayload", label: "m_payload (kg)", min: 0.001, max: 10, step: 0.001,
          value: 0.450, log: true, tip: "Payload + belt mass." },
      ],
    };
  }

  function buildPlots() {
    return [
      { title: "ω — G1 (blue), G2 (purple)",
        yFmt: (v) => v.toFixed(1),
        yFloor: { lo: -10, hi: 10 },
        yChunk: 5,
        series: [
          { label: "ω_G1",  color: "#4ea1ff", lw: 2.0,
            source: (s) => s.omega },
          { label: "ω_G2",  color: "#ce93d8", lw: 1.6,
            source: (s, p) => -s.omega * ratio(p) },
        ] },
      { title: "x — payload (m)",
        yFmt: (v) => v.toFixed(3),
        yFloor: { lo: -X_LIMIT, hi: X_LIMIT },
        yChunk: 0.05,
        series: [
          { label: "x", color: "#4ea1ff", lw: 2.2, source: (s) => s.x },
        ] },
      { title: "τ motor (N·m)",
        yFmt: (v) => v.toFixed(2),
        yFloor: { lo: -2, hi: 2 },
        yChunk: 1,
        series: [
          { label: "tau",       color: "#4ea1ff", lw: 2.0, source: (s) => s.lastTau || 0 },
          { label: "τ_at_belt", color: "#ce93d8", lw: 1.4,
            source: (s, p) => tauAtBelt(p, s.lastTau || 0) },
        ] },
    ];
  }

  function buildReadouts() {
    return [
      { label: "x", units: "m", value: (s) => s.x.toFixed(4) },
      { label: "θ_G1 (Q1a)", units: "rev",
        value: (s) => (s.theta / (2 * Math.PI)).toFixed(3) },
      { label: "θ_G2 (Q1a)", units: "rev",
        value: (s, p) => (-s.theta * ratio(p) / (2 * Math.PI)).toFixed(3) },
      { label: "ω_G1", units: "rad/s",
        value: (s) => s.omega.toFixed(2) },
      { label: "ω_G2", units: "rad/s",
        value: (s, p) => (-s.omega * ratio(p)).toFixed(2) },
      { label: "ratio r_G1/r_G2",
        value: (s, p) => ratio(p).toFixed(4) },
      { label: "r_eff = ratio · r_pulley", units: "m",
        value: (s, p) => reff(p).toFixed(4) },
      { label: "J_G1", units: "kg·m²",
        value: (s, p) => jG1(p).toExponential(3) },
      { label: "J_G2", units: "kg·m²",
        value: (s, p) => jG2(p).toExponential(3) },
      { label: "J_pulley (each)", units: "kg·m²",
        value: (s, p) => jPulley(p).toExponential(3) },
      { label: "J seen by G2 shaft (Q1c)", units: "kg·m²",
        value: (s, p) => jG2Shaft(p).toExponential(3) },
      { label: "J_eff @ motor", units: "kg·m²",
        value: (s, p) => reflectedJ(p).toExponential(3) },
      { label: "τ at belt (Q1b)", units: "N·m",
        value: (s, p) => tauAtBelt(p, +p.Tmax || 0).toFixed(3) },
      { label: "a_max payload (Q1d)", units: "m/s²",
        value: (s, p) => aMaxPayload(p).toFixed(2) },
      { label: "τ applied", units: "N·m",
        value: (s) => (s.lastTau || 0).toFixed(3) },
      { label: "Match M",
        value: (s, p) => {
          const Jmot = jG1(p);
          const Jrest = Math.max(0, reflectedJ(p) - Jmot);
          const M = (Jmot > 1e-12) ? (Jrest / Jmot) : Infinity;
          return { text: Number.isFinite(M) ? M.toFixed(2) : "∞",
                   color: LIB.MatchHint.color(M),
                   suffix: LIB.MatchHint.hint(M) };
        } },
    ];
  }

  // ---------------------------------------------------------------------------
  //  Spec
  // ---------------------------------------------------------------------------

  const SPEC = {
    id: "tut2-gear-belt-payload",
    title: "Q1 — gear pair → belt → payload",
    subtitle: "G1 drives G2 (sharing a shaft with the drive pulley); belt + payload",
    description: `<b>Q1 — gear pair driving a belt</b> — G1 (motor pinion) meshes with G2; G2 sits on the same shaft as the drive pulley. A belt over the drive and idler pulleys carries the payload. To step through the kinematics by hand, type a value into <b>Rotate by (°)</b> and click Rotate — G1 advances by that angle and the load and pulleys follow through the rigid chain (Q1a uses 3 revolutions = 1080°). Flip <b>Drive</b> ON to apply τ_motor open-loop and watch the load accelerate at the Q1d limit until it bumps the end-stop. Drag the payload along the belt, the G1 rim, or either pulley rim to feel the reflected inertia. Live readouts answer the question directly: <b>θ_G2</b> for Q1a, <b>τ at belt</b> for Q1b, <b>J seen by G2 shaft</b> for Q1c, <b>a_max payload</b> for Q1d. Vary masses and radii to see each formula respond.`,

    state: () => ({
      x: 0, v: 0, theta: 0, omega: 0,
      lastTau: 0, drag: null, driveOn: false,
      t: 0,
    }),

    onReset: (s) => {
      s.drag = null;
      cachedG1.valid = false;
      cachedDrive.valid = false;
      cachedIdler.valid = false;
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

    // Reserve enough room on the LEFT for G1 + G2 painted outside the
    // drive-pulley area. With X_LIMIT=0.20 m and a typical canvas width,
    // mToPx ≈ 1500 → ~140 px reserves enough head room. Right side gets a
    // small margin too so the idler pulley sits clear of the canvas edge.
    layout: { kind: "linearTrack", xMin: -X_LIMIT, xMax: X_LIMIT,
              marginLeftPx: 160, marginRightPx: 16 },

    dragControls: [
      { label: "Payload",       desc: "drag horizontally" },
      { label: "G1 gear",       desc: "click rim, rotate" },
      { label: "Drive pulley",  desc: "click rim, rotate" },
      { label: "Idler pulley",  desc: "click rim, rotate" },
      { label: "Rotate by (°)", desc: "advance G1 by an exact angle" },
    ],

    render: drawScene,

    icon: (ctx, W, H) => {
      const S = Math.min(W, H);
      const accent = LIB.Util.getVar("--accent");
      const good   = LIB.Util.getVar("--good");
      const ink    = LIB.Util.getVar("--ink");

      // Gear pair on the left — small driver above, larger driven below.
      const r1 = S * 0.16;
      const r2 = S * 0.24;
      const cx1 = W * 0.20;
      const cy1 = H * 0.30;
      const cx2 = cx1;
      const cy2 = cy1 + r1 + r2;

      LIB.GearRender.drawGearShape(ctx,
        { cx: cx1, cy: cy1 }, { r: r1, theta: 0 },
        accent, { phase: 0 });
      LIB.GearRender.drawGearShape(ctx,
        { cx: cx2, cy: cy2 }, { r: r2, theta: 0 },
        good, { phase: Math.PI });

      // Driven pulley on the right (same shaft as the lower gear in real
      // life; for the icon, place a separate pulley to make the belt
      // visually obvious).
      const pulleyR = S * 0.14;
      const pulleyCx = W * 0.78;
      const pulleyCy = cy2;

      ctx.fillStyle = "#2a313c";
      ctx.beginPath(); ctx.arc(pulleyCx, pulleyCy, pulleyR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.005);
      ctx.stroke();
      // Inner ring to read as a pulley not a wheel
      ctx.beginPath();
      ctx.arc(pulleyCx, pulleyCy, pulleyR * 0.55, 0, Math.PI * 2);
      ctx.stroke();

      // Belt — two tangent lines
      ctx.strokeStyle = ink + "cc";
      ctx.lineWidth = Math.max(1.5, S * 0.007);
      ctx.beginPath();
      ctx.moveTo(cx2, cy2 - r2);
      ctx.lineTo(pulleyCx, pulleyCy - pulleyR);
      ctx.moveTo(cx2, cy2 + r2);
      ctx.lineTo(pulleyCx, pulleyCy + pulleyR);
      ctx.stroke();

      // Payload box hanging from the right pulley
      const boxW = S * 0.20, boxH = S * 0.16;
      const boxCx = pulleyCx;
      const boxTop = pulleyCy + pulleyR + S * 0.06;
      ctx.strokeStyle = ink + "aa";
      ctx.lineWidth = Math.max(1, S * 0.004);
      ctx.beginPath();
      ctx.moveTo(boxCx, pulleyCy);
      ctx.lineTo(boxCx, boxTop);
      ctx.stroke();

      ctx.fillStyle = accent;
      ctx.fillRect(boxCx - boxW / 2, boxTop, boxW, boxH);
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1.2, S * 0.005);
      ctx.strokeRect(boxCx - boxW / 2, boxTop, boxW, boxH);
    },

    onPointer: (type, mx, my, L, state, params) =>
      dragMux.handle(type, mx, my, L, state, params),

    headerButtons: [
      LIB.HeaderButtons.driveToggle(),
    ],

    physHz: 240,
  };

  (window.TutorialLessons = window.TutorialLessons || {}).gearBeltPayload = SPEC;
})();
