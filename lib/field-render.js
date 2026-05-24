"use strict";

// =============================================================================
//  LIB.FieldRender — magnetic-field visualisation for AC-motor lessons.
//
//  Three primitives, all driven against an LIB.Layout3D handle. Each takes a
//  Loop (LIB.EM.loop) plus its instantaneous current, and paints onto the
//  shared 2D canvas via the projection.
//
//    LIB.FieldRender.drawLoopFieldLines(ctx, L3, loop, opts)
//      Stroked dipole-style field lines emerging from the loop's N pole and
//      closing into its S pole. Geometry is the analytic dipole solution
//      r = α·sin²(θ) traced in the loop's local frame, then transformed via
//      loop.{u,v,n} to world coords and projected.
//
//      Lines render at FIXED alpha — the way physical-textbook field-line
//      diagrams convey magnitude is by changing the *density* of drawn lines
//      (lines per unit cross-section), not their intensity. The total line
//      pool is `azSlices · alphaScales.length`; we draw the first
//      round(density · pool) lines, ordered slice-major from the smallest α
//      outward, so weak-field views show only the inner dipole loop and
//      stronger-field views add the wider arcs.
//
//      opts:
//        color        per-loop tint (defaults to "#4ea1ff")
//        visible      bool, defaults true; lesson toggles from a slider/btn
//        density      0..1 — fraction of the line pool to actually draw.
//                     The lesson typically passes |current|/Imax.
//        alpha        fixed line alpha (default 0.75)
//        lineWidth    px (default 1.4)
//        azSlices     number of azimuthal slices around loop axis (default 6)
//        alphaScales  array of α/loop.radius ratios (one line per ratio per
//                     azimuthal slice). Default [1.5, 2.2, 3.2].
//        nTheta       sample count per line (default 56)
//        thetaPad     keep θ away from the polar singularities by this many
//                     radians at each end (default 0.06)
//
//    LIB.FieldRender.drawMomentArrow(ctx, L3, loop, current, opts)
//      Big arrow drawn at the loop's geometric centre, pointing along the
//      magnetic moment direction (signed by current). Length is a fraction of
//      |current|/imax. Used to give an at-a-glance polarity readout next to
//      each coil.
//
//      opts:
//        color, current   — current is implicit in the third arg
//        imax             — for length normalisation
//        scale            — fraction of (imax · loop.radius · 1.6) for max length (default 1.0)
//        minLenPx         — pixels below which the arrow is suppressed (default 8)
//        lineWidth        — default 3
//        head             — arrowhead size (default 12 px)
//        label            — optional string drawn past the head
//
//    LIB.FieldRender.drawBarMagnet(ctx, L3, loop, current, opts)
//      Stylised N/S bar magnet centred on the loop and oriented along the
//      magnetic moment. Lessons that want the "magnet" idiom rather than
//      field-line spaghetti toggle this in place of drawLoopFieldLines.
//
//      opts:
//        current
//        lengthFactor   bar length / loop.radius (default 2.4)
//        widthPx        bar width in screen pixels (default 14)
//        northColor     red half (default "#ef5350")
//        southColor     blue half (default "#26c6da")
//        showLabels     bool (default true) — paints "N"/"S" at the ends
//        outline        edge stroke colour (default "rgba(255,255,255,0.5)")
//
//  Dependencies: lib/util.js, lib/layout3d.js, lib/em-physics.js, lib/draw.js.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Util)     throw new Error("LIB.FieldRender requires lib/util.js");
  if (!LIB.Layout3D) throw new Error("LIB.FieldRender requires lib/layout3d.js");
  if (!LIB.EM)       throw new Error("LIB.FieldRender requires lib/em-physics.js");
  if (!LIB.Draw)     throw new Error("LIB.FieldRender requires lib/draw.js");

  // ---------------------------------------------------------------------------
  //  small helpers
  // ---------------------------------------------------------------------------

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function withAlpha(rgbHex, a) {
    // Accepts "#rrggbb" or "rgba(...)" / named — for hex we pad to "rrggbbAA",
    // for everything else we wrap via globalAlpha at the call site instead.
    if (typeof rgbHex !== "string") return rgbHex;
    if (rgbHex.length === 7 && rgbHex[0] === "#") {
      const aa = Math.round(clamp01(a) * 255).toString(16).padStart(2, "0");
      return rgbHex + aa;
    }
    return rgbHex;
  }

  // Convert local-frame point (x_u, x_v, x_n) into world coords using a loop's
  // basis. Loops carry orthonormal {u, v, n}.
  function localToWorld(loop, xu, xv, xn) {
    const c = loop.center, u = loop.u, v = loop.v, n = loop.n;
    return {
      x: c.x + xu * u.x + xv * v.x + xn * n.x,
      y: c.y + xu * u.y + xv * v.y + xn * n.y,
      z: c.z + xu * u.z + xv * v.z + xn * n.z,
    };
  }

  // ---------------------------------------------------------------------------
  //  drawLoopFieldLines
  //
  //  For each azimuthal slice φ around the loop axis and each scale α, trace
  //  the dipole field line:
  //     ρ(θ) = α · sin³(θ)
  //     z(θ) = α · sin²(θ) · cos(θ)        θ ∈ (ε, π − ε)
  //  Lift to 3D (x_u, x_v, x_n) = (ρ cosφ, ρ sinφ, z), transform via loop's
  //  basis, project, stroke. Lines are tinted by per-loop colour and modulated
  //  in alpha by current magnitude so quiet coils fade out instead of cluttering
  //  the scene.
  // ---------------------------------------------------------------------------

  function drawLoopFieldLines(ctx, L3, loop, opts) {
    opts = opts || {};
    if (opts.visible === false) return;
    const color       = opts.color     || "#4ea1ff";
    const density     = Math.max(0, Math.min(1, +opts.density || 0));
    const alpha       = (opts.alpha     != null) ? +opts.alpha     : 0.75;
    const lineWidth   = (opts.lineWidth != null) ? +opts.lineWidth : 1.4;
    const azSlices    = Math.max(1, Math.round(+opts.azSlices || 6));
    const scales      = Array.isArray(opts.alphaScales)
                          ? opts.alphaScales.slice()
                          : [1.5, 2.2, 3.2];
    const nTheta      = Math.max(8, Math.round(+opts.nTheta || 56));
    const thetaPad    = (opts.thetaPad != null) ? +opts.thetaPad : 0.06;

    const total       = azSlices * scales.length;
    const active      = Math.round(density * total);
    if (active <= 0 || alpha <= 0) return;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    ctx.globalAlpha = alpha;

    const dPhi = 2 * Math.PI / azSlices;
    const dTh  = (Math.PI - 2 * thetaPad) / (nTheta - 1);
    // Slice-major ordering: the k-th line is at azimuthal slot (k mod azSlices)
    // and scale index ⌊k/azSlices⌋. So a low-density draw covers all azimuths
    // at the smallest α first, then adds the next α-shell as density rises.
    for (let k = 0; k < active; k++) {
      const s        = k % azSlices;
      const scaleIdx = Math.floor(k / azSlices);
      if (scaleIdx >= scales.length) break;
      const cphi = Math.cos(s * dPhi);
      const sphi = Math.sin(s * dPhi);
      const a    = scales[scaleIdx] * loop.radius;
      ctx.beginPath();
      let started = false;
      let prevBehind = true;
      for (let i = 0; i < nTheta; i++) {
        const th = thetaPad + i * dTh;
        const sin = Math.sin(th), cos = Math.cos(th);
        const rho = a * sin * sin * sin;
        const zL  = a * sin * sin * cos;
        const wp  = localToWorld(loop, rho * cphi, rho * sphi, zL);
        const sp  = L3.project(wp);
        if (sp.behind) { prevBehind = true; continue; }
        if (!started || prevBehind) { ctx.moveTo(sp.px, sp.py); started = true; }
        else                        { ctx.lineTo(sp.px, sp.py); }
        prevBehind = false;
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawMomentArrow
  //
  //  Big screen-space arrow at the loop centre pointing along (sign of current)
  //  · loop.n. Magnitude → length normalised by imax. Drawn in two strokes so
  //  it's legible against busy field-line backgrounds: a wider dim halo, then
  //  the bright core.
  // ---------------------------------------------------------------------------

  function drawMomentArrow(ctx, L3, loop, current, opts) {
    opts = opts || {};
    const I       = +current || 0;
    const imax    = (opts.imax != null && +opts.imax > 0) ? +opts.imax : 1;
    const scale   = (opts.scale != null) ? +opts.scale : 1.0;
    const minLen  = (opts.minLenPx != null) ? +opts.minLenPx : 8;
    const color   = opts.color || "#ffd54a";
    const halo    = opts.haloColor || "rgba(0,0,0,0.55)";
    const lineW   = (opts.lineWidth != null) ? +opts.lineWidth : 3;
    const head    = (opts.head != null) ? +opts.head : 12;

    const sign = Math.sign(I) || 0;
    if (sign === 0) return;
    const mag  = Math.min(1, Math.abs(I) / imax);
    if (mag <= 0) return;

    // Project both ends of the world-space arrow then stroke in screen space.
    // The "world tip" sits at center + sign·n·(scale · imaxRefLen).
    // imaxRefLen is loop.radius · 1.8 by default — half-length of the arrow at
    // peak current is 1.8 loop radii, plenty visible without overshooting.
    const imaxRefLen = loop.radius * 1.8 * scale;
    const tipWorld = {
      x: loop.center.x + sign * loop.n.x * imaxRefLen * mag,
      y: loop.center.y + sign * loop.n.y * imaxRefLen * mag,
      z: loop.center.z + sign * loop.n.z * imaxRefLen * mag,
    };
    const a = L3.project(loop.center);
    const b = L3.project(tipWorld);
    if (a.behind || b.behind) return;
    if (Math.hypot(b.px - a.px, b.py - a.py) < minLen) return;

    LIB.Draw.arrow(ctx, a.px, a.py, b.px, b.py, {
      color: halo, width: lineW + 3, head: head + 3,
    });
    LIB.Draw.arrow(ctx, a.px, a.py, b.px, b.py, {
      color, width: lineW, head, label: opts.label, fontSize: opts.fontSize,
    });
  }

  // ---------------------------------------------------------------------------
  //  drawBarMagnet
  //
  //  Two-tone bar centred on the loop, axis along the magnetic moment.
  //  Foreshortens correctly under the perspective camera because we project
  //  both end-points and stroke a thick screen-space line between them. A
  //  perpendicular cap-line gives the rectangle shape, end labels mark N/S.
  //  When current is negative, N and S swap (the magnet flips with the AC
  //  cycle).
  // ---------------------------------------------------------------------------

  function drawBarMagnet(ctx, L3, loop, current, opts) {
    opts = opts || {};
    const I = +current || 0;
    if (I === 0 && !opts.alwaysShow) return;
    const lengthFactor = (opts.lengthFactor != null) ? +opts.lengthFactor : 2.4;
    const widthPx      = (opts.widthPx      != null) ? +opts.widthPx      : 14;
    const northColor   = opts.northColor || "#ef5350";
    const southColor   = opts.southColor || "#26c6da";
    const outline      = opts.outline    || "rgba(232,238,247,0.65)";
    const showLabels   = opts.showLabels !== false;

    const sign  = Math.sign(I) || 1;
    const half  = loop.radius * lengthFactor * 0.5;
    // North pole is on the +n side when current is positive (right-hand rule).
    const nx = loop.n.x, ny = loop.n.y, nz = loop.n.z;
    const nWorld = { x: loop.center.x + sign * nx * half,
                     y: loop.center.y + sign * ny * half,
                     z: loop.center.z + sign * nz * half };
    const sWorld = { x: loop.center.x - sign * nx * half,
                     y: loop.center.y - sign * ny * half,
                     z: loop.center.z - sign * nz * half };
    const cWorld = loop.center;

    const np = L3.project(nWorld);
    const sp = L3.project(sWorld);
    const cp = L3.project(cWorld);
    if (np.behind || sp.behind || cp.behind) return;

    ctx.save();
    ctx.lineCap = "butt";
    // South half — from south end to centre.
    ctx.strokeStyle = southColor;
    ctx.lineWidth   = widthPx;
    ctx.beginPath();
    ctx.moveTo(sp.px, sp.py);
    ctx.lineTo(cp.px, cp.py);
    ctx.stroke();
    // North half.
    ctx.strokeStyle = northColor;
    ctx.beginPath();
    ctx.moveTo(cp.px, cp.py);
    ctx.lineTo(np.px, np.py);
    ctx.stroke();
    // Outline the whole bar with a thin stroke to lift it off the background.
    ctx.strokeStyle = outline;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(sp.px, sp.py);
    ctx.lineTo(np.px, np.py);
    ctx.stroke();
    ctx.restore();

    if (showLabels) {
      const fs = (LIB.Type && LIB.Type.current && LIB.Type.current.md) || 12;
      ctx.save();
      ctx.font = `700 ${fs}px ui-sans-serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#0d1013";
      ctx.fillText("N", np.px, np.py);
      ctx.fillText("S", sp.px, sp.py);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  //  drawVectorArrow — general world-space arrow from `origin` along `vec`,
  //  signed by sign(|vec|), length scaled by |vec| / refMag * refLen.
  //  Used for resultant-field arrows (vector sum of per-winding contributions)
  //  and any other "this many world units in this direction" callout.
  //
  //  drawTorqueArrow — convenience wrapper that scales a scalar τ by an
  //  axis-direction unit vector and a tauRef magnitude. Used to paint a yellow
  //  τ arrow along the rotor's rotation axis.
  // ---------------------------------------------------------------------------

  function drawVectorArrow(ctx, L3, vec, opts) {
    opts = opts || {};
    const origin = opts.origin || { x: 0, y: 0, z: 0 };
    const refMag = (opts.refMag != null && +opts.refMag > 0) ? +opts.refMag : 1;
    const refLen = (opts.refLen != null) ? +opts.refLen : 1.0;
    const minLen = (opts.minLenPx != null) ? +opts.minLenPx : 8;
    const color  = opts.color  || "#ffd54a";
    const halo   = opts.haloColor || "rgba(0,0,0,0.55)";
    const lineW  = (opts.lineWidth != null) ? +opts.lineWidth : 3;
    const head   = (opts.head != null) ? +opts.head : 12;

    const mag = Math.hypot(vec.x, vec.y, vec.z);
    if (mag <= 1e-12) return;
    const lengthFrac = Math.min(1, mag / refMag);
    const k = lengthFrac * refLen / mag;
    const tip = {
      x: origin.x + vec.x * k,
      y: origin.y + vec.y * k,
      z: origin.z + vec.z * k,
    };
    const a = L3.project(origin);
    const b = L3.project(tip);
    if (a.behind || b.behind) return;
    if (Math.hypot(b.px - a.px, b.py - a.py) < minLen) return;
    LIB.Draw.arrow(ctx, a.px, a.py, b.px, b.py, {
      color: halo, width: lineW + 3, head: head + 3,
    });
    LIB.Draw.arrow(ctx, a.px, a.py, b.px, b.py, {
      color, width: lineW, head, label: opts.label, fontSize: opts.fontSize,
    });
  }

  function drawTorqueArrow(ctx, L3, tau, opts) {
    opts = opts || {};
    const axis = opts.axis || { x: 1, y: 0, z: 0 };
    drawVectorArrow(ctx, L3,
      { x: axis.x * tau, y: axis.y * tau, z: axis.z * tau },
      {
        origin:    opts.origin,
        refMag:    (opts.tauRef != null) ? +opts.tauRef : 1,
        refLen:    (opts.refLen != null) ? +opts.refLen : 0.9,
        color:     opts.color || "#ffd54a",
        haloColor: opts.haloColor,
        lineWidth: (opts.lineWidth != null) ? +opts.lineWidth : 3,
        head:      (opts.head != null) ? +opts.head : 12,
        label:     opts.label != null ? opts.label : "τ",
        fontSize:  opts.fontSize,
        minLenPx:  opts.minLenPx,
      });
  }

  // ---------------------------------------------------------------------------
  //  drawGapField — gap-field annulus heatmap + optional B-vector arrows.
  //
  //  Paints the air-gap magnetic field as a heatmap (each grid cell coloured by
  //  |B| = sqrt(Br²+Bt²)) projected through an LIB.Layout3D handle, plus
  //  optional vector arrows sampled every vectorStride cells.
  //
  //  Parameters:
  //    ctx       — 2D canvas rendering context.
  //    L3        — LIB.Layout3D handle (any kind supporting .project(p)).
  //    fieldData — { Br, Bt } Float64Arrays of length Nr·Ntheta, row-major
  //                idx = i*Ntheta + j (as returned by slice.solve().field).
  //    geom      — { Nr, Ntheta, r, rInner, rOuter, planeZ=0, axis="z" }
  //                r is Float64Array(Nr) of cell-centre radii.
  //    opts      — { alpha=0.85, vectors=true, vectorStride=8, magScale=null,
  //                  colorLo="#0d1013", colorHi="#ffd54a" }
  //
  //  Cell (i,j) occupies the annular sector:
  //    r ∈ [ r[i]-dr/2, r[i]+dr/2 ],  θ ∈ [ θ_j-dθ/2, θ_j+dθ/2 ]
  //  where θ_j = (j+0.5)·2π/Ntheta.
  //
  //  World coords: x = r·cos(θ), y = r·sin(θ), z = planeZ (transverse plane).
  //
  //  Dependency: LIB.Util.lerpColor, LIB.Layout3D (via L3), LIB.FieldRender.drawVectorArrow.
  // ---------------------------------------------------------------------------

  function drawGapField(ctx, L3, fieldData, geom, opts) {
    opts = opts || {};
    const Nr          = geom.Nr;
    const Ntheta      = geom.Ntheta;
    const r           = geom.r;
    const rInner      = geom.rInner;
    const rOuter      = geom.rOuter;
    const planeZ      = (geom.planeZ != null) ? geom.planeZ : 0;
    const alpha       = (opts.alpha != null) ? opts.alpha : 0.85;
    const doVectors   = (opts.vectors !== false);
    const vecStride   = (opts.vectorStride != null) ? Math.max(1, opts.vectorStride) : 8;
    const colorLo     = opts.colorLo || "#0d1013";
    const colorHi     = opts.colorHi || "#ffd54a";
    const Br          = fieldData.Br;
    const Bt          = fieldData.Bt;

    const dTheta = 2 * Math.PI / Ntheta;

    // Determine magScale — either supplied or auto-scaled to max|B|.
    let magScale = (opts.magScale != null) ? opts.magScale : null;
    if (magScale === null || magScale <= 0) {
      let maxB = 0;
      for (let k = 0; k < Nr * Ntheta; k++) {
        const bMag = Math.sqrt(Br[k] * Br[k] + Bt[k] * Bt[k]);
        if (bMag > maxB) maxB = bMag;
      }
      magScale = (maxB > 0) ? maxB : 1;
    }

    // Precompute radial boundaries for each row.
    // Use midpoints between adjacent r values; clamp to [rInner, rOuter].
    const rLo = new Float64Array(Nr);
    const rHi = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) {
      rLo[i] = (i === 0)       ? rInner : 0.5 * (r[i - 1] + r[i]);
      rHi[i] = (i === Nr - 1)  ? rOuter : 0.5 * (r[i] + r[i + 1]);
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // Draw each annular cell as a projected quad (4 corner points).
    for (let i = 0; i < Nr; i++) {
      const r0 = rLo[i];
      const r1 = rHi[i];
      for (let j = 0; j < Ntheta; j++) {
        const idx  = i * Ntheta + j;
        const bMag = Math.sqrt(Br[idx] * Br[idx] + Bt[idx] * Bt[idx]);

        // The four angular corners of this cell.
        const thLo = j * dTheta;
        const thHi = (j + 1) * dTheta;
        const cosLo = Math.cos(thLo), sinLo = Math.sin(thLo);
        const cosHi = Math.cos(thHi), sinHi = Math.sin(thHi);

        // Corners in world space: (r, theta) → (x, y, z).
        const c0 = { x: r0 * cosLo, y: r0 * sinLo, z: planeZ };
        const c1 = { x: r1 * cosLo, y: r1 * sinLo, z: planeZ };
        const c2 = { x: r1 * cosHi, y: r1 * sinHi, z: planeZ };
        const c3 = { x: r0 * cosHi, y: r0 * sinHi, z: planeZ };

        const p0 = L3.project(c0);
        const p1 = L3.project(c1);
        const p2 = L3.project(c2);
        const p3 = L3.project(c3);

        // Skip cells whose projected corners are all behind the camera.
        if (p0.behind && p1.behind && p2.behind && p3.behind) continue;

        const t = clamp01(bMag / magScale);
        ctx.fillStyle = LIB.Util.lerpColor(colorLo, colorHi, t);

        ctx.beginPath();
        ctx.moveTo(p0.px, p0.py);
        ctx.lineTo(p1.px, p1.py);
        ctx.lineTo(p2.px, p2.py);
        ctx.lineTo(p3.px, p3.py);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();

    // Draw B-vector arrows sampled every vecStride cells.
    if (doVectors) {
      const refMag = magScale;
      // Pick a reference length in world units proportional to the annulus size.
      const refLen = (rOuter - rInner) * 0.8 * vecStride / Ntheta * Ntheta;

      for (let i = 0; i < Nr; i++) {
        for (let j = 0; j < Ntheta; j++) {
          const idx = i * Ntheta + j;
          if (idx % vecStride !== 0) continue;

          const br = Br[idx];
          const bt = Bt[idx];

          // Cell-centre angle.
          const thC  = (j + 0.5) * dTheta;
          const cosC = Math.cos(thC);
          const sinC = Math.sin(thC);

          // World-space B-vector: radial Br in (cosC, sinC, 0) direction +
          // tangential Bt in (-sinC, cosC, 0) direction.
          const vecW = {
            x: br * cosC + bt * (-sinC),
            y: br * sinC + bt * cosC,
            z: 0,
          };

          // Origin at cell centre.
          const origin = { x: r[i] * cosC, y: r[i] * sinC, z: planeZ };

          drawVectorArrow(ctx, L3, vecW, {
            origin,
            refMag,
            refLen,
            color:     colorHi,
            lineWidth: 1.2,
            head:      5,
            minLenPx:  3,
          });
        }
      }
    }
  }

  LIB.FieldRender = {
    drawLoopFieldLines,
    drawMomentArrow,
    drawBarMagnet,
    drawVectorArrow,
    drawTorqueArrow,
    drawGapField,
  };
})();
