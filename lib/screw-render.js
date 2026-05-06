"use strict";

// =============================================================================
//  LIB.ScrewRender — screw-thread geometry + canvas helpers shared across
//  the lead-screw, ball-screw, and whole-system lessons.
//
//  Public surface:
//
//    LIB.ScrewRender.startColor(k, starts) → "#rrggbb"
//    LIB.ScrewRender.startColorAlpha(k, starts, alpha) → "rgba(...)"
//        Per-start palette (mod-N over a fixed 6-entry table). Adjacent
//        threads on a multi-start screw render in different colours and the
//        same start tracks the same colour all the way around the loop.
//
//    LIB.ScrewRender.threadGeom(L, p, theta, phaseShiftPx)
//        Returns { reff, lead, leadPx, pitchPx, halfPitch, phase, phaseMod,
//                  phaseModBot, slantPx }. Visible-pitch is clamped so a
//        very fine pitch never collapses below ~12 px; pair with
//        `minRenderablePitch` to keep the slider above the same floor.
//        `p.pitch` is metres; `p.starts` is integer ≥ 1; `L.mToPx` from
//        `LIB.Layout.linearTrack`.
//
//    LIB.ScrewRender.drawShaft(ctx, L, p, theta, x0Px, x1Px, yMid, shaftHpx,
//                              phaseShiftPx)
//        Square-thread shaft with helical-flank parallelograms coloured per
//        start. Used by both lead- and ball-screw renderers.
//
//    LIB.ScrewRender.drawLeadNut(ctx, L, p, state, opts?)
//        Sliding-tooth nut with lash-amplified tooth offset. Calls drawShaft
//        internally so the caller doesn't need to. Returns
//        { nutCx, weightCyTop, yMid, top, bot } so the caller can place the
//        load and any callouts.
//        opts: { yMid? = L.trackY - 40, shaftHpx? = 48 }
//
//    LIB.ScrewRender.drawBallNut(ctx, L, p, state, opts?)
//        Recirculating-ball nut with helical balls in the working race and
//        per-start recirculation tubes above the collar. Calls drawShaft.
//        Returns { nutCx, weightCyTop }.
//        opts: { yMid? = L.trackY - 50, shaftHpx? = 44 }
//
//    LIB.ScrewRender.minRenderablePitch(canvas, starts, xLimit, fallbackMin)
//        Lower bound for a pitch slider's `dynMin` so the user can't pick
//        a value the renderer's visible-pitch clamp would silently floor.
//        Returns `fallbackMin` until the canvas has been laid out.
//
//  Zero dependencies (uses no other lib modules).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const START_COLORS = ["#f6c945", "#4ea1ff", "#66bb6a", "#ef5350", "#ab47bc", "#ff9800"];

  function startColor(k, starts) {
    const s = Math.max(1, starts | 0);
    const idx = ((k % s) + s) % s;
    return START_COLORS[idx % START_COLORS.length];
  }
  function startColorAlpha(k, starts, a) {
    const c = startColor(k, starts);
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function reff(p) { return (p.pitch * p.starts) / (2 * Math.PI); }

  function threadGeom(L, p, theta, phaseShiftPx) {
    const r = reff(p);
    const lead = r * 2 * Math.PI;
    const leadPx = Math.max(24, lead * L.mToPx);
    const pitchPx = Math.max(12, leadPx / p.starts);
    const halfPitch = pitchPx / 2;
    const phase = (theta / (2 * Math.PI)) * leadPx + (phaseShiftPx || 0);
    const phaseMod = ((phase % pitchPx) + pitchPx) % pitchPx;
    const topToBotOffset = (p.starts % 2 === 0) ? 0 : halfPitch;
    const phaseModBot = ((phase + topToBotOffset) % pitchPx + pitchPx) % pitchPx;
    const slantPx = halfPitch * p.starts;
    return { reff: r, lead, leadPx, pitchPx, halfPitch, phase, phaseMod, phaseModBot, slantPx };
  }

  function drawShaft(ctx, L, p, theta, x0Px, x1Px, yMid, shaftHpx, phaseShiftPx) {
    const halfH = shaftHpx / 2;
    const top = yMid - halfH;
    const bot = yMid + halfH;
    const G = threadGeom(L, p, theta, phaseShiftPx);
    const { pitchPx, halfPitch, phase, phaseMod, phaseModBot, slantPx } = G;
    const rootDepth = Math.min(8, Math.max(3, halfH * 0.28));

    function genEdgePoints(modPhase, yCrest, yRoot) {
      const tStart = ((x0Px - modPhase) % pitchPx + pitchPx) % pitchPx;
      const tEnd   = ((x1Px - modPhase) % pitchPx + pitchPx) % pitchPx;
      const startY = tStart < halfPitch ? yCrest : yRoot;
      const endY   = tEnd   < halfPitch ? yCrest : yRoot;
      const trans = [];
      const kFloor = Math.floor((x0Px - modPhase) / pitchPx) - 1;
      const kCeil  = Math.ceil ((x1Px - modPhase) / pitchPx) + 1;
      for (let k = kFloor; k <= kCeil; k++) {
        const xc = modPhase + k * pitchPx;
        const xv = xc + halfPitch;
        if (xc > x0Px && xc < x1Px) trans.push({ x: xc, fromY: yRoot,  toY: yCrest });
        if (xv > x0Px && xv < x1Px) trans.push({ x: xv, fromY: yCrest, toY: yRoot  });
      }
      trans.sort((a, b) => a.x - b.x);
      const pts = [[x0Px, startY]];
      for (const t of trans) { pts.push([t.x, t.fromY]); pts.push([t.x, t.toY]); }
      pts.push([x1Px, endY]);
      return pts;
    }

    const tPath = genEdgePoints(phaseMod,    top, top + rootDepth);
    const bPath = genEdgePoints(phaseModBot, bot, bot - rootDepth);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(tPath[0][0], tPath[0][1]);
    for (let i = 1; i < tPath.length; i++) ctx.lineTo(tPath[i][0], tPath[i][1]);
    ctx.lineTo(x1Px, bot);
    for (let i = bPath.length - 1; i >= 0; i--) ctx.lineTo(bPath[i][0], bPath[i][1]);
    ctx.lineTo(x0Px, top);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0,   "#1a1f28");
    grad.addColorStop(0.5, "#6f7a8a");
    grad.addColorStop(1,   "#0d1218");
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = "#2a313c";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0Px, top, x1Px - x0Px, shaftHpx);
    ctx.clip();
    const kStart = Math.floor((x0Px - phaseMod - slantPx) / pitchPx) - 1;
    const kEnd   = Math.ceil ((x1Px - phaseMod) / pitchPx) + 1;
    for (let k = kStart; k <= kEnd; k++) {
      const xc = phaseMod + k * pitchPx;
      const kAbs = Math.round((xc - phase) / pitchPx);
      ctx.fillStyle = startColorAlpha(kAbs, p.starts, 0.40);
      ctx.beginPath();
      ctx.moveTo(xc + halfPitch,           top + rootDepth);
      ctx.lineTo(xc + pitchPx,             top + rootDepth);
      ctx.lineTo(xc + pitchPx + slantPx,   bot - rootDepth);
      ctx.lineTo(xc + halfPitch + slantPx, bot - rootDepth);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = startColorAlpha(kAbs, p.starts, 0.9);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(xc + halfPitch,           top + rootDepth - 0.5);
      ctx.lineTo(xc + halfPitch + slantPx, bot - rootDepth + 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(xc + pitchPx,           top + rootDepth - 0.5);
      ctx.lineTo(xc + pitchPx + slantPx, bot - rootDepth + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawLeadNut(ctx, L, p, state, opts) {
    opts = opts || {};
    const yMid = (opts.yMid != null) ? +opts.yMid : (L.trackY - 40);
    const shaftHpx = (opts.shaftHpx != null) ? +opts.shaftHpx : 48;
    const halfH = shaftHpx / 2;
    const top = yMid - halfH;
    const bot = yMid + halfH;
    const rootDepth = Math.min(8, Math.max(3, halfH * 0.28));

    const r = reff(p);
    const psi = state.x - state.theta * r;
    const Hlash = p.lash / 2;
    const psiNorm = (Hlash > 1e-9) ? Math.max(-1, Math.min(1, psi / Hlash)) : 0;

    const nutCx = L.xToPx(state.x);
    const G = threadGeom(L, p, 0, 0);
    const { pitchPx, halfPitch, leadPx } = G;

    const lashPxPhys = p.lash * L.mToPx;
    const LASH_VIS_FLOOR = 6;
    const LASH_VIS_CEIL  = halfPitch * 0.6;
    const lashPxVis = (p.lash > 1e-9)
      ? Math.min(LASH_VIS_CEIL, Math.max(lashPxPhys, LASH_VIS_FLOOR))
      : 0;
    const Hpx = lashPxVis / 2;
    const visiblePsiPx = psiNorm * Hpx;
    const phaseShiftPx = nutCx - visiblePsiPx - 1.5 * halfPitch
                         - (state.theta / (2 * Math.PI)) * leadPx;

    const x0 = L.xToPx(L.xMin) - 4;
    const x1 = L.xToPx(L.xMax) + 4;
    drawShaft(ctx, L, p, state.theta, x0, x1, yMid, shaftHpx, phaseShiftPx);

    const nutW = 110, nutH = shaftHpx + 30;
    const nx = nutCx - nutW / 2;
    const ny = yMid - nutH / 2;

    ctx.save();
    ctx.fillStyle = "rgba(78, 161, 255, 0.08)";
    ctx.strokeStyle = "#4ea1ff";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(nx, ny, nutW, nutH); ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(nx + 1, ny + 1, nutW - 2, nutH - 2);
    ctx.clip();
    const halfTooth = (halfPitch - lashPxVis) / 2;
    const halfNutW = nutW / 2;
    const N_half = Math.ceil((halfNutW + halfPitch) / pitchPx);
    const botShift = (p.starts % 2 === 0) ? 0 : halfPitch;
    ctx.lineWidth = 1.5;
    for (let k = -N_half; k <= N_half; k++) {
      const tx = nutCx + k * pitchPx;
      if (tx < nx - halfPitch || tx > nx + nutW + halfPitch) continue;
      ctx.fillStyle = startColorAlpha(k, p.starts, 0.6);
      ctx.strokeStyle = startColor(k, p.starts);
      const tipYTop  = top + rootDepth;
      const baseYTop = ny + 5;
      ctx.beginPath();
      ctx.rect(tx - halfTooth, baseYTop, 2 * halfTooth, tipYTop - baseYTop);
      ctx.fill(); ctx.stroke();
      const txBot   = tx + botShift;
      const tipYBot = bot - rootDepth;
      const baseYBot = ny + nutH - 5;
      ctx.beginPath();
      ctx.rect(txBot - halfTooth, tipYBot, 2 * halfTooth, baseYBot - tipYBot);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();

    return { nutCx, weightCyTop: ny, yMid, top, bot };
  }

  function drawBallNut(ctx, L, p, state, opts) {
    opts = opts || {};
    const yMid = (opts.yMid != null) ? +opts.yMid : (L.trackY - 50);
    const shaftHpx = (opts.shaftHpx != null) ? +opts.shaftHpx : 44;
    const halfH = shaftHpx / 2;
    const top = yMid - halfH;
    const bot = yMid + halfH;
    const rootDepth = Math.min(8, Math.max(3, halfH * 0.28));

    const nutCx = L.xToPx(state.x);
    const Gtmp = threadGeom(L, p, 0, 0);
    const phaseShiftPx = nutCx - Gtmp.halfPitch
                         - (state.theta / (2 * Math.PI)) * Gtmp.leadPx;

    const x0 = L.xToPx(L.xMin) - 4;
    const x1 = L.xToPx(L.xMax) + 4;
    drawShaft(ctx, L, p, state.theta, x0, x1, yMid, shaftHpx, phaseShiftPx);

    const nutW = 110, nutH = shaftHpx + 40;
    const nx = nutCx - nutW / 2;
    const ny = yMid - nutH / 2 - 6;

    const { pitchPx, halfPitch, phase, slantPx } = threadGeom(L, p, 0, phaseShiftPx);
    const ballR = Math.max(3.5, Math.min(6, rootDepth + 1.5));
    const numStarts = Math.max(1, p.starts | 0);
    const tubeCy = top + rootDepth;

    const tubes = [];
    const tubeRxFull = nutW * 0.46;
    if (numStarts === 1) {
      const tubeRySingle = Math.min(tubeRxFull, nutW * 0.32);
      tubes.push({ tubeCx: nutCx, tubeRx: tubeRxFull, tubeRy: tubeRySingle, idx: 0 });
    } else {
      const tubeRyBase = Math.max(8, ballR + 3);
      const stackStepY = Math.max(6, Math.min(10, 50 / (numStarts - 1)));
      for (let i = 0; i < numStarts; i++) {
        tubes.push({
          tubeCx: nutCx, tubeRx: tubeRxFull,
          tubeRy: tubeRyBase + i * stackStepY,
          idx: i,
        });
      }
      tubes.sort((a, b) => b.tubeRy - a.tubeRy);
    }

    ctx.save();
    ctx.lineCap = "round";
    for (const tube of tubes) {
      ctx.strokeStyle = "#3a4453";
      ctx.lineWidth = Math.max(7, ballR * 1.6);
      ctx.beginPath();
      ctx.ellipse(tube.tubeCx, tubeCy, tube.tubeRx, tube.tubeRy, 0, Math.PI, 0, false);
      ctx.stroke();
      ctx.strokeStyle = startColorAlpha(tube.idx, p.starts, 0.8);
      ctx.lineWidth = Math.max(3, ballR * 0.9);
      ctx.beginPath();
      ctx.ellipse(tube.tubeCx, tubeCy, tube.tubeRx, tube.tubeRy, 0, Math.PI, 0, false);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "rgba(120, 150, 200, 0.10)";
    ctx.strokeStyle = "#a8b3c2";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(nx, ny, nutW, nutH); ctx.fill(); ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath(); ctx.rect(nx + 1, ny + 1, nutW - 2, nutH - 2);
    ctx.clip();
    function drawBall(bx, by, color) {
      ctx.fillStyle = color || "#c0c9d8";
      ctx.strokeStyle = "#1a2030";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx, by, ballR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.30)";
      ctx.beginPath(); ctx.arc(bx - ballR * 0.35, by - ballR * 0.35, ballR * 0.35, 0, Math.PI * 2); ctx.fill();
    }
    const xLeft = nx, xRight = nx + nutW;
    const yTop = top + rootDepth;
    const yBot = bot - rootDepth;
    const flankH = yBot - yTop;
    const BALLS_PER_FLANK = 4;
    const tFlow = ((phase % slantPx) + slantPx) % slantPx / slantPx;
    const sparseBalls = pitchPx < ballR * 2.5 + 2;
    const halfNutW = nutW / 2;
    const kBallSpan = Math.ceil((halfNutW + slantPx + halfPitch) / pitchPx) + 1;
    for (let k = -kBallSpan; k <= kBallSpan; k++) {
      if (sparseBalls && (((k % 2) + 2) % 2) !== 0) continue;
      const xt = nutCx + k * pitchPx;
      const col = startColor(k, p.starts);
      for (let j = 0; j < BALLS_PER_FLANK; j++) {
        const t = ((j / BALLS_PER_FLANK) + tFlow) % 1;
        const bx = xt + t * slantPx;
        const by = yTop + t * flankH;
        if (bx < xLeft + ballR * 0.5 || bx > xRight - ballR * 0.5) continue;
        drawBall(bx, by, col);
      }
    }
    ctx.restore();

    const tubePhase = ((phase % pitchPx) + pitchPx) % pitchPx;
    for (const tube of tubes) {
      const a = tube.tubeRx, b = tube.tubeRy;
      const tubeArcLen = (Math.PI / 2) * (3 * (a + b) - Math.sqrt((3*a + b) * (a + 3*b)));
      const NTube = Math.max(2, Math.round(tubeArcLen / Math.max(1, pitchPx)));
      const col = startColor(tube.idx, p.starts);
      for (let k = 0; k < NTube; k++) {
        if (sparseBalls && (((k % 2) + 2) % 2) !== 0) continue;
        const s = (k * pitchPx + tubePhase) % tubeArcLen;
        const t = s / tubeArcLen;
        const ang = Math.PI - t * Math.PI;
        const bx = tube.tubeCx + Math.cos(ang) * tube.tubeRx;
        const by = tubeCy - Math.abs(Math.sin(ang)) * tube.tubeRy;
        drawBall(bx, by, col);
      }
    }

    const tubeRyMax = tubes.reduce((m, t) => Math.max(m, t.tubeRy), 0);
    const tubeApex = tubeCy - tubeRyMax;
    return { nutCx, weightCyTop: Math.min(ny - 12, tubeApex - 4) };
  }

  // Lower bound for a pitch slider's `dynMin`. Without this, the user can
  // pick a pitch so fine that drawShaft's leadPx ≥ 24 / pitchPx ≥ 12 floors
  // engage and the rendering silently stops representing the real geometry.
  function minRenderablePitch(canvas, starts, xLimit, fallbackMin) {
    if (!canvas) return fallbackMin;
    const r = canvas.getBoundingClientRect();
    const padX = 60;
    if (r.width < 2 * padX + 8) return fallbackMin;
    const usableW = r.width - 2 * padX;
    const mToPx = usableW / (2 * xLimit);
    const s = Math.max(1, starts | 0);
    return Math.max(24, 12 * s) / (s * mToPx);
  }

  LIB.ScrewRender = {
    startColor, startColorAlpha,
    threadGeom, drawShaft,
    drawLeadNut, drawBallNut,
    minRenderablePitch,
  };
})();
