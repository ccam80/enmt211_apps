(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // Per-phase color cycle for winding conductors, matching cross-section-sprite.js.
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
  //  sliceAxialBounds(k, N, ell) → { z0, z1, zc }
  //
  //  The stack spans [-ell/2, +ell/2] along z, divided into N equal contiguous
  //  segments. Slice k occupies [z0, z1] with centroid zc.
  // ---------------------------------------------------------------------------
  function sliceAxialBounds(k, N, ell) {
    const half = ell / 2;
    const segLen = ell / N;
    const z0 = -half + k * segLen;
    const z1 = z0 + segLen;
    const zc = (z0 + z1) / 2;
    return { z0, z1, zc };
  }

  // ---------------------------------------------------------------------------
  //  faceAffine(L3, z0, R) → { a, b, c, d, e, f }
  //
  //  Returns the affine 6-tuple mapping a face-local point (u, v) metres in the
  //  plane z = z0 to CSS pixels, pinned by the camera projections of the face
  //  centre O = L3.project({x:0,y:0,z:z0}), Pu = L3.project({x:R,y:0,z:z0}),
  //  Pv = L3.project({x:0,y:R,z:z0}).
  //
  //  Canvas transform order: px = a·u + c·v + e, py = b·u + d·v + f.
  // ---------------------------------------------------------------------------
  function faceAffine(L3, z0, R) {
    const O  = L3.project({ x: 0, y: 0, z: z0 });
    const Pu = L3.project({ x: R, y: 0, z: z0 });
    const Pv = L3.project({ x: 0, y: R, z: z0 });
    return {
      a: (Pu.px - O.px) / R,
      b: (Pu.py - O.py) / R,
      c: (Pv.px - O.px) / R,
      d: (Pv.py - O.py) / R,
      e: O.px,
      f: O.py,
    };
  }

  // ---------------------------------------------------------------------------
  //  endWindingArcs(conductorFeatures, opts) → arc[]
  //
  //  Groups features by circuit; within each circuit pairs go-slot (turns>0) with
  //  return-slot (turns<0) by nearest angle. Returns arc objects with 3-D points
  //  tracing a smooth curve from go-slot to return-slot, bulging axially beyond
  //  the stack end at z = sign*(|zEnd| + bulge).
  //
  //  opts = { zEnd, bulge, sign, samples=8, member }
  //  Returns [] when no opposite-polarity pairs exist.
  // ---------------------------------------------------------------------------
  function endWindingArcs(conductorFeatures, opts) {
    if (!conductorFeatures || conductorFeatures.length === 0) return [];
    opts = opts || {};
    const zEnd    = opts.zEnd   != null ? opts.zEnd   : 0;
    const bulge   = opts.bulge  != null ? opts.bulge  : 0.005;
    const sign    = opts.sign   != null ? opts.sign   : 1;
    const samples = opts.samples != null ? opts.samples : 8;

    // Group by circuit.
    const byCircuit = new Map();
    for (const feat of conductorFeatures) {
      const circuit = feat.circuit != null ? feat.circuit : 0;
      if (!byCircuit.has(circuit)) byCircuit.set(circuit, []);
      byCircuit.get(circuit).push(feat);
    }

    const arcs = [];

    for (const [circuit, feats] of byCircuit) {
      const goSlots     = feats.filter(function (f) { return f.turns > 0; });
      const returnSlots = feats.filter(function (f) { return f.turns < 0; });
      if (goSlots.length === 0 || returnSlots.length === 0) continue;

      // Compute mean angle for each slot.
      function meanAngle(feat) {
        const [t0, t1] = feat.thetaRange;
        return (t0 + t1) / 2;
      }
      function meanRadius(feat) {
        const [r0, r1] = feat.rRange;
        return (r0 + r1) / 2;
      }

      // Sort go-slots by angle for stable pairing.
      const sortedGo = goSlots.slice().sort(function (a, b) {
        return meanAngle(a) - meanAngle(b);
      });

      // Greedy nearest-angle pairing; each return slot used at most once.
      const usedReturn = new Set();

      for (const go of sortedGo) {
        const goAngle = meanAngle(go);
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let ri = 0; ri < returnSlots.length; ri++) {
          if (usedReturn.has(ri)) continue;
          const retAngle = meanAngle(returnSlots[ri]);
          let diff = Math.abs(retAngle - goAngle);
          // Shortest arc on the circle.
          if (diff > Math.PI) diff = 2 * Math.PI - diff;
          if (diff < bestDist) {
            bestDist = diff;
            bestIdx = ri;
          }
        }
        if (bestIdx < 0) continue;
        usedReturn.add(bestIdx);

        const ret = returnSlots[bestIdx];
        const goTheta  = meanAngle(go);
        const retTheta = meanAngle(ret);
        const goR      = meanRadius(go);
        const retR     = meanRadius(ret);

        // Mid-arc radius: average of go and return conductor mean radii.
        const arcR = (goR + retR) / 2;

        // Build samples points following a smooth arc in 3-D:
        // endpoint 0 at z = sign*|zEnd|, endpoint (samples-1) at z = sign*|zEnd|,
        // mid-point at z = sign*(|zEnd| + bulge).
        const zBase   = sign * Math.abs(zEnd);
        const zPeak   = sign * (Math.abs(zEnd) + bulge);
        const points  = new Float64Array(samples * 3);

        // Place the peak at the exact middle sample index so the bulge point
        // is always present in the output array.
        const midIdx = Math.floor((samples - 1) / 2);
        for (let si = 0; si < samples; si++) {
          const t = si / (samples - 1);
          // Interpolate angle along the shorter arc.
          let dTheta = retTheta - goTheta;
          if (dTheta >  Math.PI) dTheta -= 2 * Math.PI;
          if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
          const theta = goTheta + t * dTheta;

          // Axial profile: sine-shaped between endpoints; force exact peak at midIdx.
          let zFrac;
          if (si === midIdx) {
            zFrac = 1;
          } else {
            zFrac = Math.sin(Math.PI * t);
          }
          const z = zBase + (zPeak - zBase) * zFrac;

          // Radius interpolation: straight lerp between go and return radii.
          const r = goR + t * (retR - goR);

          points[si * 3 + 0] = r * Math.cos(theta);
          points[si * 3 + 1] = r * Math.sin(theta);
          points[si * 3 + 2] = z;
        }

        arcs.push({ circuit, points });
      }
    }

    return arcs;
  }

  // ---------------------------------------------------------------------------
  //  ringFromGapLoop(body, Anode) → { gapR, gapTheta, A }
  //
  //  Builds a GapEval descriptor ring from a field body (field.rotor or
  //  field.stator) and its nodal A vector.
  // ---------------------------------------------------------------------------
  function ringFromGapLoop(body, Anode) {
    const loop = body.mesh.gapLoop;
    const N    = loop.length;
    const gapTheta = new Float64Array(N);
    const A        = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const ni = loop[i];
      const x  = body.mesh.nodes[2 * ni];
      const y  = body.mesh.nodes[2 * ni + 1];
      gapTheta[i] = Math.atan2(y, x);
      A[i]        = Anode[ni];
    }
    return { gapR: body.mesh.gapR, gapTheta, A };
  }

  // ---------------------------------------------------------------------------
  //  Overlay grid cache — keyed on lastSolve identity.
  // ---------------------------------------------------------------------------
  let _cacheLastSolve = null;
  let _cacheMap       = null;

  function getCachedGrid(lastSolve, k, bodyKey, kind) {
    if (_cacheLastSolve !== lastSolve) {
      _cacheMap       = new Map();
      _cacheLastSolve = lastSolve;
    }
    return _cacheMap.get(k + ":" + bodyKey + ":" + kind) || null;
  }

  function setCachedGrid(lastSolve, k, bodyKey, kind, grid) {
    if (_cacheLastSolve !== lastSolve) {
      _cacheMap       = new Map();
      _cacheLastSolve = lastSolve;
    }
    _cacheMap.set(k + ":" + bodyKey + ":" + kind, grid);
  }

  // ---------------------------------------------------------------------------
  //  classifyConductors(conductorFeatures, rings) → { distributed, concentrated }
  //
  //  Identical to the classification used in cross-section-render.js.
  // ---------------------------------------------------------------------------
  function classifyConductors(conductorFeatures, rings) {
    const distributed   = [];
    const concentrated  = [];
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

  // ---------------------------------------------------------------------------
  //  drawCapSprite — draws one cross-section face through the installed affine
  //  transform (face-local world metres, +y up). Called with ctx already in the
  //  face plane (DPR base + faceAffine installed).
  // ---------------------------------------------------------------------------
  function drawCapSprite(ctx, features, rings, field, phi, runtime) {
    const CSP = window.LIB && window.LIB.CrossSectionSprite;
    if (!CSP) return;

    const rotorIron  = features.filter(function (f) { return f.member === "rotor"  && f.kind === "iron";      });
    const rotorMag   = features.filter(function (f) { return f.member === "rotor"  && f.kind === "magnet";    });
    const rotorCond  = features.filter(function (f) { return f.member === "rotor"  && f.kind === "conductor"; });
    const statorIron = features.filter(function (f) { return f.member === "stator" && f.kind === "iron";      });
    const statorMag  = features.filter(function (f) { return f.member === "stator" && f.kind === "magnet";    });
    const statorCond = features.filter(function (f) { return f.member === "stator" && f.kind === "conductor"; });

    const rotorClass  = classifyConductors(rotorCond,  rings);
    const statorClass = classifyConductors(statorCond, rings);

    const currents = (runtime && runtime.state && runtime.state.i) ? runtime.state.i : null;

    // Shaft and gap radii are read from the field mesh when a solve is present.
    let shaftR    = 0;
    let gapInnerR = 0;
    let gapOuterR = 0;
    if (field) {
      shaftR    = field.rotor.mesh.shaftR  != null ? field.rotor.mesh.shaftR  : 0;
      gapInnerR = field.rotor.mesh.gapR    != null ? field.rotor.mesh.gapR    : 0;
      gapOuterR = field.stator.mesh.gapR   != null ? field.stator.mesh.gapR   : 0;
    }

    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};

    // Rotor body inside rotate(phi).
    ctx.save();
    ctx.rotate(phi);

    CSP.drawIron(ctx, rotorIron, { gapEdge: "outer" });
    CSP.drawMagnet(ctx, rotorMag, {});

    if (rotorClass.distributed.length > 0) {
      CSP.drawWinding(ctx, rotorClass.distributed, "distributed", {
        palette: WIRE_PALETTE,
        currents: currents,
        showCurrentGlyph: !!viz.currentDensity,
      });
    }
    if (rotorClass.concentrated.length > 0) {
      CSP.drawWinding(ctx, rotorClass.concentrated, "concentrated", {
        palette: WIRE_PALETTE,
        currents: currents,
        showCurrentGlyph: !!viz.currentDensity,
      });
    }

    CSP.drawShaftAndGap(ctx, { shaftR, gapInnerR, gapOuterR }, {});

    ctx.restore(); // end rotate(phi)

    // Stator body (lab frame).
    CSP.drawIron(ctx, statorIron, { gapEdge: "inner" });
    CSP.drawMagnet(ctx, statorMag, {});

    if (statorClass.distributed.length > 0) {
      CSP.drawWinding(ctx, statorClass.distributed, "distributed", {
        palette: WIRE_PALETTE,
        currents: currents,
        showCurrentGlyph: !!viz.currentDensity,
      });
    }
    if (statorClass.concentrated.length > 0) {
      CSP.drawWinding(ctx, statorClass.concentrated, "concentrated", {
        palette: WIRE_PALETTE,
        currents: currents,
        showCurrentGlyph: !!viz.currentDensity,
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  drawCapFieldOverlays — draws field overlays on the cap face.
  //  Called with ctx in the face-affine frame (DPR base + faceAffine installed).
  //  Rotor overlays must be called inside a rotate(phi) save/restore.
  // ---------------------------------------------------------------------------
  function drawCapFieldOverlays(ctx, k, field, phi, lastSolve) {
    const MMV     = window.LIB && window.LIB.MotorMeshView;
    const GapEval = window.LIB && window.LIB.GapEval;
    if (!MMV) return;

    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};

    const Nr     = 12;
    const Ntheta = 64;

    // Rotor overlays inside rotate(phi).
    ctx.save();
    ctx.rotate(phi);

    const rf = field.rotor;
    if (viz.fluxLines) {
      let grid = getCachedGrid(lastSolve, k, "rotor", "fluxLines");
      if (!grid) {
        grid = MMV.resampleField(rf.mesh, rf.Anode, { Nr, Ntheta });
        setCachedGrid(lastSolve, k, "rotor", "fluxLines", grid);
      }
      MMV.drawFluxLines(ctx, grid, { levels: 12 });
    }
    if (viz.modulusB) {
      let grid = getCachedGrid(lastSolve, k, "rotor", "modulusB");
      if (!grid) {
        const nodal = MMV.elemToNodal(rf.mesh, rf.Belem.mag);
        grid = MMV.resampleField(rf.mesh, nodal, { Nr, Ntheta });
        setCachedGrid(lastSolve, k, "rotor", "modulusB", grid);
      }
      MMV.drawModulusB(ctx, grid, { range: "auto" });
    }

    ctx.restore(); // end rotate(phi)

    // Stator overlays (lab frame).
    const sf = field.stator;
    if (viz.fluxLines) {
      let grid = getCachedGrid(lastSolve, k, "stator", "fluxLines");
      if (!grid) {
        grid = MMV.resampleField(sf.mesh, sf.Anode, { Nr, Ntheta });
        setCachedGrid(lastSolve, k, "stator", "fluxLines", grid);
      }
      MMV.drawFluxLines(ctx, grid, { levels: 12 });
    }
    if (viz.modulusB) {
      let grid = getCachedGrid(lastSolve, k, "stator", "modulusB");
      if (!grid) {
        const nodal = MMV.elemToNodal(sf.mesh, sf.Belem.mag);
        grid = MMV.resampleField(sf.mesh, nodal, { Nr, Ntheta });
        setCachedGrid(lastSolve, k, "stator", "modulusB", grid);
      }
      MMV.drawModulusB(ctx, grid, { range: "auto" });
    }

    // Cross-gap flux (lab frame).
    if (viz.fluxLines && GapEval) {
      const rotorBody  = field.rotor;
      const statorBody = field.stator;
      if (rotorBody.mesh.gapLoop && statorBody.mesh.gapLoop &&
          rotorBody.mesh.gapR > 0 && statorBody.mesh.gapR > rotorBody.mesh.gapR) {
        const descriptor = {
          rotor:  ringFromGapLoop(rotorBody,  rotorBody.Anode),
          stator: ringFromGapLoop(statorBody, statorBody.Anode),
          phi:    field.gap.phi,
        };
        try {
          const gapGrid = GapEval.evalAOnGrid(descriptor, { Nr: 8, Ntheta: 96 });
          MMV.drawFluxLines(ctx, gapGrid, { levels: 12 });
        } catch (e) {
          // Gap eval failed (e.g. radii constraints not met); skip silently.
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  maxOuterRadius — largest node radius across all features of a slice section.
  // ---------------------------------------------------------------------------
  function maxOuterRadius(features) {
    let rMax = 0;
    for (const feat of features) {
      if (feat.rRange && feat.rRange[1] > rMax) rMax = feat.rRange[1];
    }
    return rMax;
  }

  // ---------------------------------------------------------------------------
  //  paint(mountCtx, L3, rctx) — the 3-D render seam entry.
  // ---------------------------------------------------------------------------
  function paint(mountCtx, L3, rctx) {
    const runtime  = mountCtx.runtime;
    const expanded = rctx.expanded;
    const config   = rctx.config || mountCtx.config;

    if (!runtime || !expanded || !rctx.canvas) return;

    const ctx = rctx.canvas.getContext("2d");
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;

    const N   = expanded.slices.length;
    const ell = expanded.grid.ell;
    const rings = config.rings || [];

    const lastSolve = runtime.lastSolve || null;

    // Build the flat list of draw items for painter's algorithm.
    const items = [];

    for (let k = 0; k < N; k++) {
      const { z0, z1, zc } = sliceAxialBounds(k, N, ell);

      const field = (lastSolve && lastSolve.perSliceField && lastSolve.perSliceField[k])
        ? lastSolve.perSliceField[k]
        : null;

      const phi = field
        ? field.gap.phi
        : ((runtime.state ? runtime.state.theta : 0) + expanded.slices[k].offset);

      const features = expanded.slices[k].section.features;
      const rMax     = maxOuterRadius(features);

      // Two cap faces per slice (z0 and z1).
      for (let ci = 0; ci < 2; ci++) {
        const zFace  = ci === 0 ? z0 : z1;
        const pCentr = L3.project({ x: 0, y: 0, z: zFace });
        const depth  = L3.depthOf({ x: 0, y: 0, z: zFace });

        // Capture loop variables for the closure.
        const _zFace    = zFace;
        const _rMax     = rMax;
        const _features = features;
        const _field    = field;
        const _phi      = phi;
        const _k        = k;

        items.push({
          depth,
          paint: function () {
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const A = faceAffine(L3, _zFace, _rMax);
            ctx.transform(A.a, A.b, A.c, A.d, A.e, A.f);

            drawCapSprite(ctx, _features, rings, _field, _phi, runtime);

            if (_field) {
              drawCapFieldOverlays(ctx, _k, _field, _phi, lastSolve);
            }

            ctx.restore();
          },
        });
      }

      // Side-wall quads (radial-extreme silhouette between z0 and z1).
      // Sample the outer radius silhouette at several angles to form quads.
      const WALL_SEGS = 32;
      for (let si = 0; si < WALL_SEGS; si++) {
        const theta0 = (si / WALL_SEGS) * 2 * Math.PI;
        const theta1 = ((si + 1) / WALL_SEGS) * 2 * Math.PI;

        const pt00 = { x: rMax * Math.cos(theta0), y: rMax * Math.sin(theta0), z: z0 };
        const pt10 = { x: rMax * Math.cos(theta1), y: rMax * Math.sin(theta1), z: z0 };
        const pt11 = { x: rMax * Math.cos(theta1), y: rMax * Math.sin(theta1), z: z1 };
        const pt01 = { x: rMax * Math.cos(theta0), y: rMax * Math.sin(theta0), z: z1 };

        const wallDepth = L3.depthOf({
          x: rMax * Math.cos((theta0 + theta1) / 2),
          y: rMax * Math.sin((theta0 + theta1) / 2),
          z: zc,
        });

        const _pt00 = pt00, _pt10 = pt10, _pt11 = pt11, _pt01 = pt01;

        items.push({
          depth: wallDepth,
          paint: function () {
            const p00 = L3.project(_pt00);
            const p10 = L3.project(_pt10);
            const p11 = L3.project(_pt11);
            const p01 = L3.project(_pt01);

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p00.px * dpr, p00.py * dpr);
            ctx.lineTo(p10.px * dpr, p10.py * dpr);
            ctx.lineTo(p11.px * dpr, p11.py * dpr);
            ctx.lineTo(p01.px * dpr, p01.py * dpr);
            ctx.closePath();
            ctx.fillStyle = "rgba(40,44,55,0.85)";
            ctx.fill();
            ctx.strokeStyle = "rgba(80,90,110,0.5)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
          },
        });
      }

      // End-winding arcs at the two outer ends only (k=0 for z0 end, k=N-1 for z1 end).
      const conductorFeats = features.filter(function (f) { return f.kind === "conductor"; });
      if (conductorFeats.length > 0) {
        if (k === 0) {
          const ewArcs = endWindingArcs(conductorFeats, {
            zEnd: z0, bulge: ell * 0.15, sign: -1, samples: 8,
          });
          for (const arc of ewArcs) {
            const ewDepth = L3.depthOf({
              x: arc.points[0],
              y: arc.points[1],
              z: arc.points[2],
            });
            const _arc    = arc;
            items.push({
              depth: ewDepth,
              paint: function () {
                const color = WIRE_PALETTE[_arc.circuit % WIRE_PALETTE.length];
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth   = 2 * dpr;
                ctx.beginPath();
                const pts = _arc.points;
                const ns  = pts.length / 3;
                for (let pi = 0; pi < ns; pi++) {
                  const wp = { x: pts[pi * 3], y: pts[pi * 3 + 1], z: pts[pi * 3 + 2] };
                  const pp = L3.project(wp);
                  if (pi === 0) {
                    ctx.moveTo(pp.px * dpr, pp.py * dpr);
                  } else {
                    ctx.lineTo(pp.px * dpr, pp.py * dpr);
                  }
                }
                ctx.stroke();
                ctx.restore();
              },
            });
          }
        }
        if (k === N - 1) {
          const ewArcs = endWindingArcs(conductorFeats, {
            zEnd: z1, bulge: ell * 0.15, sign: 1, samples: 8,
          });
          for (const arc of ewArcs) {
            const ewDepth = L3.depthOf({
              x: arc.points[0],
              y: arc.points[1],
              z: arc.points[2],
            });
            const _arc = arc;
            items.push({
              depth: ewDepth,
              paint: function () {
                const color = WIRE_PALETTE[_arc.circuit % WIRE_PALETTE.length];
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth   = 2 * dpr;
                ctx.beginPath();
                const pts = _arc.points;
                const ns  = pts.length / 3;
                for (let pi = 0; pi < ns; pi++) {
                  const wp = { x: pts[pi * 3], y: pts[pi * 3 + 1], z: pts[pi * 3 + 2] };
                  const pp = L3.project(wp);
                  if (pi === 0) {
                    ctx.moveTo(pp.px * dpr, pp.py * dpr);
                  } else {
                    ctx.lineTo(pp.px * dpr, pp.py * dpr);
                  }
                }
                ctx.stroke();
                ctx.restore();
              },
            });
          }
        }
      }
    }

    // Depth-sort farthest first (painter's algorithm) then paint.
    const sorted = LIB.Layout3D.depthSort(items, function (it) { return it.depth; });
    for (const item of sorted) {
      item.paint();
    }
  }

  // ---------------------------------------------------------------------------
  //  register(UM) — installs the 3-D renderer via the UM.registerRender3D seam.
  // ---------------------------------------------------------------------------
  function register(UM_arg) {
    const target = UM_arg || UM;
    if (target.registerRender3D) {
      target.registerRender3D({ paint });
    }
  }

  UM.Render3D = { paint, register, sliceAxialBounds, faceAffine, endWindingArcs };

  if (UM.registerRender3D) register(UM);
})();
