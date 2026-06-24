(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});
  const TWO_PI = 2 * Math.PI;

  // These sprites draw in world units under a caller transform that scales world
  // → pixels (typically by thousands). A stroke's lineWidth is in world units, so
  // the default lineWidth of 1 renders thousands of pixels wide and floods the
  // canvas. Size every stroke in device pixels by dividing by the current
  // transform's scale (matches the 1/scale convention the field overlays use).
  function pxLineWidth(ctx, px) {
    if (typeof ctx.getTransform !== "function") return px;
    const m = ctx.getTransform();
    const s = Math.hypot(m.a, m.b) || 1;
    return px / s;
  }

  // Per-phase color cycle for winding conductors. Indexed by circuit number.
  const WIRE_PALETTE = [
    "#4ea1ff",
    "#ef5350",
    "#66bb6a",
    "#ffd54a",
    "#ab47bc",
    "#26c6da",
    "#ff8a65",
    "#d4e157",
  ];

  // ---------------------------------------------------------------------------
  //  drawIron(ctx, ironFeatures, opts)
  //
  //  Draws each iron feature as a filled, outlined annular sector.
  //  Full-annulus features (thetaRange spans >= 2pi) draw as plain rings.
  //  Sub-2pi features draw as annular sectors with a gap-side tooth-tip flare.
  //
  //  opts = {
  //    gapEdge: "outer" | "inner"   (which radial edge faces the air gap)
  //    fill:    css color           (default steel gray)
  //    stroke:  css color           (default slightly lighter)
  //    tipFlare: number             (default 1.25, angular width multiplier at tip)
  //    tipFrac:  number             (default 0.18, fraction of radial extent that flares)
  //  }
  // ---------------------------------------------------------------------------
  function drawIron(ctx, ironFeatures, opts) {
    if (!ironFeatures || ironFeatures.length === 0) return;
    opts = opts || {};
    const fill    = opts.fill   != null ? opts.fill   : "#6a6a7a";
    const stroke  = opts.stroke != null ? opts.stroke : "#9a9aaa";
    const gapEdge = opts.gapEdge || "outer";
    const tipFlare = opts.tipFlare != null ? opts.tipFlare : 1.25;
    const tipFrac  = opts.tipFrac  != null ? opts.tipFrac  : 0.18;

    for (const feat of ironFeatures) {
      const [r0, r1] = feat.rRange;
      const [t0, t1] = feat.thetaRange;
      const span = t1 - t0;

      ctx.beginPath();

      if (span >= TWO_PI - 1e-6) {
        // Full annulus: outer arc CCW, inner arc CW.
        ctx.arc(0, 0, r1, 0, TWO_PI, false);
        ctx.arc(0, 0, r0, TWO_PI, 0, true);
      } else {
        // Annular sector with optional tip flare on the gap-facing edge.
        // The gap edge is r1 when gapEdge="outer", r0 when gapEdge="inner".
        const radialExtent = r1 - r0;
        const flareDepth = tipFrac * radialExtent;

        // Determine which end is the gap edge and which is the back.
        const gapR  = gapEdge === "outer" ? r1 : r0;
        const backR = gapEdge === "outer" ? r0 : r1;

        // Angular half-width at the gap edge (flared) vs back edge (nominal).
        const nomHalf  = span / 2;
        const flarHalf = nomHalf * tipFlare;
        const tMid     = (t0 + t1) / 2;

        // Corner points of the sector polygon (world space, +y up convention).
        // We trace: gap edge arc (flared angular width), then side to back edge,
        // then back edge arc (nominal angular width), then side back.
        //
        // Divide radial extent into flare zone (tipFrac of extent from gap edge)
        // and body (rest). The flare transitions linearly from flarHalf at gapR
        // to nomHalf at gapR ± flareDepth.

        if (gapEdge === "outer") {
          // Transition radius between flare zone and body.
          const rTrans = r1 - flareDepth;

          // Path: start at (rTrans, tMid - flarHalf), go outward to gap edge,
          // arc CCW at r1 over flared angle, drop inward to rTrans, arc inward
          // to body corner, body arc CW at r0 over nominal angle, close.

          // Outer (gap) arc at r1, flared angular extent.
          const outerT0 = tMid - flarHalf;
          const outerT1 = tMid + flarHalf;

          // Transition arc at rTrans (nominal angular extent = same as back).
          const transT0 = tMid - nomHalf;
          const transT1 = tMid + nomHalf;

          // Back (inner) arc at r0, nominal angular extent.
          const innerT0 = transT0;
          const innerT1 = transT1;

          // Trace outer arc CCW (left edge → right edge).
          ctx.arc(0, 0, r1, outerT0, outerT1, false);
          // Line from outer right edge to transition right edge.
          ctx.lineTo(rTrans * Math.cos(transT1), rTrans * Math.sin(transT1));
          // Back arc CW (right → left).
          ctx.arc(0, 0, r0, innerT1, innerT0, true);
          // Line from inner left edge to outer left edge (closes the sector).
          ctx.lineTo(rTrans * Math.cos(transT0), rTrans * Math.sin(transT0));
          ctx.lineTo(r1 * Math.cos(outerT0), r1 * Math.sin(outerT0));
        } else {
          // gapEdge === "inner": gap is at r0.
          const rTrans = r0 + flareDepth;

          const innerT0 = tMid - flarHalf;
          const innerT1 = tMid + flarHalf;
          const transT0 = tMid - nomHalf;
          const transT1 = tMid + nomHalf;
          const outerT0 = transT0;
          const outerT1 = transT1;

          // Outer arc CCW at r1.
          ctx.arc(0, 0, r1, outerT0, outerT1, false);
          // Line to transition right.
          ctx.lineTo(rTrans * Math.cos(transT1), rTrans * Math.sin(transT1));
          // Gap arc CW at r0 (flared).
          ctx.arc(0, 0, r0, innerT1, innerT0, true);
          // Line to transition left then outer left.
          ctx.lineTo(rTrans * Math.cos(transT0), rTrans * Math.sin(transT0));
          ctx.lineTo(r1 * Math.cos(outerT0), r1 * Math.sin(outerT0));
        }
      }

      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = pxLineWidth(ctx, 1.5);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  //  drawMagnet(ctx, magnetFeatures, opts)
  //
  //  Fills each magnet annular-sector polygon.
  //  N poles (Mr >= 0) use nFill; S poles (Mr < 0) use sFill.
  //  A centred "N" or "S" label is drawn unless opts.label === false.
  //
  //  opts = { nFill, sFill, label }
  // ---------------------------------------------------------------------------
  function drawMagnet(ctx, magnetFeatures, opts) {
    if (!magnetFeatures || magnetFeatures.length === 0) return;
    opts = opts || {};
    const nFill = opts.nFill != null ? opts.nFill : "#e05050";
    const sFill = opts.sFill != null ? opts.sFill : "#5080e0";
    const showLabel = opts.label !== false;

    for (const feat of magnetFeatures) {
      const [r0, r1] = feat.rRange;
      const [t0, t1] = feat.thetaRange;
      const isN = feat.Mr >= 0;
      const color = isN ? nFill : sFill;

      // Annular sector path.
      ctx.beginPath();
      ctx.arc(0, 0, r1, t0, t1, false);
      ctx.arc(0, 0, r0, t1, t0, true);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      if (showLabel) {
        const tMid = (t0 + t1) / 2;
        const rMid = (r0 + r1) / 2;
        const lx = rMid * Math.cos(tMid);
        const ly = rMid * Math.sin(tMid);
        ctx.save();
        ctx.translate(lx, ly);
        ctx.scale(1, -1);
        // Font size is in world units (the caller scales world → pixels), so it
        // must be sized to the magnet, not left at the unscaled default — a
        // default ~10px font under a ×thousands transform renders thousands of
        // pixels tall and blankets the rotor.
        ctx.font = ((r1 - r0) * 0.6) + "px sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(isN ? "N" : "S", 0, 0);
        ctx.restore();
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  drawMagnetArrows(ctx, magnetFeatures, opts)
  //
  //  One magnetization arrow per magnet feature, from the sector centroid along
  //  the unit magnetization direction (Mr*r_hat + Mtheta*theta_hat) at the
  //  centroid angle. Length scales with |hypot(Mr,Mtheta)| normalized across
  //  the passed features. Each arrow has a shaft + two head segments.
  //
  //  opts = { arrowLen, color }
  // ---------------------------------------------------------------------------
  function drawMagnetArrows(ctx, magnetFeatures, opts) {
    if (!magnetFeatures || magnetFeatures.length === 0) return;
    opts = opts || {};
    const color    = opts.color    != null ? opts.color    : "rgba(255,220,60,0.95)";
    const arrowLen = opts.arrowLen != null ? opts.arrowLen : 0.004;

    // Normalize lengths by the maximum |M| across the feature set.
    let maxM = 0;
    for (const feat of magnetFeatures) {
      const m = Math.hypot(feat.Mr || 0, feat.Mtheta || 0);
      if (m > maxM) maxM = m;
    }
    if (maxM < 1e-30) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = pxLineWidth(ctx, 1.5);

    for (const feat of magnetFeatures) {
      const [r0, r1] = feat.rRange;
      const [t0, t1] = feat.thetaRange;
      const tMid = (t0 + t1) / 2;
      const rMid = (r0 + r1) / 2;

      // Centroid of the sector (approximate: midpoint of rMid and tMid).
      const cx = rMid * Math.cos(tMid);
      const cy = rMid * Math.sin(tMid);

      // Unit magnetization direction at the centroid angle.
      const Mr     = feat.Mr     || 0;
      const Mtheta = feat.Mtheta || 0;
      const mag = Math.hypot(Mr, Mtheta);
      if (mag < 1e-30) continue;

      // r_hat and theta_hat at centroid angle tMid.
      const rhatX   =  Math.cos(tMid);
      const rhatY   =  Math.sin(tMid);
      const thatX   = -Math.sin(tMid);
      const thatY   =  Math.cos(tMid);

      const ux = (Mr * rhatX + Mtheta * thatX) / mag;
      const uy = (Mr * rhatY + Mtheta * thatY) / mag;

      const frac = mag / maxM;
      const len  = arrowLen * frac;
      const tipX = cx + ux * len;
      const tipY = cy + uy * len;

      // Arrowhead: two segments at ±150 degrees from tip.
      const head = len * 0.4;
      const ang  = Math.atan2(uy, ux);
      const aL   = ang + Math.PI * 0.83;
      const aR   = ang - Math.PI * 0.83;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(aL) * head, tipY + Math.sin(aL) * head);
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(aR) * head, tipY + Math.sin(aR) * head);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawShaftAndGap(ctx, geom, opts)
  //
  //  Fills a solid shaft disc of radius shaftR and strokes an air-gap ring
  //  between gapInnerR and gapOuterR.
  //
  //  geom = { shaftR, gapInnerR, gapOuterR }
  //  opts = { shaftFill, gapStroke, gapAlpha }
  // ---------------------------------------------------------------------------
  function drawShaftAndGap(ctx, geom, opts) {
    opts = opts || {};
    const shaftFill  = opts.shaftFill  != null ? opts.shaftFill  : "#444455";
    const gapStroke  = opts.gapStroke  != null ? opts.gapStroke  : "rgba(120,200,255,0.3)";
    const { shaftR, gapInnerR, gapOuterR } = geom;

    // Shaft disc.
    if (shaftR > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, shaftR, 0, TWO_PI);
      ctx.fillStyle = shaftFill;
      ctx.fill();
    }

    // Air-gap ring: stroke inner and outer circles.
    if (gapInnerR > 0 && gapOuterR > gapInnerR) {
      ctx.save();
      ctx.strokeStyle = gapStroke;
      ctx.lineWidth = pxLineWidth(ctx, 1.2);
      ctx.beginPath();
      ctx.arc(0, 0, gapInnerR, 0, TWO_PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, gapOuterR, 0, TWO_PI);
      ctx.stroke();
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  //  drawWinding(ctx, conductorFeatures, mode, opts)
  //
  //  Draws individual conductor cross-sections into every slot, never a single
  //  filled slot rectangle.
  //
  //  mode: "distributed" | "concentrated"
  //  opts = {
  //    currents?:        Float64Array or Array of per-circuit current values
  //    showCurrentGlyph?: boolean (default false)
  //    palette?:         string[] (default WIRE_PALETTE)
  //    Ndist?:           number   (default 8, cap for distributed)
  //    Nconc?:           number   (default 10, cap for concentrated)
  //    wireR?:           number   (base wire radius in world units, default auto)
  //  }
  // ---------------------------------------------------------------------------
  function drawWinding(ctx, conductorFeatures, mode, opts) {
    if (!conductorFeatures || conductorFeatures.length === 0) return;
    opts = opts || {};
    const palette         = (Array.isArray(opts.palette) && opts.palette.length > 0)
                              ? opts.palette : WIRE_PALETTE;
    const Ndist           = opts.Ndist != null ? opts.Ndist : 8;
    const Nconc           = opts.Nconc != null ? opts.Nconc : 10;
    const currents        = opts.currents || null;
    const showCurrentGlyph = opts.showCurrentGlyph || false;

    for (const feat of conductorFeatures) {
      const [r0, r1] = feat.rRange;
      const [t0, t1] = feat.thetaRange;
      const circuit  = feat.circuit != null ? feat.circuit : 0;
      const turns    = feat.turns   != null ? feat.turns   : 1;
      const T        = Math.abs(Math.round(turns));

      // Wire color from the palette indexed by circuit.
      const colorIdx = ((circuit % palette.length) + palette.length) % palette.length;
      const wireColor = palette[colorIdx];

      // Polarity sign: static from turns sign; optionally modulated by current.
      let polarity = Math.sign(turns);
      if (showCurrentGlyph && currents != null) {
        const cur = (circuit >= 0 && circuit < currents.length) ? currents[circuit] : 0;
        if (cur !== 0) {
          polarity = Math.sign(turns * cur);
        } else {
          polarity = 0;
        }
      }

      if (mode === "distributed") {
        drawDistributedSlot(ctx, r0, r1, t0, t1, T, Ndist, wireColor, polarity, opts.wireR);
      } else {
        drawConcentratedSlot(ctx, r0, r1, t0, t1, T, Nconc, wireColor, polarity, opts.wireR);
      }
    }
  }

  // Draw v = min(Ndist, T) wires packed in a grid inside [r0,r1] x [t0,t1].
  function drawDistributedSlot(ctx, r0, r1, t0, t1, T, Ndist, color, polarity, wireROverride) {
    const v = Math.min(Ndist, T === 0 ? 1 : T);
    if (v <= 0) return;

    // Arrange v wires in a rectangular grid within the slot.
    // Determine row and column counts.
    const cols = Math.ceil(Math.sqrt(v));
    const rows = Math.ceil(v / cols);

    const rSpan = r1 - r0;
    const tSpan = t1 - t0;
    const rStep = rSpan / rows;
    const tStep = tSpan / cols;

    // Base wire radius: fit within cell, leave a small margin.
    const rMid  = (r0 + r1) / 2;
    const cellArcW = rMid * tStep;
    const cellRadH  = rStep;
    const autoWireR = 0.35 * Math.min(cellArcW, cellRadH);
    const wireR = wireROverride != null ? wireROverride : autoWireR;

    let drawn = 0;
    outer:
    for (let ri = 0; ri < rows; ri++) {
      for (let ci = 0; ci < cols; ci++) {
        if (drawn >= v) break outer;
        const r = r0 + (ri + 0.5) * rStep;
        const theta = t0 + (ci + 0.5) * tStep;
        const wx = r * Math.cos(theta);
        const wy = r * Math.sin(theta);
        drawWireDisc(ctx, wx, wy, wireR, color, polarity);
        drawn++;
      }
    }
  }

  // Draw a concentrated bundle of v = min(Nconc, T) wires laid along the slot
  // radial extent [r0, r1]. Each wire interval = (r1-r0)/v; centre at interval midpoint.
  // Outer (T mod v) wires carry base+1 turns; wire radius scales as sqrt(turnsOnWire).
  function drawConcentratedSlot(ctx, r0, r1, t0, t1, T, Nconc, color, polarity, wireROverride) {
    const v = Math.min(Nconc, T === 0 ? 1 : T);
    if (v <= 0) return;

    // Distribute turns: base turns per wire, remainder go to outer wires.
    const base      = Math.floor(T / v);
    const remainder = T - base * v;

    // Outer `remainder` wires carry base+1 turns. "Outer" = highest indices.
    const tMid   = (t0 + t1) / 2;
    const rSpan  = r1 - r0;
    const rStep  = rSpan / v;
    const baseTurns = base > 0 ? base : 1;

    // Base wire radius sized to fit comfortably in the interval.
    const rMidSlot = (r0 + r1) / 2;
    const tSpan = t1 - t0;
    const arcW  = rMidSlot * tSpan;
    const autoWireR = 0.35 * Math.min(arcW, rStep);
    const wireRBase = wireROverride != null ? wireROverride : autoWireR;

    for (let i = 0; i < v; i++) {
      const r = r0 + (i + 0.5) * rStep;
      const wx = r * Math.cos(tMid);
      const wy = r * Math.sin(tMid);

      // Wires are indexed from the inner end (i=0); outer wires have higher i.
      const outerStart = v - remainder;
      const turnsOnWire = (remainder > 0 && i >= outerStart) ? (base + 1) : base;
      const effectiveTurns = Math.max(turnsOnWire, 1);
      const scaledR = wireRBase * Math.sqrt(effectiveTurns / baseTurns);

      drawWireDisc(ctx, wx, wy, scaledR, color, polarity);
    }
  }

  // Draw a single wire disc with a polarity glyph.
  // polarity: +1 = dot (out of page), -1 = cross (into page), 0 = no glyph.
  function drawWireDisc(ctx, cx, cy, r, color, polarity) {
    // Disc fill.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TWO_PI);
    ctx.fillStyle = color;
    ctx.fill();

    // Polarity glyph.
    if (polarity > 0) {
      // Dot: small filled disc at centre (out of page).
      const d = r * 0.35;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(cx - d, cy - d, 2 * d, 2 * d);
    } else if (polarity < 0) {
      // Cross: two diagonal segments (into page).
      const arm = r * 0.6;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = pxLineWidth(ctx, 1.0);
      ctx.beginPath();
      ctx.moveTo(cx - arm, cy - arm);
      ctx.lineTo(cx + arm, cy + arm);
      ctx.moveTo(cx + arm, cy - arm);
      ctx.lineTo(cx - arm, cy + arm);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------
  LIB.CrossSectionSprite = {
    drawIron,
    drawMagnet,
    drawMagnetArrows,
    drawShaftAndGap,
    drawWinding,
    WIRE_PALETTE,
  };
})();
