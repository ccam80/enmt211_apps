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
  //  Physics constants
  // ---------------------------------------------------------------------------

  const MU0 = 4 * Math.PI * 1e-7; // H/m

  const RESISTIVITY_DEFAULT = 1.68e-8; // copper
  const RESISTIVITY_MAP = {
    copper:    1.68e-8,
    aluminium: 2.82e-8,
    aluminum:  2.82e-8,
  };

  // ---------------------------------------------------------------------------
  //  nuMaxForWinding(windingSpec) → integer
  //
  //  Returns the maximum MMF harmonic order ν_max for a winding specification.
  //  windingSpec is one entry from the windings Map: { kind, m, p, Q, member }
  //   kind = 'wound' | 'cage'
  //   m    = number of phases (wound)
  //   p    = pole count (even integer, pole-count not pole-pairs)
  //   Q    = slot count (wound) or bar count (cage)
  //   member = 'rotor' | 'stator'
  // ---------------------------------------------------------------------------

  function nuMaxForWinding(spec) {
    if (!spec) return 13;
    const kind = spec.kind || 'wound';

    if (kind === 'cage') {
      const p    = spec.p   != null ? spec.p   : 2;
      const bars = spec.Q   != null ? spec.Q   : 28;
      const pp   = p / 2; // pole-pairs
      return Math.max(17, 1 + Math.round(bars / Math.max(1, pp)));
    }

    // wound / distributed winding
    const m = spec.m != null ? spec.m : 3;
    const p = spec.p != null ? spec.p : 2;
    const Q = spec.Q != null ? spec.Q : 6;

    // SPP = Q / (m * p) — slots per pole per phase
    const spp = Q / (m * p);
    if (spp < 1 - 1e-9) {
      // Concentrated / fractional-slot: dominant harmonic is determined by pole count
      return Math.max(p, 13);
    }

    // Distributed:
    if (m === 3) return 17;
    if (m === 2) return 13;
    return 11; // m === 1 or other
  }

  // ---------------------------------------------------------------------------
  //  tangentialPhysicsTargets(features, member, opts) →
  //    { cellsPerPole, nuMax, nuMaxSlice, perFeatureLocalizedExtras }
  //
  //  Slice-wide ν_max (max over ALL windings in the slice, both members).
  //  cellsPerPole = round(2.4 × nuMaxSlice)
  //  perFeatureLocalizedExtras: Map<feature-idx → extraCells>
  //    Magnet pole-edge features: +5 extra cells per pole edge pair
  //    Salient tooth-tip features: +3 extra cells per tooth
  // ---------------------------------------------------------------------------

  function tangentialPhysicsTargets(features, member, opts) {
    opts = opts || {};
    const physics = opts.physics || null;
    const windings = (physics && physics.windings instanceof Map) ? physics.windings : new Map();
    const poles    = (physics && physics.poles != null) ? physics.poles : 2;

    // Compute slice-wide ν_max across ALL windings (both members)
    let nuMaxSlice = 1;
    for (const [, spec] of windings) {
      const nu = nuMaxForWinding(spec);
      if (nu > nuMaxSlice) nuMaxSlice = nu;
    }
    if (nuMaxSlice < 1) nuMaxSlice = 1;

    const cellsPerPole = Math.round(2.4 * nuMaxSlice);

    // Per-feature localized extras for the gap-adjacent band.
    // Extra columns are added ON TOP of the base uniform gap-band Ntheta.
    // Magnet pole-edges: +5 extra per pole edge (each magnet contributes 2 edges → +10)
    // Salient tooth-tips: +3 extra per tooth
    const perFeatureLocalizedExtras = new Map();

    // Identify features for the specified member
    const memberFeatures = features.filter(f => f.member === member);

    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      if (f.member !== member) continue;

      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full-circle: no localization extras

      if (f.kind === 'magnet') {
        // Magnet pole-edges: each magnet feature contributes 2 pole-edge refinement zones
        perFeatureLocalizedExtras.set(fi, 5);
      } else if (f.kind === 'iron') {
        // Salient tooth-tip: a localized (non-full-circle) iron feature near the gap
        // is a tooth-tip candidate. We detect gap-adjacency by checking if the feature
        // rRange[1] is near the body's outermost feature surface.
        let maxFeatR = -Infinity;
        for (const mf of memberFeatures) {
          if (mf.rRange[1] > maxFeatR) maxFeatR = mf.rRange[1];
        }
        const isNearGap = Math.abs(f.rRange[1] - maxFeatR) < 1e-9;
        if (isNearGap) {
          perFeatureLocalizedExtras.set(fi, 3);
        }
      }
    }

    return { cellsPerPole, nuMax: nuMaxSlice, nuMaxSlice, perFeatureLocalizedExtras };
  }

  // ---------------------------------------------------------------------------
  //  physicsFromConfig(config) →
  //    { circuits: [{freq, amp, conductorMaterial}],
  //      windings: Map<ringIdx, {kind, m, p, Q, member}>,
  //      poles: int }
  //
  //  Extended from Phase 2.6 to also extract windings Map and poles.
  // ---------------------------------------------------------------------------

  function physicsFromConfig(config) {
    const circuits = Array.isArray(config.circuits) ? config.circuits : [];
    const circuitsOut = circuits.map(function (c) {
      const t = (c && c.terminal) ? c.terminal : {};
      let freq = 0;
      if (t.type === "AC") {
        freq = (typeof t.freq === "number" && isFinite(t.freq)) ? Math.abs(t.freq) : 0;
      } else if (t.type === "STEP") {
        freq = (typeof t.chopFreq === "number" && isFinite(t.chopFreq)) ? Math.abs(t.chopFreq) : 0;
      }
      const amp = (typeof t.amp === "number" && isFinite(t.amp)) ? Math.abs(t.amp) : 0;
      const mat = (typeof t.conductorMaterial === "string") ? t.conductorMaterial : "copper";
      return { freq, amp, conductorMaterial: mat };
    });

    // Extract windings Map from config.rings (or config.slices[0].rings)
    const windingsMap = new Map();
    let poles = 2;

    // Try to get rings from expanded config structure
    const rings = config.rings || [];
    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      if (!ring) continue;
      const w = ring.winding;
      if (!w) continue;
      if (w.standard) {
        const s = w.standard;
        windingsMap.set(ri, {
          kind: 'wound',
          m: s.m != null ? s.m : 3,
          p: s.p != null ? s.p : 2,
          Q: s.Q != null ? s.Q : 6,
          member: ring.member || 'stator',
        });
      } else if (w.cage) {
        const c = w.cage;
        windingsMap.set(ri, {
          kind: 'cage',
          m: 1,
          p: c.p != null ? c.p : 2,
          Q: c.bars != null ? c.bars : 28,
          member: ring.member || 'rotor',
        });
      }
      // Update poles from ring's p if available
      const ringP = (w.standard && w.standard.p) || (w.cage && w.cage.p);
      if (ringP && ringP > poles) poles = ringP;
    }

    // Fallback: try config.poles directly
    if (config.poles != null) poles = config.poles;

    return { circuits: circuitsOut, windings: windingsMap, poles };
  }

  // ---------------------------------------------------------------------------
  //  skinDepth(freq, rho, muR) → metres (or Infinity for DC)
  // ---------------------------------------------------------------------------

  function skinDepth(freq, rho, muR) {
    const omega = 2 * Math.PI * freq;
    if (omega < 1e-12) return Infinity;
    return Math.sqrt(2 * rho / (MU0 * muR * omega));
  }

  // ---------------------------------------------------------------------------
  //  physicsTargets(features, opts) →
  //    { perBandLayers: Map, perFeatureExtraCols: Map }
  //
  //  Radial physics (skin depth, saturation) — unchanged from Phase 2.6.
  // ---------------------------------------------------------------------------

  function physicsTargets(features, opts) {
    opts = opts || {};
    const physics  = opts.physics  || null;
    const refine   = Math.min(4, Math.max(0.25, opts.refine != null ? opts.refine : 1));
    const circuits = (physics && Array.isArray(physics.circuits)) ? physics.circuits : [];

    function totalAmpTurns(member) {
      let at = 0;
      for (const f of features) {
        if (f.member !== member) continue;
        if (f.kind !== "conductor") continue;
        const cIdx = f.circuit != null ? f.circuit : -1;
        const circ = (cIdx >= 0 && cIdx < circuits.length) ? circuits[cIdx] : null;
        const amp  = circ ? circ.amp : 0;
        const turns= Math.abs(f.turns != null ? f.turns : 0);
        at += amp * turns;
      }
      return at;
    }

    const perBandLayers = new Map();

    function updateBand(key, nLayers) {
      const prev = perBandLayers.get(key) || 0;
      if (nLayers > prev) perBandLayers.set(key, nLayers);
    }

    const bodyPeriods = {};
    for (const member of ["rotor", "stator"]) {
      bodyPeriods[member] = computeBodyPeriod(features, member);
    }

    const perFeatureExtraCols = new Map();

    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      const member = f.member;
      const P_body = bodyPeriods[member];
      const bodyPeriodAngle = TWO_PI / P_body;

      const r0 = f.rRange[0];
      const r1 = f.rRange[1];
      const dr = r1 - r0;
      const bKey = `${r0}|${r1}|${member}|${f.kind}`;

      if (f.kind === "conductor") {
        const cIdx = f.circuit != null ? f.circuit : -1;
        const circ = (cIdx >= 0 && cIdx < circuits.length) ? circuits[cIdx] : null;
        const freq  = circ ? circ.freq : 0;
        const mat   = circ ? circ.conductorMaterial : "copper";
        const rho   = RESISTIVITY_MAP[mat] != null ? RESISTIVITY_MAP[mat] : RESISTIVITY_DEFAULT;
        const muR   = 1;
        const delta  = skinDepth(freq, rho, muR);
        const target = Math.min(delta / 3, dr / 3);
        const nRaw   = Math.ceil(dr / target);
        const nLayers= Math.max(3, nRaw);
        updateBand(bKey, Math.round(nLayers * refine));

      } else if (f.kind === "magnet") {
        const nLayers = 4;
        updateBand(bKey, Math.round(nLayers * refine));

      } else if (f.kind === "iron") {
        const Bknee = (f.Bknee != null) ? f.Bknee : 1.6;
        const muR   = (f.muR   != null) ? f.muR   : 1000;
        const rMid = 0.5 * (r0 + r1);
        const at   = totalAmpTurns(member);
        const gapArea = 2 * Math.PI * rMid * dr;
        const Bexp = (gapArea > 1e-20 && at > 0)
          ? (MU0 * muR * at) / gapArea
          : 0;
        let satMultiplier = 1;
        if (Bexp > 1.5 * Bknee) { satMultiplier = 4; }
        else if (Bexp > 0.7 * Bknee) { satMultiplier = 2; }
        const nLayers = Math.max(2, Math.ceil(satMultiplier));
        updateBand(bKey, Math.round(nLayers * refine));
      }

      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue;
      if (span < 0.5 * bodyPeriodAngle) {
        perFeatureExtraCols.set(fi, 1);
      }
    }

    return { perBandLayers, perFeatureExtraCols };
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
  //  computeBodyPeriod(features, member) → integer P_body
  // ---------------------------------------------------------------------------

  function computeBodyPeriod(features, member) {
    const SPAN_ROUND = 1e9;
    const spanCounts = new Map();
    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue;
      const key = Math.round(span * SPAN_ROUND);
      spanCounts.set(key, (spanCounts.get(key) || 0) + 1);
    }
    let period = 0;
    for (const count of spanCounts.values()) {
      if (count >= 2) {
        period = period === 0 ? count : gcd(period, count);
      }
    }
    return period > 0 ? period : 1;
  }

  // ---------------------------------------------------------------------------
  //  Build per-feature column edges for one sector (0 to sectorAngle).
  //
  //  Returns sorted array of theta values (feature boundary edges + sub-divisions)
  //  within [0, sectorAngle] so that each feature segment is subdivided into
  //  max(1, round(featureSpan / Δθ_target)) equal cells.
  //
  //  If a feature's thetaRange crosses 0 or sectorAngle, its contribution is
  //  clipped to the sector.
  // ---------------------------------------------------------------------------

  function buildPerFeatureSectorEdges(features, member, sectorAngle, Δθ_target) {
    const EPS = 1e-12;

    // Collect all unique feature boundary angles within [0, sectorAngle]
    const boundarySet = new Set();
    function addBoundary(v) {
      // snap to avoid floating-point duplicates
      const snapped = Math.round(v * 1e12) / 1e12;
      if (snapped >= -EPS && snapped <= sectorAngle + EPS) {
        boundarySet.add(Math.max(0, Math.min(sectorAngle, snapped)));
      }
    }

    addBoundary(0);
    addBoundary(sectorAngle);

    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full-circle: no boundaries

      // Map feature boundaries into [0, sectorAngle] by modulo
      for (const raw of [f.thetaRange[0], f.thetaRange[1]]) {
        let t = raw % sectorAngle;
        if (t < 0) t += sectorAngle;
        addBoundary(t);
      }
    }

    const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

    // Now subdivide each inter-boundary segment uniformly.
    // For each segment [b_k, b_{k+1}], compute n = max(1, round(segSpan / Δθ_target)).
    const edges = [0];
    for (let k = 0; k + 1 < boundaries.length; k++) {
      const t0 = boundaries[k];
      const t1 = boundaries[k + 1];
      const segSpan = t1 - t0;
      if (segSpan < EPS) continue;

      const n = Math.max(1, Math.round(segSpan / Δθ_target));
      for (let i = 1; i <= n; i++) {
        edges.push(t0 + (segSpan * i) / n);
      }
    }

    // Deduplicate while preserving order
    const result = [edges[0]];
    for (let i = 1; i < edges.length; i++) {
      if (edges[i] - result[result.length - 1] > EPS) {
        result.push(edges[i]);
      }
    }

    return result; // sorted array of theta values in [0, sectorAngle]
  }

  // ---------------------------------------------------------------------------
  //  Build per-feature thetaColumns for the entire body (0 to 2π).
  //
  //  Tiles the per-sector edges by P_body.
  //  Returns Float64Array of length Ntheta (total columns).
  // ---------------------------------------------------------------------------

  function buildPerFeatureThetaColumns(features, member, P_body, Δθ_target) {
    const sectorAngle = TWO_PI / P_body;
    const sectorEdges = buildPerFeatureSectorEdges(features, member, sectorAngle, Δθ_target);
    const edgesPerSector = sectorEdges.length - 1; // number of cells per sector

    const Ntheta = edgesPerSector * P_body;
    const cols = new Float64Array(Ntheta);

    for (let p = 0; p < P_body; p++) {
      const offset = p * sectorAngle;
      for (let k = 0; k < edgesPerSector; k++) {
        cols[p * edgesPerSector + k] = offset + sectorEdges[k];
      }
    }

    return cols; // last column is NOT included (it would be 2π = 0 wrap)
  }

  // ---------------------------------------------------------------------------
  //  Build uniform thetaColumns for the gap-adjacent band.
  //
  //  Ntheta_gap = poles × round(2.4 × nuMaxSlice)
  //  Plus optional localized extras (per-feature +extra added uniformly).
  //  Returns Float64Array of length Ntheta_gap.
  // ---------------------------------------------------------------------------

  function buildGapBandThetaColumns(poles, nuMaxSlice) {
    const Ntheta_gap = poles * Math.round(2.4 * nuMaxSlice);
    const cols = new Float64Array(Ntheta_gap);
    for (let j = 0; j < Ntheta_gap; j++) {
      cols[j] = j * TWO_PI / Ntheta_gap;
    }
    return cols;
  }

  // ---------------------------------------------------------------------------
  //  buildBandTransitionConstraints(gapCols, innerCols) →
  //    { slaves: Int32Array, masters: Float64Array } | null
  //
  //  Given two column arrays (gapCols = uniform gap-adjacent band columns,
  //  innerCols = per-feature interior band columns), build the constraint matrix
  //  for hanging nodes on the transition row.
  //
  //  The transition row belongs to the inner band's radial index. At this row,
  //  the nodes are placed at innerCols positions. But the gap band expects
  //  them at gapCols positions. Nodes that coincide (within ε = 1e-9) are
  //  "merged" — no constraint needed. Nodes that don't coincide are slaves,
  //  constrained to their two bracketing gap masters.
  //
  //  Global node indices are NOT known here — we return column indices relative
  //  to the transition row, which the caller translates to global indices.
  //
  //  Returns:
  //    slaves: Int32Array of inner-column indices (positions in innerCols) that
  //            are hanging (no matching gap column)
  //    masters: Float64Array [gapColL, w_L, gapColR, w_R] per slave (4 values)
  //             where gapColL, gapColR are COLUMN INDICES in gapCols
  //             w_L = (1 - w), w_R = w (linear interpolation weights, sum to 1)
  //
  //  Returns null if ALL inner columns coincide with gap columns (no constraints).
  // ---------------------------------------------------------------------------

  function buildColumnConstraints(gapCols, innerCols) {
    const NG = gapCols.length;
    const NI = innerCols.length;
    const EPS = 1e-9;

    const slaveList = [];
    const masterData = [];

    // For each inner column, check if it coincides with a gap column
    // If not: find bracketing gap columns and compute interpolation weights
    for (let i = 0; i < NI; i++) {
      const theta = innerCols[i];

      // Normalize theta to [0, 2π)
      const th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;

      // Find the bracketing gap columns
      // gapCols is uniform: gapCols[j] = j * 2π/NG
      const frac = th * NG / TWO_PI;
      const jL = Math.floor(frac) % NG;
      const jR = (jL + 1) % NG;

      const thetaL = gapCols[jL];
      let thetaR = jR === 0 ? TWO_PI : gapCols[jR];

      // Check if this inner column coincides with jL or jR
      const diffL = Math.abs(th - ((thetaL % TWO_PI + TWO_PI) % TWO_PI));
      const diffR = Math.abs(th - ((thetaR % TWO_PI + TWO_PI) % TWO_PI));
      const matchL = diffL < EPS || Math.abs(diffL - TWO_PI) < EPS;
      const matchR = diffR < EPS || Math.abs(diffR - TWO_PI) < EPS;

      if (matchL || matchR) {
        // Coincident — no constraint needed (will be identified as same node)
        continue;
      }

      // Hanging node: compute interpolation weight
      // w = (theta_inner - theta_L) / (theta_R - theta_L)
      let spanLR = thetaR - thetaL;
      if (spanLR < EPS) spanLR = TWO_PI / NG; // wrap-around case
      let w = (th - thetaL % TWO_PI) / spanLR;

      // Handle wrap-around: theta could cross 0
      if (w < -EPS) w += 1;
      if (w > 1 + EPS) w -= 1;

      // Clamp to (0, 1) strictly — degenerate constraints are bugs
      if (w <= EPS) w = EPS;
      if (w >= 1 - EPS) w = 1 - EPS;

      slaveList.push(i); // inner column index
      masterData.push(jL, 1 - w, jR, w); // [leftGapColIdx, w_left, rightGapColIdx, w_right]
    }

    if (slaveList.length === 0) return null;

    return {
      slaves: new Int32Array(slaveList),
      masters: new Float64Array(masterData),
    };
  }

  // ---------------------------------------------------------------------------
  //  Build radial node positions for one body.
  // ---------------------------------------------------------------------------

  function buildRadialNodes(rEdges, gapSide, opts, features, member, physicsPerBand) {
    const gapLayers  = Math.max(1, Math.round(opts.gapLayers  != null ? opts.gapLayers  : 3));
    const yokeCoarsen= Math.max(1, opts.yokeCoarsen != null ? opts.yokeCoarsen : 1);
    const refine     = Math.min(4, Math.max(0.25, opts.refine  != null ? opts.refine      : 1));

    const edges = rEdges.slice().sort((a, b) => a - b);
    const nBands = edges.length - 1;

    const rNodes = [edges[0]];

    for (let b = 0; b < nBands; b++) {
      const r0 = edges[b];
      const r1 = edges[b + 1];
      const dr = r1 - r0;

      const isGapBand =
        (gapSide === "outer" && b === nBands - 1) ||
        (gapSide === "inner" && b === 0);

      let nLayers;
      if (isGapBand) {
        nLayers = Math.max(1, Math.round(gapLayers * refine));
      } else {
        let physicsLayers = 0;
        if (physicsPerBand && features && member) {
          for (const f of features) {
            if (f.member !== member) continue;
            const fr0 = f.rRange[0], fr1 = f.rRange[1];
            if (Math.abs(fr0 - r0) < 1e-12 && Math.abs(fr1 - r1) < 1e-12) {
              const bKey = `${fr0}|${fr1}|${member}|${f.kind}`;
              const pLayers = physicsPerBand.get(bKey) || 0;
              if (pLayers > physicsLayers) physicsLayers = pLayers;
            }
          }
        }
        nLayers = physicsLayers > 0
          ? Math.max(1, physicsLayers)
          : Math.max(1, Math.round(refine / yokeCoarsen));
      }

      for (let i = 1; i <= nLayers; i++) {
        let t;
        if (isGapBand && nLayers > 1) {
          if (gapSide === "outer") {
            t = 1 - Math.pow(1 - i / nLayers, 2);
          } else {
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
  //  Feature lookup
  // ---------------------------------------------------------------------------

  function makeFeatureLookup(features, member) {
    const bodyFeatures = features.filter(f => f.member === member);

    return function lookupFeature(r, theta) {
      let th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
      let best = null;
      let bestSpan = Infinity;

      for (const f of bodyFeatures) {
        if (r < f.rRange[0] || r >= f.rRange[1]) continue;
        const rawSpan = f.thetaRange[1] - f.thetaRange[0];
        if (rawSpan >= TWO_PI - 1e-9) {
          if (best === null) { best = f; bestSpan = TWO_PI; }
          continue;
        }
        let t0 = ((f.thetaRange[0] % TWO_PI) + TWO_PI) % TWO_PI;
        let t1 = ((f.thetaRange[1] % TWO_PI) + TWO_PI) % TWO_PI;
        let inside;
        if (Math.abs(t1 - t0) < 1e-12) {
          inside = false;
        } else if (t0 < t1) {
          inside = th >= t0 && th < t1;
        } else {
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
  //  isCollarBand
  // ---------------------------------------------------------------------------

  function isCollarBand(r0, r1, features, member, gapSide) {
    if (gapSide === "outer") {
      let maxFeatR = -Infinity;
      for (const f of features) {
        if (f.member === member && f.rRange[1] > maxFeatR) maxFeatR = f.rRange[1];
      }
      return r0 >= maxFeatR - 1e-12;
    } else {
      let minFeatR = Infinity;
      for (const f of features) {
        if (f.member === member && f.rRange[0] < minFeatR) minFeatR = f.rRange[0];
      }
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
  //  Build BodyMesh for one member (rotor or stator).
  //
  //  Architecture (Phase 2.7):
  //  - Gap-adjacent band: uniform Δθ at poles × round(2.4 × ν_max_slice) columns
  //  - Interior bands: per-feature column layout (no straddling at feature boundaries)
  //  - Hanging nodes at the gap-band / interior-band transition are constrained
  //    (linear interpolation between bracketing gap masters)
  //  - body.constraints = { slaves: Int32Array, masters: Float64Array } | null
  //
  //  opts.physics must have { windings: Map, poles: int } — throws if absent.
  // ---------------------------------------------------------------------------

  function buildBodyMesh(features, member, collarR, gapSide, opts) {
    const refine      = Math.min(4, Math.max(0.25, opts.refine != null ? opts.refine : 1));
    const dofBudget   = opts.dofBudget   != null ? opts.dofBudget   : null;
    const gapMinNodes = opts.gapMinNodes != null ? opts.gapMinNodes : null;

    const physics = opts.physics;
    if (!physics || !(physics.windings instanceof Map) || physics.poles == null) {
      throw new Error(
        "MotorMesh.build: opts.physics is required and must contain { windings: Map, poles: int }. " +
        "Pass syntheticPhysics() for tests using synthetic sections."
      );
    }

    const { rMin, rMax } = bodyRadii(features, member);
    if (!isFinite(rMin) || !isFinite(rMax)) return emptyBodyMesh(member);

    const poles = physics.poles;
    const { nuMaxSlice, cellsPerPole } = tangentialPhysicsTargets(features, member, opts);

    // Collect unique radial edges
    const rEdgeSet = new Set();
    for (const f of features) {
      if (f.member !== member) continue;
      rEdgeSet.add(f.rRange[0]);
      rEdgeSet.add(f.rRange[1]);
    }
    rEdgeSet.add(collarR);

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
    rEdges = rEdges.filter((r, i) => i === 0 || r - rEdges[i-1] > 1e-15);

    const P_body = computeBodyPeriod(features, member);

    // Compute physics-derived per-band layer counts
    const physTargets = physicsTargets(features, opts);
    const { perBandLayers } = physTargets;

    // Build radial nodes
    let rNodes = buildRadialNodes(rEdges, gapSide, opts, features, member, perBandLayers);

    // -----------------------------------------------------------------------
    //  Tangential column layout:
    //   - Gap-adjacent band (topmost for rotor, bottommost for stator): uniform
    //   - All other bands: per-feature columns
    // -----------------------------------------------------------------------

    // Gap-band columns (uniform, N_gap = poles × round(2.4 × nuMaxSlice))
    let N_gap_base = poles * Math.max(1, Math.round(2.4 * nuMaxSlice));
    // Apply gapMinNodes floor
    if (gapMinNodes !== null && N_gap_base < gapMinNodes) {
      N_gap_base = snapUpToMultiple(gapMinNodes, poles);
    }
    // Ensure multiple of poles
    N_gap_base = snapUpToMultiple(N_gap_base, poles);

    // dofBudget: estimate row counts and apply budget to both N_gap and N_inner.
    // Budget equation: nInnerRows × N_inner + nGapRows × N_gap ≤ dofBudget
    // N_gap is reduced first (subject to gapMinNodes floor and pole-multiple constraint),
    // then N_inner is reduced with the remaining budget.
    let N_gap = N_gap_base;
    let Δθ_target = TWO_PI / (poles * cellsPerPole);

    if (dofBudget !== null) {
      // Count gap band rows vs inner rows from rNodes
      const nBandsTmp = rEdges.length - 1;
      const gapBandIdxTmp = gapSide === "outer" ? nBandsTmp - 1 : 0;
      const EPS_tmp = 1e-10;
      let gapRowStartTmp = -1, gapRowEndTmp = -1;
      for (let i = 0; i < rNodes.length; i++) {
        if (Math.abs(rNodes[i] - rEdges[gapBandIdxTmp]) < EPS_tmp) gapRowStartTmp = i;
        if (Math.abs(rNodes[i] - rEdges[gapBandIdxTmp + 1]) < EPS_tmp) gapRowEndTmp = i;
      }
      if (gapRowStartTmp < 0) gapRowStartTmp = gapBandIdxTmp;
      if (gapRowEndTmp < 0) gapRowEndTmp = gapBandIdxTmp + 1;
      const nGapRowsTmp = gapRowEndTmp - gapRowStartTmp + 1;
      const nInnerRowsTmp = Math.max(1, rNodes.length - nGapRowsTmp);

      // Joint budget: nGapRows * N_gap + nInnerRows * N_inner <= dofBudget
      // Strategy: scale both proportionally from their natural values, maintaining
      // the natural ratio alpha = N_gap_natural / N_inner_natural. This avoids
      // extreme N_gap/N_inner ratios that cause inverted elements at the transition.
      //
      // Natural values before budget:
      const N_gap_natural  = N_gap_base;
      const N_inner_natural = Math.round(TWO_PI / Δθ_target);
      const alpha = N_inner_natural > 0 ? N_gap_natural / N_inner_natural : 1;

      // Total natural nodes:
      const totalNatural = nGapRowsTmp * N_gap_natural + nInnerRowsTmp * N_inner_natural;
      const gapMinFloor = gapMinNodes != null ? snapUpToMultiple(gapMinNodes, poles) : poles;
      const N_inner_floor = P_body; // at least one column per body-period sector

      if (totalNatural > dofBudget) {
        // Proportional scale: solve for N_inner such that
        //   nGapRows * (alpha * N_inner) + nInnerRows * N_inner = dofBudget
        //   N_inner = dofBudget / (nGapRows * alpha + nInnerRows)
        const denom = nGapRowsTmp * alpha + nInnerRowsTmp;
        let N_inner_target = denom > 0 ? Math.floor(dofBudget / denom) : N_inner_natural;
        N_inner_target = Math.max(N_inner_floor, N_inner_target);

        // Derive N_gap from the remaining budget after inner is set
        const innerNodesBudget = nInnerRowsTmp * N_inner_target;
        const gapBudgetLeft = Math.max(0, dofBudget - innerNodesBudget);
        let N_gap_target = nGapRowsTmp > 0 ? Math.floor(gapBudgetLeft / nGapRowsTmp) : N_gap_natural;
        // Snap N_gap to a pole-multiple, respecting gapMinFloor
        N_gap_target = Math.max(poles, Math.floor(N_gap_target / poles) * poles);
        N_gap_target = Math.max(gapMinFloor, N_gap_target);

        // Apply reductions
        N_gap = Math.min(N_gap_natural, N_gap_target);
        if (N_inner_target < N_inner_natural) {
          Δθ_target = TWO_PI / N_inner_target;
        }
      }
    }

    const gapCols = new Float64Array(N_gap);
    for (let j = 0; j < N_gap; j++) {
      gapCols[j] = j * TWO_PI / N_gap;
    }

    const innerCols = buildPerFeatureThetaColumns(features, member, P_body, Δθ_target);
    const N_inner = innerCols.length;

    // Build column constraint between gap-band and interior-band
    const colConstraints = buildColumnConstraints(gapCols, innerCols);

    // Identify which radial band is the gap-adjacent band
    // gapSide === "outer" → gap band is the LAST radial band (b = nBands-1)
    // gapSide === "inner" → gap band is the FIRST radial band (b = 0)
    const nBands = rEdges.length - 1;
    const gapBandIdx = gapSide === "outer" ? nBands - 1 : 0;

    // Assign thetaColumns per band
    // Gap band: gapCols (uniform)
    // Interior bands: innerCols (per-feature)
    // In this implementation:
    //   - All interior bands share the same innerCols
    //   - Only the gap-adjacent band gets gapCols
    // This matches the spec: "drop uniform-Δθ-across-whole-body; keep it only in the gap-adjacent band"

    return assembleMeshMultiBand(
      features, member, rNodes, rEdges,
      gapCols, innerCols, N_gap, N_inner,
      gapBandIdx, collarR, gapSide,
      colConstraints, opts
    );
  }

  // ---------------------------------------------------------------------------
  //  Assemble the BodyMesh from radial + per-band angular grids
  //
  //  Each radial band has its own thetaColumns:
  //   - gapBandIdx → gapCols (uniform, length N_gap)
  //   - all other bands → innerCols (per-feature, length N_inner)
  //
  //  Node indexing:
  //   Band b has columns thetaCols_b (length Nc_b).
  //   We lay out nodes band by band, with the transition row shared.
  //
  //  The transition row (between gap band and first interior band) has nodes
  //  at positions determined by BOTH column systems. Masters are the gap-band
  //  nodes. Slaves are inner-band nodes that don't coincide with gap-band nodes.
  //
  //  For simplicity of the quad topology: each band generates a rectangular
  //  grid of elements. At the transition row, inner-side nodes that are hanging
  //  are constrained but still appear in the node list; elements on the inner
  //  band side connect to the inner-band column nodes.
  //
  //  Node layout (for gapSide = "outer" example):
  //   Radial rows: i = 0 (rNodes[0]) ... i = Nr-1 (rNodes[Nr-1] = collarR)
  //   Bands 0..nBands-2 are interior (use innerCols, N_inner columns each)
  //   Band nBands-1 is the gap band (use gapCols, N_gap columns)
  //   The boundary row between band nBands-2 and nBands-1 is the transition row.
  //
  //  To handle the column-count mismatch cleanly:
  //   - Interior bands: rows i=0..gapRowIdx-1, each row has N_inner nodes
  //   - Gap band: rows i=gapRowIdx-1..Nr-1 (for outer), each row has N_gap nodes
  //   - The transition (shared) row at gapRowIdx-1 (for outer) has BOTH:
  //     * N_gap master nodes (from gap band perspective)
  //     * N_inner slave nodes (from interior band perspective)
  //     But we implement this as: one physical row with N_gap nodes (the masters)
  //     plus a set of virtual slave nodes that are linearly interpolated.
  //
  //  Actually the cleaner approach: use two separate node rows at the transition,
  //  one with N_inner nodes (interior side) and one with N_gap nodes (gap side).
  //  The constraint system ties the inner-side slaves to gap-side masters.
  //
  //  IMPLEMENTATION: for simplicity and correctness, we use the following scheme:
  //
  //  ALL nodes are placed at their physical positions. The node array has:
  //   - For interior rows (bands without gap band): nodes at innerCols positions
  //   - For gap-band rows: nodes at gapCols positions
  //   - The transition row exists in BOTH: there are N_inner nodes at innerCols positions
  //     AND N_gap nodes at gapCols positions. The constraint matrix ties them.
  //
  //  Elements in the interior bands reference the interior-column nodes.
  //  Elements in the gap band reference the gap-column nodes.
  //  At the transition the gap-band elements use the N_gap transition nodes
  //  and interior-band elements use the N_inner transition nodes.
  //
  //  This gives: Nn = (Nr_inner + 1) * N_inner + Nr_gap * N_gap
  //  where Nr_inner = number of radial rows in interior bands (excluding transition)
  //  and Nr_gap = number of radial rows in gap band (including gap row).
  //
  //  For the standard case (single interior band + single gap band = 2 total bands):
  //   Nr_inner = number of interior nodes - 1 (nodes excluding transition row)
  //   Nr_gap = number of gap-band nodes (including transition)
  // ---------------------------------------------------------------------------

  function assembleMeshMultiBand(
    features, member, rNodes, rEdges,
    gapCols, innerCols, N_gap, N_inner,
    gapBandIdx, collarR, gapSide,
    colConstraints, opts
  ) {
    const Nr = rNodes.length;
    const nBands = rEdges.length - 1;
    const EPS = 1e-10;

    // Map rEdge index → rNode row index
    const bandRowStarts = new Array(nBands + 1).fill(-1);
    for (let b = 0; b <= nBands; b++) {
      const targetR = rEdges[b];
      let best = 0;
      for (let i = 0; i < Nr; i++) {
        if (Math.abs(rNodes[i] - targetR) < EPS) { bandRowStarts[b] = i; break; }
        if (Math.abs(rNodes[i] - targetR) < Math.abs(rNodes[best] - targetR)) best = i;
      }
      if (bandRowStarts[b] < 0) bandRowStarts[b] = best;
    }

    // Gap-band row range (inclusive)
    const gapBandRowStart = bandRowStarts[gapBandIdx];     // smaller-r boundary of gap band
    const gapBandRowEnd   = bandRowStarts[gapBandIdx + 1]; // larger-r boundary of gap band

    // Transition row: the row that sits between the interior and gap-band sections.
    // For gapSide=outer: the gap band is at larger r, so transition = gapBandRowStart (gap-band's inner boundary)
    // For gapSide=inner: the gap band is at smaller r, so transition = gapBandRowEnd  (gap-band's outer boundary)
    const transitionRow = gapSide === "outer" ? gapBandRowStart : gapBandRowEnd;

    // Node layout strategy:
    //
    // Every radial row is assigned a "section":
    //   - "gap" rows: rows strictly within the gap band (gapBandRowStart..gapBandRowEnd inclusive)
    //                 → N_gap nodes per row, at gapCols positions
    //   - "inner" rows: all other rows → N_inner nodes per row, at innerCols positions
    //
    // The transition row belongs to the GAP section (N_gap nodes).
    // Interior-section elements at the transition boundary use either:
    //   a) the gap-section transition nodes directly (when N_inner == N_gap, colConstraints null)
    //   b) slave nodes constrained to gap-section transition nodes (when colConstraints non-null)
    //
    // Slave nodes (if any) are appended at the END of the node array.

    // Count inner rows (all rows NOT in the gap band range)
    // inner rows: 0..gapBandRowStart-1 (for outer) or gapBandRowEnd+1..Nr-1 (for inner)
    // These are the rows that use innerCols.
    let innerRows; // sorted array of global rNode indices for inner rows
    if (gapSide === "outer") {
      innerRows = [];
      for (let i = 0; i < gapBandRowStart; i++) innerRows.push(i);
    } else {
      innerRows = [];
      for (let i = gapBandRowEnd + 1; i < Nr; i++) innerRows.push(i);
    }
    const nInnerRows = innerRows.length;

    // Gap rows: gapBandRowStart..gapBandRowEnd inclusive
    const nGapRows = gapBandRowEnd - gapBandRowStart + 1;

    // Slave nodes: N_inner nodes at transitionRow radius, in innerCols positions
    // Only exist when colConstraints !== null
    const hasConstraints = colConstraints !== null;
    const nSlaveNodes = hasConstraints ? N_inner : 0;

    const Nn = nInnerRows * N_inner + nGapRows * N_gap + nSlaveNodes;

    // Node index functions
    // Inner rows are numbered 0..nInnerRows-1 in order of increasing index in innerRows[]
    function innerRowLocalIdx(globalRow) {
      return gapSide === "outer" ? globalRow : (globalRow - (gapBandRowEnd + 1));
    }
    function innerNodeIdx(localRow, j) {
      return localRow * N_inner + j;
    }
    // Gap rows are numbered 0..nGapRows-1 in order of increasing global row index
    function gapRowLocalIdx(globalRow) {
      return globalRow - gapBandRowStart;
    }
    function gapNodeIdx(localRow, j) {
      return nInnerRows * N_inner + localRow * N_gap + j;
    }
    function slaveNodeIdx(j) {
      return nInnerRows * N_inner + nGapRows * N_gap + j;
    }

    // When there are NO column constraints, buildColumnConstraints found that every
    // interior column coincides with SOME gap column — but that does NOT imply the two
    // grids are index-aligned. The interior band can be a COARSER subset of a finer
    // uniform gap band (N_inner < N_gap), e.g. a regular slot pitch landing on every
    // k-th uniform gap node (e.g. a regular slot pitch over a coarser interior grid
    // than the gap band, N_inner < N_gap). Mapping interior
    // column j to gap column j (same index) then connects nodes at DIFFERENT angles,
    // producing degenerate angle-spanning transition quads that get tagged as conductors
    // and scramble the stator MMF (4-pole content collapses; field decouples from rotor).
    // Map each interior column to the gap column it actually coincides with, by angle.
    // gapCols is uniform (gapCols[k]=k·2π/N_gap), so the coincident index is a round().
    let innerToGapCol = null;
    if (!hasConstraints) {
      innerToGapCol = new Int32Array(N_inner);
      for (let i = 0; i < N_inner; i++) {
        const th = ((innerCols[i] % TWO_PI) + TWO_PI) % TWO_PI;
        innerToGapCol[i] = ((Math.round(th * N_gap / TWO_PI) % N_gap) + N_gap) % N_gap;
      }
    }

    // Get the node index for a column j at the transition row from the inner section's perspective.
    // When no constraints: map to the gap-section node at the COINCIDENT angle (not the raw
    // index j, which is wrong when the interior grid is a coarser subset of the gap grid).
    // When constraints: slave node.
    function transitionInnerNodeIdx(j) {
      if (hasConstraints) return slaveNodeIdx(j);
      return gapNodeIdx(gapRowLocalIdx(transitionRow), innerToGapCol ? innerToGapCol[j] : j);
    }

    // Build node coordinates
    const nodes = new Float64Array(2 * Nn);

    // Inner rows
    for (let li = 0; li < nInnerRows; li++) {
      const r = rNodes[innerRows[li]];
      for (let j = 0; j < N_inner; j++) {
        const ni = innerNodeIdx(li, j);
        const th = innerCols[j];
        nodes[2*ni]   = r * Math.cos(th);
        nodes[2*ni+1] = r * Math.sin(th);
      }
    }

    // Gap rows
    for (let gi = 0; gi < nGapRows; gi++) {
      const r = rNodes[gapBandRowStart + gi];
      for (let j = 0; j < N_gap; j++) {
        const ni = gapNodeIdx(gi, j);
        const th = gapCols[j];
        nodes[2*ni]   = r * Math.cos(th);
        nodes[2*ni+1] = r * Math.sin(th);
      }
    }

    // Slave nodes at transition row
    if (hasConstraints) {
      const r = rNodes[transitionRow];
      for (let j = 0; j < N_inner; j++) {
        const ni = slaveNodeIdx(j);
        const th = innerCols[j];
        nodes[2*ni]   = r * Math.cos(th);
        nodes[2*ni+1] = r * Math.sin(th);
      }
    }

    // Build elements
    // Inner-section elements: nInnerRows layers, where the gap-adjacent layer
    // connects to the transition row nodes.
    // Gap-section elements: nGapRows-1 layers.
    const nInnerBandElems = nInnerRows * N_inner;
    const nGapBandElems   = (nGapRows - 1) * N_gap;
    const Ne = nInnerBandElems + nGapBandElems;

    const elems  = new Int32Array(4 * Ne);
    const matId  = new Int32Array(Ne);
    const srcId  = new Int32Array(Ne).fill(-1);
    const turns  = new Float64Array(Ne);
    const magDir = new Float64Array(2 * Ne);

    const materials = [airMaterial()];
    const matKeyMap = new Map();
    matKeyMap.set(materialKey(materials[0]), 0);
    const lookup = makeFeatureLookup(features, member);

    let eIdx = 0;

    function classifyElement(rCent, thCent, inCollar) {
      if (inCollar) { matId[eIdx] = 0; return; }
      const feat = lookup(rCent, thCent);
      if (feat === null) {
        matId[eIdx] = 0;
      } else if (feat.kind === "iron") {
        const muR   = feat.muR   != null ? feat.muR   : 1000;
        const Bknee = feat.Bknee != null ? feat.Bknee : null;
        matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "iron", muR, mrMag: 0, Bknee });
      } else if (feat.kind === "magnet") {
        const Mr     = feat.Mr     != null ? feat.Mr     : 0;
        const Mtheta = feat.Mtheta != null ? feat.Mtheta : 0;
        const mrMag  = Math.hypot(Mr, Mtheta);
        matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "magnet", muR: 1, mrMag, Bknee: null });
        if (mrMag > 1e-30) {
          const cosT = Math.cos(thCent), sinT = Math.sin(thCent);
          const dirX = (Mr / mrMag) * cosT + (Mtheta / mrMag) * (-sinT);
          const dirY = (Mr / mrMag) * sinT + (Mtheta / mrMag) *   cosT;
          const len  = Math.hypot(dirX, dirY);
          magDir[2*eIdx]   = len > 0 ? dirX / len : 0;
          magDir[2*eIdx+1] = len > 0 ? dirY / len : 0;
        }
      } else if (feat.kind === "conductor") {
        matId[eIdx] = findOrAddMaterial(materials, matKeyMap, { kind: "conductor", muR: 1, mrMag: 0, Bknee: null });
        srcId[eIdx] = feat.circuit != null ? feat.circuit : -1;
        turns[eIdx] = feat.turns   != null ? feat.turns   : 0;
      } else {
        matId[eIdx] = 0;
      }
    }

    // Inner-section elements.
    // For each inner layer li (0..nInnerRows-1):
    //   The "bottom" (smaller-r) row and "top" (larger-r) row of the layer depend on gapSide.
    //   For gapSide=outer: rows go from smaller r (innerRows[0]) toward larger r (approaching gap).
    //     Layer li: bottom = innerRows[li], top = innerRows[li+1] or transitionRow
    //   For gapSide=inner: rows go from larger r (innerRows[0] = largest r) toward smaller r (approaching gap).
    //     Actually innerRows is sorted by increasing global index = increasing r.
    //     Layer li: bottom = innerRows[li] (smaller r), top = innerRows[li+1] or transitionRow
    //
    // In both cases the elements are CCW quads (n00=bottom-left, n10=top-left, n11=top-right, n01=bottom-right)
    // Element centroid is between the two radial rows of the layer.
    for (let li = 0; li < nInnerRows; li++) {
      const globalRow0 = innerRows[li];
      const r0 = rNodes[globalRow0];

      // Top row: next inner row or transition
      let r1, topRowNodes;
      if (li + 1 < nInnerRows) {
        // Not the last inner layer → top row is the next inner row
        const globalRow1 = innerRows[li + 1];
        r1 = rNodes[globalRow1];
        topRowNodes = (j) => innerNodeIdx(li + 1, j);
      } else {
        // Last inner layer → top row is the transition row
        if (gapSide === "outer") {
          r1 = rNodes[transitionRow];
        } else {
          // For gapSide=inner, the transition row is at smaller r (below inner rows).
          // innerRows[0] is the first inner row (smallest r among inner rows).
          // But wait: for gapSide=inner, the inner rows are ABOVE the gap band (larger r).
          // Li=0 is the first inner row (at gapBandRowEnd+1), which is the row just above transition.
          // The layer from transition to innerRows[0] is li=0's layer (first layer).
          // So for gapSide=inner, li=0 is the "gap-adjacent" layer.
          // The loop goes li=0..nInnerRows-1. For the FIRST (li=0) layer with gapSide=inner,
          // the bottom row = transitionRow. We need to reverse the inner layer ordering for gapSide=inner.
          r1 = rNodes[innerRows[0]];
        }
        topRowNodes = (j) => transitionInnerNodeIdx(j);
      }

      // For gapSide=inner, the gap-adjacent layer is li=0. Bottom = transition, top = innerRows[0].
      // For gapSide=outer, the gap-adjacent layer is li=nInnerRows-1. Bottom = innerRows[nInnerRows-1], top = transition.
      // The current loop structure puts the transition row at the TOP of the last layer for outer,
      // but for inner it should be at the BOTTOM of the first layer.
      // Solution: for gapSide=inner, reverse the loop direction and adjust indices.
      // --> Simpler: restructure so both sides work uniformly.
      // The invariant: element li spans rNodes[innerRows[li]] to rNodes[innerRows[li+1]] (or transition).
      // For gapSide=inner, innerRows[0] is the row closest to the gap (smallest r among inner rows),
      // so the gap-adjacent layer is li=0 and spans from innerRows[0] down to transitionRow.

      // Recalculate properly for gapSide=inner:
      let actualR0, actualR1, bottomNodes, actualTopRowNodes;
      if (gapSide === "outer") {
        actualR0 = rNodes[innerRows[li]];
        if (li + 1 < nInnerRows) {
          actualR1 = rNodes[innerRows[li + 1]];
          bottomNodes = (j) => innerNodeIdx(li, j);
          actualTopRowNodes = (j) => innerNodeIdx(li + 1, j);
        } else {
          actualR1 = rNodes[transitionRow];
          bottomNodes = (j) => innerNodeIdx(li, j);
          actualTopRowNodes = (j) => transitionInnerNodeIdx(j);
        }
      } else {
        // gapSide=inner: innerRows sorted ascending. innerRows[0] is closest to gap (smallest r).
        // Layer li spans from innerRows[li] to innerRows[li+1], EXCEPT layer 0 which spans from transition to innerRows[0].
        // Wait: with gapSide=inner, the gap is at SMALLER r. So innerRows[0] is at gapBandRowEnd+1 (just above transition).
        // Layer 0: transition (bottom, smaller r) → innerRows[0] (top, larger r)
        // Layer 1: innerRows[0] → innerRows[1]
        // ...
        // This means we need to loop differently. Let me restructure:
        if (li === 0) {
          actualR0 = rNodes[transitionRow];     // smaller r = transition
          actualR1 = rNodes[innerRows[0]];      // larger r = first inner row
          bottomNodes = (j) => transitionInnerNodeIdx(j);
          actualTopRowNodes = (j) => innerNodeIdx(0, j);
        } else {
          actualR0 = rNodes[innerRows[li - 1]];
          actualR1 = rNodes[innerRows[li]];
          bottomNodes = (j) => innerNodeIdx(li - 1, j);
          actualTopRowNodes = (j) => innerNodeIdx(li, j);
        }
      }

      const rCent = 0.5 * (actualR0 + actualR1);
      const inCollar = isCollarBand(actualR0, actualR1, features, member, gapSide);

      for (let j = 0; j < N_inner; j++) {
        const jNext = (j + 1) % N_inner;
        // CCW quad: n00 (bottom-left), n10 (top-left), n11 (top-right), n01 (bottom-right)
        elems[4*eIdx]   = bottomNodes(j);
        elems[4*eIdx+1] = actualTopRowNodes(j);
        elems[4*eIdx+2] = actualTopRowNodes(jNext);
        elems[4*eIdx+3] = bottomNodes(jNext);

        const th0 = innerCols[j];
        const th1 = jNext > j ? innerCols[jNext] : innerCols[jNext] + TWO_PI;
        const thCent = 0.5 * (th0 + th1);
        classifyElement(rCent, thCent, inCollar);
        eIdx++;
      }
    }

    // Gap-section elements: nGapRows-1 layers, using gapCols.
    for (let gi = 0; gi + 1 < nGapRows; gi++) {
      const r0 = rNodes[gapBandRowStart + gi];
      const r1 = rNodes[gapBandRowStart + gi + 1];
      const rCent = 0.5 * (r0 + r1);
      const inCollar = isCollarBand(r0, r1, features, member, gapSide);

      for (let j = 0; j < N_gap; j++) {
        const jNext = (j + 1) % N_gap;
        elems[4*eIdx]   = gapNodeIdx(gi,     j);
        elems[4*eIdx+1] = gapNodeIdx(gi + 1, j);
        elems[4*eIdx+2] = gapNodeIdx(gi + 1, jNext);
        elems[4*eIdx+3] = gapNodeIdx(gi,     jNext);

        const th0 = gapCols[j];
        const th1 = jNext > j ? gapCols[jNext] : gapCols[jNext] + TWO_PI;
        const thCent = 0.5 * (th0 + th1);
        classifyElement(rCent, thCent, inCollar);
        eIdx++;
      }
    }

    // Area-weighted turns: per spec, turns[e] = feat.turns * area_e / A_feature
    // where A_feature is the summed area of all elements sharing the same srcId.
    // This makes Jz_e = current * turns[e] / area_e = current * feat.turns / A_feature
    // uniform across each circuit's conductor cross-section, and mesh-invariant.
    // At this point turns[e] still holds the raw feat.turns value from
    // classifyElement; we now rewrite it as the area-weighted share.
    const areaPerSrc  = new Map();   // srcId -> Σ area_e
    const elemArea    = new Float64Array(Ne);
    for (let e = 0; e < Ne; e++) {
      const n0 = elems[4*e],   n1 = elems[4*e+1];
      const n2 = elems[4*e+2], n3 = elems[4*e+3];
      const x0 = nodes[2*n0], y0 = nodes[2*n0+1];
      const x1 = nodes[2*n1], y1 = nodes[2*n1+1];
      const x2 = nodes[2*n2], y2 = nodes[2*n2+1];
      let a;
      if (n3 === -1) {
        a = 0.5 * Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
      } else {
        const x3 = nodes[2*n3], y3 = nodes[2*n3+1];
        a = 0.5 * Math.abs((x0*y1-x1*y0) + (x1*y2-x2*y1)
                         + (x2*y3-x3*y2) + (x3*y0-x0*y3));
      }
      elemArea[e] = a;
      const sid = srcId[e];
      if (sid >= 0) {
        areaPerSrc.set(sid, (areaPerSrc.get(sid) || 0) + a);
      }
    }
    for (let e = 0; e < Ne; e++) {
      const sid = srcId[e];
      if (sid >= 0) {
        const Atot = areaPerSrc.get(sid);
        if (Atot > 0) {
          turns[e] = turns[e] * (elemArea[e] / Atot);
        } else {
          turns[e] = 0;
        }
      }
    }

    // gapLoop: outermost nodes of the gap band on the gap-circle side
    // gapSide=outer → largest r in gap band = gapBandRowEnd
    // gapSide=inner → smallest r in gap band = gapBandRowStart
    const gapCircleGi = gapSide === "outer"
      ? gapRowLocalIdx(gapBandRowEnd)
      : gapRowLocalIdx(gapBandRowStart);

    const gapLoop  = new Int32Array(N_gap);
    const gapTheta = new Float64Array(N_gap);
    for (let j = 0; j < N_gap; j++) {
      gapLoop[j]  = gapNodeIdx(gapCircleGi, j);
      gapTheta[j] = gapCols[j];
    }

    // Constraints
    let constraints = null;
    if (hasConstraints) {
      const transGapLi = gapRowLocalIdx(transitionRow);
      const S = colConstraints.slaves.length;
      const globalSlaves  = new Int32Array(S);
      const globalMasters = new Float64Array(4 * S);

      for (let k = 0; k < S; k++) {
        globalSlaves[k] = slaveNodeIdx(colConstraints.slaves[k]);

        const jL = colConstraints.masters[4*k];
        const wL = colConstraints.masters[4*k+1];
        const jR = colConstraints.masters[4*k+2];
        const wR = colConstraints.masters[4*k+3];
        globalMasters[4*k]   = gapNodeIdx(transGapLi, jL);
        globalMasters[4*k+1] = wL;
        globalMasters[4*k+2] = gapNodeIdx(transGapLi, jR);
        globalMasters[4*k+3] = wR;
      }
      constraints = { slaves: globalSlaves, masters: globalMasters };
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
      constraints,
      sig: "",
    };
  }

  // ---------------------------------------------------------------------------
  //  emptyBodyMesh
  // ---------------------------------------------------------------------------

  function emptyBodyMesh(member) {
    return {
      member,
      nodes:       new Float64Array(0),
      elems:       new Int32Array(0),
      matId:       new Int32Array(0),
      srcId:       new Int32Array(0),
      turns:       new Float64Array(0),
      magDir:      new Float64Array(0),
      materials:   [airMaterial()],
      gapLoop:     new Int32Array(0),
      gapTheta:    new Float64Array(0),
      gapR:        0,
      constraints: null,
      sig:         "",
    };
  }

  // ---------------------------------------------------------------------------
  //  signature(section, member, opts) → string
  //  Extended to include nuMaxSlice and poles (Phase 2.7)
  // ---------------------------------------------------------------------------

  function signature(section, member, opts) {
    opts = opts || {};
    const features    = (section.features || []).filter(f => f.member === member);
    const gapLayers   = opts.gapLayers  != null ? opts.gapLayers  : 3;
    const yokeCoarsen = opts.yokeCoarsen!= null ? opts.yokeCoarsen: 1;
    const refine      = opts.refine     != null ? opts.refine     : 1;
    const gapMinNodes = opts.gapMinNodes!= null ? opts.gapMinNodes: null;
    const dofBudget   = opts.dofBudget  != null ? opts.dofBudget  : null;

    // Magnet features carry signed (Mr, Mtheta); the prior code read
    // f.mrMag here, which features never have (mrMag is computed inside
    // classifyElement as hypot(Mr,Mtheta)). The result was that every
    // magnet variant produced the SAME signature, so the mesh cache
    // returned the FIRST-EVER-BUILT mesh for any subsequent call —
    // a fresh slice with Mr=8e3 silently reused a stale mesh whose
    // material table still had mrMag=8e5. The fix is to key on the raw
    // (Mr, Mtheta) the features actually carry.
    const featStr = features.map(f =>
      [f.kind, f.member,
       f.rRange ? f.rRange.join(":") : "",
       f.thetaRange ? f.thetaRange.join(":") : "",
       f.muR    != null ? f.muR    : "",
       f.Mr     != null ? f.Mr     : "",
       f.Mtheta != null ? f.Mtheta : "",
       f.Bknee  != null ? f.Bknee  : "",
       f.circuit!= null ? f.circuit: "",
       f.turns  != null ? f.turns  : "",
      ].join("/")
    ).join("|");

    let physStr = "";
    const physics = opts.physics;
    if (physics) {
      const circuits = Array.isArray(physics.circuits) ? physics.circuits : [];
      const poles    = physics.poles != null ? physics.poles : "";
      const windings = physics.windings instanceof Map
        ? Array.from(physics.windings.entries()).map(([k, v]) =>
            `${k}:${v.kind}/${v.m}/${v.p}/${v.Q}/${v.member}`).join("+")
        : "";
      physStr = `poles=${poles};w=${windings};c=${circuits.map((c, i) =>
        `c${i}:freq=${c.freq != null ? c.freq : ""},amp=${c.amp != null ? c.amp : ""},mat=${c.conductorMaterial != null ? c.conductorMaterial : ""}`
      ).join("|")}`;
    }

    return `${member};${featStr};gl=${gapLayers};yc=${yokeCoarsen};ref=${refine};gmn=${gapMinNodes};db=${dofBudget};ph=${physStr}`;
  }

  // ---------------------------------------------------------------------------
  //  build(section, opts) → { rotor: BodyMesh, stator: BodyMesh }
  //
  //  REQUIRES opts.physics = { windings: Map, poles: int }
  //  Throws if missing. No fallback.
  // ---------------------------------------------------------------------------

  function build(section, opts) {
    opts = opts || {};
    // Validate that opts.physics is present with required fields
    const physics = opts.physics;
    if (!physics || !(physics.windings instanceof Map) || physics.poles == null) {
      throw new Error(
        "MotorMesh.build: opts.physics is required and must contain { windings: Map, poles: int }. " +
        "For tests using synthetic sections, use syntheticPhysics() from tests/mesh/_fixtures.js."
      );
    }

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
  //  LRU Cache
  // ---------------------------------------------------------------------------

  const CACHE_CAPACITY = 8;
  const _cache = {
    map:    new Map(),
    order:  [],
    hits:   0,
    misses: 0,
  };

  function cacheGet(sig) {
    if (!_cache.map.has(sig)) return null;
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

  LIB.MotorMesh = {
    build, buildCached, signature, quality, cacheStats, clearCache,
    physicsFromConfig, physicsTargets,
    tangentialPhysicsTargets, nuMaxForWinding,
  };
})();
