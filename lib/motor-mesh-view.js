(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // ---------------------------------------------------------------------------
  //  colorFor(matId, materials) → cssColorString
  //  Pure function — no DOM access. Distinct colors per material kind.
  // ---------------------------------------------------------------------------

  const KIND_COLORS = {
    air:       "#d0e8ff",
    iron:      "#7a7a8a",
    magnet:    "#e05050",
    conductor: "#f0a020",
  };

  // Palette cycling for multiple materials of the same kind
  const KIND_PALETTE = {
    air:       ["#d0e8ff", "#c0d8ef"],
    iron:      ["#7a7a8a", "#5a5a6a", "#9a9aaa", "#4a4a5a"],
    magnet:    ["#e05050", "#c03030", "#ff7070", "#a01010"],
    conductor: ["#f0a020", "#d08010", "#ffb030", "#b06000"],
  };

  function colorFor(matId, materials) {
    if (!materials || matId < 0 || matId >= materials.length) {
      return KIND_COLORS.air;
    }
    const mat = materials[matId];
    const kind = mat.kind || "air";
    const palette = KIND_PALETTE[kind] || [KIND_COLORS[kind] || "#888888"];
    // Cycle within kind
    const kindIdx = materials.filter((m, i) => i <= matId && m.kind === kind).length - 1;
    return palette[kindIdx % palette.length];
  }

  // ---------------------------------------------------------------------------
  //  draw(ctx, bodyMesh, opts) → void
  //
  //  Fills one polygon per element, strokes edges, overlays gapLoop when
  //  opts.showGapLoop is true.
  //
  //  opts = { showGapLoop: true, colorBy: "material"|"circuit", palette }
  // ---------------------------------------------------------------------------

  // Derive a pole-sign color for a magnet element from its magDir.
  // The radial unit at the element centroid is (cos θ_c, sin θ_c). The radial
  // component of magDir is magDir · radialUnit; its sign distinguishes N from S poles.
  // Returns a warm red for positive radial component, a cool blue for negative.
  function magnetPoleColor(bodyMesh, e) {
    const { nodes, elems, magDir } = bodyMesh;
    const n0 = elems[4 * e], n1 = elems[4 * e + 1], n2 = elems[4 * e + 2];
    const n3 = elems[4 * e + 3];
    const count = n3 === -1 ? 3 : 4;
    let cx = 0, cy = 0;
    for (let k = 0; k < count; k++) {
      const ni = elems[4 * e + k];
      cx += nodes[2 * ni];
      cy += nodes[2 * ni + 1];
    }
    cx /= count;
    cy /= count;
    const r = Math.hypot(cx, cy);
    if (r < 1e-12) return "#e05050";
    const rux = cx / r, ruy = cy / r;
    const mdx = magDir[2 * e], mdy = magDir[2 * e + 1];
    const radialDot = mdx * rux + mdy * ruy;
    return radialDot >= 0 ? "#e05050" : "#5080e0";
  }

  function draw(ctx, bodyMesh, opts) {
    opts = opts || {};
    const showGapLoop = opts.showGapLoop !== false;  // default true
    const colorBy = opts.colorBy || "material";

    const { nodes, elems, matId, srcId, materials, gapLoop, gapTheta, gapR } = bodyMesh;
    const Ne = elems.length / 4;
    const Nn = nodes.length / 2;

    if (Nn === 0 || Ne === 0) return;

    // LOD stroke check: skip per-element strokes when the average element on screen
    // is smaller than ~30 px² — at that density the strokes blend (via
    // composite=difference) into a uniform wash and the per-element fills become
    // invisible. Strokes return when the user zooms in enough that cells are large
    // enough to read individually.
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let n = 0; n < Nn; n++) {
      const x = nodes[2 * n], y = nodes[2 * n + 1];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    // If the ctx doesn't expose getTransform (e.g. a recording mock in tests),
    // assume identity scale and keep strokes on.
    let scalePx = 1;
    if (typeof ctx.getTransform === "function") {
      const t = ctx.getTransform();
      scalePx = Math.hypot(t.a, t.b);
    }
    const bboxAreaPx = (xMax - xMin) * (yMax - yMin) * scalePx * scalePx;
    // Annular body fills ~π/4 of its bbox, on average each cell occupies
    // (annulus area) / Ne ≈ (bboxArea * 0.785) / Ne. Threshold 30 px² ≈ 5×6 cell.
    const avgCellAreaPx = (bboxAreaPx * 0.785) / Ne;
    const showStrokes = avgCellAreaPx >= 30;

    // We use the ctx transform that is already set by the caller (or identity).
    // Draw elements
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4 * e];
      const n1 = elems[4 * e + 1];
      const n2 = elems[4 * e + 2];
      const n3 = elems[4 * e + 3];
      const isTri = n3 === -1;

      // Color: magnets are differentiated by pole sign (radial magDir component);
      // all other elements use the material-palette cycle.
      let color;
      if (colorBy === "circuit") {
        const cIdx = srcId[e];
        if (cIdx >= 0) {
          const CIRCUIT_COLORS = ["#f0a020", "#40a0e0", "#50c050", "#e060e0", "#e07030", "#30b0b0"];
          color = CIRCUIT_COLORS[cIdx % CIRCUIT_COLORS.length];
        } else if (materials[matId[e]] && materials[matId[e]].kind === "magnet") {
          color = magnetPoleColor(bodyMesh, e);
        } else {
          color = colorFor(matId[e], materials);
        }
      } else if (materials[matId[e]] && materials[matId[e]].kind === "magnet") {
        color = magnetPoleColor(bodyMesh, e);
      } else {
        color = colorFor(matId[e], materials);
      }

      ctx.beginPath();
      ctx.moveTo(nodes[2 * n0], nodes[2 * n0 + 1]);
      ctx.lineTo(nodes[2 * n1], nodes[2 * n1 + 1]);
      ctx.lineTo(nodes[2 * n2], nodes[2 * n2 + 1]);
      if (!isTri) {
        ctx.lineTo(nodes[2 * n3], nodes[2 * n3 + 1]);
      }
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      // Stroke each element using composite='difference' so the edge is the
      // inverse of whatever fill is underneath — guaranteed contrast against
      // dark background, light-blue air, gray iron, red/blue magnets, and
      // orange conductors alike. Skipped when cells are sub-2-px (LOD).
      if (showStrokes) {
        const prevComp = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = "difference";
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.globalCompositeOperation = prevComp;
      }
    }

    // Overlay gapLoop. Line widths are left to the caller's ctx state so this
    // function is correct under any installed transform (e.g. ctx.scale).
    if (showGapLoop && gapLoop && gapLoop.length > 0) {
      ctx.beginPath();
      for (let k = 0; k < gapLoop.length; k++) {
        const ni = gapLoop[k];
        const x = nodes[2 * ni], y = nodes[2 * ni + 1];
        if (k === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.strokeStyle = "#00ff88";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, gapR, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(0,255,136,0.3)";
      ctx.stroke();
    }
  }

  // ===========================================================================
  //  Production R1+R2+R3 surface (Phase 6, T6.1.1).
  //
  //  Every method below is pure-functional drawing: it reads its inputs, draws
  //  to the supplied 2-D context (whose transform the caller has already set so
  //  that world metres map to pixels), and returns nothing. None mutates the
  //  mesh. They never touch the DOM.
  // ===========================================================================

  // Iterate a body's elements, invoking cb(e, count, nodeIdx[]) for each.
  // count is 3 (tri) or 4 (quad); nodeIdx is the element's node indices.
  function eachElement(bodyMesh, cb) {
    const { elems } = bodyMesh;
    const Ne = elems.length / 4;
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4 * e], n1 = elems[4 * e + 1];
      const n2 = elems[4 * e + 2], n3 = elems[4 * e + 3];
      const count = n3 === -1 ? 3 : 4;
      cb(e, count, n0, n1, n2, n3);
    }
  }

  // Trace the element polygon as a closed path on ctx (no fill/stroke).
  function elementPath(ctx, nodes, count, n0, n1, n2, n3) {
    ctx.beginPath();
    ctx.moveTo(nodes[2 * n0], nodes[2 * n0 + 1]);
    ctx.lineTo(nodes[2 * n1], nodes[2 * n1 + 1]);
    ctx.lineTo(nodes[2 * n2], nodes[2 * n2 + 1]);
    if (count === 4) ctx.lineTo(nodes[2 * n3], nodes[2 * n3 + 1]);
    ctx.closePath();
  }

  // Element centroid in world coordinates.
  function elementCentroid(nodes, count, n0, n1, n2, n3) {
    let cx = nodes[2 * n0] + nodes[2 * n1] + nodes[2 * n2];
    let cy = nodes[2 * n0 + 1] + nodes[2 * n1 + 1] + nodes[2 * n2 + 1];
    if (count === 4) { cx += nodes[2 * n3]; cy += nodes[2 * n3 + 1]; }
    return [cx / count, cy / count];
  }

  // -------------------------------------------------------------------------
  //  Viridis-like colormap. t ∈ [0,1] → "rgb(r,g,b)". Five-stop piecewise
  //  linear interpolation through the canonical viridis control points
  //  (dark blue → teal → green → yellow). Pure; no allocation beyond a string.
  // -------------------------------------------------------------------------
  const VIRIDIS_STOPS = [
    [68, 1, 84],     // 0.0  dark purple
    [59, 82, 139],   // 0.25 blue
    [33, 145, 140],  // 0.5  teal
    [94, 201, 98],   // 0.75 green
    [253, 231, 37],  // 1.0  yellow
  ];

  function viridis(t) {
    if (t <= 0) { const c = VIRIDIS_STOPS[0]; return `rgb(${c[0]},${c[1]},${c[2]})`; }
    if (t >= 1) { const c = VIRIDIS_STOPS[4]; return `rgb(${c[0]},${c[1]},${c[2]})`; }
    const seg = t * 4;
    const i = Math.floor(seg);
    const f = seg - i;
    const a = VIRIDIS_STOPS[i], b = VIRIDIS_STOPS[i + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * f);
    const g = Math.round(a[1] + (b[1] - a[1]) * f);
    const bl = Math.round(a[2] + (b[2] - a[2]) * f);
    return `rgb(${r},${g},${bl})`;
  }

  // ---------------------------------------------------------------------------
  //  drawMaterial(ctx, bodyMesh, opts) → void
  //
  //  Fills one polygon per element coloured by materials[matId].kind. This is
  //  the production R1 material layer (the Phase-2 `draw` default coloring,
  //  factored into a standalone method). Magnets are pole-sign-coloured.
  //
  //  opts = { palette?, alpha=1, lineWidth=0.5, stroke=true }
  // ---------------------------------------------------------------------------
  function drawMaterial(ctx, bodyMesh, opts) {
    opts = opts || {};
    const alpha     = opts.alpha != null ? opts.alpha : 1;
    const lineWidth = opts.lineWidth != null ? opts.lineWidth : 0.5;
    const stroke    = opts.stroke !== false;
    const palette   = opts.palette || null;

    const { nodes, matId, materials } = bodyMesh;
    if (nodes.length === 0) return;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const mat = materials[matId[e]];
      let color;
      if (Array.isArray(palette) && palette.length > 0) {
        color = palette[matId[e] % palette.length];
      } else if (mat && mat.kind === "magnet") {
        color = magnetPoleColor(bodyMesh, e);
      } else {
        color = colorFor(matId[e], materials);
      }
      elementPath(ctx, nodes, count, n0, n1, n2, n3);
      ctx.fillStyle = color;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
    });

    ctx.globalAlpha = prevAlpha;
  }

  // ---------------------------------------------------------------------------
  //  drawFluxLines(ctx, bodyMesh, Anode, opts) → void
  //
  //  Marching-squares iso-contour pass over the per-node potential Anode on the
  //  body's elements (R2). For each contour level and each element, the level
  //  set A(x) = level is a straight segment crossing the element edges; we
  //  stroke that segment. Quads are split into two triangles so the linear
  //  interpolation is exact per sub-triangle.
  //
  //  opts = { levels: number | number[] (default 12 evenly spaced over
  //           Anode's min..max), color="rgba(255,255,255,0.7)", lineWidth=1 }
  // ---------------------------------------------------------------------------
  function drawFluxLines(ctx, bodyMesh, Anode, opts) {
    opts = opts || {};
    const color     = opts.color != null ? opts.color : "rgba(255,255,255,0.7)";
    const lineWidth = opts.lineWidth != null ? opts.lineWidth : 1;

    const { nodes } = bodyMesh;
    if (nodes.length === 0 || !Anode || Anode.length === 0) return;

    // Determine contour levels.
    let aMin = Infinity, aMax = -Infinity;
    for (let i = 0; i < Anode.length; i++) {
      const v = Anode[i];
      if (v < aMin) aMin = v;
      if (v > aMax) aMax = v;
    }
    if (!(aMax > aMin)) return; // degenerate / constant field: no contours

    let levels;
    if (Array.isArray(opts.levels)) {
      levels = opts.levels;
    } else {
      const nLevels = opts.levels != null ? opts.levels : 12;
      levels = [];
      // Interior levels only (skip the exact min/max which produce nothing).
      for (let l = 1; l <= nLevels; l++) {
        levels.push(aMin + (aMax - aMin) * (l / (nLevels + 1)));
      }
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    // Contour one triangle (node indices a,b,c) at one level.
    function contourTri(ia, ib, ic, level) {
      const ax = nodes[2 * ia], ay = nodes[2 * ia + 1], av = Anode[ia];
      const bx = nodes[2 * ib], by = nodes[2 * ib + 1], bv = Anode[ib];
      const cx = nodes[2 * ic], cy = nodes[2 * ic + 1], cv = Anode[ic];
      const pts = [];
      // Each edge: if the level lies strictly between the two endpoint values,
      // the contour crosses it once. Linear-interpolate the crossing point.
      function edge(x0, y0, v0, x1, y1, v1) {
        if ((v0 < level && v1 >= level) || (v1 < level && v0 >= level)) {
          const t = (level - v0) / (v1 - v0);
          pts.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
        }
      }
      edge(ax, ay, av, bx, by, bv);
      edge(bx, by, bv, cx, cy, cv);
      edge(cx, cy, cv, ax, ay, av);
      if (pts.length >= 4) {
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        ctx.lineTo(pts[2], pts[3]);
        ctx.stroke();
      }
    }

    for (let li = 0; li < levels.length; li++) {
      const level = levels[li];
      eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
        contourTri(n0, n1, n2, level);
        if (count === 4) contourTri(n0, n2, n3, level);
      });
    }

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawModulusB(ctx, bodyMesh, Belem, opts) → void
  //
  //  Per-element fill by Belem.mag mapped through the viridis colormap (R2).
  //  opts = { range: [number,number] | "auto", alpha=0.85 }
  // ---------------------------------------------------------------------------
  function drawModulusB(ctx, bodyMesh, Belem, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : 0.85;
    const { nodes } = bodyMesh;
    if (nodes.length === 0 || !Belem || !Belem.mag) return;
    const mag = Belem.mag;

    let lo, hi;
    if (Array.isArray(opts.range)) {
      lo = opts.range[0]; hi = opts.range[1];
    } else {
      lo = Infinity; hi = -Infinity;
      for (let e = 0; e < mag.length; e++) {
        if (mag[e] < lo) lo = mag[e];
        if (mag[e] > hi) hi = mag[e];
      }
    }
    const span = hi - lo;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const t = span > 1e-30 ? (mag[e] - lo) / span : 0;
      elementPath(ctx, nodes, count, n0, n1, n2, n3);
      ctx.fillStyle = viridis(t);
      ctx.fill();
    });

    ctx.globalAlpha = prevAlpha;
  }

  // ---------------------------------------------------------------------------
  //  drawSaturation(ctx, bodyMesh, Belem, opts) → void
  //
  //  Per-iron-element fill by |B(elem)| / Bknee_eff mapped 0..2 through viridis
  //  (1.0 = at the knee → colormap mid-band) (D4). Non-iron elements are not
  //  drawn. Bknee_eff = materials[matId].Bknee when finite-and-positive, else
  //  opts.BkneeDefault.
  //
  //  opts = { BkneeDefault=1.6, alpha=0.85 }
  // ---------------------------------------------------------------------------
  function drawSaturation(ctx, bodyMesh, Belem, opts) {
    opts = opts || {};
    const BkneeDefault = opts.BkneeDefault != null ? opts.BkneeDefault : 1.6;
    const alpha = opts.alpha != null ? opts.alpha : 0.85;
    const { nodes, matId, materials } = bodyMesh;
    if (nodes.length === 0 || !Belem || !Belem.mag) return;
    const mag = Belem.mag;

    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const mat = materials[matId[e]];
      if (!mat || mat.kind !== "iron") return;
      const Bknee = (mat.Bknee != null && isFinite(mat.Bknee) && mat.Bknee > 0)
        ? mat.Bknee : BkneeDefault;
      // Map |B|/Bknee over 0..2 onto the 0..1 colormap (1.0 → mid-band 0.5).
      const ratio = mag[e] / Bknee;
      const t = Math.max(0, Math.min(1, ratio / 2));
      elementPath(ctx, nodes, count, n0, n1, n2, n3);
      ctx.fillStyle = viridis(t);
      ctx.fill();
    });

    ctx.globalAlpha = prevAlpha;
  }

  // ---------------------------------------------------------------------------
  //  drawMagnetization(ctx, bodyMesh, opts) → void
  //
  //  Draws an arrow per magnet element from its centroid along magDir, length
  //  proportional to materials[matId].mrMag (R3). The arrow is a shaft plus a
  //  two-segment arrowhead (3 lineTo segments total per magnet element).
  //
  //  opts = { arrowLenPx=8, color }
  // ---------------------------------------------------------------------------
  function drawMagnetization(ctx, bodyMesh, opts) {
    opts = opts || {};
    const arrowLen = opts.arrowLenPx != null ? opts.arrowLenPx : 8;
    const color = opts.color != null ? opts.color : "rgba(255,220,60,0.95)";
    const { nodes, matId, materials, magDir } = bodyMesh;
    if (nodes.length === 0) return;

    // Largest mrMag across magnet materials → length normalization.
    let maxMr = 0;
    for (const m of materials) {
      if (m.kind === "magnet" && m.mrMag > maxMr) maxMr = m.mrMag;
    }

    ctx.save();
    ctx.strokeStyle = color;

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const mat = materials[matId[e]];
      if (!mat || mat.kind !== "magnet") return;
      const dx = magDir[2 * e], dy = magDir[2 * e + 1];
      const dl = Math.hypot(dx, dy);
      if (dl < 1e-12) return;
      const ux = dx / dl, uy = dy / dl;
      const frac = maxMr > 0 ? (mat.mrMag / maxMr) : 1;
      const len = arrowLen * (0.4 + 0.6 * frac);
      const [cx, cy] = elementCentroid(nodes, count, n0, n1, n2, n3);
      // Shaft from centroid along magDir.
      const tipX = cx + ux * len, tipY = cy + uy * len;
      // Arrowhead: two short segments back from the tip at ±150°.
      const head = len * 0.4;
      const ang = Math.atan2(uy, ux);
      const aL = ang + Math.PI * 0.83, aR = ang - Math.PI * 0.83;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tipX, tipY);                                  // shaft
      ctx.lineTo(tipX + Math.cos(aL) * head, tipY + Math.sin(aL) * head); // head L
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX + Math.cos(aR) * head, tipY + Math.sin(aR) * head); // head R
      ctx.stroke();
    });

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawCurrentDensity(ctx, bodyMesh, currents, opts) → void
  //
  //  Draws a dot/cross glyph per conductor element at its centroid (R3). Color
  //  comes from a palette keyed by srcId; the glyph is a dot when the net
  //  signed current (currents[srcId] · turns[e]) is positive (current toward
  //  the viewer) and a cross when negative.
  //
  //  opts = { palette?, glyphRadiusPx=4 }
  // ---------------------------------------------------------------------------
  const CURRENT_PALETTE = [
    "#4ea1ff", "#ef5350", "#66bb6a", "#ffd54a",
    "#ab47bc", "#26c6da", "#ff8a65", "#d4e157",
  ];

  function drawCurrentDensity(ctx, bodyMesh, currents, opts) {
    opts = opts || {};
    const palette = (Array.isArray(opts.palette) && opts.palette.length > 0)
      ? opts.palette : CURRENT_PALETTE;
    const gr = opts.glyphRadiusPx != null ? opts.glyphRadiusPx : 4;
    const { nodes, matId, materials, srcId, turns } = bodyMesh;
    if (nodes.length === 0) return;

    ctx.save();

    eachElement(bodyMesh, function (e, count, n0, n1, n2, n3) {
      const mat = materials[matId[e]];
      if (!mat || mat.kind !== "conductor") return;
      const sid = srcId[e];
      const color = palette[((sid >= 0 ? sid : 0)) % palette.length];
      const [cx, cy] = elementCentroid(nodes, count, n0, n1, n2, n3);

      const cur = (currents && sid >= 0 && sid < currents.length) ? currents[sid] : 0;
      const net = cur * (turns[e] || 0);

      // Glyph disc.
      ctx.beginPath();
      ctx.arc(cx, cy, gr, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 0.6;
      ctx.stroke();

      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#ffffff";
      if (net >= 0) {
        // Dot — current out of the page (toward viewer). Drawn as a small
        // filled square so the disc remains the only `arc` op per conductor
        // (one glyph = one arc, regardless of sign).
        const d = gr * 0.35;
        ctx.fillRect(cx - d, cy - d, 2 * d, 2 * d);
      } else {
        // Cross — current into the page.
        const arm = gr * 0.6;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy - arm);
        ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx + arm, cy - arm);
        ctx.lineTo(cx - arm, cy + arm);
        ctx.stroke();
      }
    });

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawGapLoop(ctx, bodyMesh, opts) → void
  //
  //  Standalone mesh-structural overlay: strokes the body's uniform-Δθ gap loop
  //  polyline (the mid-gap circle from Phase 2's BodyMesh.gapLoop) plus the
  //  gapR reference circle. opts = { color="#00ff88", lineWidth }.
  // ---------------------------------------------------------------------------
  function drawGapLoop(ctx, bodyMesh, opts) {
    opts = opts || {};
    const color = opts.color != null ? opts.color : "#00ff88";
    const { nodes, gapLoop, gapR } = bodyMesh;
    if (!gapLoop || gapLoop.length === 0) return;

    ctx.save();
    if (opts.lineWidth != null) ctx.lineWidth = opts.lineWidth;

    ctx.beginPath();
    for (let k = 0; k < gapLoop.length; k++) {
      const ni = gapLoop[k];
      const x = nodes[2 * ni], y = nodes[2 * ni + 1];
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, gapR, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,255,136,0.3)";
    ctx.stroke();

    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------

  LIB.MotorMeshView = {
    colorFor,
    draw,
    drawMaterial,
    drawFluxLines,
    drawModulusB,
    drawSaturation,
    drawMagnetization,
    drawCurrentDensity,
    drawGapLoop,
    viridis,
  };
})();
