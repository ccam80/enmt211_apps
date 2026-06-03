"use strict";

// =============================================================================
//  LIB.BeltRender — pulley + inextensible-belt drawing helpers, shared by
//  the conveyor lesson and the whole-system lesson's "conv" mode.
//
//  Public surface:
//
//    LIB.BeltRender.layout(L, p, opts?)
//        Returns { cy, drivePulleyCx, idlerPulleyCx, r1Px, r2Px,
//                  motorCx, motorR, loadTopY }. `loadTopY` is the
//        belt's top tangent at the drive-pulley side — the y a
//        trapezoidal load would sit on, useful for hit-tests.
//        Drive pulley is anchored at L.xMin, idler at L.xMax;
//        the motor (if drawn) sits to the left of the drive pulley.
//        opts: { yMid? = L.trackY - 60, motorR? = 28 }
//
//    LIB.BeltRender.beltPath(g)
//        Tangent-line + wrap geometry for the belt around two unequal
//        pulleys. Open (external) wrap, top tangent above both centres.
//        Returns { aTopX, aTopY, bTopX, bTopY, aBotX, aBotY, bBotX, bBotY }
//        where a = drive pulley side, b = idler side.
//
//    LIB.BeltRender.drawScene(ctx, L, p, state, opts?)
//        Belt body + two pulleys (with spoke indicators) + phase marks on
//        the top run. The motor is OPT-IN — pass `opts.motor: true` to
//        draw it. Returns { loadCx, loadTopY } so the caller can place a
//        trapezoidal load.
//        opts: { yMid?, motorR?, motor?: false, motorOpts? }
//          motor      — draw the motor disc next to the drive pulley.
//          motorOpts  — forwarded to LIB.Draw.motor when motor is on
//                       (thermal halo / fillColor / strokeColor / etc.).
//
//  Dependencies: LIB.Draw (lib/draw.js) for the motor primitive.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Draw) {
    throw new Error("LIB.BeltRender requires lib/draw.js (LIB.Draw.motor)");
  }

  function layout(L, p, opts) {
    opts = opts || {};
    const cy      = (opts.yMid != null)   ? +opts.yMid   : (L.trackY - 60);
    const motorR  = (opts.motorR != null) ? +opts.motorR : 28;
    const r1Px = p.rDrive * L.mToPx;
    const r2Px = p.rIdler * L.mToPx;
    // Inset pulleys by their radii so the wheels sit fully INSIDE the
    // usable area of the canvas instead of overhanging L.xMin / L.xMax.
    // opts.inset = false places pulley centres at L.xMin/xMax instead; the
    // inset layout with `loadXToPx` for both rendering and hit-tests is
    // preferred.
    const inset = (opts.inset !== false);
    const drivePulleyCx = inset ? (L.xToPx(L.xMin) + r1Px) : L.xToPx(L.xMin);
    const idlerPulleyCx = inset ? (L.xToPx(L.xMax) - r2Px) : L.xToPx(L.xMax);
    // Motor sits just left of the drive-pulley centre (visually layered
    // behind the pulley body). With inset layout the motor follows the
    // pulley inboard so it stays on-canvas too.
    const motorCx = drivePulleyCx - motorR - 8;
    const loadTopY = cy - r1Px;
    // Map a physical state.x ∈ [L.xMin, L.xMax] linearly across the visible
    // belt span between the two pulley centres. Lessons must use this for
    // both load rendering and pointer hit-tests so they stay coupled.
    function loadXToPx(x) {
      const span = (L.xMax - L.xMin) || 1e-9;
      const t = (x - L.xMin) / span;
      return drivePulleyCx + t * (idlerPulleyCx - drivePulleyCx);
    }
    return { cy, drivePulleyCx, idlerPulleyCx, r1Px, r2Px, motorCx, motorR,
             loadTopY, inset, loadXToPx };
  }

  function beltPath(g) {
    const { cy, drivePulleyCx, idlerPulleyCx, r1Px, r2Px } = g;
    const dx = idlerPulleyCx - drivePulleyCx;
    const Lc = Math.hypot(dx, 0);
    const sinA = (r1Px - r2Px) / Math.max(1e-9, Lc);
    const alpha = Math.asin(Math.max(-1, Math.min(1, sinA)));
    const cosA = Math.cos(alpha);
    return {
      aTopX: drivePulleyCx + r1Px * sinA, aTopY: cy - r1Px * cosA,
      bTopX: idlerPulleyCx + r2Px * sinA, bTopY: cy - r2Px * cosA,
      aBotX: drivePulleyCx + r1Px * sinA, aBotY: cy + r1Px * cosA,
      bBotX: idlerPulleyCx + r2Px * sinA, bBotY: cy + r2Px * cosA,
    };
  }

  function drawScene(ctx, L, p, state, opts) {
    opts = opts || {};
    const g = layout(L, p, opts);
    const { cy, drivePulleyCx, idlerPulleyCx, r1Px, r2Px, motorCx, motorR } = g;

    // Pulley angle drives both the spoke indicator and the phase-mark scroll.
    // For lessons that drive the belt through a gear chain (so the pulley
    // angle ≠ state.theta), pass opts.pulleyTheta to override.
    const pulleyTheta = (opts.pulleyTheta != null)
      ? +opts.pulleyTheta : (+state.theta || 0);

    // Motor is opt-in — standalone conveyor lessons leave it off so the
    // device stays the focus; system-level lessons set `opts.motor: true`
    // (and forward thermal halo / colours via `opts.motorOpts`).
    if (opts.motor) {
      LIB.Draw.motor(ctx, motorCx, cy, motorR,
        Object.assign({ theta: state.theta, label: "motor" },
                      opts.motorOpts || {}));
    }

    const bp = beltPath(g);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(bp.aTopX, bp.aTopY);
    ctx.lineTo(bp.bTopX, bp.bTopY);
    ctx.arc(idlerPulleyCx, cy, r2Px,
            Math.atan2(bp.bTopY - cy, bp.bTopX - idlerPulleyCx),
            Math.atan2(bp.bBotY - cy, bp.bBotX - idlerPulleyCx),
            false);
    ctx.lineTo(bp.aBotX, bp.aBotY);
    ctx.arc(drivePulleyCx, cy, r1Px,
            Math.atan2(bp.aBotY - cy, bp.aBotX - drivePulleyCx),
            Math.atan2(bp.aTopY - cy, bp.aTopX - drivePulleyCx),
            false);
    ctx.closePath();
    ctx.strokeStyle = "#202833"; ctx.lineWidth = 11; ctx.stroke();
    ctx.strokeStyle = "#4a5460"; ctx.lineWidth = 7;  ctx.stroke();
    ctx.strokeStyle = "#6a7384"; ctx.lineWidth = 1;  ctx.stroke();

    // Pulleys + spoke indicator
    const driveStroke = (opts.motorOpts && opts.motorOpts.strokeColor) || "#4ea1ff";
    for (const [pcx, pr, label] of [[drivePulleyCx, r1Px, "drive"],
                                    [idlerPulleyCx, r2Px, "idler"]]) {
      ctx.fillStyle = "#1a2030";
      ctx.beginPath(); ctx.arc(pcx, cy, pr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = (label === "drive") ? driveStroke : "#c0c9d8";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(pcx, cy, pr, 0, Math.PI * 2); ctx.stroke();
      const phaseTheta = (label === "drive")
        ? pulleyTheta
        : pulleyTheta * (p.rDrive / Math.max(1e-6, p.rIdler));
      const ind = pr * 0.7;
      ctx.strokeStyle = "#c0c9d8"; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(pcx, cy);
      ctx.lineTo(pcx + Math.cos(phaseTheta) * ind, cy - Math.sin(phaseTheta) * ind);
      ctx.stroke();
      ctx.fillStyle = "#6a7384";
      ctx.beginPath(); ctx.arc(pcx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
      const labelFs = (LIB.Type && LIB.Type.current) ? LIB.Type.current.sm : 11;
      ctx.fillStyle = "#8a93a3";
      ctx.font = `${labelFs}px ui-sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(label, pcx, cy + pr + 4);
    }

    // Phase marks scrolling along the top run. Drive these from state.x
    // (the load's position) using the same pixel-per-metre scale that
    // `loadXToPx` uses, so the dots track the load exactly even when the
    // kinematic chain inverts (gear-belt: G2 spins the opposite way to the
    // motor, but x = +k·r·θ so the belt should still scroll with the load).
    const segLen = bp.bTopX - bp.aTopX;
    const beltLinScale = (g.idlerPulleyCx - g.drivePulleyCx)
                       / Math.max(1e-9, L.xMax - L.xMin);
    const beltPhase = (+state.x || 0) * beltLinScale;
    const Nmk = Math.max(4, Math.round(segLen / 60));
    for (let k = 0; k < Nmk; k++) {
      const u = ((k / Nmk) * segLen + beltPhase) % segLen;
      const uu = u < 0 ? u + segLen : u;
      const t = uu / segLen;
      const xp = bp.aTopX + t * (bp.bTopX - bp.aTopX);
      const yp = bp.aTopY + t * (bp.bTopY - bp.aTopY);
      ctx.fillStyle = "#0d1013";
      ctx.beginPath(); ctx.arc(xp, yp, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#f6c945";
      ctx.beginPath(); ctx.arc(xp, yp, 2.5, 0, Math.PI * 2); ctx.fill();
    }

    // Where to drop the load — use the inset-aware mapping so the load
    // tracks the visible belt span exactly. Lessons should also use
    // `geom.loadXToPx(x)` for hit-tests so the affordance follows the
    // visual placement.
    const xp = g.loadXToPx(state.x);
    const tt = (bp.bTopX > bp.aTopX) ? (xp - bp.aTopX) / (bp.bTopX - bp.aTopX) : 0;
    const yTop = bp.aTopY + tt * (bp.bTopY - bp.aTopY);
    return { loadCx: xp, loadTopY: yTop - 1, geom: g, beltPath: bp };
  }

  // ---------------------------------------------------------------------------
  //  Open belt around two free-floating pulleys (rotational belt-and-pulley
  //  lessons). Unlike the conveyor's same-y two-pulley layout, here `a` and
  //  `b` can sit at any canvas position and have unequal radii.
  //
  //  openBeltPath(a, b, raPx, rbPx) → { at(s) → {x,y}, total, draw(ctx, opts) }
  //
  //    Closed loop in 4 segments:
  //      1. tangent on side1   (aSide1 → bSide1)
  //      2. wrap around B      (away-from-A side, length = rbPx · ψB)
  //      3. tangent on side2   (bSide2 → aSide2)
  //      4. wrap around A      (away-from-B side, length = raPx · ψA)
  //
  //    `at(s)` parameterises the loop by arc-length pixels (modular over
  //    `total`), suitable for distributing belt-phase marks. `draw(ctx, opts?)`
  //    renders the belt body. opts: { outerColor, beltColor, hilightColor,
  //    outerWidth = 9, beltWidth = 6 }.
  //
  //  drawOpenBelt(ctx, a, b, raPx, rbPx, beltOffsetPx, opts?)
  //    Calls openBeltPath(...).draw(ctx) plus N evenly-spaced phase dots
  //    advanced by `beltOffsetPx` (= ω·raPx for the drive pulley). opts
  //    forwarded to draw, plus { dotSpacing = 70, dotColor = "#f6c945",
  //    dotOutline = "#0d1013" }.
  // ---------------------------------------------------------------------------

  function openBeltPath(a, b, raPx, rbPx) {
    const dx = b.cx - a.cx, dy = b.cy - a.cy;
    const L = Math.hypot(dx, dy) || 1e-9;
    const ux = dx / L, uy = dy / L;
    const v1x = -uy,   v1y = ux;

    const sinA = (raPx - rbPx) / L;
    const alpha = Math.asin(Math.max(-1, Math.min(1, sinA)));
    const cosA = Math.cos(alpha);

    const aS1 = { x: a.cx + raPx * (sinA * ux + cosA * v1x),
                  y: a.cy + raPx * (sinA * uy + cosA * v1y) };
    const bS1 = { x: b.cx + rbPx * (sinA * ux + cosA * v1x),
                  y: b.cy + rbPx * (sinA * uy + cosA * v1y) };
    const aS2 = { x: a.cx + raPx * (sinA * ux - cosA * v1x),
                  y: a.cy + raPx * (sinA * uy - cosA * v1y) };
    const bS2 = { x: b.cx + rbPx * (sinA * ux - cosA * v1x),
                  y: b.cy + rbPx * (sinA * uy - cosA * v1y) };

    const Ltan = Math.hypot(bS1.x - aS1.x, bS1.y - aS1.y);
    const psiA = Math.PI + 2 * alpha;
    const psiB = Math.PI - 2 * alpha;
    const arcA = raPx * psiA;
    const arcB = rbPx * psiB;
    const total = 2 * Ltan + arcA + arcB;

    const angA1 = Math.atan2(aS1.y - a.cy, aS1.x - a.cx);
    const angA2 = Math.atan2(aS2.y - a.cy, aS2.x - a.cx);
    const angB1 = Math.atan2(bS1.y - b.cy, bS1.x - b.cx);
    const angB2 = Math.atan2(bS2.y - b.cy, bS2.x - b.cx);

    function arcDir(start, end, mid) {
      const TAU = 2 * Math.PI;
      const norm = (a) => ((a % TAU) + TAU) % TAU;
      const sweepCCW = norm(end - start);
      const midCCW = norm(mid - start);
      return midCCW < sweepCCW ? +1 : -1;
    }
    const farFromA_atB = Math.atan2( uy,  ux);
    const farFromB_atA = Math.atan2(-uy, -ux);
    const dirB = arcDir(angB1, angB2, farFromA_atB);
    const dirA = arcDir(angA2, angA1, farFromB_atA);

    function at(s) {
      s = ((s % total) + total) % total;
      if (s < Ltan) {
        const t = s / Ltan;
        return { x: aS1.x + (bS1.x - aS1.x) * t,
                 y: aS1.y + (bS1.y - aS1.y) * t };
      }
      s -= Ltan;
      if (s < arcB) {
        const t = s / arcB;
        const ang = angB1 + dirB * t * psiB;
        return { x: b.cx + rbPx * Math.cos(ang),
                 y: b.cy + rbPx * Math.sin(ang) };
      }
      s -= arcB;
      if (s < Ltan) {
        const t = s / Ltan;
        return { x: bS2.x + (aS2.x - bS2.x) * t,
                 y: bS2.y + (aS2.y - bS2.y) * t };
      }
      s -= Ltan;
      const t = s / arcA;
      const ang = angA2 + dirA * t * psiA;
      return { x: a.cx + raPx * Math.cos(ang),
               y: a.cy + raPx * Math.sin(ang) };
    }

    function draw(ctx, opts) {
      opts = opts || {};
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.strokeStyle = opts.outerColor || "#202833";
      ctx.lineWidth   = +opts.outerWidth || 9;
      ctx.beginPath();
      ctx.moveTo(aS1.x, aS1.y);
      ctx.lineTo(bS1.x, bS1.y);
      if (dirB > 0) ctx.arc(b.cx, b.cy, rbPx, angB1, angB1 + psiB, false);
      else          ctx.arc(b.cx, b.cy, rbPx, angB1, angB1 - psiB, true);
      ctx.lineTo(aS2.x, aS2.y);
      if (dirA > 0) ctx.arc(a.cx, a.cy, raPx, angA2, angA2 + psiA, false);
      else          ctx.arc(a.cx, a.cy, raPx, angA2, angA2 - psiA, true);
      ctx.closePath();
      ctx.stroke();
      ctx.strokeStyle = opts.beltColor || "#4a5460";
      ctx.lineWidth   = +opts.beltWidth || 6;
      ctx.stroke();
      ctx.strokeStyle = opts.hilightColor || "#6a7384";
      ctx.lineWidth   = 1;
      ctx.stroke();
    }

    return { at, total, draw };
  }

  function drawOpenBelt(ctx, a, b, raPx, rbPx, beltOffsetPx, opts) {
    opts = opts || {};
    const path = openBeltPath(a, b, raPx, rbPx);
    path.draw(ctx, opts);
    const spacing = +opts.dotSpacing || 70;
    const N = Math.max(4, Math.round(path.total / spacing));
    const dotColor    = opts.dotColor    || "#f6c945";
    const dotOutline  = opts.dotOutline  || "#0d1013";
    for (let k = 0; k < N; k++) {
      const s = (k / N) * path.total + (+beltOffsetPx || 0);
      const p = path.at(s);
      ctx.fillStyle = dotOutline;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = dotColor;
      ctx.beginPath(); ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
    return path;
  }

  LIB.BeltRender = { layout, beltPath, drawScene, openBeltPath, drawOpenBelt };
})();
