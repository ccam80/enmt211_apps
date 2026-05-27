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
      // orange conductors alike. lineWidth stays the caller's responsibility.
      const prevComp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = "difference";
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.globalCompositeOperation = prevComp;
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

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------

  LIB.MotorMeshView = { colorFor, draw };
})();
