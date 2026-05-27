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

  function lcm(a, b) {
    if (a === 0 || b === 0) return 0;
    return Math.round(Math.abs(a) / gcd(a, b)) * Math.abs(b);
  }

  // Approximate frac ∈ [0,1] as p/q with q <= maxDenom.
  // Returns q (the denominator of the best rational approximation).
  function rationalDenominator(frac, maxDenom) {
    frac = Math.abs(frac);
    frac -= Math.floor(frac);
    if (frac < 1e-12 || frac > 1 - 1e-12) return 1;
    // Stern-Brocot / continued-fraction approach
    let pLo = 0, qLo = 1, pHi = 1, qHi = 1;
    for (let iter = 0; iter < 200; iter++) {
      const pMid = pLo + pHi;
      const qMid = qLo + qHi;
      if (qMid > maxDenom) break;
      if (Math.abs(pMid / qMid - frac) < 1e-11) return qMid;
      if (pMid / qMid < frac) { pLo = pMid; qLo = qMid; }
      else                    { pHi = pMid; qHi = qMid; }
    }
    return maxDenom;
  }

  function snapUpToMultiple(n, k) {
    if (k <= 0) return n;
    return Math.ceil(n / k) * k;
  }

  // ---------------------------------------------------------------------------
  //  Physics constants
  // ---------------------------------------------------------------------------

  const MU0 = 4 * Math.PI * 1e-7; // H/m

  // Resistivity of common conductor materials (Ω·m at ~20 °C).
  // Default: copper.  Implementers choosing a different default must update here.
  const RESISTIVITY_DEFAULT = 1.68e-8; // copper
  const RESISTIVITY_MAP = {
    copper:    1.68e-8,
    aluminium: 2.82e-8,
    aluminum:  2.82e-8,
  };

  // ---------------------------------------------------------------------------
  //  physicsFromConfig(config) → { circuits: [{freq, amp, conductorMaterial}] }
  //
  //  Extracts the physics inputs the mesher needs (terminal frequency, amplitude,
  //  and conductor material) from a raw fixture config object.
  //  DC and CURRENT terminals → freq = 0 (skin depth → ∞, ≥3-layer floor applies).
  //  STEP terminals → freq = chopFreq.
  //  AC terminals  → freq = terminal.freq.
  // ---------------------------------------------------------------------------

  function physicsFromConfig(config) {
    const circuits = Array.isArray(config.circuits) ? config.circuits : [];
    return {
      circuits: circuits.map(function (c) {
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
      }),
    };
  }

  // ---------------------------------------------------------------------------
  //  skinDepth(freq, rho, muR) → metres (or Infinity for DC)
  //  rho = electrical resistivity (Ω·m), muR = relative permeability
  // ---------------------------------------------------------------------------

  function skinDepth(freq, rho, muR) {
    const omega = 2 * Math.PI * freq;
    if (omega < 1e-12) return Infinity;
    return Math.sqrt(2 * rho / (MU0 * muR * omega));
  }

  // ---------------------------------------------------------------------------
  //  physicsTargets(features, opts) →
  //    { perBandLayers: Map<rRange-key, number>,
  //      perFeatureExtraCols: Map<feature-idx, number> }
  //
  //  Computes physics-derived radial-layer counts and angular extra-column counts
  //  for each feature band, ready to be consumed by buildRadialNodes and
  //  buildAngularColumns.
  //
  //  opts.physics = { circuits: [{freq, amp, conductorMaterial}] }
  //  opts.refine  = global refine scaler [0.25, 4]
  //  opts.materials = optional Bknee override per iron feature (not used directly;
  //                   Bknee comes from feature.Bknee if present, else default 1.6 T)
  //
  //  Band key: "${r0}:${r1}:${member}:${kind}" (unique per band, not per feature)
  //  since multiple features may share the same rRange (e.g. conductor slots in
  //  a stator with overlapping iron back-iron).  Per-band layers are the maximum
  //  over all features in that band.
  //
  //  Angular extra-cols: a localised feature (thetaRange span < half body period)
  //  gets 1 extra column edge at its midpoint → minimum 2 sub-cells within the
  //  feature's angular span.
  // ---------------------------------------------------------------------------

  function physicsTargets(features, opts) {
    opts = opts || {};
    const physics  = opts.physics  || null;
    const refine   = Math.min(4, Math.max(0.25, opts.refine != null ? opts.refine : 1));
    const circuits = (physics && Array.isArray(physics.circuits)) ? physics.circuits : [];

    // ---- Estimate total ampere-conductors for B estimation ----
    // Sum |amp| × |turns| over all conductor features, weighted by their circuit.
    // Used for saturation B estimate per body.
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

    // ---- Build unique rRange band set per member ----
    // Key: "${r0}|${r1}|${member}|${kind}" for max-layer accumulation
    const perBandLayers = new Map();

    // Helper to set/update band layers to max
    function updateBand(key, nLayers) {
      const prev = perBandLayers.get(key) || 0;
      if (nLayers > prev) perBandLayers.set(key, nLayers);
    }

    // ---- Compute body period for each member (needed for angular sub-cell check) ----
    const bodyPeriods = {};
    for (const member of ["rotor", "stator"]) {
      bodyPeriods[member] = computeBodyPeriod(features, member);
    }

    // ---- Per-feature angular extra-columns ----
    const perFeatureExtraCols = new Map();

    for (let fi = 0; fi < features.length; fi++) {
      const f = features[fi];
      const member = f.member;
      const P_body = bodyPeriods[member];
      const bodyPeriodAngle = TWO_PI / P_body;

      // ---- Radial layers for this feature ----
      const r0 = f.rRange[0];
      const r1 = f.rRange[1];
      const dr = r1 - r0;
      const bKey = `${r0}|${r1}|${member}|${f.kind}`;

      if (f.kind === "conductor") {
        // Skin-depth sizing for W/C/K conductor bands
        const cIdx = f.circuit != null ? f.circuit : -1;
        const circ = (cIdx >= 0 && cIdx < circuits.length) ? circuits[cIdx] : null;
        const freq  = circ ? circ.freq : 0;
        const mat   = circ ? circ.conductorMaterial : "copper";
        const rho   = RESISTIVITY_MAP[mat] != null ? RESISTIVITY_MAP[mat] : RESISTIVITY_DEFAULT;
        const muR   = 1; // conductors are non-magnetic

        const delta  = skinDepth(freq, rho, muR);
        const target = Math.min(delta / 3, dr / 3);
        const nRaw   = Math.ceil(dr / target);
        const nLayers= Math.max(3, nRaw);
        updateBand(bKey, Math.round(nLayers * refine));

      } else if (f.kind === "magnet") {
        // Magnet: minimum 4 layers to capture magnetisation gradient
        const nLayers = 4;
        updateBand(bKey, Math.round(nLayers * refine));

      } else if (f.kind === "iron") {
        // Saturation-gradient sizing
        const Bknee = (f.Bknee != null) ? f.Bknee : 1.6; // T — typical M-19 steel
        const muR   = (f.muR   != null) ? f.muR   : 1000;

        // Estimate expected B at the gap (rough: Ampere-conductors × poles / (gap area × mu0))
        // Here we use a simpler heuristic per band: total AT / (2π × r_mid × dr × mu0 × muR)
        const rMid = 0.5 * (r0 + r1);
        const at   = totalAmpTurns(member);
        const gapArea = 2 * Math.PI * rMid * dr;
        const Bexp = (gapArea > 1e-20 && at > 0)
          ? (MU0 * muR * at) / gapArea
          : 0;

        let satMultiplier = 1;
        if (Bexp > 1.5 * Bknee) {
          satMultiplier = 4;
        } else if (Bexp > 0.7 * Bknee) {
          satMultiplier = 2;
        }

        const nLayers = Math.max(2, Math.ceil(satMultiplier));
        updateBand(bKey, Math.round(nLayers * refine));
      }

      // ---- Angular curvature refinement for localised features ----
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full-circle — no extra cols
      if (span < 0.5 * bodyPeriodAngle) {
        // Localised feature: ensure at least 2 angular sub-cells across the span
        // by requesting 1 extra mid-point column edge.
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
  //  Compute the body's angular period P_body (number of periodic repetitions)
  //  from the features.  Full-circle features don't constrain the period.
  // ---------------------------------------------------------------------------

  function computeBodyPeriod(features, member) {
    // Group non-full-circle features by their angular span (rounded to avoid
    // floating-point grouping errors).  The number of features sharing the same
    // span is the repetition count for that layer, and P_body = gcd of all counts.
    //
    // This correctly handles salient-tooth geometries where each tooth covers
    // only a fraction of its period (e.g. 4 teeth each spanning 60% of π/2).
    const SPAN_ROUND = 1e9; // 1 nm precision is more than enough
    const spanCounts = new Map(); // rounded-span-key → count
    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full circle — doesn't constrain period
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
  //  Collect all unique theta boundaries for features within [0, periodAngle].
  //  Only non-full-circle features contribute angular edges.
  //  Always includes 0 and periodAngle.
  // ---------------------------------------------------------------------------

  function collectThetaEdgesInSector(features, member, periodAngle) {
    const EPS = 1e-9;
    // Round to 12 significant decimal digits to collapse floating-point noise
    // from modulo arithmetic (differences < 1e-12 rad are the same edge).
    const ROUND = 1e12;
    function snap(v) { return Math.round(v * ROUND) / ROUND; }

    // Use a Map keyed by snapped value to store the canonical float
    const edgeMap = new Map();
    function addEdge(v) {
      const k = snap(v);
      if (!edgeMap.has(k)) edgeMap.set(k, v);
    }

    addEdge(0);
    addEdge(periodAngle);

    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - EPS) continue; // full circle — no sector edges

      // Map thetaRange edges into [0, periodAngle] by modulo
      for (const raw of [f.thetaRange[0], f.thetaRange[1]]) {
        let t = raw % periodAngle;
        if (t < 0) t += periodAngle;
        if (t > EPS && t < periodAngle - EPS) addEdge(t);
      }
    }

    return Array.from(edgeMap.values()).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------------------
  //  Build the angular column positions for the body zone (0 to 2π).
  //
  //  Strategy (primary): per-feature density target.
  //    targetCellsPerFeature = round(8 * refine)
  //    targetNtheta = max(P_body * 4, numFeatures * targetCellsPerFeature)
  //    Snapped up to the smallest multiple of P_body >= target.
  //    Feature-boundary alignment: check each boundary angle θ_k is within
  //    epsilon = 2π/Ntheta * 0.4 of a grid column. If not, bump Ntheta up by
  //    one P_body and retry, up to a ceiling of targetCellsPerFeature * numFeatures * 2.
  //    If alignment still fails: fall back to LCM-with-cap (secondary path) but
  //    enforce the ceiling so element count stays bounded (tertiary: hard ceiling).
  //
  //  LCM-with-cap (secondary/tertiary fallback): kept intact.
  //    For each feature boundary angle θ_k that is a rational fraction of 2π
  //    (p/q with q ≤ LCM_CAP), extend baseN = lcm(baseN, q).
  //    If overflow, fall back to nBandsPerSector × P_body as baseN.
  //    Then enforce ceiling on the result.
  //
  //  Ntheta = chosen baseN (or aligned target); thetaColumns is a strict uniform
  //  grid j × 2π/Ntheta, so gapTheta is automatically uniform to machine precision.
  //
  //  divsPerBandOverride: when set, bypasses the per-feature target and uses this
  //    value directly (used by gapMinNodes and dofBudget paths in buildBodyMesh).
  //
  //  Returns { thetaColumns: Float64Array(Ntheta), Ntheta: number,
  //            divsPerBand: number, nBandsPerSector: number }
  // ---------------------------------------------------------------------------

  const LCM_CAP = 1000; // overflow threshold for LCM path

  // Check whether a given Ntheta places a grid column on every non-full-circle
  // feature boundary angle for the given member.
  //
  // A column j lands at θ = j * 2π/Ntheta.  Boundary angle t aligns when
  // t * Ntheta / (2π) is an integer (to floating-point precision).
  // Equivalently: t/(2π) must be a rational p/q with q | Ntheta.
  // We test this by computing frac = t * Ntheta / (2π), then checking
  // |frac - round(frac)| < EPS_INT.
  // This avoids the accumulated floating-point error in j * (2π/Ntheta).
  const EPS_INT = 1e-9; // fractional tolerance for integer check
  function angularGridAligns(features, member, Ntheta) {
    for (const f of features) {
      if (f.member !== member) continue;
      const span = f.thetaRange[1] - f.thetaRange[0];
      if (span >= TWO_PI - 1e-9) continue; // full-circle: no boundary to align
      for (const rawAngle of [f.thetaRange[0], f.thetaRange[1]]) {
        let t = ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI;
        if (t < 1e-9 || t > TWO_PI - 1e-9) continue; // at 0 or 2π — always aligned
        // Column index must be an integer
        const frac = t * Ntheta / TWO_PI;
        if (Math.abs(frac - Math.round(frac)) > EPS_INT) return false;
      }
    }
    return true;
  }

  function buildAngularColumns(features, member, P_body, targetTotalDivs, divsPerBandOverride, minDivsPerBand, refine, numFeatures) {
    const sectorAngle = TWO_PI / P_body;

    // Collect boundary edges within one sector (for nBandsPerSector count)
    const thetaEdges = collectThetaEdgesInSector(features, member, sectorAngle);
    const nBandsPerSector = thetaEdges.length - 1;

    // When divsPerBandOverride is set, bypass the per-feature target entirely.
    // This path is used by gapMinNodes and dofBudget reductions in buildBodyMesh.
    if (divsPerBandOverride !== undefined) {
      const divsPerBand = Math.max(1, Math.round(divsPerBandOverride));
      const effectiveDpb = (minDivsPerBand !== undefined && divsPerBand < minDivsPerBand)
        ? minDivsPerBand : divsPerBand;
      const Ntheta = nBandsPerSector * P_body * effectiveDpb;
      const thetaColumns = new Float64Array(Ntheta);
      for (let j = 0; j < Ntheta; j++) thetaColumns[j] = j * TWO_PI / Ntheta;
      return { thetaColumns, Ntheta, divsPerBand: effectiveDpb, nBandsPerSector };
    }

    // -----------------------------------------------------------------------
    // Primary path: per-feature density target
    // -----------------------------------------------------------------------
    const clampedRefine = Math.min(4, Math.max(0.25, refine != null ? refine : 1));
    // Count ALL features for this member (including full-circle) for the density target.
    const nFeat = numFeatures != null ? numFeatures : features.filter(f => f.member === member).length;
    const targetCellsPerFeature = Math.round(8 * clampedRefine);
    // Floor: max of (P_body * 4) for slot bodies, and (minGeomDivs) for area accuracy.
    // minGeomDivs matches the old area-accuracy floor (N-gon area error < 1% needs N>=32).
    const minGeomDivs = Math.max(8, Math.ceil(clampedRefine * 32));
    const rawTarget = Math.max(P_body * 4, minGeomDivs, nFeat * targetCellsPerFeature);
    // Snap up to smallest multiple of P_body >= rawTarget
    let candidateNtheta = snapUpToMultiple(rawTarget, P_body);
    const ceiling = Math.max(candidateNtheta, snapUpToMultiple(targetCellsPerFeature * Math.max(nFeat, 1) * 2, P_body));

    // Try to find an Ntheta in [candidateNtheta, ceiling] (stepping by P_body)
    // that places a grid column within 40% of a cell width of every feature boundary.
    let alignedNtheta = null;
    for (let tryN = candidateNtheta; tryN <= ceiling; tryN += P_body) {
      if (angularGridAligns(features, member, tryN)) {
        alignedNtheta = tryN;
        break;
      }
    }

    let Ntheta;
    let divsPerBand;

    if (alignedNtheta !== null) {
      // Alignment found within the per-feature ceiling: use it.
      Ntheta = alignedNtheta;
      // divsPerBand is the ratio Ntheta / (nBandsPerSector * P_body), for
      // compatibility with the dofBudget reduction code that uses nBandsPerSector.
      divsPerBand = Math.max(1, Math.round(Ntheta / (nBandsPerSector * P_body)));
    } else {
      // -----------------------------------------------------------------------
      // Secondary path: LCM-with-cap (exact rational alignment, no ceiling on
      // the LCM result — the LCM only grows as needed for exact alignment).
      // -----------------------------------------------------------------------
      let baseN = P_body;
      let overflowed = false;

      for (const f of features) {
        if (f.member !== member) continue;
        const span = f.thetaRange[1] - f.thetaRange[0];
        if (span >= TWO_PI - 1e-9) continue; // full-circle: no angular boundaries

        for (const rawAngle of [f.thetaRange[0], f.thetaRange[1]]) {
          let t = ((rawAngle % TWO_PI) + TWO_PI) % TWO_PI;
          if (t < 1e-12 || t > TWO_PI - 1e-12) continue; // at 0 or 2π — already covered

          const q = rationalDenominator(t / TWO_PI, LCM_CAP);
          const candidate = lcm(baseN, q);
          if (candidate > LCM_CAP) { overflowed = true; break; }
          baseN = candidate;
        }
        if (overflowed) break;
      }

      if (overflowed) {
        // Tertiary path: irrational-fraction boundaries — use nBandsPerSector × P_body
        // but enforce the per-feature ceiling so element count stays bounded.
        baseN = Math.max(nBandsPerSector, 1) * P_body;
      }

      // Enforce the per-feature ceiling on both LCM and tertiary results.
      // This prevents rational-LCM from producing 960 cells for a 13-feature body
      // when 8 cells/feature → 104 target.  The LCM value is still used when it
      // falls within the ceiling (e.g., iSectionWithTeeth gives LCM=80, ceiling=80).
      if (baseN > ceiling) {
        baseN = ceiling;
      }

      // Ensure baseN is a multiple of P_body.
      baseN = snapUpToMultiple(baseN, P_body);
      if (baseN < P_body) baseN = P_body;

      // divsPerBand for the LCM/tertiary result is always 1 (baseN is already final).
      divsPerBand = 1;
      if (minDivsPerBand !== undefined && divsPerBand < minDivsPerBand) {
        divsPerBand = minDivsPerBand;
      }

      Ntheta = baseN * divsPerBand;
    }

    // -----------------------------------------------------------------------
    // Cap: Ntheta must not exceed 12 cells per feature × refine, snapped to
    // the nearest multiple of P_body (preserves gapTheta uniformity).
    // The floor also includes minGeomDivs so area accuracy is preserved.
    // When the cap fires, search upward from maxNthetaSnapped (in steps of
    // P_body) to find the smallest aligned value, so feature boundaries stay
    // on grid columns even after capping.
    // -----------------------------------------------------------------------
    const numFeaturesCap = features.filter(f => f.member === member).length;
    const refineFactor = Math.min(4, Math.max(0.25, refine != null ? refine : 1));
    const minGeomDivsCap = Math.max(8, Math.ceil(refineFactor * 32));
    const maxNtheta = Math.max(P_body, minGeomDivsCap, Math.ceil(numFeaturesCap * 12 * refineFactor));
    const maxNthetaSnapped = Math.ceil(maxNtheta / P_body) * P_body;
    if (Ntheta > maxNthetaSnapped) {
      // Search upward from maxNthetaSnapped for the smallest aligned Ntheta,
      // capped at the original Ntheta so we never exceed the pre-cap value.
      let cappedN = maxNthetaSnapped;
      for (let tryN = maxNthetaSnapped; tryN <= Ntheta; tryN += P_body) {
        if (angularGridAligns(features, member, tryN)) {
          cappedN = tryN;
          break;
        }
      }
      Ntheta = cappedN;
      divsPerBand = 1;
    }

    const thetaColumns = new Float64Array(Ntheta);
    for (let j = 0; j < Ntheta; j++) thetaColumns[j] = j * TWO_PI / Ntheta;

    return { thetaColumns, Ntheta, divsPerBand, nBandsPerSector };
  }

  // ---------------------------------------------------------------------------
  //  Build radial node positions for one body.
  //
  //  rEdges: sorted array of r boundaries (body inner → collar)
  //  gapSide: "outer" (rotor) or "inner" (stator)
  //  features: the full feature list (needed to determine per-band layer counts)
  //  member: "rotor" | "stator"
  //
  //  Strategy:
  //    • Each feature band gets a physics-derived layer count (from physicsTargets),
  //      scaled by the global refine scaler.
  //    • The gap-adjacent band gets gapLayers layers with quadratic grading
  //      toward the gap surface.
  //    • Non-gap, non-feature (collar/yoke) bands use physicsTargets iron default
  //      or the yokeCoarsen fallback.
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

      // Identify which band is gap-adjacent
      const isGapBand =
        (gapSide === "outer" && b === nBands - 1) ||
        (gapSide === "inner" && b === 0);

      let nLayers;
      if (isGapBand) {
        nLayers = Math.max(1, Math.round(gapLayers * refine));
      } else {
        // Look up physics-derived layer count for this radial band.
        // The band key encodes r0, r1, member, and the dominant feature kind.
        // We search for all matching feature keys and take the maximum.
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
        // If no physics entry found (collar band, pure air), fall back to
        // refine / yokeCoarsen with a floor of 1.
        nLayers = physicsLayers > 0
          ? Math.max(1, physicsLayers)
          : Math.max(1, Math.round(refine / yokeCoarsen));
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
  //  Build BodyMesh for one member (rotor or stator)
  // ---------------------------------------------------------------------------

  function buildBodyMesh(features, member, collarR, gapSide, opts) {
    const refine      = Math.min(4, Math.max(0.25, opts.refine != null ? opts.refine : 1));
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

    // Compute physics-derived per-band layer counts and per-feature extra columns
    const physTargets = physicsTargets(features, opts);
    const { perBandLayers, perFeatureExtraCols } = physTargets;

    // Determine minimum divsPerBand from curvature refinement:
    // any localised feature (in perFeatureExtraCols) requires >= 2 sub-cells across
    // its angular span.  Since the uniform grid has one column per (baseN / P_body)
    // sector arc, we need divsPerBand >= 2 when any localised feature exists.
    let minDivsPerBand = 1;
    if (perFeatureExtraCols.size > 0) {
      for (const [fi] of perFeatureExtraCols) {
        const f = features[fi];
        if (f && f.member === member) {
          minDivsPerBand = 2;
          break;
        }
      }
    }

    // Count all features for this member (used by per-feature density target).
    // Full-circle features are included in the density count because they
    // contribute to the body's radial complexity even though they have no
    // angular boundary constraints.
    const numMemberFeatures = features.filter(f => f.member === member).length;

    // Build angular columns using the per-feature density target as primary path.
    let angResult = buildAngularColumns(features, member, P_body, 0, undefined, minDivsPerBand, refine, numMemberFeatures);
    let { thetaColumns, Ntheta: N_gap, divsPerBand, nBandsPerSector } = angResult;

    // Apply gapMinNodes floor: if required, raise Ntheta so that N_gap >= gapMinNodes,
    // snapped to next multiple of P_body.  Use divsPerBandOverride path so the
    // per-feature target doesn't re-run.
    if (gapMinNodes !== null && N_gap < gapMinNodes) {
      const requiredTotal = snapUpToMultiple(gapMinNodes, P_body);
      const newDivsPerBand = Math.ceil(requiredTotal / (P_body * nBandsPerSector));
      angResult = buildAngularColumns(features, member, P_body, 0, newDivsPerBand, minDivsPerBand);
      ({ thetaColumns, Ntheta: N_gap, divsPerBand } = angResult);
    }

    // Build initial radial nodes with physics-derived per-band layer counts
    let rNodes = buildRadialNodes(rEdges, gapSide, opts, features, member, perBandLayers);
    let Nr = rNodes.length;

    // Apply dofBudget: reduce angular columns (and if needed radial rows) to fit budget.
    // The gapMinNodes floor is a hard constraint: N_gap must not drop below it.
    // Strategy:
    //   1. Find the largest Ntheta (multiple of P_body) such that Nr * Ntheta <=
    //      dofBudget + P_body.  Since the primary path sets Ntheta directly (not via
    //      divsPerBand), we target Ntheta directly and use divsPerBandOverride to
    //      produce that Ntheta via the nBandsPerSector * P_body * dpb formula.
    //   2. If even gapFloor * Nr exceeds budget, reduce Nr as well.
    //   3. The final Nn may overshoot dofBudget by at most one body-period worth of
    //      nodes (documented: callers treat dofBudget as Nn <= dofBudget + P_body).
    if (dofBudget !== null) {
      const bandsTotal = nBandsPerSector * P_body;
      const gapFloor = gapMinNodes !== null
        ? snapUpToMultiple(gapMinNodes, P_body)
        : Math.max(P_body, bandsTotal); // minimum possible Ntheta

      const budget_with_slack = dofBudget + P_body;

      // Largest Ntheta (multiple of P_body) such that Nr * Ntheta <= budget + P_body.
      // Snap DOWN (floor) to keep product within budget.
      const rawMaxPerRow = Math.floor(budget_with_slack / Math.max(Nr, 1));
      const maxNtheta = Math.max(P_body, Math.floor(rawMaxPerRow / P_body) * P_body);
      let targetNtheta = Math.min(maxNtheta, N_gap);
      if (targetNtheta < gapFloor) targetNtheta = gapFloor;
      if (targetNtheta < P_body)   targetNtheta = P_body;

      // If even gapFloor * Nr exceeds budget, reduce Nr as well
      if (gapFloor * Nr > budget_with_slack) {
        Nr = Math.max(rEdges.length, Math.floor(budget_with_slack / gapFloor));
        const reducedGapLayers = Math.max(1, Math.round(
          (opts.gapLayers != null ? opts.gapLayers : 3) * Nr / rNodes.length
        ));
        const reducedOpts = Object.assign({}, opts, { gapLayers: reducedGapLayers });
        rNodes = buildRadialNodes(rEdges, gapSide, reducedOpts, features, member, perBandLayers);
        Nr = rNodes.length;
        targetNtheta = gapFloor;
      }

      // Rebuild angular columns at the reduced Ntheta if it actually helps.
      // Use divsPerBandOverride path: dpb = targetNtheta / bandsTotal (ceil).
      if (N_gap > targetNtheta) {
        const targetDpb = Math.max(1, Math.ceil(targetNtheta / bandsTotal));
        const reduced = buildAngularColumns(features, member, P_body, 0, targetDpb, minDivsPerBand);
        if (reduced.Ntheta <= N_gap && reduced.Ntheta >= gapFloor) {
          ({ thetaColumns, Ntheta: N_gap } = reduced);
        }
      }
    }

    return assembleMesh(features, member, rNodes, thetaColumns, N_gap, P_body, collarR, gapSide, opts);
  }

  // ---------------------------------------------------------------------------
  //  Assemble the BodyMesh from radial + angular grids
  //
  //  Node grid: (Nr radial lines) × (Ntheta angular lines)
  //  Node index: i * Ntheta + j   (i = radial index, j = angular index)
  //  Elements: one quad per (i, j) cell: CCW winding (n00→n10→n11→n01)
  //
  //  thetaColumns: Float64Array of angular positions (non-uniform, feature-aligned)
  // ---------------------------------------------------------------------------

  function assembleMesh(features, member, rNodes, thetaColumns, N_gap, P_body, collarR, gapSide, opts) {
    const Nr     = rNodes.length;
    const Ntheta = thetaColumns.length; // === N_gap
    const Nn     = Nr * Ntheta;
    const Ne     = (Nr - 1) * Ntheta;

    // Gap-row radial index: the row at collarR (outermost for rotor, innermost for stator)
    const gapRowIdx = gapSide === "outer" ? Nr - 1 : 0;

    // Build node coordinates (r, θ) → (x, y).
    // thetaColumns is a uniform grid (j * 2π/Ntheta), so all rows share the same
    // angular positions — no twisting, no inverted elements, and gapTheta is
    // automatically uniform to machine precision.
    const nodes = new Float64Array(2 * Nn);
    for (let i = 0; i < Nr; i++) {
      const r = rNodes[i];
      for (let j = 0; j < Ntheta; j++) {
        const th = thetaColumns[j];
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

    let eIdx = 0;
    for (let i = 0; i < Nr - 1; i++) {
      const r0 = rNodes[i];
      const r1 = rNodes[i + 1];
      const rCent = 0.5 * (r0 + r1);
      const inCollar = isCollarBand(r0, r1, features, member, gapSide);

      for (let j = 0; j < Ntheta; j++) {
        const jNext = (j + 1) % Ntheta;

        // CCW quad: (i,j) → (i+1,j) → (i+1,jNext) → (i,jNext)
        const n00 = i       * Ntheta + j;
        const n10 = (i + 1) * Ntheta + j;
        const n11 = (i + 1) * Ntheta + jNext;
        const n01 = i       * Ntheta + jNext;

        elems[4 * eIdx]     = n00;
        elems[4 * eIdx + 1] = n10;
        elems[4 * eIdx + 2] = n11;
        elems[4 * eIdx + 3] = n01;

        if (inCollar) {
          matId[eIdx] = 0; // air collar
        } else {
          // Centroid angle: midpoint between column j and column jNext.
          let th0 = thetaColumns[j];
          let th1 = jNext > j ? thetaColumns[jNext] : thetaColumns[jNext] + TWO_PI;
          const thCent = 0.5 * (th0 + th1);

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

    // gapLoop: nodes on the gap row (gapRowIdx).
    // thetaColumns is a uniform grid so gapTheta[j] = thetaColumns[j] = j * 2π/Ntheta.
    const gapLoop  = new Int32Array(Ntheta);
    const gapTheta = new Float64Array(Ntheta);
    for (let j = 0; j < Ntheta; j++) {
      gapLoop[j]  = gapRowIdx * Ntheta + j;
      gapTheta[j] = thetaColumns[j];
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

    // Fold physics inputs into the signature so different operating points
    // produce distinct cache entries.
    let physStr = "";
    if (opts.physics && Array.isArray(opts.physics.circuits)) {
      physStr = opts.physics.circuits.map((c, i) =>
        `c${i}:freq=${c.freq != null ? c.freq : ""},amp=${c.amp != null ? c.amp : ""},mat=${c.conductorMaterial != null ? c.conductorMaterial : ""}`
      ).join("|");
    }

    return `${member};${featStr};gl=${gapLayers};yc=${yokeCoarsen};ref=${refine};gmn=${gapMinNodes};db=${dofBudget};ph=${physStr}`;
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

  LIB.MotorMesh = { build, buildCached, signature, quality, cacheStats, clearCache, physicsFromConfig, physicsTargets };
})();
