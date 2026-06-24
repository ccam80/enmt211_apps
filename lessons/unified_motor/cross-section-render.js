(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});
  const TWO_PI = 2 * Math.PI;

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

  // Max node radius across a body mesh — used for fit scale.
  function maxNodeRadius(bodyMesh) {
    const nodes = bodyMesh.nodes;
    let rMax = 0;
    for (let n = 0; n < nodes.length / 2; n++) {
      const r = Math.hypot(nodes[2 * n], nodes[2 * n + 1]);
      if (r > rMax) rMax = r;
    }
    return rMax;
  }

  // Classify conductor features by their owning ring's element type.
  // Returns { distributed: Feature[], concentrated: Feature[] } for a given
  // set of conductor features. Ring classification: element "C" → concentrated,
  // element "W" or "K" → distributed.
  function classifyConductors(conductorFeatures, rings) {
    const distributed = [];
    const concentrated = [];
    for (const feat of conductorFeatures) {
      let matched = false;
      for (const ring of rings) {
        if (ring.member !== feat.member) continue;
        const slotRange = ring.slotRRange != null ? ring.slotRRange : ring.rRange;
        if (!Array.isArray(slotRange) || slotRange.length < 2) continue;
        const inRange = slotRange[0] <= feat.rRange[0] && feat.rRange[1] <= slotRange[1];
        if (!inRange) continue;
        if (ring.element === "C") {
          concentrated.push(feat);
        } else {
          distributed.push(feat);
        }
        matched = true;
        break;
      }
      if (!matched) distributed.push(feat);
    }
    return { distributed, concentrated };
  }

  // Build a GapEval descriptor from a body mesh and its nodal A values.
  // Returns { gapR, gapTheta, A }.
  function ringFromGapLoop(body, Anode) {
    const loop = body.gapLoop;
    const N = loop.length;
    const gapTheta = new Float64Array(N);
    const A = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const ni = loop[i];
      const x = body.nodes[2 * ni], y = body.nodes[2 * ni + 1];
      gapTheta[i] = Math.atan2(y, x);
      A[i] = Anode[ni];
    }
    return { gapR: body.gapR, gapTheta, A };
  }

  // Overlay recompute cache — keyed on lastSolve reference.
  // Structure: Map<lastSolve, Map<string, grid>>
  let _overlayCache = null;
  let _overlayLastSolve = null;

  function getCachedGrid(lastSolve, k, bodyKey, fieldKind) {
    if (_overlayLastSolve !== lastSolve) {
      _overlayCache = new Map();
      _overlayLastSolve = lastSolve;
    }
    const cacheKey = k + ":" + bodyKey + ":" + fieldKind;
    return _overlayCache.get(cacheKey) || null;
  }

  function setCachedGrid(lastSolve, k, bodyKey, fieldKind, grid) {
    if (_overlayLastSolve !== lastSolve) {
      _overlayCache = new Map();
      _overlayLastSolve = lastSolve;
    }
    const cacheKey = k + ":" + bodyKey + ":" + fieldKind;
    _overlayCache.set(cacheKey, grid);
  }

  // ---------------------------------------------------------------------------
  //  paintCanvas — paint one cross-section canvas for slice index k.
  // ---------------------------------------------------------------------------
  function paintCanvas(canvas, runtime, config, expanded, k) {
    const { W, H } = fitCanvas(canvas);
    if (W <= 0 || H <= 0) return;
    const ctx = canvas.getContext("2d");

    ctx.save();
    ctx.fillStyle = "#0d1013";
    ctx.clearRect(0, 0, W, H);
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    const viz = UM.fieldViz || (UM.fieldViz = defaultFieldViz());

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

    const rotor  = bodies.rotor;
    const stator = bodies.stator;

    const solved = runtime.lastSolve;
    const field  = (solved && solved.perSliceField && solved.perSliceField[k])
      ? solved.perSliceField[k] : null;

    const phi = field ? field.gap.phi : (runtime.state ? runtime.state.theta : 0);

    // Fit transform: centre the union of both bodies.
    const rMax = Math.max(maxNodeRadius(rotor), maxNodeRadius(stator), 1e-6);
    const pad = 10;
    const scale = Math.min((W - 2 * pad) / (2 * rMax), (H - 2 * pad) / (2 * rMax));

    const CSP = window.LIB.CrossSectionSprite;
    const MMV = window.LIB.MotorMeshView;

    // Resolve features for this slice.
    const section = expanded.slices[k].section;
    const features = section.features;
    const rings = config.rings || [];

    const rotorIron  = features.filter(function (f) { return f.member === "rotor"  && f.kind === "iron";      });
    const rotorMag   = features.filter(function (f) { return f.member === "rotor"  && f.kind === "magnet";    });
    const rotorCond  = features.filter(function (f) { return f.member === "rotor"  && f.kind === "conductor"; });
    const statorIron = features.filter(function (f) { return f.member === "stator" && f.kind === "iron";      });
    const statorMag  = features.filter(function (f) { return f.member === "stator" && f.kind === "magnet";    });
    const statorCond = features.filter(function (f) { return f.member === "stator" && f.kind === "conductor"; });

    const rotorClass  = classifyConductors(rotorCond,  rings);
    const statorClass = classifyConductors(statorCond, rings);

    const currents = (runtime.state && runtime.state.i) ? runtime.state.i : null;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(scale, -scale);

    const Nr_grid     = 12;
    const Ntheta_grid = 64;

    // ---- Rotor sprite (inside rotate(phi) frame) ----------------------------
    ctx.save();
    ctx.rotate(phi);

    if (CSP) {
      CSP.drawIron(ctx, rotorIron, { gapEdge: "outer" });
      CSP.drawMagnet(ctx, rotorMag, {});
      if (rotorClass.distributed.length > 0) {
        CSP.drawWinding(ctx, rotorClass.distributed, "distributed", {
          currents: currents,
          showCurrentGlyph: viz.currentDensity,
        });
      }
      if (rotorClass.concentrated.length > 0) {
        CSP.drawWinding(ctx, rotorClass.concentrated, "concentrated", {
          currents: currents,
          showCurrentGlyph: viz.currentDensity,
        });
      }
      CSP.drawShaftAndGap(ctx, {
        shaftR:     rotor.shaftR    != null ? rotor.shaftR    : 0,
        gapInnerR:  rotor.gapR      != null ? rotor.gapR      : 0,
        gapOuterR:  stator.gapR     != null ? stator.gapR     : 0,
      }, {});
    }

    // Rotor field overlays (inside rotate(phi) frame).
    if (field && MMV) {
      const rf = field.rotor;
      if (viz.saturation) {
        MMV.drawSaturation(ctx, rf.mesh, rf.Belem, {});
      }
      if (viz.modulusB) {
        let grid = getCachedGrid(solved, k, "rotor", "modulusB");
        if (!grid) {
          const nodal = MMV.elemToNodal(rf.mesh, rf.Belem.mag);
          grid = MMV.resampleField(rf.mesh, nodal, { Nr: Nr_grid, Ntheta: Ntheta_grid });
          setCachedGrid(solved, k, "rotor", "modulusB", grid);
        }
        MMV.drawModulusB(ctx, grid, { range: "auto" });
      }
      if (viz.fluxLines) {
        let grid = getCachedGrid(solved, k, "rotor", "fluxLines");
        if (!grid) {
          grid = MMV.resampleField(rf.mesh, rf.Anode, { Nr: Nr_grid, Ntheta: Ntheta_grid });
          setCachedGrid(solved, k, "rotor", "fluxLines", grid);
        }
        MMV.drawFluxLines(ctx, grid, { levels: 12 });
      }
      if (viz.magnetization && CSP) {
        CSP.drawMagnetArrows(ctx, rotorMag, {});
      }
    } else if (!field && viz.magnetization && CSP) {
      CSP.drawMagnetArrows(ctx, rotorMag, {});
    }

    if (viz.gapLoop && MMV) {
      const gapR_scale = (typeof ctx.getTransform === "function")
        ? 1 / (Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1)
        : 1;
      MMV.drawGapLoop(ctx, rotor, { lineWidth: gapR_scale });
    }

    ctx.restore(); // end rotate(phi)

    // ---- Stator sprite (lab frame, no rotation) ----------------------------
    if (CSP) {
      CSP.drawIron(ctx, statorIron, { gapEdge: "inner" });
      CSP.drawMagnet(ctx, statorMag, {});
      if (statorClass.distributed.length > 0) {
        CSP.drawWinding(ctx, statorClass.distributed, "distributed", {
          currents: currents,
          showCurrentGlyph: viz.currentDensity,
        });
      }
      if (statorClass.concentrated.length > 0) {
        CSP.drawWinding(ctx, statorClass.concentrated, "concentrated", {
          currents: currents,
          showCurrentGlyph: viz.currentDensity,
        });
      }
    }

    // Stator field overlays.
    if (field && MMV) {
      const sf = field.stator;
      if (viz.saturation) {
        MMV.drawSaturation(ctx, sf.mesh, sf.Belem, {});
      }
      if (viz.modulusB) {
        let grid = getCachedGrid(solved, k, "stator", "modulusB");
        if (!grid) {
          const nodal = MMV.elemToNodal(sf.mesh, sf.Belem.mag);
          grid = MMV.resampleField(sf.mesh, nodal, { Nr: Nr_grid, Ntheta: Ntheta_grid });
          setCachedGrid(solved, k, "stator", "modulusB", grid);
        }
        MMV.drawModulusB(ctx, grid, { range: "auto" });
      }
      if (viz.fluxLines) {
        let grid = getCachedGrid(solved, k, "stator", "fluxLines");
        if (!grid) {
          grid = MMV.resampleField(sf.mesh, sf.Anode, { Nr: Nr_grid, Ntheta: Ntheta_grid });
          setCachedGrid(solved, k, "stator", "fluxLines", grid);
        }
        MMV.drawFluxLines(ctx, grid, { levels: 12 });
      }
      if (viz.magnetization && CSP) {
        CSP.drawMagnetArrows(ctx, statorMag, {});
      }
      if (viz.gapLoop) {
        const gapR_scale = (typeof ctx.getTransform === "function")
          ? 1 / (Math.hypot(ctx.getTransform().a, ctx.getTransform().b) || 1)
          : 1;
        MMV.drawGapLoop(ctx, stator, { lineWidth: gapR_scale });
      }
    } else if (!field && viz.magnetization && CSP) {
      CSP.drawMagnetArrows(ctx, statorMag, {});
    }

    // Cross-gap flux lines (lab frame): build the GapEval descriptor.
    if (viz.fluxLines && field && window.LIB.GapEval) {
      const GapEval = window.LIB.GapEval;
      const rotorBody  = field.rotor.mesh;
      const statorBody = field.stator.mesh;
      if (rotorBody.gapLoop && statorBody.gapLoop &&
          rotorBody.gapR > 0 && statorBody.gapR > rotorBody.gapR) {
        const descriptor = {
          rotor:  ringFromGapLoop(rotorBody,  field.rotor.Anode),
          stator: ringFromGapLoop(statorBody, field.stator.Anode),
          phi:    field.gap.phi,
        };
        try {
          const gapGrid = GapEval.evalAOnGrid(descriptor, { Nr: 8, Ntheta: 96 });
          MMV.drawFluxLines(ctx, gapGrid, {
            levels: 12,
            color:  "rgba(120,200,255,0.6)",
            lineWidth: 1 / scale,
          });
        } catch (e) {
          // Gap eval failed (e.g. radii constraints not met); skip silently.
        }
      }
    }

    ctx.restore(); // end translate/scale
  }

  // ---------------------------------------------------------------------------
  //  paint(mountCtx, canvases, rctx) — the 2-D-render seam entry.
  // ---------------------------------------------------------------------------
  function paint(mountCtx, canvases, rctx) {
    const runtime  = mountCtx.runtime;
    const config   = mountCtx.config || (rctx && rctx.config) || {};
    const expanded = (rctx && rctx.expanded) ? rctx.expanded
      : (runtime && runtime.stack ? runtime.stack.expanded : null);
    if (!runtime || !expanded) return;

    const nSlices = expanded.slices.length;
    paintCanvas(canvases[0], runtime, config, expanded, 0);
    const k1 = nSlices > 1 ? 1 : 0;
    paintCanvas(canvases[1], runtime, config, expanded, k1);
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
  //  register(UM) — installs the 2-D seam + the field-view header control.
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

  if (UM.registerHeaderControl) register(UM);

  UM.CrossSectionRender = { paint, register };
})();
