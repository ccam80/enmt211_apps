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
  //  Affine 6-tuple mapping a face-local point (u, v) metres in the plane z = z0
  //  to CSS pixels, pinned by the camera projections of the face centre
  //  O = L3.project({x:0,y:0,z:z0}), Pu = L3.project({x:R,y:0,z:z0}),
  //  Pv = L3.project({x:0,y:R,z:z0}).  px = a·u + c·v + e, py = b·u + d·v + f.
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
  // ---------------------------------------------------------------------------
  function endWindingArcs(conductorFeatures, opts) {
    if (!conductorFeatures || conductorFeatures.length === 0) return [];
    opts = opts || {};
    const zEnd    = opts.zEnd   != null ? opts.zEnd   : 0;
    const bulge   = opts.bulge  != null ? opts.bulge  : 0.005;
    const sign    = opts.sign   != null ? opts.sign   : 1;
    const samples = opts.samples != null ? opts.samples : 8;

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

      function meanAngle(feat) {
        const [t0, t1] = feat.thetaRange;
        return (t0 + t1) / 2;
      }
      function meanRadius(feat) {
        const [r0, r1] = feat.rRange;
        return (r0 + r1) / 2;
      }

      const sortedGo = goSlots.slice().sort(function (a, b) {
        return meanAngle(a) - meanAngle(b);
      });

      const usedReturn = new Set();

      for (const go of sortedGo) {
        const goAngle = meanAngle(go);
        let bestIdx = -1;
        let bestDist = Infinity;
        for (let ri = 0; ri < returnSlots.length; ri++) {
          if (usedReturn.has(ri)) continue;
          const retAngle = meanAngle(returnSlots[ri]);
          let diff = Math.abs(retAngle - goAngle);
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

        const zBase   = sign * Math.abs(zEnd);
        const zPeak   = sign * (Math.abs(zEnd) + bulge);
        const points  = new Float64Array(samples * 3);

        const midIdx = Math.floor((samples - 1) / 2);
        for (let si = 0; si < samples; si++) {
          const t = si / (samples - 1);
          let dTheta = retTheta - goTheta;
          if (dTheta >  Math.PI) dTheta -= 2 * Math.PI;
          if (dTheta < -Math.PI) dTheta += 2 * Math.PI;
          const theta = goTheta + t * dTheta;

          let zFrac;
          if (si === midIdx) {
            zFrac = 1;
          } else {
            zFrac = Math.sin(Math.PI * t);
          }
          const z = zBase + (zPeak - zBase) * zFrac;
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
  //  maxOuterRadius — largest node radius across all features of a slice section.
  // ---------------------------------------------------------------------------
  function maxOuterRadius(features) {
    let rMax = 0;
    for (const feat of features) {
      if (feat.rRange && feat.rRange[1] > rMax) rMax = feat.rRange[1];
    }
    return rMax;
  }

  // ===========================================================================
  //  Cutaway + extruded body geometry
  //
  //  The casing is solid: the outer member (larger-radius body) encloses the
  //  inner one, so a full extrusion would hide the teeth and windings inside it.
  //  The rig removes a fixed angular wedge from the OUTER member only — the inner
  //  member is drawn whole and free to spin — so the cut reveals the toothed
  //  core, the conductor bars in the slots, the gap, and the inner member along
  //  the full axial length. The wedge is world-fixed; the camera orbits into it.
  // ===========================================================================

  const CUT_CENTER = Math.PI / 2;   // wedge centre angle (world frame, +y)
  const CUT_HALF   = 1.05;          // half-width of the removed wedge (radians)
  const ARC_SEG    = 0.18;          // max arc segment width for tessellation (rad)

  // Kept angular arc [KEEP_A0, KEEP_A1] = the complement of the removed wedge.
  const KEEP_A0 = CUT_CENTER + CUT_HALF;
  const KEEP_A1 = CUT_CENTER - CUT_HALF + 2 * Math.PI;

  // True when angle `a` lies inside the removed wedge.
  function inWedge(a) {
    let d = a - CUT_CENTER;
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return Math.abs(d) < CUT_HALF;
  }

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
  }

  const COLOR = {
    iron: [106, 106, 122],
    yoke: [92, 92, 106],
    magN: [224, 80, 80],
    magS: [80, 128, 224],
    cut:  [120, 120, 134],   // freshly-cut radial faces, lighter steel
  };

  // Push one quad face (world, unrotated) with an outward normal and base rgb.
  function pushQuad(faces, p0, p1, p2, p3, nx, ny, nz, rgb, rotor) {
    faces.push({ v: [p0, p1, p2, p3], n: [nx, ny, nz], rgb: rgb, rotor: rotor });
  }

  // Extrude one annular sector [r0,r1] x [a0,a1] over [z0,z1] into outward-facing
  // quads: outer + inner cylindrical bands (tessellated), the two radial flanks,
  // and the two axial end caps. Full-circle sectors skip their flanks.
  function extrudeSector(faces, r0, r1, a0, a1, z0, z1, rgb, rotor, opts) {
    opts = opts || {};
    const cutFlanks = opts.cutFlanks || null;
    const span = a1 - a0;
    const nSeg = Math.max(1, Math.ceil(span / ARC_SEG));
    const dA = span / nSeg;

    function P(r, a, z) { return [r * Math.cos(a), r * Math.sin(a), z]; }

    for (let i = 0; i < nSeg; i++) {
      const aa = a0 + i * dA;
      const ab = aa + dA;
      const am = (aa + ab) / 2;
      pushQuad(faces, P(r1, aa, z0), P(r1, ab, z0), P(r1, ab, z1), P(r1, aa, z1),
        Math.cos(am), Math.sin(am), 0, rgb, rotor);
      if (r0 > 1e-6) {
        pushQuad(faces, P(r0, ab, z0), P(r0, aa, z0), P(r0, aa, z1), P(r0, ab, z1),
          -Math.cos(am), -Math.sin(am), 0, rgb, rotor);
      }
      pushQuad(faces, P(r0, aa, z0), P(r1, aa, z0), P(r1, ab, z0), P(r0, ab, z0),
        0, 0, -1, rgb, rotor);
      pushQuad(faces, P(r0, ab, z1), P(r1, ab, z1), P(r1, aa, z1), P(r0, aa, z1),
        0, 0, 1, rgb, rotor);
    }

    if (span < 2 * Math.PI - 1e-6) {
      const flankRgb = cutFlanks || rgb;
      pushQuad(faces, P(r0, a0, z0), P(r1, a0, z0), P(r1, a0, z1), P(r0, a0, z1),
        Math.sin(a0), -Math.cos(a0), 0, flankRgb, rotor);
      pushQuad(faces, P(r1, a1, z0), P(r0, a1, z0), P(r0, a1, z1), P(r1, a1, z1),
        -Math.sin(a1), Math.cos(a1), 0, flankRgb, rotor);
    }
  }

  // Extrude one feature honouring the cutaway. Full-annulus features become the
  // kept arc (with cut-coloured flanks); narrow features inside the wedge drop,
  // those outside are kept whole.
  function extrudeFeature(faces, feat, z0, z1, rgb, rotor, cut) {
    const [r0, r1] = feat.rRange;
    const [t0, t1] = feat.thetaRange;
    const span = t1 - t0;

    if (span >= 2 * Math.PI - 1e-6) {
      if (cut) {
        extrudeSector(faces, r0, r1, KEEP_A0, KEEP_A1, z0, z1, rgb, rotor, { cutFlanks: COLOR.cut });
      } else {
        extrudeSector(faces, r0, r1, 0, 2 * Math.PI, z0, z1, rgb, rotor, {});
      }
      return;
    }

    if (cut && inWedge((t0 + t1) / 2)) return;
    extrudeSector(faces, r0, r1, t0, t1, z0, z1, rgb, rotor, {});
  }

  // Replicate cross-section-sprite's distributed wire layout (positions + radius)
  // so the body bars sit exactly under the cap discs. Returns [{x,y,r}].
  function distributedWireLayout(feat) {
    const [r0, r1] = feat.rRange;
    const [t0, t1] = feat.thetaRange;
    const T = Math.abs(Math.round(feat.turns != null ? feat.turns : 1));
    const v = Math.min(8, T === 0 ? 1 : T);
    if (v <= 0) return [];
    const cols = Math.ceil(Math.sqrt(v));
    const rows = Math.ceil(v / cols);
    const rStep = (r1 - r0) / rows;
    const tStep = (t1 - t0) / cols;
    const rMid = (r0 + r1) / 2;
    const wireR = 0.35 * Math.min(rMid * tStep, rStep);
    const out = [];
    let drawn = 0;
    for (let ri = 0; ri < rows && drawn < v; ri++) {
      for (let ci = 0; ci < cols && drawn < v; ci++) {
        const r = r0 + (ri + 0.5) * rStep;
        const theta = t0 + (ci + 0.5) * tStep;
        out.push({ x: r * Math.cos(theta), y: r * Math.sin(theta), r: wireR });
        drawn++;
      }
    }
    return out;
  }

  // Extrude each conductor's individual wires as square bars along the stack.
  function extrudeWires(faces, feat, z0, z1, rgb, rotor, cut) {
    const [t0, t1] = feat.thetaRange;
    if (cut && inWedge((t0 + t1) / 2)) return;
    const wires = distributedWireLayout(feat);
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const w of wires) {
      const h = w.r, x = w.x, y = w.y;
      const c = [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
      for (let s = 0; s < 4; s++) {
        const a = c[s], b = c[(s + 1) % 4];
        pushQuad(faces,
          [a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1],
          normals[s][0], normals[s][1], 0, rgb, rotor);
      }
    }
  }

  // Build the extruded body face list for one slice. The radially-outer member
  // gets the cutaway; the inner member is whole. Pure: world-space faces only.
  function buildSliceBody(features, z0, z1) {
    let rotorMax = 0, statorMax = 0;
    for (const f of features) {
      if (!f.rRange) continue;
      if (f.member === "rotor"  && f.rRange[1] > rotorMax)  rotorMax  = f.rRange[1];
      if (f.member === "stator" && f.rRange[1] > statorMax) statorMax = f.rRange[1];
    }
    const outerMember = statorMax >= rotorMax ? "stator" : "rotor";

    const faces = [];
    for (const f of features) {
      const rotor = (f.member === "rotor");
      const cut = (f.member === outerMember);
      if (f.kind === "iron") {
        const full = (f.thetaRange[1] - f.thetaRange[0]) >= 2 * Math.PI - 1e-6;
        extrudeFeature(faces, f, z0, z1, full ? COLOR.yoke : COLOR.iron, rotor, cut);
      } else if (f.kind === "magnet") {
        extrudeFeature(faces, f, z0, z1, (f.Mr >= 0) ? COLOR.magN : COLOR.magS, rotor, cut);
      } else if (f.kind === "conductor") {
        const idx = (((f.circuit | 0) % WIRE_PALETTE.length) + WIRE_PALETTE.length) % WIRE_PALETTE.length;
        extrudeWires(faces, f, z0, z1, hexToRgb(WIRE_PALETTE[idx]), rotor, cut);
      }
    }
    return faces;
  }

  // Memoize the per-slice body geometry on the expanded-config identity, so it is
  // rebuilt only on a geometry edit — never per frame.
  let _bodyKey = null;
  let _bodyFaces = null;

  function bodyFacesFor(expanded) {
    if (_bodyKey === expanded && _bodyFaces) return _bodyFaces;
    const N = expanded.slices.length;
    const ell = expanded.grid.ell;
    const out = [];
    for (let k = 0; k < N; k++) {
      const { z0, z1 } = sliceAxialBounds(k, N, ell);
      out.push(buildSliceBody(expanded.slices[k].section.features, z0, z1));
    }
    _bodyKey = expanded;
    _bodyFaces = out;
    return out;
  }

  // Clip the 2-D context (under the installed face affine, world metres) to the
  // kept angular sector so a cap opening matches the body cutaway.
  function clipToKept(ctx, rMax) {
    const RBIG = rMax * 1.4 + 0.02;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, RBIG, KEEP_A0, KEEP_A1, false);
    ctx.closePath();
    ctx.clip();
  }

  // ---------------------------------------------------------------------------
  //  drawCapSprite — draws one cross-section face through the installed affine
  //  transform. The outer (cut) member is clipped to the kept sector so the cap
  //  opening matches the body cutaway; the inner member is drawn whole.
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

    let rotorMax = 0, statorMax = 0;
    for (const f of features) {
      if (!f.rRange) continue;
      if (f.member === "rotor"  && f.rRange[1] > rotorMax)  rotorMax  = f.rRange[1];
      if (f.member === "stator" && f.rRange[1] > statorMax) statorMax = f.rRange[1];
    }
    const outerIsStator = statorMax >= rotorMax;
    const rMax = Math.max(rotorMax, statorMax);

    let shaftR    = 0;
    let gapInnerR = 0;
    let gapOuterR = 0;
    if (field) {
      shaftR    = field.rotor.mesh.shaftR  != null ? field.rotor.mesh.shaftR  : 0;
      gapInnerR = field.rotor.mesh.gapR    != null ? field.rotor.mesh.gapR    : 0;
      gapOuterR = field.stator.mesh.gapR   != null ? field.stator.mesh.gapR   : 0;
    }

    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};

    // Rotor body inside rotate(phi); clipped only when the rotor is the cut member.
    ctx.save();
    if (!outerIsStator) clipToKept(ctx, rMax);
    ctx.rotate(phi);

    CSP.drawIron(ctx, rotorIron, { gapEdge: "outer" });
    CSP.drawMagnet(ctx, rotorMag, {});

    if (rotorClass.distributed.length > 0) {
      CSP.drawWinding(ctx, rotorClass.distributed, "distributed", {
        palette: WIRE_PALETTE, currents: currents, showCurrentGlyph: !!viz.currentDensity,
      });
    }
    if (rotorClass.concentrated.length > 0) {
      CSP.drawWinding(ctx, rotorClass.concentrated, "concentrated", {
        palette: WIRE_PALETTE, currents: currents, showCurrentGlyph: !!viz.currentDensity,
      });
    }
    CSP.drawShaftAndGap(ctx, { shaftR, gapInnerR, gapOuterR }, {});
    ctx.restore();

    // Stator body (lab frame); clipped only when the stator is the cut member.
    ctx.save();
    if (outerIsStator) clipToKept(ctx, rMax);

    CSP.drawIron(ctx, statorIron, { gapEdge: "inner" });
    CSP.drawMagnet(ctx, statorMag, {});

    if (statorClass.distributed.length > 0) {
      CSP.drawWinding(ctx, statorClass.distributed, "distributed", {
        palette: WIRE_PALETTE, currents: currents, showCurrentGlyph: !!viz.currentDensity,
      });
    }
    if (statorClass.concentrated.length > 0) {
      CSP.drawWinding(ctx, statorClass.concentrated, "concentrated", {
        palette: WIRE_PALETTE, currents: currents, showCurrentGlyph: !!viz.currentDensity,
      });
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  //  drawCapFieldOverlays — draws field overlays on the cap face.
  // ---------------------------------------------------------------------------
  function drawCapFieldOverlays(ctx, k, field, phi, lastSolve, rMax) {
    const MMV     = window.LIB && window.LIB.MotorMeshView;
    const GapEval = window.LIB && window.LIB.GapEval;
    if (!MMV) return;

    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};

    const Nr     = 12;
    const Ntheta = 64;

    // Clip every overlay group to the kept sector in the lab frame so the field
    // is cut away with the body. The rotor group rotates inside the clip, so the
    // pattern spins behind a fixed cutaway window instead of spilling past it.
    ctx.save();
    clipToKept(ctx, rMax || 0.1);
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

    ctx.restore();

    // Stator + cross-gap overlays (lab frame), clipped to the same kept sector.
    ctx.save();
    clipToKept(ctx, rMax || 0.1);

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

    ctx.restore();
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
    const bodySlices = bodyFacesFor(expanded);

    const fwd = L3.basis.forward;

    const items = [];

    // --- Extruded body faces (one item per face, shaded + back-face culled).
    for (let k = 0; k < N; k++) {
      const field = (lastSolve && lastSolve.perSliceField && lastSolve.perSliceField[k])
        ? lastSolve.perSliceField[k]
        : null;
      const phi = field
        ? field.gap.phi
        : ((runtime.state ? runtime.state.theta : 0) + expanded.slices[k].offset);
      const cphi = Math.cos(phi), sphi = Math.sin(phi);

      const faces = bodySlices[k];
      for (let fi = 0; fi < faces.length; fi++) {
        const face = faces[fi];
        const rotor = face.rotor;

        let nx = face.n[0], ny = face.n[1];
        const nz = face.n[2];
        if (rotor) { const rnx = nx * cphi - ny * sphi; ny = nx * sphi + ny * cphi; nx = rnx; }
        const facing = -(nx * fwd.x + ny * fwd.y + nz * fwd.z);
        if (facing <= 0.02) continue;   // faces away from the camera

        const v = face.v;
        const sp = new Array(4);
        let depth = 0;
        let behind = false;
        for (let c = 0; c < 4; c++) {
          let x = v[c][0], y = v[c][1];
          if (rotor) { const rx = x * cphi - y * sphi; y = x * sphi + y * cphi; x = rx; }
          const pr = L3.project({ x: x, y: y, z: v[c][2] });
          if (pr.behind) { behind = true; break; }
          sp[c] = pr;
          depth += pr.depth;
        }
        if (behind) continue;
        depth /= 4;

        const rgb = face.rgb;
        const sh = 0.40 + 0.60 * facing;
        const fill = "rgb(" + Math.round(rgb[0] * sh) + "," +
                              Math.round(rgb[1] * sh) + "," +
                              Math.round(rgb[2] * sh) + ")";

        items.push({
          depth: depth,
          paint: (function (sp, fill) {
            return function () {
              ctx.save();
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              ctx.beginPath();
              ctx.moveTo(sp[0].px, sp[0].py);
              ctx.lineTo(sp[1].px, sp[1].py);
              ctx.lineTo(sp[2].px, sp[2].py);
              ctx.lineTo(sp[3].px, sp[3].py);
              ctx.closePath();
              ctx.fillStyle = fill;
              ctx.fill();
              ctx.restore();
            };
          })(sp, fill),
        });
      }
    }

    // --- Cross-section cap sprites + field overlays + end-winding arcs.
    for (let k = 0; k < N; k++) {
      const { z0, z1 } = sliceAxialBounds(k, N, ell);

      const field = (lastSolve && lastSolve.perSliceField && lastSolve.perSliceField[k])
        ? lastSolve.perSliceField[k]
        : null;
      const phi = field
        ? field.gap.phi
        : ((runtime.state ? runtime.state.theta : 0) + expanded.slices[k].offset);

      const features = expanded.slices[k].section.features;
      const rMax     = maxOuterRadius(features);

      for (let ci = 0; ci < 2; ci++) {
        const zFace = ci === 0 ? z0 : z1;
        const depth = L3.depthOf({ x: 0, y: 0, z: zFace });

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
              drawCapFieldOverlays(ctx, _k, _field, _phi, lastSolve, _rMax);
            }

            ctx.restore();
          },
        });
      }

      // End-winding arcs at the two outer ends only.
      const conductorFeats = features.filter(function (f) { return f.kind === "conductor"; });
      if (conductorFeats.length > 0) {
        const ends = [];
        if (k === 0)     ends.push({ zEnd: z0, sign: -1 });
        if (k === N - 1) ends.push({ zEnd: z1, sign:  1 });
        for (const end of ends) {
          const ewArcs = endWindingArcs(conductorFeats, {
            zEnd: end.zEnd, bulge: ell * 0.15, sign: end.sign, samples: 8,
          });
          for (const arc of ewArcs) {
            // Drop arcs whose midpoint sits in the cut wedge so the end windings
            // match the body cutaway.
            const mid = Math.floor((arc.points.length / 3) / 2);
            const mAng = Math.atan2(arc.points[mid * 3 + 1], arc.points[mid * 3]);
            if (inWedge(mAng)) continue;

            const ewDepth = L3.depthOf({ x: arc.points[0], y: arc.points[1], z: arc.points[2] });
            const _arc = arc;
            items.push({
              depth: ewDepth,
              paint: function () {
                const color = WIRE_PALETTE[_arc.circuit % WIRE_PALETTE.length];
                ctx.save();
                ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
                ctx.strokeStyle = color;
                ctx.lineWidth   = 2;
                ctx.beginPath();
                const pts = _arc.points;
                const ns  = pts.length / 3;
                for (let pi = 0; pi < ns; pi++) {
                  const pp = L3.project({ x: pts[pi * 3], y: pts[pi * 3 + 1], z: pts[pi * 3 + 2] });
                  if (pi === 0) ctx.moveTo(pp.px, pp.py);
                  else          ctx.lineTo(pp.px, pp.py);
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
