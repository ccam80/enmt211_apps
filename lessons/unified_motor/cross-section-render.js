(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  const TWO_PI = 2 * Math.PI;
  const MU0 = 4 * Math.PI * 1e-7;

  // Default circuit colour palette (used when no browser palette override is given)
  const DEFAULT_PALETTE = [
    "#4ea1ff", "#ef5350", "#66bb6a", "#ffd54a",
    "#ab47bc", "#26c6da", "#ff8a65", "#d4e157",
  ];

  // ---------------------------------------------------------------------------
  //  circuitColor(circuitIndex, nCircuits, palette = null) → hex
  //
  //  Returns the colour for circuit k. Uses the supplied palette when it is a
  //  non-empty array; otherwise falls back to DEFAULT_PALETTE. Wraps by
  //  palette.length (custom palette) or by nCircuits against DEFAULT_PALETTE
  //  so that circuitColor(k, n) === circuitColor(k + n, n) always holds.
  //  Never reads the DOM.
  // ---------------------------------------------------------------------------
  function circuitColor(circuitIndex, nCircuits, palette) {
    if (Array.isArray(palette) && palette.length > 0) {
      return palette[circuitIndex % palette.length];
    }
    const n = (nCircuits != null && nCircuits > 0) ? nCircuits : DEFAULT_PALETTE.length;
    const effectiveLen = Math.min(n, DEFAULT_PALETTE.length);
    return DEFAULT_PALETTE[circuitIndex % effectiveLen];
  }

  // ---------------------------------------------------------------------------
  //  resolveWinding(ring) → routing | null
  //
  //  Resolves ring.winding to a plain routing object. Supports both the explicit
  //  routing form and the { standard: { m,p,Q,coilPitch,turns } } shorthand.
  // ---------------------------------------------------------------------------
  function resolveWinding(ring) {
    const w = ring.winding;
    if (!w) return null;
    if (w.standard) {
      return LIB.WindingModel.standardWinding(w.standard);
    }
    return w;
  }

  // ---------------------------------------------------------------------------
  //  buildGeometry(config) → geom
  //
  //  Pure. Resolves each ring into draw-ready primitives (slots, teeth, magnets)
  //  with global circuit offsets matching Phase-5 expand().
  // ---------------------------------------------------------------------------
  function buildGeometry(config) {
    const rings = config.rings;
    let circuitBase = 0;
    const outRings = [];

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const el = ring.element;
      const outRing = {
        member: ring.member,
        element: el,
        rRange: ring.rRange,
        slots: [],
        teeth: [],
        magnets: [],
      };

      if (el === "W" || el === "C" || el === "K") {
        const routing = resolveWinding(ring);
        const ac = LIB.WindingModel.ampereConductors(routing);
        const nSlots = ac.nSlots;
        const nCircuits = ac.nCircuits;

        for (let s = 0; s < nSlots; s++) {
          const theta = routing.slotTheta[s];
          const conductors = [];
          for (let c = 0; c < nCircuits; c++) {
            const T = ac.turns[c * nSlots + s];
            if (T !== 0) {
              conductors.push({
                circuit: circuitBase + c,
                turns: T,
                glyph: T > 0 ? "dot" : "cross",
              });
            }
          }
          outRing.slots.push({ index: s, theta, conductors });
        }

        // C rings also emit teeth: one per slot, centred at the slot angle
        if (el === "C") {
          const spanFraction = ring.spanFraction != null ? ring.spanFraction : 0.5;
          for (let s = 0; s < nSlots; s++) {
            const thetaCenter = routing.slotTheta[s];
            const halfSpan = spanFraction * (Math.PI / nSlots);
            outRing.teeth.push({ index: s, thetaCenter, halfSpan });
          }
        }

        circuitBase += nCircuits;

      } else if (el === "I") {
        const count = ring.teeth != null ? ring.teeth : 1;
        const theta0 = ring.theta0 != null ? ring.theta0 : 0;
        const spanFraction = ring.spanFraction != null ? ring.spanFraction : 0.5;
        for (let t = 0; t < count; t++) {
          const thetaCenter = theta0 + t * TWO_PI / count;
          const halfSpan = spanFraction * (Math.PI / count);
          outRing.teeth.push({ index: t, thetaCenter, halfSpan });
        }

      } else if (el === "M") {
        const count = ring.magnets != null ? ring.magnets : 2;
        for (let g = 0; g < count; g++) {
          const theta0 = g * TWO_PI / count;
          const theta1 = (g + 1) * TWO_PI / count;
          const polarity = (g % 2 === 0) ? +1 : -1;
          outRing.magnets.push({ index: g, theta0, theta1, polarity });
        }
      }

      outRings.push(outRing);
    }

    return {
      rInner: config.grid.rInner,
      rOuter: config.grid.rOuter,
      nCircuits: circuitBase,
      rings: outRings,
    };
  }

  // ---------------------------------------------------------------------------
  //  compileForOverlay(config, sliceIndex = 0) → { compiled, grid }
  //
  //  Pure. Expands config via ConfigSchema, selects the section for sliceIndex,
  //  and rasterizes via MotorCompile. Returns the compiled object and its grid.
  // ---------------------------------------------------------------------------
  function compileForOverlay(config, sliceIndex) {
    if (sliceIndex == null) sliceIndex = 0;
    const exp = UM.ConfigSchema.expand(config);
    const section = exp.slices[sliceIndex].section;
    const compiled = LIB.MotorCompile.compile(section);
    return { compiled, grid: compiled.grid };
  }

  // ---------------------------------------------------------------------------
  //  drawSemantic(ctx2d, layout, geom, opts = {})
  //
  //  Draws the annulus background, per-ring slot wedges / tooth sectors / magnet
  //  N/S sectors, and conductor dot/cross glyphs coloured by circuitColor.
  //  layout is a LIB.Layout.rotational handle.
  // ---------------------------------------------------------------------------
  function drawSemantic(ctx2d, layout, geom, opts) {
    opts = opts || {};
    const palette = opts.palette != null ? opts.palette : null;
    const highlightRing = opts.highlightRing != null ? opts.highlightRing : null;
    const highlightSlots = opts.highlightSlots || [];
    const glyphRadiusPx = opts.glyphRadiusPx != null ? opts.glyphRadiusPx : 7;
    const lineWidth = opts.lineWidth != null ? opts.lineWidth : 1.5;

    const ctx = ctx2d;
    const scale = layout.scale;
    const originPx = layout.originPx;

    ctx.save();
    ctx.lineWidth = lineWidth;

    // Draw annulus background (air gap region)
    const rInnerPx = geom.rInner * scale;
    const rOuterPx = geom.rOuter * scale;
    ctx.beginPath();
    ctx.arc(originPx.x, originPx.y, rOuterPx, 0, TWO_PI);
    ctx.arc(originPx.x, originPx.y, rInnerPx, 0, TWO_PI, true);
    ctx.fillStyle = "rgba(180,200,220,0.18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(150,170,190,0.5)";
    ctx.stroke();

    for (let ri = 0; ri < geom.rings.length; ri++) {
      const ring = geom.rings[ri];
      const isHighlighted = (highlightRing === ri);
      const r0 = ring.rRange[0];
      const r1 = ring.rRange[1];
      const r0px = r0 * scale;
      const r1px = r1 * scale;

      // Draw ring background annulus
      ctx.beginPath();
      ctx.arc(originPx.x, originPx.y, r1px, 0, TWO_PI);
      ctx.arc(originPx.x, originPx.y, r0px, 0, TWO_PI, true);
      if (ring.element === "I" || ring.element === "M") {
        ctx.fillStyle = isHighlighted ? "rgba(120,130,160,0.35)" : "rgba(100,110,140,0.2)";
      } else {
        ctx.fillStyle = isHighlighted ? "rgba(60,80,120,0.25)" : "rgba(40,60,100,0.12)";
      }
      ctx.fill();

      // Draw magnet sectors (M rings)
      for (const mag of ring.magnets) {
        // theta0 is CCW from +x; canvas y is downward so we negate y in layout.polar
        const startAngle = mag.theta0;
        const endAngle = mag.theta1;
        ctx.beginPath();
        const p0 = layout.polar(r0, startAngle);
        const p1 = layout.polar(r1, startAngle);
        ctx.moveTo(p1.px, p1.py);
        // Arc outer edge: theta increases CCW (negative canvas angle from +x)
        // layout.polar uses: px = originPx.x + cos(theta)*r*scale, py = originPx.y - sin(theta)*r*scale
        // So angle in canvas coords is -theta (clockwise); use anticlockwise=true for CCW arc
        ctx.arc(originPx.x, originPx.y, r1px, -startAngle, -endAngle, true);
        const p2 = layout.polar(r0, endAngle);
        ctx.lineTo(p2.px, p2.py);
        ctx.arc(originPx.x, originPx.y, r0px, -endAngle, -startAngle, false);
        ctx.closePath();
        ctx.fillStyle = mag.polarity > 0 ? "rgba(220,60,60,0.75)" : "rgba(60,100,220,0.75)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.stroke();
      }

      // Draw tooth sectors (I and C rings)
      for (const tooth of ring.teeth) {
        const tStart = tooth.thetaCenter - tooth.halfSpan;
        const tEnd = tooth.thetaCenter + tooth.halfSpan;
        ctx.beginPath();
        ctx.arc(originPx.x, originPx.y, r1px, -tStart, -tEnd, true);
        ctx.arc(originPx.x, originPx.y, r0px, -tEnd, -tStart, false);
        ctx.closePath();
        ctx.fillStyle = isHighlighted ? "rgba(180,150,100,0.55)" : "rgba(160,130,80,0.4)";
        ctx.fill();
        ctx.strokeStyle = "rgba(200,170,120,0.5)";
        ctx.stroke();
      }

      // Draw slot wedges + conductor glyphs (W, C, K rings)
      if (ring.slots.length > 0) {
        const nSlots = ring.slots.length;
        const slotHalfAngle = Math.PI / nSlots * 0.45;
        for (let si = 0; si < ring.slots.length; si++) {
          const slot = ring.slots[si];
          const isHlSlot = highlightSlots.indexOf(si) >= 0;
          const tStart = slot.theta - slotHalfAngle;
          const tEnd = slot.theta + slotHalfAngle;

          // Slot wedge background
          ctx.beginPath();
          ctx.arc(originPx.x, originPx.y, r1px, -tStart, -tEnd, true);
          ctx.arc(originPx.x, originPx.y, r0px, -tEnd, -tStart, false);
          ctx.closePath();
          ctx.fillStyle = isHlSlot
            ? "rgba(255,220,80,0.35)"
            : (slot.conductors.length > 0 ? "rgba(30,50,80,0.35)" : "rgba(30,50,80,0.12)");
          ctx.fill();
          ctx.strokeStyle = "rgba(80,100,140,0.4)";
          ctx.stroke();

          // Conductor glyphs
          const rMid = (r0 + r1) / 2;
          const glyphPt = layout.polar(rMid, slot.theta);
          for (let ci = 0; ci < slot.conductors.length; ci++) {
            const cond = slot.conductors[ci];
            const color = circuitColor(cond.circuit, geom.nCircuits, palette);
            const offset = (slot.conductors.length > 1)
              ? (ci - (slot.conductors.length - 1) / 2) * (glyphRadiusPx * 2.2)
              : 0;

            // Offset along tangent direction (perpendicular to radial)
            const tangentAngle = slot.theta + Math.PI / 2;
            const gx = glyphPt.px + Math.cos(tangentAngle) * offset * layout.scale / layout.scale;
            const gy = glyphPt.py - Math.sin(tangentAngle) * offset * layout.scale / layout.scale;

            ctx.beginPath();
            ctx.arc(gx, gy, glyphRadiusPx, 0, TWO_PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.7)";
            ctx.lineWidth = 1.0;
            ctx.stroke();
            ctx.lineWidth = lineWidth;

            if (cond.glyph === "dot") {
              ctx.beginPath();
              ctx.arc(gx, gy, glyphRadiusPx * 0.35, 0, TWO_PI);
              ctx.fillStyle = "#fff";
              ctx.fill();
            } else {
              // cross
              const arm = glyphRadiusPx * 0.55;
              ctx.beginPath();
              ctx.moveTo(gx - arm, gy - arm);
              ctx.lineTo(gx + arm, gy + arm);
              ctx.moveTo(gx + arm, gy - arm);
              ctx.lineTo(gx - arm, gy + arm);
              ctx.strokeStyle = "#fff";
              ctx.lineWidth = 1.8;
              ctx.stroke();
              ctx.lineWidth = lineWidth;
            }
          }
        }
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawCompiledOverlay(ctx2d, layout, compiled, grid, opts = {})
  //
  //  Draws the rasterized-cell QA overlay: iron tint, magnetization arrows,
  //  and coil-mask outlines — all keyed to cell arrays from MotorCompile.
  // ---------------------------------------------------------------------------
  function drawCompiledOverlay(ctx2d, layout, compiled, grid, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.5;
    const vectorStride = opts.vectorStride != null ? opts.vectorStride : 2;
    const palette = opts.palette != null ? opts.palette : null;

    const ctx = ctx2d;
    const { Nr, Ntheta, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = TWO_PI / Ntheta;
    const scale = layout.scale;
    const originPx = layout.originPx;

    const nuThreshold = (1 / MU0) * 0.999;

    ctx.save();
    ctx.globalAlpha = alpha;

    for (let i = 0; i < Nr; i++) {
      const rCentre = rInner + (i + 0.5) * dr;
      const rCellPx0 = (rCentre - dr / 2) * scale;
      const rCellPx1 = (rCentre + dr / 2) * scale;

      for (let j = 0; j < Ntheta; j++) {
        const idx = i * Ntheta + j;
        const theta = (j + 0.5) * dtheta;
        const tStart = theta - dtheta / 2;
        const tEnd = theta + dtheta / 2;

        // Iron tint
        if (compiled.nu[idx] < nuThreshold) {
          ctx.beginPath();
          ctx.arc(originPx.x, originPx.y, rCellPx1, -tStart, -tEnd, true);
          ctx.arc(originPx.x, originPx.y, rCellPx0, -tEnd, -tStart, false);
          ctx.closePath();
          ctx.fillStyle = "rgba(180,140,80,0.6)";
          ctx.fill();
        }

        // Coil mask outlines
        for (let k = 0; k < compiled.coilMasks.length; k++) {
          if (compiled.coilMasks[k][idx] !== 0) {
            ctx.beginPath();
            ctx.arc(originPx.x, originPx.y, rCellPx1, -tStart, -tEnd, true);
            ctx.arc(originPx.x, originPx.y, rCellPx0, -tEnd, -tStart, false);
            ctx.closePath();
            ctx.strokeStyle = circuitColor(k, compiled.coilMasks.length, palette);
            ctx.lineWidth = 1.5;
            ctx.stroke();
          }
        }
      }
    }

    // Magnetization arrows (drawn after tints for visibility)
    ctx.globalAlpha = 1.0;
    for (let i = 0; i < Nr; i += vectorStride) {
      const rCentre = rInner + (i + 0.5) * dr;
      for (let j = 0; j < Ntheta; j += vectorStride) {
        const idx = i * Ntheta + j;
        const theta = (j + 0.5) * dtheta;
        const Mrv = compiled.magnetization.Mr[idx];
        const Mtv = compiled.magnetization.Mtheta[idx];
        const mag = Math.hypot(Mrv, Mtv);
        if (mag <= 0) continue;

        const pt = layout.polar(rCentre, theta);
        const arrowLen = Math.min(dr * scale * 1.5, 8);
        const arrowAngle = Math.atan2(Mtv, Mrv);
        // Rotate by theta to get world angle
        const worldAngle = theta + arrowAngle;
        const ax = Math.cos(worldAngle) * arrowLen;
        const ay = Math.sin(worldAngle) * arrowLen;

        ctx.beginPath();
        ctx.moveTo(pt.px - ax / 2, pt.py + ay / 2);
        ctx.lineTo(pt.px + ax / 2, pt.py - ay / 2);
        ctx.strokeStyle = "rgba(255,200,50,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — adds the compiled-overlay toggle header control.
  //  Guarded: only runs when UM.registerHeaderControl exists.
  // ---------------------------------------------------------------------------
  function register(UM_arg) {
    const target = UM_arg || UM;
    if (!target.registerHeaderControl) return;
    target.registerHeaderControl({
      id: "xsec-overlay",
      build: function (host, ctx) {
        const label = document.createElement("label");
        label.style.cssText = "display:inline-flex;align-items:center;gap:4px;cursor:pointer;font-size:0.85em";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!target._xsecOverlay;
        cb.addEventListener("change", function () {
          target._xsecOverlay = cb.checked;
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode("Compiled overlay"));
        host.appendChild(label);
        return function () {
          host.removeChild(label);
        };
      },
    });
  }

  // Auto-register when seams exist at load time (guarded)
  register(UM);

  UM.CrossSectionRender = {
    buildGeometry,
    circuitColor,
    compileForOverlay,
    drawSemantic,
    drawCompiledOverlay,
    register,
  };
})();
