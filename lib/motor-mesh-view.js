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

  function draw(ctx, bodyMesh, opts) {
    opts = opts || {};
    const showGapLoop = opts.showGapLoop !== false;  // default true
    const colorBy = opts.colorBy || "material";

    const { nodes, elems, matId, srcId, materials, gapLoop, gapTheta, gapR } = bodyMesh;
    const Ne = elems.length / 4;
    const Nn = nodes.length / 2;

    if (Nn === 0 || Ne === 0) return;

    // Determine canvas bounding box of the mesh for auto-scaling
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let n = 0; n < Nn; n++) {
      const x = nodes[2 * n], y = nodes[2 * n + 1];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }

    // We use the ctx transform that is already set by the caller (or identity).
    // Draw elements
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4 * e];
      const n1 = elems[4 * e + 1];
      const n2 = elems[4 * e + 2];
      const n3 = elems[4 * e + 3];
      const isTri = n3 === -1;

      // Color
      let color;
      if (colorBy === "circuit") {
        const cIdx = srcId[e];
        if (cIdx >= 0) {
          const CIRCUIT_COLORS = ["#f0a020", "#40a0e0", "#50c050", "#e060e0", "#e07030", "#30b0b0"];
          color = CIRCUIT_COLORS[cIdx % CIRCUIT_COLORS.length];
        } else {
          color = colorFor(matId[e], materials);
        }
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
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.stroke();
    }

    // Overlay gapLoop
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
      ctx.lineWidth = 2;
      ctx.stroke();

      // Draw arc at gap radius for visual confirmation
      ctx.beginPath();
      ctx.arc(0, 0, gapR, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(0,255,136,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------

  LIB.MotorMeshView = { colorFor, draw };
})();
