(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  const TWO_PI = 2 * Math.PI;

  // D3's locked initial field-viz state. Six independent overlays; flux-lines
  // on by default, everything else opt-in.
  function defaultFieldViz() {
    return {
      fluxLines: true,
      modulusB: false,
      saturation: false,
      magnetization: false,
      currentDensity: false,
      gapLoop: false,
    };
  }

  // ---------------------------------------------------------------------------
  //  DPR-fit a canvas to its client size and return { W, H } in CSS pixels.
  //  Mirrors mount.js's fitCanvas. Falls back to the canvas's intrinsic
  //  width/height when client dimensions are unavailable (headless mocks).
  // ---------------------------------------------------------------------------
  function fitCanvas(canvas) {
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const W = canvas.clientWidth || canvas.width || 0;
    const H = canvas.clientHeight || canvas.height || 0;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    return { W, H };
  }

  // ---------------------------------------------------------------------------
  //  rotatedMesh(bodyMesh, phi) → bodyMesh-like clone with rotated nodes.
  //  The mesh nodes are body-local; a rigid rotation by phi is applied to the
  //  node coordinates for draw (the underlying mesh is never mutated). Returns
  //  the original mesh when phi is ~0 (no allocation).
  // ---------------------------------------------------------------------------
  function rotatedMesh(bodyMesh, phi) {
    if (!phi || Math.abs(phi) < 1e-12) return bodyMesh;
    const src = bodyMesh.nodes;
    const dst = new Float64Array(src.length);
    const c = Math.cos(phi), s = Math.sin(phi);
    for (let n = 0; n < src.length / 2; n++) {
      const x = src[2 * n], y = src[2 * n + 1];
      dst[2 * n] = c * x - s * y;
      dst[2 * n + 1] = s * x + c * y;
    }
    const clone = Object.create(bodyMesh);
    clone.nodes = dst;
    return clone;
  }

  // ---------------------------------------------------------------------------
  //  bodyRadii(bodyMesh) → { rMax } — outermost node radius (for fit scale).
  // ---------------------------------------------------------------------------
  function maxNodeRadius(bodyMesh) {
    const nodes = bodyMesh.nodes;
    let rMax = 0;
    for (let n = 0; n < nodes.length / 2; n++) {
      const r = Math.hypot(nodes[2 * n], nodes[2 * n + 1]);
      if (r > rMax) rMax = r;
    }
    return rMax;
  }

  // ---------------------------------------------------------------------------
  //  paintCanvas — paint one cross-section canvas for slice index k.
  // ---------------------------------------------------------------------------
  function paintCanvas(canvas, runtime, expanded, k) {
    const { W, H } = fitCanvas(canvas);
    if (W <= 0 || H <= 0) return;
    const ctx = canvas.getContext("2d");

    // Background.
    ctx.save();
    ctx.fillStyle = "#0d1013";
    ctx.clearRect(0, 0, W, H);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const viz = UM.fieldViz || (UM.fieldViz = defaultFieldViz());

    // Static mesh (Phase 5 D2). Before the first solve this is the stable ref.
    let bodies = null;
    try {
      bodies = runtime.stack.sliceMesh(k);
    } catch (e) {
      bodies = null;
    }
    if (!bodies) {
      ctx.save();
      ctx.fillStyle = "rgba(138,147,163,0.8)";
      ctx.font = "11px ui-sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("slice " + k, W / 2, H / 2);
      ctx.restore();
      return;
    }

    const rotor = bodies.rotor;
    const stator = bodies.stator;

    // Per-frame field bundle (Phase 5 D3) — may be null before the first solve.
    const solved = runtime.lastSolve;
    const field = (solved && solved.perSliceField && solved.perSliceField[k])
      ? solved.perSliceField[k] : null;

    // Rotor body-local rotation: gap.phi when solved, else live theta.
    const phi = field ? field.gap.phi : (runtime.state ? runtime.state.theta : 0);

    // Fit transform: centre the union of both bodies, scale to fill.
    const rMax = Math.max(maxNodeRadius(rotor), maxNodeRadius(stator), 1e-6);
    const pad = 10;
    const scale = Math.min((W - 2 * pad) / (2 * rMax), (H - 2 * pad) / (2 * rMax));

    ctx.save();
    // World→px: centre origin, +y up (canvas y is down → negative scale on y).
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, -scale);

    const rotorDraw = rotatedMesh(rotor, phi);
    const MMV = window.LIB.MotorMeshView;

    // Compose overlays in the fixed order (each gated on UM.fieldViz):
    //   material → saturation → modulusB → magnetization → currentDensity →
    //   fluxLines (+ R5 analytic gap) → gapLoop.
    drawBody(MMV, ctx, rotorDraw, field ? field.rotor : null, viz, runtime, "rotor");
    drawBody(MMV, ctx, stator, field ? field.stator : null, viz, runtime, "stator");

    // R5 analytic in-gap A(r,θ) reconstruction — additional iso-contours
    // bridging rotor and stator flux lines, drawn when fluxLines is on and a
    // field + the GapEval helper are present.
    if (viz.fluxLines && field && window.LIB.GapEval) {
      drawAnalyticGap(ctx, field, rotor, stator);
    }

    // gapLoop mesh-structural overlay.
    if (viz.gapLoop) {
      MMV.drawGapLoop(ctx, rotorDraw, { lineWidth: 1 / scale });
      MMV.drawGapLoop(ctx, stator, { lineWidth: 1 / scale });
    }

    ctx.restore();
  }

  // Draw a single body's overlay stack.
  function drawBody(MMV, ctx, mesh, bodyField, viz, runtime, member) {
    const lw = 0.4;
    // Material is the base layer (always drawn so the geometry is visible).
    MMV.drawMaterial(ctx, mesh, { alpha: 1, lineWidth: lw, stroke: true });

    if (!bodyField) {
      // Static layer only when no field: glyphs that don't need a solve.
      if (viz.magnetization) MMV.drawMagnetization(ctx, mesh, {});
      if (viz.currentDensity && runtime.state) {
        MMV.drawCurrentDensity(ctx, mesh, runtime.state.i, {});
      }
      return;
    }

    if (viz.saturation) MMV.drawSaturation(ctx, mesh, bodyField.Belem, {});
    if (viz.modulusB)   MMV.drawModulusB(ctx, mesh, bodyField.Belem, { range: "auto" });
    if (viz.magnetization) MMV.drawMagnetization(ctx, mesh, {});
    if (viz.currentDensity && runtime.state) {
      MMV.drawCurrentDensity(ctx, mesh, runtime.state.i, {});
    }
    if (viz.fluxLines) MMV.drawFluxLines(ctx, mesh, bodyField.Anode, { levels: 12 });
  }

  // R5 analytic in-gap field: sample LIB.GapEval over the annulus and march
  // iso-contours of A across the sampling grid, drawn into the current
  // (world-scaled) transform.
  function drawAnalyticGap(ctx, field, rotor, stator) {
    const GapEval = window.LIB.GapEval;
    const r_mr = rotor.gapR;
    const r_ms = stator.gapR;
    if (!(r_ms > r_mr)) return;
    const grid = GapEval.evalAOnGrid(field.gap, r_mr, r_ms, { Nr: 8, Ntheta: 96 });
    const { rs, thetas, Az } = grid;
    const Nr = rs.length, Nt = thetas.length;

    // Iso-levels over Az min..max.
    let aMin = Infinity, aMax = -Infinity;
    for (let i = 0; i < Az.length; i++) {
      if (Az[i] < aMin) aMin = Az[i];
      if (Az[i] > aMax) aMax = Az[i];
    }
    if (!(aMax > aMin)) return;
    const nLevels = 12;

    ctx.save();
    ctx.strokeStyle = "rgba(120,200,255,0.6)";
    ctx.lineWidth = 0;
    if (ctx.getTransform) {
      const t = ctx.getTransform();
      const sc = Math.hypot(t.a, t.b) || 1;
      ctx.lineWidth = 1 / sc;
    }

    function xy(ri, ti) {
      const r = rs[ri], th = thetas[ti];
      return [r * Math.cos(th), r * Math.sin(th)];
    }
    function val(ri, ti) { return Az[ri * Nt + ti]; }

    for (let l = 1; l <= nLevels; l++) {
      const level = aMin + (aMax - aMin) * (l / (nLevels + 1));
      for (let ri = 0; ri + 1 < Nr; ri++) {
        for (let ti = 0; ti < Nt; ti++) {
          const tiN = (ti + 1) % Nt;
          // Two triangles of the polar cell.
          marchTri(ctx, level, xy(ri, ti), val(ri, ti),
            xy(ri + 1, ti), val(ri + 1, ti),
            xy(ri + 1, tiN), val(ri + 1, tiN));
          marchTri(ctx, level, xy(ri, ti), val(ri, ti),
            xy(ri + 1, tiN), val(ri + 1, tiN),
            xy(ri, tiN), val(ri, tiN));
        }
      }
    }
    ctx.restore();
  }

  function marchTri(ctx, level, pA, vA, pB, vB, pC, vC) {
    const pts = [];
    function edge(p0, v0, p1, v1) {
      if ((v0 < level && v1 >= level) || (v1 < level && v0 >= level)) {
        const t = (level - v0) / (v1 - v0);
        pts.push(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t);
      }
    }
    edge(pA, vA, pB, vB);
    edge(pB, vB, pC, vC);
    edge(pC, vC, pA, vA);
    if (pts.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      ctx.lineTo(pts[2], pts[3]);
      ctx.stroke();
    }
  }

  // ---------------------------------------------------------------------------
  //  paint(mountCtx, canvases, rctx) — the 2-D-render seam entry.
  //
  //  canvases = [canvas2DA, canvas2DB] (top → bottom). canvas A shows slice 0;
  //  canvas B shows slice 1 when the stack has ≥ 2 slices, else slice 0 again.
  //  Both canvases are repainted on every call.
  // ---------------------------------------------------------------------------
  function paint(mountCtx, canvases, rctx) {
    const runtime = mountCtx.runtime;
    const expanded = (rctx && rctx.expanded) ? rctx.expanded
      : (runtime && runtime.stack ? runtime.stack.expanded : null);
    if (!runtime || !expanded) return;

    const nSlices = expanded.slices.length;
    paintCanvas(canvases[0], runtime, expanded, 0);
    const k1 = nSlices > 1 ? 1 : 0;
    paintCanvas(canvases[1], runtime, expanded, k1);
  }

  // ---------------------------------------------------------------------------
  //  buildFieldViewToggles(host, ctx) — six labeled checkboxes wired to
  //  UM.fieldViz. Returns an unmount that detaches listeners.
  // ---------------------------------------------------------------------------
  function buildFieldViewToggles(host, ctx) {
    if (!UM.fieldViz) UM.fieldViz = defaultFieldViz();
    const viz = UM.fieldViz;

    const FIELDS = [
      { key: "fluxLines",      label: "flux" },
      { key: "modulusB",       label: "|B|" },
      { key: "saturation",     label: "sat" },
      { key: "magnetization",  label: "M" },
      { key: "currentDensity", label: "J" },
      { key: "gapLoop",        label: "gap loop" },
    ];

    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:8px;font-size:0.82em";
    const labelTxt = document.createElement("span");
    labelTxt.textContent = "Field view:";
    labelTxt.style.color = "var(--muted,#8a93a3)";
    wrap.appendChild(labelTxt);

    const listeners = [];
    for (const f of FIELDS) {
      const lab = document.createElement("label");
      lab.style.cssText = "display:inline-flex;align-items:center;gap:3px;cursor:pointer";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!viz[f.key];
      const handler = function () { viz[f.key] = cb.checked; };
      cb.addEventListener("change", handler);
      listeners.push({ cb, handler });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(f.label));
      wrap.appendChild(lab);
    }

    host.appendChild(wrap);

    return function unmount() {
      for (const l of listeners) l.cb.removeEventListener("change", l.handler);
      if (wrap.parentNode === host) host.removeChild(wrap);
    };
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — installs the 2-D seam + the D3 field-view header control.
  // ---------------------------------------------------------------------------
  function register(UM_arg) {
    const target = UM_arg || UM;
    if (!target.fieldViz) target.fieldViz = defaultFieldViz();
    if (target.registerCrossSection2D) {
      target.registerCrossSection2D({ paint });
    }
    if (target.registerHeaderControl) {
      target.registerHeaderControl({ id: "field-view", build: buildFieldViewToggles });
    }
  }

  // Auto-register only when the seams exist at load time (guarded). In a bare
  // headless require with no mount.js loaded, registerHeaderControl is absent
  // and register is NOT auto-called.
  if (UM.registerHeaderControl) register(UM);

  UM.CrossSectionRender = { paint, register };
})();
