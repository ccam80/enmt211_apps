(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});
  const TWO_PI = 2 * Math.PI;

  // ---------------------------------------------------------------------------
  //  Integer math helpers
  // ---------------------------------------------------------------------------

  function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b > 0) { const t = b; b = a % b; a = t; }
    return a;
  }

  function snapUpToMultiple(n, k) {
    if (k <= 0) return n;
    return Math.ceil(n / k) * k;
  }

  // ---------------------------------------------------------------------------
  //  Material table helpers
  // ---------------------------------------------------------------------------

  function airMaterial() {
    return { kind: "air", muR: 1, mrMag: 0, Bknee: null };
  }

  function materialKey(m) {
    return `${m.kind}|${m.muR}|${m.mrMag}|${m.Bknee}`;
  }

  function findOrAddMaterial(materials, keyMap, entry) {
    const k = materialKey(entry);
    if (keyMap.has(k)) return keyMap.get(k);
    const idx = materials.length;
    materials.push(entry);
    keyMap.set(k, idx);
    return idx;
  }

  // ---------------------------------------------------------------------------
  //  Geometry helpers
  // ---------------------------------------------------------------------------

  function bodyRadii(features, member) {
    let rMin = Infinity, rMax = -Infinity;
    for (const f of features) {
      if (f.member !== member) continue;
      if (f.rRange[0] < rMin) rMin = f.rRange[0];
      if (f.rRange[1] > rMax) rMax = f.rRange[1];
    }
    return { rMin, rMax };
  }

  // ---------------------------------------------------------------------------
  //  Compute the body's angular period P_body (number of periodic repetitions)
  //  from the features.  Full-circle features don't constrain the period.
  // ---------------------------------------------------------------------------

  function computeBodyPeriod(features, member) {
    let period = 0;
    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full circle — doesn't constrain period
      // count = number of identical sectors that tile the circle
      const count = Math.round(TWO_PI / span);
      if (count >= 2) {
        period = period === 0 ? count : gcd(period, count);
      }
    }
    return period > 0 ? period : 1;
  }

  // ---------------------------------------------------------------------------
  //  Collect all unique theta boundaries for features within [0, periodAngle].
  //  Only non-full-circle features contribute angular edges.
  //  Always includes 0 and periodAngle.
  // ---------------------------------------------------------------------------

  function collectThetaEdgesInSector(features, member, periodAngle) {
    const EPS = 1e-9;
    const edgeSet = new Set();
    edgeSet.add(0);
    edgeSet.add(periodAngle);

    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - EPS) continue; // full circle — no sector edges

      // Map thetaRange edges into [0, periodAngle] by modulo
      for (const raw of [f.thetaRange[0], f.thetaRange[1]]) {
        let t = raw % periodAngle;
        if (t < 0) t += periodAngle;
        if (t > EPS && t < periodAngle - EPS) edgeSet.add(t);
      }
    }

    return Array.from(edgeSet).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  //  Build radial node positions for one body.
  //
  //  rEdges: sorted array of r boundaries (body inner → collar)
  //  gapSide: "outer" (rotor) or "inner" (stator)
  //
  //  Strategy:
  //    • Each feature band gets 1 base layer, scaled by refine.
  //    • The gap-adjacent band gets gapLayers layers with quadratic grading
  //      toward the gap surface.
  //    • Yoke bands beyond the gap-adjacent band are coarsened by yokeCoarsen.
  // ---------------------------------------------------------------------------

  function buildRadialNodes(rEdges, gapSide, opts) {
    const gapLayers  = Math.max(1, Math.round(opts.gapLayers  != null ? opts.gapLayers  : 3));
    const yokeCoarsen= Math.max(1, opts.yokeCoarsen != null ? opts.yokeCoarsen : 1);
    const refine     = Math.max(1, opts.refine      != null ? opts.refine      : 1);

    const edges = rEdges.slice().sort((a, b) => a - b);
    const nBands = edges.length - 1;

    const rNodes = [edges[0]];

    for (let b = 0; b < nBands; b++) {
      const r0 = edges[b];
      const r1 = edges[b + 1];
      const dr = r1 - r0;

      // Identify which band is gap-adjacent
      const isGapBand =
        (gapSide === "outer" && b === nBands - 1) ||
        (gapSide === "inner" && b === 0);

      let nLayers;
      if (isGapBand) {
        nLayers = Math.max(1, Math.round(gapLayers * refine));
      } else {
        nLayers = Math.max(1, Math.round(refine / yokeCoarsen));
      }

      for (let i = 1; i <= nLayers; i++) {
        // Quadratic grading toward gap surface for the gap band
        let t;
        if (isGapBand && nLayers > 1) {
          if (gapSide === "outer") {
            // Dense at r1 (gap surface)
            t = 1 - Math.pow(1 - i / nLayers, 2);
          } else {
            // Dense at r0 (gap surface for inner)
            t = Math.pow(1 - (nLayers - i) / nLayers, 2);
          }
        } else {
          t = i / nLayers;
        }
        const r = r0 + t * dr;
        const last = rNodes[rNodes.length - 1];
        if (r - last > 1e-15) rNodes.push(r);
      }
    }

    return rNodes;
  }

  // ---------------------------------------------------------------------------
  //  Feature lookup: given (r, theta) return the matching feature or null.
  //  Most-specific match wins (smallest angular span for non-full-circle;
  //  full-circle features are always lower priority).
  // ---------------------------------------------------------------------------

  function makeFeatureLookup(features, member) {
    const bodyFeatures = features.filter(f => f.member === member);

    return function lookupFeature(r, theta) {
      // Normalize theta to [0, 2π)
      let th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;

      let best = null;
      let bestSpan = Infinity;

      for (const f of bodyFeatures) {
        if (r < f.rRange[0] || r >= f.rRange[1]) continue;

        const rawSpan = f.thetaRange[1] - f.thetaRange[0];
        if (rawSpan >= TWO_PI - 1e-9) {
          // Full-circle feature: matches any theta, but loses to any non-full
          if (best === null) { best = f; bestSpan = TWO_PI; }
          continue;
        }

        // Map thetaRange to [0, 2π)
        let t0 = ((f.thetaRange[0] % TWO_PI) + TWO_PI) % TWO_PI;
        let t1 = ((f.thetaRange[1] % TWO_PI) + TWO_PI) % TWO_PI;

        let inside;
        if (Math.abs(t1 - t0) < 1e-12) {
          inside = false;
        } else if (t0 < t1) {
          inside = th >= t0 && th < t1;
        } else {
          // wraps around 0
          inside = th >= t0 || th < t1;
        }

        if (inside) {
          const span = rawSpan;
          if (span < bestSpan) { best = f; bestSpan = span; }
        }
      }
      return best;
    };
  }

  // ---------------------------------------------------------------------------
  //  isCollarBand: does radial band [r0,r1] belong to the pure-air collar?
  //  The collar is the region between the body's outermost feature surface
  //  and the gapR circle (or innermost for stator).
  // ---------------------------------------------------------------------------

  function isCollarBand(r0, r1, features, member, gapSide) {
    if (gapSide === "outer") {
      // Find max feature rRange[1] for this member
      let maxFeatR = -Infinity;
      for (const f of features) {
        if (f.member === member && f.rRange[1] > maxFeatR) maxFeatR = f.rRange[1];
      }
      // A band is collar if its inner edge >= max feature surface
      return r0 >= maxFeatR - 1e-12;
    } else {
      // Find min feature rRange[0] for this member
      let minFeatR = Infinity;
      for (const f of features) {
        if (f.member === member && f.rRange[0] < minFeatR) minFeatR = f.rRange[0];
      }
      // A band is collar if its outer edge <= min feature bore
      return r1 <= minFeatR + 1e-12;
    }
  }

  // ---------------------------------------------------------------------------
  //  Compute gap geometry from features
  // ---------------------------------------------------------------------------

  function computeGapGeometry(features) {
    let rRotorSurface = -Infinity;
    let rStatorBore   =  Infinity;

    for (const f of features) {
      if (f.member === "rotor"  && f.rRange[1] > rRotorSurface) rRotorSurface = f.rRange[1];
      if (f.member === "stator" && f.rRange[0] < rStatorBore)   rStatorBore   = f.rRange[0];
    }

    if (!isFinite(rRotorSurface)) rRotorSurface = 0.04;
    if (!isFinite(rStatorBore))   rStatorBore   = 0.06;

    const g = rStatorBore - rRotorSurface;
    const rotorGapR  = rRotorSurface + 0.25 * g;
    const statorGapR = rStatorBore   - 0.25 * g;

    return { rotorGapR, statorGapR, g, rRotorSurface, rStatorBore };
  }

  // ---------------------------------------------------------------------------
  //  Build BodyMesh for one member (rotor or stator)
  // ---------------------------------------------------------------------------

  function buildBodyMesh(features, member, collarR, gapSide, opts) {
    const refine      = Math.max(1, opts.refine      != null ? opts.refine      : 1);
    const dofBudget   = opts.dofBudget   != null ? opts.dofBudget   : null;
    const gapMinNodes = opts.gapMinNodes != null ? opts.gapMinNodes : null;

    const { rMin, rMax } = bodyRadii(features, member);
    if (!isFinite(rMin) || !isFinite(rMax)) return emptyBodyMesh(member);

    // Collect unique radial edges (feature boundaries + collar edge)
    const rEdgeSet = new Set();
    for (const f of features) {
      if (f.member !== member) continue;
      rEdgeSet.add(f.rRange[0]);
      rEdgeSet.add(f.rRange[1]);
    }
    rEdgeSet.add(collarR);

    // For rotor: edges from rMin to collarR; for stator: collarR to rMax
    let rEdges = Array.from(rEdgeSet).sort((a, b) => a - b);
    if (gapSide === "outer") {
      rEdges = rEdges.filter(r => r >= rMin - 1e-15 && r <= collarR + 1e-15);
      rEdges[0] = rMin;
      rEdges[rEdges.length - 1] = collarR;
    } else {
      rEdges = rEdges.filter(r => r >= collarR - 1e-15 && r <= rMax + 1e-15);
      rEdges[0] = collarR;
      rEdges[rEdges.length - 1] = rMax;
    }
    // Deduplicate
    rEdges = rEdges.filter((r, i) => i === 0 || r - rEdges[i-1] > 1e-15);

    // Body angular period
    const P_body = computeBodyPeriod(features, member);
    const sectorAngle = TWO_PI / P_body;

    // Collect theta edges within one sector
    const thetaEdgesInSector = collectThetaEdgesInSector(features, member, sectorAngle);
    const nAngularBandsPerSector = Math.max(1, thetaEdgesInSector.length - 1);

    // Base angular divisions: subdivide each theta band by refine, then tile P_body.
    // The minimum must be large enough so that the straight-chord quads approximate
    // circular-arc sectors with < 1% area error.  A regular N-gon has area error
    // 1 - N·sin(2π/N)/(2π).  N=32 → ~0.26%; N=16 → ~1.0%.  We use ≥ 32 total
    // angular divisions (snapped to next multiple of P_body).
    const minTotalDivs = Math.max(32, Math.ceil(refine * 32));
    const minDivsPerSector = Math.max(4, Math.ceil(minTotalDivs / P_body));
    const baseDivsPerSector = Math.max(minDivsPerSector, Math.round(nAngularBandsPerSector * refine));
    let N_gap = P_body * baseDivsPerSector;

    // Apply gapMinNodes floor: snap up to next multiple of P_body
    if (gapMinNodes !== null && N_gap < gapMinNodes) {
      N_gap = snapUpToMultiple(gapMinNodes, P_body);
    }

    // Build initial radial nodes
    let rNodes = buildRadialNodes(rEdges, gapSide, opts);

    // Apply dofBudget: reduce radial resolution (but never pull N_gap below gapMinNodes floor)
    if (dofBudget !== null) {
      const maxNr = Math.max(2, Math.floor(dofBudget / Math.max(N_gap, 1)));
      if (rNodes.length > maxNr) {
        const reducedOpts = Object.assign({}, opts, {
          gapLayers: Math.max(1, Math.floor((opts.gapLayers != null ? opts.gapLayers : 3) * maxNr / rNodes.length)),
        });
        rNodes = buildRadialNodes(rEdges, gapSide, reducedOpts);
      }
    }

    return assembleMesh(features, member, rNodes, N_gap, P_body, collarR, gapSide, opts);
  }

  // ---------------------------------------------------------------------------
  //  Assemble the BodyMesh from radial + angular grids
  //
  //  Node grid: (Nr radial lines) × (Ntheta angular lines)
  //  Node index: i * Ntheta + j   (i = radial index, j = angular index)
  //  Elements: one quad per (i, j) cell: CCW winding (n00→n10→n11→n01)
  // ---------------------------------------------------------------------------

  function assembleMesh(features, member, rNodes, N_gap, P_body, collarR, gapSide, opts) {
    const Nr     = rNodes.length;
    const Ntheta = N_gap;
    const Nn     = Nr * Ntheta;
    const Ne     = (Nr - 1) * Ntheta;

    // Uniform angular spacing
    const dTheta = TWO_PI / Ntheta;

    // Build node coordinates (r, θ) → (x, y)
    const nodes = new Float64Array(2 * Nn);
    for (let i = 0; i < Nr; i++) {
      const r = rNodes[i];
      for (let j = 0; j < Ntheta; j++) {
        const th = j * dTheta;
        const ni = i * Ntheta + j;
        nodes[2 * ni]     = r * Math.cos(th);
        nodes[2 * ni + 1] = r * Math.sin(th);
      }
    }

    // Build elements
    const elems  = new Int32Array(4 * Ne);
    const matId  = new Int32Array(Ne);
    const srcId  = new Int32Array(Ne).fill(-1);
    const turns  = new Float64Array(Ne);
    const magDir = new Float64Array(2 * Ne);

    // Material table
    const materials = [airMaterial()];
    const matKeyMap = new Map();
    matKeyMap.set(materialKey(materials[0]), 0);

    // Feature lookup
    const lookup = makeFeatureLookup(features, member);

    // Gap-circle radial index
    const gapRadialIdx = gapSide === "outer" ? Nr - 1 : 0;

    let eIdx = 0;
    for (let i = 0; i < Nr - 1; i++) {
      const r0 = rNodes[i];
      const r1 = rNodes[i + 1];
      const rCent = 0.5 * (r0 + r1);
      const inCollar = isCollarBand(r0, r1, features, member, gapSide);

      for (let j = 0; j < Ntheta; j++) {
        const jNext = (j + 1) % Ntheta;
        // CCW quad: (i,j) → (i+1,j) → (i+1,j+1) → (i,j+1)
        const n00 = i       * Ntheta + j;
        const n10 = (i + 1) * Ntheta + j;
        const n11 = (i + 1) * Ntheta + jNext;
        const n01 = i       * Ntheta + jNext;

        elems[4 * eIdx]     = n00;
        elems[4 * eIdx + 1] = n10;
        elems[4 * eIdx + 2] = n11;
        elems[4 * eIdx + 3] = n01;

        if (inCollar) {
          // Air collar — material stays 0
          matId[eIdx]           = 0;
          srcId[eIdx]           = -1;
          turns[eIdx]           = 0;
          magDir[2 * eIdx]     = 0;
          magDir[2 * eIdx + 1] = 0;
        } else {
          const thCent = (j + 0.5) * dTheta;
          const feat = lookup(rCent, thCent);

          if (feat === null) {
            matId[eIdx] = 0; // air gap

          } else if (feat.kind === "iron") {
            const muR  = feat.muR   != null ? feat.muR   : 1000;
            const Bknee = feat.Bknee != null ? feat.Bknee : null;
            matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "iron", muR, mrMag: 0, Bknee });

          } else if (feat.kind === "magnet") {
            const Mr     = feat.Mr     != null ? feat.Mr     : 0;
            const Mtheta = feat.Mtheta != null ? feat.Mtheta : 0;
            const mrMag  = Math.hypot(Mr, Mtheta);
            matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "magnet", muR: 1, mrMag, Bknee: null });
            if (mrMag > 1e-30) {
              // Unit remanence direction at centroid angle
              const cosT = Math.cos(thCent), sinT = Math.sin(thCent);
              // Radial direction: (cosT, sinT); tangential: (-sinT, cosT)
              const dirX = (Mr / mrMag) * cosT + (Mtheta / mrMag) * (-sinT);
              const dirY = (Mr / mrMag) * sinT + (Mtheta / mrMag) *   cosT;
              const len  = Math.hypot(dirX, dirY);
              magDir[2 * eIdx]     = len > 0 ? dirX / len : 0;
              magDir[2 * eIdx + 1] = len > 0 ? dirY / len : 0;
            }

          } else if (feat.kind === "conductor") {
            matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "conductor", muR: 1, mrMag: 0, Bknee: null });
            srcId[eIdx] = feat.circuit != null ? feat.circuit : -1;
            turns[eIdx] = feat.turns   != null ? feat.turns   : 0;

          } else {
            matId[eIdx] = 0;
          }
        }

        eIdx++;
      }
    }

    // gapLoop: node indices on the gap circle
    const gapLoop  = new Int32Array(Ntheta);
    const gapTheta = new Float64Array(Ntheta);
    for (let j = 0; j < Ntheta; j++) {
      gapLoop[j]  = gapRadialIdx * Ntheta + j;
      gapTheta[j] = j * dTheta;
    }

    return {
      member,
      nodes,
      elems,
      matId,
      srcId,
      turns,
      magDir,
      materials,
      gapLoop,
      gapTheta,
      gapR: collarR,
      sig: "", // filled by caller
    };
  }

  // ---------------------------------------------------------------------------
  //  emptyBodyMesh: returned when no features exist for the member
  // ---------------------------------------------------------------------------

  function emptyBodyMesh(member) {
    return {
      member,
      nodes:     new Float64Array(0),
      elems:     new Int32Array(0),
      matId:     new Int32Array(0),
      srcId:     new Int32Array(0),
      turns:     new Float64Array(0),
      magDir:    new Float64Array(0),
      materials: [airMaterial()],
      gapLoop:   new Int32Array(0),
      gapTheta:  new Float64Array(0),
      gapR:      0,
      sig:       "",
    };
  }

  // ---------------------------------------------------------------------------
  //  signature(section, member, opts) → string
  // ---------------------------------------------------------------------------

  function signature(section, member, opts) {
    opts = opts || {};
    const features   = (section.features || []).filter(f => f.member === member);
    const gapLayers  = opts.gapLayers  != null ? opts.gapLayers  : 3;
    const yokeCoarsen= opts.yokeCoarsen!= null ? opts.yokeCoarsen: 1;
    const refine     = opts.refine     != null ? opts.refine     : 1;
    const gapMinNodes= opts.gapMinNodes!= null ? opts.gapMinNodes: null;
    const dofBudget  = opts.dofBudget  != null ? opts.dofBudget  : null;

    const featStr = features.map(f =>
      [f.kind, f.member,
       f.rRange ? f.rRange.join(":") : "",
       f.thetaRange ? f.thetaRange.join(":") : "",
       f.muR    != null ? f.muR    : "",
       f.mrMag  != null ? f.mrMag  : "",
       f.Bknee  != null ? f.Bknee  : "",
       f.circuit!= null ? f.circuit: "",
       f.turns  != null ? f.turns  : "",
      ].join("/")
    ).join("|");

    return `${member};${featStr};gl=${gapLayers};yc=${yokeCoarsen};ref=${refine};gmn=${gapMinNodes};db=${dofBudget}`;
  }

  // ---------------------------------------------------------------------------
  //  build(section, opts) → { rotor: BodyMesh, stator: BodyMesh }
  // ---------------------------------------------------------------------------

  function build(section, opts) {
    opts = opts || {};
    const features = section.features || [];
    const geo = computeGapGeometry(features);

    const rotor  = buildBodyMesh(features, "rotor",  geo.rotorGapR,  "outer", opts);
    const stator = buildBodyMesh(features, "stator", geo.statorGapR, "inner", opts);

    rotor.sig  = signature(section, "rotor",  opts);
    stator.sig = signature(section, "stator", opts);

    return { rotor, stator };
  }

  // ---------------------------------------------------------------------------
  //  quality(bodyMesh) → { minAngle, maxAngle, maxAspect, nInverted, nDegenerate, areaError }
  // ---------------------------------------------------------------------------

  function quality(bodyMesh) {
    const { nodes, elems } = bodyMesh;
    const Ne = elems.length / 4;
    const Nn = nodes.length / 2;

    let minAngle   = Infinity;
    let maxAngle   = -Infinity;
    let maxAspect  = 0;
    let nInverted  = 0;
    let nDegenerate = 0;
    let totalArea  = 0;

    const DEG = 180 / Math.PI;

    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4*e], n1 = elems[4*e+1], n2 = elems[4*e+2], n3 = elems[4*e+3];
      const isTri = n3 === -1;

      const x0 = nodes[2*n0], y0 = nodes[2*n0+1];
      const x1 = nodes[2*n1], y1 = nodes[2*n1+1];
      const x2 = nodes[2*n2], y2 = nodes[2*n2+1];

      let area;
      if (isTri) {
        area = 0.5 * ((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
        if (Math.abs(area) < 1e-24) { nDegenerate++; continue; }
        if (area < 0) { nInverted++; totalArea -= area; continue; }
        totalArea += area;

        const pts = [[x0,y0],[x1,y1],[x2,y2]];
        for (let c = 0; c < 3; c++) {
          const prev = pts[(c+2)%3], cur = pts[c], next = pts[(c+1)%3];
          const a = cornerAngle(prev, cur, next);
          if (a < minAngle) minAngle = a;
          if (a > maxAngle) maxAngle = a;
        }
      } else {
        const x3 = nodes[2*n3], y3 = nodes[2*n3+1];
        // Shoelace signed area (CCW > 0)
        area = 0.5 * ((x0*y1-x1*y0) + (x1*y2-x2*y1) + (x2*y3-x3*y2) + (x3*y0-x0*y3));
        if (Math.abs(area) < 1e-24) { nDegenerate++; continue; }
        if (area < 0) { nInverted++; totalArea -= area; continue; }
        totalArea += area;

        const pts = [[x0,y0],[x1,y1],[x2,y2],[x3,y3]];
        for (let c = 0; c < 4; c++) {
          const prev = pts[(c+3)%4], cur = pts[c], next = pts[(c+1)%4];
          const a = cornerAngle(prev, cur, next);
          if (a < minAngle) minAngle = a;
          if (a > maxAngle) maxAngle = a;
        }
      }
    }

    // Annulus area from radial extremes of mesh nodes
    let rMin = Infinity, rMax = -Infinity;
    for (let n = 0; n < Nn; n++) {
      const r = Math.hypot(nodes[2*n], nodes[2*n+1]);
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
    }
    const annArea  = Math.PI * (rMax*rMax - rMin*rMin);
    const areaError = annArea > 1e-20 ? Math.abs(totalArea - annArea) / annArea : 0;

    return {
      minAngle:    minAngle  === Infinity  ? 0 : minAngle,
      maxAngle:    maxAngle  === -Infinity ? 0 : maxAngle,
      maxAspect,
      nInverted,
      nDegenerate,
      areaError,
    };
  }

  function cornerAngle(prev, cur, next) {
    const ux = prev[0]-cur[0], uy = prev[1]-cur[1];
    const vx = next[0]-cur[0], vy = next[1]-cur[1];
    const dot = ux*vx + uy*vy;
    const mag = Math.hypot(ux,uy) * Math.hypot(vx,vy);
    if (mag < 1e-30) return 0;
    return Math.acos(Math.max(-1, Math.min(1, dot/mag))) * (180 / Math.PI);
  }

  // ---------------------------------------------------------------------------
  //  LRU Cache (capacity CACHE_CAPACITY per body sig)
  // ---------------------------------------------------------------------------

  const CACHE_CAPACITY = 8;
  const _cache = {
    map:    new Map(),   // sig → BodyMesh
    order:  [],          // LRU order (oldest first)
    hits:   0,
    misses: 0,
  };

  function cacheGet(sig) {
    if (!_cache.map.has(sig)) return null;
    // Move to most-recently-used
    const idx = _cache.order.indexOf(sig);
    if (idx >= 0) _cache.order.splice(idx, 1);
    _cache.order.push(sig);
    return _cache.map.get(sig);
  }

  function cachePut(sig, mesh) {
    while (_cache.order.length >= CACHE_CAPACITY) {
      const oldest = _cache.order.shift();
      _cache.map.delete(oldest);
    }
    _cache.map.set(sig, mesh);
    _cache.order.push(sig);
  }

  function buildCached(section, opts) {
    opts = opts || {};
    const features = section.features || [];
    const geo = computeGapGeometry(features);

    const rSig = signature(section, "rotor",  opts);
    const sSig = signature(section, "stator", opts);

    let rotor = cacheGet(rSig);
    if (rotor) { _cache.hits++; }
    else {
      rotor = buildBodyMesh(features, "rotor", geo.rotorGapR, "outer", opts);
      rotor.sig = rSig;
      cachePut(rSig, rotor);
      _cache.misses++;
    }

    let stator = cacheGet(sSig);
    if (stator) { _cache.hits++; }
    else {
      stator = buildBodyMesh(features, "stator", geo.statorGapR, "inner", opts);
      stator.sig = sSig;
      cachePut(sSig, stator);
      _cache.misses++;
    }

    return { rotor, stator };
  }

  function cacheStats() {
    return { hits: _cache.hits, misses: _cache.misses, size: _cache.map.size };
  }

  function clearCache() {
    _cache.map.clear();
    _cache.order.length = 0;
    _cache.hits   = 0;
    _cache.misses = 0;
  }

  // ---------------------------------------------------------------------------
  //  Exports
  // ---------------------------------------------------------------------------

  LIB.MotorMesh = { build, buildCached, signature, quality, cacheStats, clearCache };
})();
