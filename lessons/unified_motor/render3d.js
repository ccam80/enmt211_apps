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

  function angleDelta(from, to) {
    let d = to - from;
    if (d >  Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  // ---------------------------------------------------------------------------
  //  endTurnArcs(winding, opts) → arc[]
  //
  //  The end turns that close every coil. The in-slot conductors run axially
  //  (extruded as bars in the body); here we draw only the connections at the
  //  two stack ends. For each coil (slotGo→slotReturn from the true routing)
  //  connect wire k of the go slot to wire k of the return slot — one arc per
  //  wire, not per slot — at the slot radius, crossing tangentially over the
  //  intervening tooth/teeth and bulging only axially just past the stack face.
  //  Concentrated and distributed differ only in how far apart the two slots
  //  are. Each arc is tagged with `end` (−1 / +1) for near/far paint layering.
  // ---------------------------------------------------------------------------
  function endTurnArcs(winding, opts) {
    opts = opts || {};
    const ell     = opts.ell != null ? opts.ell : 0.05;
    const bulge   = opts.bulge != null ? opts.bulge : ell * 0.15;
    const samples = opts.samples != null ? opts.samples : 10;
    const w  = winding.angularWidth;
    const sr = winding.slotRRange;
    const st = winding.slotTheta;

    const arcs = [];
    for (const coil of winding.coils) {
      // Land on the actual conductor bundles — for concentrated coils these are
      // the flank bundles (offset angle + narrower width), so the end turns meet
      // the in-slot bars rather than the slot centre.
      const goTheta  = coil.goThetaC  != null ? coil.goThetaC  : st[coil.slotGo];
      const retTheta = coil.retThetaC != null ? coil.retThetaC : st[coil.slotReturn];
      const goW  = coil.goW  != null ? coil.goW  : w;
      const retW = coil.retW != null ? coil.retW : w;
      const goBand  = coil.goRRange  || sr;
      const retBand = coil.retRRange || sr;
      const goWires  = distributedWireLayout({ rRange: goBand,  thetaRange: [goTheta - goW / 2, goTheta + goW / 2], turns: coil.turns });
      const retWires = distributedWireLayout({ rRange: retBand, thetaRange: [retTheta - retW / 2, retTheta + retW / 2], turns: coil.turns });
      const n = Math.min(goWires.length, retWires.length);

      for (let e = 0; e < 2; e++) {
        const sign  = e === 0 ? -1 : 1;
        const zBase = sign * (ell / 2);
        const zPeak = sign * (ell / 2 + bulge);
        for (let k = 0; k < n; k++) {
          const gW = goWires[k], rW = retWires[k];
          const gR = Math.hypot(gW.x, gW.y), gT = Math.atan2(gW.y, gW.x);
          const rR = Math.hypot(rW.x, rW.y), rT = Math.atan2(rW.y, rW.x);
          const dT = angleDelta(gT, rT);
          const points = new Float64Array(samples * 3);
          for (let si = 0; si < samples; si++) {
            const t = si / (samples - 1);
            const theta = gT + t * dT;
            const r = gR + t * (rR - gR);
            const z = zBase + (zPeak - zBase) * Math.sin(Math.PI * t);
            points[si * 3 + 0] = r * Math.cos(theta);
            points[si * 3 + 1] = r * Math.sin(theta);
            points[si * 3 + 2] = z;
          }
          arcs.push({ circuit: coil.circuit, end: sign, points: points });
        }
      }
    }
    return arcs;
  }

  // ---------------------------------------------------------------------------
  //  cageEndRing(features) → { member, rRange } | null
  //
  //  A cage shorts every bar with a solid conducting end ring at each axial end.
  //  The ring spans the bars' radial band; it is rendered as a flat filled
  //  annulus on the end faces.
  // ---------------------------------------------------------------------------
  function cageEndRing(features) {
    let r0 = Infinity, r1 = -Infinity, member = null;
    for (const f of features) {
      if (f.kind !== "conductor" || f.component !== "cage" || !f.rRange) continue;
      if (f.rRange[0] < r0) r0 = f.rRange[0];
      if (f.rRange[1] > r1) r1 = f.rRange[1];
      member = f.member;
    }
    if (member === null) return null;
    return { member: member, rRange: [r0, r1] };
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
      // Conductor features carry their winding kind via feat.component.
      if (feat.component === "concentrated-winding") concentrated.push(feat);
      else distributed.push(feat);
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
  //  Extruded body geometry
  //
  //  Each member is extruded as a full solid along the stack; the outer member
  //  encloses the inner one. Per-feature opacity (feat.alpha) reveals the teeth,
  //  windings, gap, and inner member — set a layer translucent to see past it.
  // ===========================================================================

  const ARC_SEG = 0.18;   // max arc segment width for tessellation (rad)

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
  };

  // Push one quad face (world, unrotated) with an outward normal, base rgb, and
  // opacity (a ∈ [0,1]).
  function pushQuad(faces, p0, p1, p2, p3, nx, ny, nz, rgb, rotor, a) {
    faces.push({ v: [p0, p1, p2, p3], n: [nx, ny, nz], rgb: rgb, rotor: rotor, a: a != null ? a : 1 });
  }

  // Extrude one annular sector [r0,r1] x [a0,a1] over [z0,z1] into outward-facing
  // quads: outer + inner cylindrical bands (tessellated) and the two radial
  // flanks. Full-circle sectors skip their flanks. No axial end caps — the
  // detailed cap sprite IS the end face; emitting flat end-cap discs here would
  // compete with the single-depth sprite item and occlude it (and its flux
  // overlay) on the camera-near side.
  function extrudeSector(faces, r0, r1, a0, a1, z0, z1, rgb, rotor, opts) {
    opts = opts || {};
    const a = opts.alpha != null ? opts.alpha : 1;
    const span = a1 - a0;
    const nSeg = Math.max(1, Math.ceil(span / ARC_SEG));
    const dA = span / nSeg;

    function P(r, ang, z) { return [r * Math.cos(ang), r * Math.sin(ang), z]; }

    for (let i = 0; i < nSeg; i++) {
      const aa = a0 + i * dA;
      const ab = aa + dA;
      const am = (aa + ab) / 2;
      pushQuad(faces, P(r1, aa, z0), P(r1, ab, z0), P(r1, ab, z1), P(r1, aa, z1),
        Math.cos(am), Math.sin(am), 0, rgb, rotor, a);
      if (r0 > 1e-6) {
        pushQuad(faces, P(r0, ab, z0), P(r0, aa, z0), P(r0, aa, z1), P(r0, ab, z1),
          -Math.cos(am), -Math.sin(am), 0, rgb, rotor, a);
      }
    }

    if (span < 2 * Math.PI - 1e-6) {
      pushQuad(faces, P(r0, a0, z0), P(r1, a0, z0), P(r1, a0, z1), P(r0, a0, z1),
        Math.sin(a0), -Math.cos(a0), 0, rgb, rotor, a);
      pushQuad(faces, P(r1, a1, z0), P(r0, a1, z0), P(r0, a1, z1), P(r1, a1, z1),
        -Math.sin(a1), Math.cos(a1), 0, rgb, rotor, a);
    }
  }

  // Extrude one feature as a full solid: a full-annulus feature becomes a
  // complete annular band; a narrow feature becomes its own sector.
  function extrudeFeature(faces, feat, z0, z1, rgb, rotor) {
    const [r0, r1] = feat.rRange;
    const [t0, t1] = feat.thetaRange;
    const span = t1 - t0;
    const a = feat.alpha != null ? feat.alpha : 1;

    if (span >= 2 * Math.PI - 1e-6) {
      extrudeSector(faces, r0, r1, 0, 2 * Math.PI, z0, z1, rgb, rotor, { alpha: a });
      return;
    }
    extrudeSector(faces, r0, r1, t0, t1, z0, z1, rgb, rotor, { alpha: a });
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
  function extrudeWires(faces, feat, z0, z1, rgb, rotor) {
    const alpha = feat.alpha != null ? feat.alpha : 1;
    const wires = distributedWireLayout(feat);
    const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (const w of wires) {
      const h = w.r, x = w.x, y = w.y;
      const c = [[x - h, y - h], [x + h, y - h], [x + h, y + h], [x - h, y + h]];
      for (let s = 0; s < 4; s++) {
        const p = c[s], q = c[(s + 1) % 4];
        pushQuad(faces,
          [p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z1],
          normals[s][0], normals[s][1], 0, rgb, rotor, alpha);
      }
    }
  }

  // Build the extruded body face list for one slice. Pure: world-space faces only.
  function buildSliceBody(features, z0, z1) {
    const faces = [];
    for (const f of features) {
      const rotor = (f.member === "rotor");
      if (f.kind === "iron") {
        const full = (f.thetaRange[1] - f.thetaRange[0]) >= 2 * Math.PI - 1e-6;
        extrudeFeature(faces, f, z0, z1, full ? COLOR.yoke : COLOR.iron, rotor);
      } else if (f.kind === "magnet") {
        extrudeFeature(faces, f, z0, z1, (f.Mr >= 0) ? COLOR.magN : COLOR.magS, rotor);
      } else if (f.kind === "conductor") {
        const idx = (((f.circuit | 0) % WIRE_PALETTE.length) + WIRE_PALETTE.length) % WIRE_PALETTE.length;
        extrudeWires(faces, f, z0, z1, hexToRgb(WIRE_PALETTE[idx]), rotor);
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

  // ---------------------------------------------------------------------------
  //  drawCapSprite — draws one cross-section face through the installed affine
  //  transform. Both members are drawn whole; the rotor rotates by phi.
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

    // Stator body (lab frame).
    ctx.save();
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
  function drawCapFieldOverlays(ctx, k, field, phi, lastSolve) {
    const MMV     = window.LIB && window.LIB.MotorMeshView;
    const GapEval = window.LIB && window.LIB.GapEval;
    if (!MMV) return;

    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};

    const Nr     = 12;
    const Ntheta = 64;

    // Rotor overlays rotate by phi; stator/gap overlays stay in the lab frame.
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

    ctx.restore();

    // Stator + cross-gap overlays (lab frame).
    ctx.save();

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
  //  Current-flow dot phase — one accumulated offset per circuit, advanced by
  //  the live current each frame off SIM time (so dots freeze when paused and
  //  reverse with current sign). Module-scoped; re-zeroed when the runtime
  //  changes or its clock rewinds (Reset).
  // ---------------------------------------------------------------------------
  let _dotPhase = null, _dotRt = null, _dotT = 0;
  function advanceDots(runtime, currents) {
    const m = currents.length;
    const t = (runtime.state && runtime.state.t != null) ? runtime.state.t : 0;
    if (_dotRt !== runtime || !_dotPhase || _dotPhase.length !== m || t < _dotT) {
      _dotPhase = new Float64Array(m); _dotRt = runtime; _dotT = t;
      return _dotPhase;
    }
    let dt = t - _dotT; _dotT = t;
    if (dt < 0) dt = 0; else if (dt > 0.05) dt = 0.05;
    const viz = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};
    LIB.CurrentDots.step(_dotPhase, currents, dt, {
      speedScale: viz.currentDotSpeed != null ? viz.currentDotSpeed : LIB.CurrentDots.DEFAULTS.speedScale,
      mode: viz.currentDotLog ? "logarithmic" : "linear",
    });
    return _dotPhase;
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

    // The body's two end faces (cap sprites) and the winding end caps sit on the
    // frontmost / backmost surfaces of the body. A single coarse depth key on a
    // cap lets teeth bodies sort in front of the end face at shallow angles, so
    // these are layered around the body's depth-sort rather than mixed into it:
    // the far layer paints behind the body, the near layer on top. An end is
    // "near" when its outward normal (±z) points toward the camera (sign·fwd.z<0).
    const nearCaps = [];
    const farCaps  = [];
    function layerFor(sign) { return (sign * fwd.z < 0) ? nearCaps : farCaps; }

    // Current-flow dots (yellow) ride the winding conductors. One accumulated
    // phase per circuit; each dot is placed along a conductor polyline and either
    // layered with its end turn (near/far) or depth-sorted with the body (bars).
    const vizDots = (typeof UM !== "undefined" && UM.fieldViz) ? UM.fieldViz : {};
    const currents = (runtime.state && runtime.state.i) ? runtime.state.i : null;
    const showDots = !!(vizDots.currentDots && currents && LIB.CurrentDots);
    const dotPhase = showDots ? advanceDots(runtime, currents) : null;
    const DOT_SPACING = (LIB.CurrentDots && LIB.CurrentDots.DEFAULTS.spacing) || 0.006;
    function dotItem(p, depthBias) {
      const depth = L3.depthOf({ x: p[0], y: p[1], z: p[2] }) - (depthBias || 0);
      return { depth: depth, kind: "dot", paint: function () {
        const pp = L3.project({ x: p[0], y: p[1], z: p[2] });
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.beginPath();
        ctx.arc(pp.px, pp.py, 2.6, 0, 2 * Math.PI);
        ctx.fillStyle = "#ffd633";
        ctx.fill();
        ctx.restore();
      } };
    }

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
        const fill = "rgba(" + Math.round(rgb[0] * sh) + "," +
                               Math.round(rgb[1] * sh) + "," +
                               Math.round(rgb[2] * sh) + "," + face.a + ")";

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

        // The two outermost faces are the true end faces — layer them near/far so
        // the end cross-section (back-iron included) is never occluded by teeth
        // bodies. Interior slice-boundary caps (multi-slice skew) stay in the sort.
        const isEndFace = (k === 0 && ci === 0) || (k === N - 1 && ci === 1);
        const target = isEndFace ? layerFor(ci === 0 ? -1 : 1) : items;
        target.push({
          depth,
          kind: "face",
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

    }

    // --- Winding end caps: per-wire end turns + cage shorting rings, from the
    //     true coil connectivity in expanded.windings (modulated by the end-cap
    //     alpha). They bulge axially beyond the iron end face, so they join the
    //     same near/far layers as the end faces — near turns paint on top of the
    //     body, far turns behind it.
    const endCapAlpha = expanded.endCapAlpha != null ? expanded.endCapAlpha : 1;
    if (endCapAlpha > 0) {
      const z0full = sliceAxialBounds(0, N, ell).z0;
      const z1full = sliceAxialBounds(N - 1, N, ell).z1;

      function strokeFor(circuit) {
        const i = ((circuit % WIRE_PALETTE.length) + WIRE_PALETTE.length) % WIRE_PALETTE.length;
        const c = hexToRgb(WIRE_PALETTE[i]);
        return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + endCapAlpha + ")";
      }

      function addArc(arc, lw) {
        const pts = arc.points, ns = pts.length / 3;
        const m = Math.floor(ns / 2);
        const depth = L3.depthOf({ x: pts[m * 3], y: pts[m * 3 + 1], z: pts[m * 3 + 2] });
        const _arc = arc, _lw = lw;
        layerFor(arc.end).push({
          depth: depth,
          kind: "wind",
          paint: function () {
            ctx.save();
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.strokeStyle = strokeFor(_arc.circuit);
            ctx.lineWidth = _lw;
            ctx.lineCap = "round";
            ctx.beginPath();
            const p = _arc.points, np = p.length / 3;
            for (let pi = 0; pi < np; pi++) {
              const pp = L3.project({ x: p[pi * 3], y: p[pi * 3 + 1], z: p[pi * 3 + 2] });
              if (pi === 0) ctx.moveTo(pp.px, pp.py);
              else          ctx.lineTo(pp.px, pp.py);
            }
            ctx.stroke();
            ctx.restore();
          },
        });
      }

      for (const wnd of (expanded.windings || [])) {
        for (const arc of endTurnArcs(wnd, { ell: ell, bulge: ell * 0.15 })) {
          addArc(arc, 2);
          if (showDots) {
            const off = (dotPhase[arc.circuit] || 0) * arc.end;   // flow sign = end
            const layer = layerFor(arc.end);
            for (const d of LIB.CurrentDots.placeDots(arc.points, off, DOT_SPACING)) layer.push(dotItem(d, 0));
          }
        }
      }

      // Cage shorting rings — a flat filled annulus on each end face, layered the
      // same way (near ring in front of its cross-section, far ring behind).
      const ring = cageEndRing(expanded.slices[0].section.features);
      if (ring) {
        const COPPER = [184, 115, 51];
        for (const sign of [-1, 1]) {
          const _z = sign < 0 ? z0full : z1full;
          const _ring = ring;
          const depth = L3.depthOf({ x: _ring.rRange[1], y: 0, z: _z });
          layerFor(sign).push({
            depth: depth,
            kind: "wind",
            paint: function () {
              ctx.save();
              ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              const A = faceAffine(L3, _z, _ring.rRange[1]);
              ctx.transform(A.a, A.b, A.c, A.d, A.e, A.f);
              ctx.beginPath();
              ctx.arc(0, 0, _ring.rRange[1], 0, 2 * Math.PI, false);
              ctx.arc(0, 0, _ring.rRange[0], 0, 2 * Math.PI, true);
              ctx.fillStyle = "rgba(" + COPPER[0] + "," + COPPER[1] + "," + COPPER[2] + "," + endCapAlpha + ")";
              ctx.fill("evenodd");
              ctx.restore();
            },
          });
        }
      }
    }

    // Current-flow dots along the in-slot conductor bars. Bars run the full
    // stack length, so depth-sorting their dots against the coarse full-length
    // body faces makes a dot wink out halfway down the body where the face
    // centroid crosses it. Instead keep only the camera-facing bars (the back
    // half is genuinely behind the body) and paint them as a final overlay, so a
    // dot stays visible along the whole bar. Rotor bars rotate by phi.
    const barDots = [];
    if (showDots) {
      for (let k = 0; k < N; k++) {
        const fld = (lastSolve && lastSolve.perSliceField && lastSolve.perSliceField[k]) ? lastSolve.perSliceField[k] : null;
        const phi = fld ? fld.gap.phi : ((runtime.state ? runtime.state.theta : 0) + expanded.slices[k].offset);
        const cphi = Math.cos(phi), sphi = Math.sin(phi);
        const bnd = sliceAxialBounds(k, N, ell);
        for (const f of expanded.slices[k].section.features) {
          if (f.kind !== "conductor" || f.circuit == null || !f.thetaRange) continue;
          const off = (dotPhase[f.circuit] || 0) * (f.turns >= 0 ? 1 : -1);
          const wires = distributedWireLayout({ rRange: f.rRange, thetaRange: f.thetaRange, turns: f.turns });
          for (let wi = 0; wi < wires.length; wi++) {
            let x = wires[wi].x, y = wires[wi].y;
            if (f.member === "rotor") { const rx = x * cphi - y * sphi; y = x * sphi + y * cphi; x = rx; }
            if (x * fwd.x + y * fwd.y >= 0) continue;          // skip the camera-far half
            const pts = new Float64Array([x, y, bnd.z0, x, y, bnd.z1]);
            for (const d of LIB.CurrentDots.placeDots(pts, off, DOT_SPACING)) barDots.push(dotItem(d, 0));
          }
        }
      }
    }

    // Paint back→front at each end:
    //   far end-turns/rings → far end face → body → near end face → near end-turns/rings
    // The end face sorts behind its own bulged turns (so it never hides them) and
    // the body never hides the near end face (so the back-iron stays visible).
    // Each sub-list is itself farthest-first for correct self-occlusion.
    function paintSorted(list) {
      list.sort(function (a, b) { return b.depth - a.depth; });
      for (const it of list) it.paint();
    }
    function ofKind(list, kind) { return list.filter(function (it) { return it.kind === kind; }); }

    paintSorted(ofKind(farCaps, "dot"));
    paintSorted(ofKind(farCaps, "wind"));
    paintSorted(ofKind(farCaps, "face"));
    const sorted = LIB.Layout3D.depthSort(items, function (it) { return it.depth; });
    for (const item of sorted) item.paint();
    paintSorted(ofKind(nearCaps, "face"));
    paintSorted(ofKind(nearCaps, "wind"));
    paintSorted(ofKind(nearCaps, "dot"));
    paintSorted(barDots);   // camera-facing in-slot bar dots, on top
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

  UM.Render3D = { paint, register, sliceAxialBounds, faceAffine,
    endTurnArcs, cageEndRing };

  if (UM.registerRender3D) register(UM);
})();
