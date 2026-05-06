"use strict";

// =============================================================================
//  LIB.GearRender — gear-tooth + wheel rendering for the rotational family.
//
//  Public surface:
//
//    LIB.GearRender.PITCH_ARC = 0.30
//        Default arc-length (m) along the pitch circle per tooth. Constant
//        across a chain so adjacent meshes share the same module.
//
//    LIB.GearRender.teethCount(rPitch, pitchArc?)
//        Integer tooth count for a pitch radius (≥6 by construction).
//
//    LIB.GearRender.snapRadiusToTeeth(rPitch, nMin?, nMax?, pitchArc?) → r
//        Snaps a continuous radius to the nearest integer-N tooth count, so
//        every gear in a chain shares the same module exactly.
//
//    LIB.GearRender.gearPhases(wheels, centers, pitchArc?)
//        Per-wheel initial tooth phase such that adjacent gears interlock at
//        their mesh point at θ=0. centers must be world-space (math-CCW y),
//        e.g. layoutCenters output mapped through the renderer's xToPx/yToPx
//        is NOT what you want — pass the unmapped chain centres so the
//        atan2 of the mate direction reads right.
//
//    LIB.GearRender.drawGearShape(ctx, c, w, color, opts)
//        Textbook involute spur-gear profile. opts:
//          { isDragging, phase, scale, lashM = 0, pitchArc = 0.30,
//            pressureAngleDeg = 20, addendumFrac = 1.0, dedendumFrac = 1.25 }
//        c = {cx, cy} in canvas pixels. scale = world-m → px.
//
//    LIB.GearRender.drawWheel(ctx, c, w, opts)
//        Disc + outline + indicator dot + per-wheel annotation (#i, ω, τ).
//        Renders compound wheels (r1/r2) as concentric stepped discs when
//        opts.compound=true. opts:
//          { color, isDrive, isDragging, compound, scale,
//            label?, omega?, tau?, annotate?: false }
//
//    LIB.GearRender.drawDriveArrow(ctx, c, lastT, opts?)
//        Curved arc above wheel 0 indicating drive-torque direction.
//        opts: { color, threshold = 1e-3, radiusPad = 10 }.
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const PITCH_ARC = 0.30;

  function teethCount(rPitch, pitchArc) {
    const arc = +pitchArc || PITCH_ARC;
    return Math.max(6, Math.round((2 * Math.PI * rPitch) / arc));
  }

  function snapRadiusToTeeth(rPitch, nMin, nMax, pitchArc) {
    const arc = +pitchArc || PITCH_ARC;
    const lo = (nMin != null) ? +nMin : 6;
    const hi = (nMax != null) ? +nMax : 60;
    const n  = Math.max(lo, Math.min(hi, teethCount(rPitch, arc)));
    return (n * arc) / (2 * Math.PI);
  }

  // Per-wheel phase such that adjacent gears interlock at their mesh point.
  // Convention: gear 0 presents a tooth toward gear 1; subsequent gears
  // alternate tooth↔gap to maintain interlock through the chain. After the
  // mesh, what RIGHT side a gear shows depends on the parity of its tooth
  // count (the diametric chord spans (N/2)·pitchAng — integer when N even,
  // half-integer when N odd).
  function gearPhases(wheels, centers, pitchArc) {
    const arc = +pitchArc || PITCH_ARC;
    const phases = new Array(wheels.length).fill(0);
    let rightIsTooth = true;
    for (let i = 0; i < wheels.length; i++) {
      const ci = centers[i];
      if (!ci) continue;
      const N = teethCount(wheels[i].r, arc);
      const pitchAng = (2 * Math.PI) / N;
      const halfPitch = pitchAng / 2;

      if (i === 0) {
        if (wheels.length > 1 && centers[1]) {
          phases[i] = Math.atan2(-(centers[1].cy - ci.cy),
                                   centers[1].cx - ci.cx);
        }
        rightIsTooth = true;
      } else {
        const cL = centers[i - 1];
        const angLeft = cL ? Math.atan2(-(cL.cy - ci.cy), cL.cx - ci.cx) : 0;
        const leftIsTooth = !rightIsTooth;
        phases[i] = leftIsTooth ? angLeft : (angLeft + halfPitch);
        const Neven = (N % 2 === 0);
        rightIsTooth = (leftIsTooth === Neven);
      }
    }
    return phases;
  }

  function drawGearShape(ctx, c, w, color, opts) {
    opts = opts || {};
    const sx = +opts.scale || 1;
    const isDragging = !!opts.isDragging;
    const phase      = +opts.phase || 0;
    const lashM      = +opts.lashM || 0;
    const arc        = +opts.pitchArc || PITCH_ARC;
    const pressure   = ((opts.pressureAngleDeg != null) ? +opts.pressureAngleDeg : 20)
                       * Math.PI / 180;
    const addFrac    = (opts.addendumFrac != null) ? +opts.addendumFrac : 1.0;
    const dedFrac    = (opts.dedendumFrac != null) ? +opts.dedendumFrac : 1.25;

    const cx = c.cx, cy = c.cy;
    const rPitch = w.r;
    const N = teethCount(rPitch, arc);
    const pitchAng = (2 * Math.PI) / N;
    const lashAng = lashM / Math.max(1e-3, rPitch);
    const halfAtPitch = Math.max(pitchAng * 0.02, (pitchAng - lashAng) / 4);

    const module_ = (2 * rPitch) / N;
    const rTip  = rPitch + module_ * addFrac;
    const rRoot = Math.max(0.2 * rPitch, rPitch - module_ * dedFrac);
    const rBase = rPitch * Math.cos(pressure);

    const invFn = (a) => Math.tan(a) - a;
    const invAtPitch = invFn(pressure);
    const halfAtBase = halfAtPitch + invAtPitch;
    function halfThickAt(r) {
      if (r <= rBase) return halfAtBase;
      const cosPhi = Math.min(1, Math.max(-1, rBase / r));
      const phi = Math.acos(cosPhi);
      return halfAtPitch + invAtPitch - invFn(phi);
    }
    function vertex(angle, rWorld) {
      return { x: cx + Math.cos(angle) * rWorld * sx,
               y: cy - Math.sin(angle) * rWorld * sx };
    }

    const FLANK_SAMPLES = 8;
    const TIP_SAMPLES   = 4;
    const ROOT_SAMPLES  = 4;
    const rFlankStart = Math.max(rRoot, rBase);

    let rEnd = rTip;
    if (halfThickAt(rTip) <= 0) {
      let lo = rFlankStart, hi = rTip;
      for (let it = 0; it < 24; it++) {
        const mid = 0.5 * (lo + hi);
        if (halfThickAt(mid) > 0) lo = mid; else hi = mid;
      }
      rEnd = lo;
    }
    const halfAtTip = Math.max(0, halfThickAt(rEnd));

    ctx.fillStyle = "#1a2030";
    ctx.beginPath();
    for (let k = 0; k < N; k++) {
      const tc = w.theta + phase + k * pitchAng;
      const aRootL = tc - halfAtBase;
      const aRootR = tc + halfAtBase;
      const aRootNextL = tc + pitchAng - halfAtBase;

      const v0 = vertex(aRootL, rRoot);
      if (k === 0) ctx.moveTo(v0.x, v0.y);
      else         ctx.lineTo(v0.x, v0.y);

      if (rRoot < rBase) {
        const v = vertex(aRootL, rBase);
        ctx.lineTo(v.x, v.y);
      }
      for (let s = 1; s <= FLANK_SAMPLES; s++) {
        const r = rFlankStart + (s / FLANK_SAMPLES) * (rEnd - rFlankStart);
        const v = vertex(tc - Math.max(0, halfThickAt(r)), r);
        ctx.lineTo(v.x, v.y);
      }
      for (let s = 1; s <= TIP_SAMPLES; s++) {
        const a = (tc - halfAtTip) + (s / TIP_SAMPLES) * (2 * halfAtTip);
        const v = vertex(a, rEnd);
        ctx.lineTo(v.x, v.y);
      }
      for (let s = 1; s <= FLANK_SAMPLES; s++) {
        const r = rEnd - (s / FLANK_SAMPLES) * (rEnd - rFlankStart);
        const v = vertex(tc + Math.max(0, halfThickAt(r)), r);
        ctx.lineTo(v.x, v.y);
      }
      if (rRoot < rBase) {
        const v = vertex(aRootR, rRoot);
        ctx.lineTo(v.x, v.y);
      }
      for (let s = 1; s <= ROOT_SAMPLES; s++) {
        const a = aRootR + (s / ROOT_SAMPLES) * (aRootNextL - aRootR);
        const v = vertex(a, rRoot);
        ctx.lineTo(v.x, v.y);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = isDragging ? "#fff" : color;
    ctx.lineWidth = isDragging ? 2.5 : 1.4;
    ctx.stroke();

    // Pitch circle — where rolling actually happens.
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = color + "55";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rPitch * sx, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Disc (single or compound) + indicator dot + annotation.
  function drawWheel(ctx, c, w, opts) {
    opts = opts || {};
    const color      = opts.color || "#4ea1ff";
    const isDrive    = !!opts.isDrive;
    const isDragging = !!opts.isDragging;
    const compound   = !!opts.compound;
    const sx         = +opts.scale || 1;
    const annotate   = (opts.annotate !== false);

    if (compound) {
      const rOuter = Math.max(c.r1Px, c.r2Px);
      const rInner = Math.min(c.r1Px, c.r2Px);
      ctx.fillStyle = "#1a2030";
      ctx.beginPath(); ctx.arc(c.cx, c.cy, rOuter, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isDragging ? "#fff" : color;
      ctx.lineWidth = isDragging ? 3 : 2;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, rOuter, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = "#222a3a";
      ctx.beginPath(); ctx.arc(c.cx, c.cy, rInner, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isDragging ? "#fff" : color;
      ctx.lineWidth = isDragging ? 3 : 2;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, rInner, 0, Math.PI * 2); ctx.stroke();
      // r1 / r2 mini-labels
      ctx.fillStyle = color + "cc";
      ctx.font = "10px ui-sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(`r1=${w.r1.toFixed(2)}`, c.cx + rInner + 4, c.cy - rInner * 0.5);
      ctx.fillText(`r2=${w.r2.toFixed(2)}`, c.cx + rInner + 4, c.cy + rInner * 0.5);
    } else {
      const r = c.rPx;
      ctx.fillStyle = "#1a2030";
      ctx.beginPath(); ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isDragging ? "#fff" : color;
      ctx.lineWidth = isDragging ? 3 : 2;
      ctx.beginPath(); ctx.arc(c.cx, c.cy, r, 0, Math.PI * 2); ctx.stroke();
    }

    // hub dot
    ctx.fillStyle = "#6a7384";
    ctx.beginPath(); ctx.arc(c.cx, c.cy, 3, 0, Math.PI * 2); ctx.fill();

    // Theta indicator — sits on the smaller rim for compound so a contacting
    // neighbour drawn on top of the larger ring doesn't hide it.
    const rIndicator = compound ? Math.min(c.r1Px, c.r2Px) : c.rPx;
    const dotR = Math.max(3, rIndicator * 0.08);
    const dx = Math.cos(w.theta) * (rIndicator - dotR - 2);
    const dy = -Math.sin(w.theta) * (rIndicator - dotR - 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c.cx, c.cy); ctx.lineTo(c.cx + dx, c.cy + dy); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(c.cx + dx, c.cy + dy, dotR, 0, Math.PI * 2); ctx.fill();

    if (annotate) {
      const titleFs = 19, valFs = 17, lineH = 22;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const label = (opts.label != null) ? opts.label
                                         : (isDrive ? "#0 (drive)" : "#?");
      ctx.font = `700 ${titleFs}px ui-sans-serif`;
      ctx.fillStyle = isDrive ? "#fff" : color;
      ctx.fillText(label, c.cx, c.cy - lineH);
      if (opts.omega != null) {
        ctx.font = `600 ${valFs}px ui-sans-serif`;
        ctx.fillStyle = "#e6e9ef";
        ctx.fillText(`ω=${(+opts.omega).toFixed(2)} rad/s`, c.cx, c.cy + 2);
      }
      if (opts.tau != null) {
        ctx.fillStyle = "#c0c9d8";
        ctx.fillText(`τ=${(+opts.tau).toFixed(2)} N·m`, c.cx, c.cy + 2 + lineH);
      }
    }
  }

  function drawDriveArrow(ctx, c, lastT, opts) {
    opts = opts || {};
    const threshold = (opts.threshold != null) ? +opts.threshold : 1e-3;
    if (Math.abs(lastT) < threshold) return;
    const color = opts.color || "#ff9f43";
    const pad   = (opts.radiusPad != null) ? +opts.radiusPad : 10;
    const sign = lastT >= 0 ? 1 : -1;
    const r = c.rPx + pad;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (sign > 0) ctx.arc(c.cx, c.cy, r, -Math.PI * 0.7, -Math.PI * 0.1);
    else          ctx.arc(c.cx, c.cy, r, -Math.PI * 0.9, -Math.PI * 0.3, true);
    ctx.stroke();
    ctx.fillStyle = color;
    const tipAngle = sign > 0 ? -Math.PI * 0.1 : -Math.PI * 0.3;
    const tipX = c.cx + Math.cos(tipAngle) * r;
    const tipY = c.cy + Math.sin(tipAngle) * r;
    ctx.beginPath();
    ctx.arc(tipX, tipY, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  LIB.GearRender = {
    PITCH_ARC,
    teethCount, snapRadiusToTeeth,
    gearPhases,
    drawGearShape, drawWheel, drawDriveArrow,
  };
})();
