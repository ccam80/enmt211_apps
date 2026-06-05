(function () {
  "use strict";

  const TWO_PI = 2 * Math.PI;
  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // ---------------------------------------------------------------------------
  //  Internal helpers
  // ---------------------------------------------------------------------------

  function isFinitePositiveInt(v) {
    return Number.isInteger(v) && v >= 1;
  }

  function isFinitePositiveEvenInt(v) {
    return Number.isInteger(v) && v >= 2 && v % 2 === 0;
  }

  // Build a routing object from a ring descriptor.
  // For element "K" rings: uses ring.cage = { bars } to build a cage routing.
  // For element "W" or "C" rings: uses ring.winding.standard or explicit routing.
  function resolveWinding(ring) {
    if (ring.element === "K") {
      if (!ring.cage || !Number.isInteger(ring.cage.bars)) {
        throw new Error(
          `resolveWinding: element "K" ring requires cage.bars (integer); got ${JSON.stringify(ring.cage)}`
        );
      }
      return LIB.WindingModel.cageRouting({ bars: ring.cage.bars });
    }
    const w = ring.winding;
    if (!w) return null;
    if (w.standard) {
      const { m, p, Q, coilPitch, turns } = w.standard;
      return LIB.WindingModel.standardWinding({ m, p, Q, coilPitch, turns });
    }
    // Explicit routing object
    return w;
  }

  // ---------------------------------------------------------------------------
  //  deriveGapBand(grid, rings) → { iInner, iOuter } | null
  //
  //  Automatically finds the longest contiguous pure-air radial run between the
  //  outermost rotor-member row and the innermost stator-member row.
  //  Returns null if no valid band of width >= 2 exists.
  //
  //  Dispatch is ONLY on ring.member / ring.element / ring.rRange (and sub-ranges).
  //  No machine identity is used.
  // ---------------------------------------------------------------------------
  function deriveGapBand(grid, rings) {
    const { Nr, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;

    // Compute cell-centre radii
    const rCentre = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) {
      rCentre[i] = rInner + (i + 0.5) * dr;
    }

    // Mark each row as occupied ("rotor" | "stator" | null)
    // A row is occupied if its cell centre lies in any ring footprint.
    // Uses the SAME cell-centre test as coveredCells: r0 <= r[i] < r1.
    const rowMember = new Array(Nr).fill(null);

    for (const ring of rings) {
      const member = ring.member;
      const el = ring.element;

      // Collect rRange segments that this ring occupies
      const segments = [];

      if (el === "I") {
        segments.push(ring.rRange);
      } else if (el === "M") {
        segments.push(ring.rRange);
        if (ring.backIron && ring.backIronRRange) {
          segments.push(ring.backIronRRange);
        }
      } else if (el === "W" || el === "K") {
        // Slot region
        segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
        // Back-iron region
        segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
      } else if (el === "C") {
        // Slot region
        segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
        // Back-iron region
        segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
        // Teeth (same rRange as ring)
        segments.push(ring.rRange);
      }

      for (const seg of segments) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        const r0 = seg[0];
        const r1 = seg[1];
        for (let i = 0; i < Nr; i++) {
          if (rCentre[i] >= r0 && rCentre[i] < r1) {
            // Mark as occupied; rotor wins over stator if both claim the same row
            // (should not happen in a valid config, but be deterministic)
            if (rowMember[i] === null) {
              rowMember[i] = member;
            }
          }
        }
      }
    }

    // Find outermost rotor row and innermost stator row
    let outermostRotor = -1;
    let innermostStator = Nr;

    for (let i = 0; i < Nr; i++) {
      if (rowMember[i] === "rotor") {
        outermostRotor = i;
      }
    }
    for (let i = 0; i < Nr; i++) {
      if (rowMember[i] === "stator") {
        innermostStator = i;
        break;
      }
    }

    if (outermostRotor < 0 || innermostStator >= Nr) {
      return null;
    }

    // Air annulus: unoccupied rows strictly between outermostRotor and innermostStator
    // i.e. rows i where outermostRotor < i < innermostStator and rowMember[i] === null
    const airStart = outermostRotor + 1;
    const airEnd = innermostStator; // exclusive

    if (airEnd <= airStart) {
      return null;
    }

    // Find the LONGEST contiguous pure-air run in [airStart, airEnd)
    // Ties → innermost (lowest iInner)
    let bestLen = 0;
    let bestStart = -1;
    let runStart = -1;
    let runLen = 0;

    for (let i = airStart; i <= airEnd; i++) {
      const isAir = (i < airEnd) && (rowMember[i] === null);
      if (isAir) {
        if (runStart < 0) runStart = i;
        runLen++;
      } else {
        if (runLen > bestLen) {
          bestLen = runLen;
          bestStart = runStart;
        }
        runStart = -1;
        runLen = 0;
      }
    }

    if (bestLen < 2) {
      return null;
    }

    return { iInner: bestStart, iOuter: bestStart + bestLen };
  }

  // ---------------------------------------------------------------------------
  //  isPureAirRow(grid, rings, i) — checks if row i is pure air
  //  (not occupied by any ring footprint using the same cell-centre test)
  // ---------------------------------------------------------------------------
  function isPureAirRow(grid, rings, i) {
    const dr = (grid.rOuter - grid.rInner) / grid.Nr;
    const rc = grid.rInner + (i + 0.5) * dr;

    for (const ring of rings) {
      const el = ring.element;
      const segments = [];

      if (el === "I") {
        segments.push(ring.rRange);
      } else if (el === "M") {
        segments.push(ring.rRange);
        if (ring.backIron && ring.backIronRRange) segments.push(ring.backIronRRange);
      } else if (el === "W" || el === "K") {
        segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
        segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
      } else if (el === "C") {
        segments.push(ring.slotRRange != null ? ring.slotRRange : ring.rRange);
        segments.push(ring.ironRRange != null ? ring.ironRRange : ring.rRange);
        segments.push(ring.rRange);
      }

      for (const seg of segments) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        if (rc >= seg[0] && rc < seg[1]) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  Element→feature builders
  //  Each returns an array of Phase-2 feature objects for the given ring.
  //  circuitBase is added to every conductor feature.circuit.
  // ---------------------------------------------------------------------------

  function buildIronFeatures(ring) {
    const features = [];
    const count = ring.teeth || 1;
    const member = ring.member;
    const rRange = ring.rRange;
    const muR = ring.muR != null ? ring.muR : 1000;
    // A bare un-toothed iron ring is a SOLID ring (full annulus). spanFraction
    // 0.5 (iron over half each tooth-pitch) is only a sensible default for an
    // explicitly-toothed/salient structure (teeth>1); defaulting the count=1
    // case to 0.5 would silently produce a half-disc 2-pole salient rotor,
    // which is never what "a plain iron ring" means. (spec 2026-05-29 #5)
    const spanFraction = ring.spanFraction != null
      ? ring.spanFraction
      : (ring.teeth ? 0.5 : 1.0);
    const theta0 = ring.theta0 != null ? ring.theta0 : 0;

    const Bknee = ring.Bknee != null ? ring.Bknee : null;
    for (let t = 0; t < count; t++) {
      const centre = theta0 + t * TWO_PI / count;
      const h = spanFraction * (Math.PI / count);
      features.push({
        kind: "iron",
        member,
        rRange,
        thetaRange: [centre - h, centre + h],
        muR,
        Bknee,
      });
    }
    return features;
  }

  function buildMagnetFeatures(ring) {
    const features = [];
    const count = ring.magnets || 2;
    const member = ring.member;
    const rRange = ring.rRange;
    const Mr = ring.Mr != null ? ring.Mr : 1e6;

    for (let g = 0; g < count; g++) {
      features.push({
        kind: "magnet",
        member,
        rRange,
        thetaRange: [g * TWO_PI / count, (g + 1) * TWO_PI / count],
        Mr: Mr * Math.pow(-1, g),
        Mtheta: 0,
      });
    }

    if (ring.backIron) {
      const muR = ring.muR != null ? ring.muR : 1000;
      features.push({
        kind: "iron",
        member,
        rRange: ring.backIronRRange,
        thetaRange: [0, TWO_PI],
        muR,
        Bknee: ring.Bknee != null ? ring.Bknee : null,
      });
    }

    return features;
  }

  function buildWoundFeatures(ring, circuitBase, teethMode) {
    const features = [];
    const member = ring.member;
    const muR = ring.muR != null ? ring.muR : 1000;

    const routing = resolveWinding(ring);

    // Slot geometry
    const slotRRange = ring.slotRRange != null ? ring.slotRRange : ring.rRange;
    const nSlots = routing.nSlots;
    const angularWidth =
      ring.slotWidth != null
        ? ring.slotWidth
        : (ring.slotFraction != null ? ring.slotFraction : 0.5) * (TWO_PI / nSlots);

    const slotGeom = {
      rRange: slotRRange,
      member,
      angularWidth,
    };

    // Build conductor features and offset circuit index
    const rawFeatures = LIB.WindingModel.conductorFeatures(routing, slotGeom);
    for (const f of rawFeatures) {
      features.push(Object.assign({}, f, { circuit: f.circuit + circuitBase }));
    }

    const BkneeWound = ring.Bknee != null ? ring.Bknee : null;

    // Back-iron feature spanning the full ring rRange
    features.push({
      kind: "iron",
      member,
      rRange: ring.ironRRange != null ? ring.ironRRange : ring.rRange,
      thetaRange: [0, TWO_PI],
      muR,
      Bknee: BkneeWound,
    });

    // Iron teeth between the conductor slots/bars.
    //  - "concentrated" ("C"): salient teeth centred ON each slot (the coil wraps a
    //    tooth), spanning the full ring rRange.
    //  - "distributed" ("W"/"K"): teeth fill the INTER-slot complement of the slot
    //    band (slotRRange), so gap-crossing magnetizing flux reaches the back-iron
    //    through iron teeth instead of a phantom non-magnetic slot gap. Without
    //    these the whole slotRRange band is conductors + air (zero iron in the
    //    radial flux path), which makes the magnetizing inductance gap/μ-blind.
    const slotTheta = routing.slotTheta;
    if (teethMode === "concentrated") {
      const spanFraction = ring.spanFraction != null ? ring.spanFraction : 0.5;
      for (let s = 0; s < nSlots; s++) {
        const centre = slotTheta[s];
        const h = spanFraction * (Math.PI / nSlots);
        features.push({
          kind: "iron",
          member,
          rRange: ring.rRange,
          thetaRange: [centre - h, centre + h],
          muR,
          Bknee: BkneeWound,
        });
      }
    } else if (teethMode === "distributed") {
      // Conductor slot arc = angularWidth (centred on slotTheta[s]); the tooth is
      // the remaining pitch, centred at the inter-slot midpoint, spanning the slot
      // band radially. Conductor arc and tooth arc tile the pitch exactly.
      const pitch = TWO_PI / nSlots;
      const hTooth = 0.5 * Math.max(0, pitch - angularWidth);
      if (hTooth > 0) {
        for (let s = 0; s < nSlots; s++) {
          const centre = slotTheta[s] + 0.5 * pitch;
          features.push({
            kind: "iron",
            member,
            rRange: slotRRange,
            thetaRange: [centre - hTooth, centre + hTooth],
            muR,
            Bknee: BkneeWound,
          });
        }
      }
    }

    return features;
  }

  // ---------------------------------------------------------------------------
  //  validate(config) → { ok:boolean, errors:string[] }
  // ---------------------------------------------------------------------------
  function validate(config) {
    const errors = [];

    if (!config || typeof config !== "object") {
      errors.push("config must be a non-null object");
      return { ok: false, errors };
    }

    // grid
    const g = config.grid;
    if (!g || typeof g !== "object") {
      errors.push("grid must be a non-null object");
    } else {
      if (!isFinitePositiveInt(g.Nr)) errors.push(`grid.Nr must be an integer >= 1; got ${g.Nr}`);
      if (!isFinitePositiveInt(g.Ntheta)) errors.push(`grid.Ntheta must be an integer >= 1; got ${g.Ntheta}`);
      if (typeof g.rInner !== "number" || !isFinite(g.rInner) ||
          typeof g.rOuter !== "number" || !isFinite(g.rOuter) ||
          g.rInner >= g.rOuter) {
        errors.push(`grid.rInner (${g.rInner}) must be < grid.rOuter (${g.rOuter}) and both finite`);
      }
      if (typeof g.ell !== "number" || !isFinite(g.ell) || g.ell <= 0) {
        errors.push(`grid.ell must be a finite positive number; got ${g.ell}`);
      }
    }

    const gapBandMode = config.gapBandMode != null ? config.gapBandMode : "auto";

    if (gapBandMode === "manual") {
      // Manual mode: validate config.gapBand integer range and pure-air content
      const gb = config.gapBand;
      const gridValid = g && isFinitePositiveInt(g.Nr);
      if (!gb || typeof gb !== "object") {
        errors.push("gapBand must be a non-null object (required in manual mode)");
      } else {
        const Nr = gridValid ? g.Nr : null;
        if (!Number.isInteger(gb.iInner) || gb.iInner < 0 || (Nr !== null && gb.iInner >= Nr)) {
          errors.push(`gapBand.iInner must be an integer in [0, Nr); got ${gb.iInner}`);
        }
        if (!Number.isInteger(gb.iOuter) || gb.iOuter < 0 || (Nr !== null && gb.iOuter >= Nr)) {
          errors.push(`gapBand.iOuter must be an integer in [0, Nr); got ${gb.iOuter}`);
        }
        if (Number.isInteger(gb.iInner) && Number.isInteger(gb.iOuter) && gb.iInner >= gb.iOuter) {
          errors.push(`gapBand.iInner (${gb.iInner}) must be < gapBand.iOuter (${gb.iOuter})`);
        }
        // Width >= 2
        if (Number.isInteger(gb.iInner) && Number.isInteger(gb.iOuter) &&
            gb.iOuter - gb.iInner < 2) {
          errors.push(`gapBand width (${gb.iOuter - gb.iInner}) must be >= 2`);
        }
        // Every row in [iInner, iOuter) must be pure air
        if (gridValid && Array.isArray(config.rings) &&
            Number.isInteger(gb.iInner) && Number.isInteger(gb.iOuter) &&
            gb.iInner < gb.iOuter) {
          for (let i = gb.iInner; i < gb.iOuter; i++) {
            if (!isPureAirRow(g, config.rings, i)) {
              errors.push(`gapBand row ${i} is not pure air — manual band must lie entirely in air`);
            }
          }
        }
      }
    } else {
      // Auto mode: config.gapBand is optional; validate by attempting derivation
      if (g && isFinitePositiveInt(g.Nr) && Array.isArray(config.rings)) {
        const derived = deriveGapBand(g, config.rings);
        if (derived === null) {
          // Diagnose why
          let hasRotor = false;
          let hasStator = false;
          for (const ring of config.rings) {
            if (ring.member === "rotor") hasRotor = true;
            if (ring.member === "stator") hasStator = true;
          }
          if (!hasRotor) {
            errors.push("auto gap-band derivation failed: no rotor-member ring found");
          } else if (!hasStator) {
            errors.push("auto gap-band derivation failed: no stator-member ring found");
          } else {
            errors.push("auto gap-band derivation failed: no contiguous pure-air run of width >= 2 between outermost rotor and innermost stator rows");
          }
        }
      }
    }

    // poles
    if (!isFinitePositiveEvenInt(config.poles)) {
      errors.push(`poles must be a positive even integer; got ${config.poles}`);
    }

    // mechanical
    const mech = config.mechanical;
    if (!mech || typeof mech !== "object") {
      errors.push("mechanical must be a non-null object");
    } else {
      if (typeof mech.J !== "number" || !isFinite(mech.J) || mech.J <= 0) {
        errors.push(`mechanical.J must be a finite positive number; got ${mech.J}`);
      }
    }

    // rings
    const rings = config.rings;
    if (!Array.isArray(rings)) {
      errors.push("rings must be an array");
    } else {
      const rInner = g && typeof g.rInner === "number" ? g.rInner : null;
      const rOuter = g && typeof g.rOuter === "number" ? g.rOuter : null;
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        if (!ring || typeof ring !== "object") {
          errors.push(`rings[${ri}] must be a non-null object`);
          continue;
        }
        if (ring.member !== "rotor" && ring.member !== "stator") {
          errors.push(`rings[${ri}].member must be "rotor" or "stator"; got ${ring.member}`);
        }
        const validElements = ["W", "C", "M", "I", "K"];
        if (!validElements.includes(ring.element)) {
          errors.push(`rings[${ri}].element must be one of {W,C,M,I,K}; got ${ring.element}`);
        }
        if (!Array.isArray(ring.rRange) || ring.rRange.length !== 2) {
          errors.push(`rings[${ri}].rRange must be a [r0, r1] array`);
        } else {
          const [r0, r1] = ring.rRange;
          if (typeof r0 !== "number" || typeof r1 !== "number" || !isFinite(r0) || !isFinite(r1)) {
            errors.push(`rings[${ri}].rRange values must be finite numbers`);
          } else {
            if (rInner !== null && r0 < rInner) {
              errors.push(`rings[${ri}].rRange[0] (${r0}) must be >= grid.rInner (${rInner})`);
            }
            if (rOuter !== null && r1 > rOuter) {
              errors.push(`rings[${ri}].rRange[1] (${r1}) must be <= grid.rOuter (${rOuter})`);
            }
            if (r0 >= r1) {
              errors.push(`rings[${ri}].rRange[0] (${r0}) must be < rRange[1] (${r1})`);
            }
          }
        }
        if (ring.Bknee !== undefined) {
          if (typeof ring.Bknee !== "number" || !isFinite(ring.Bknee) || ring.Bknee <= 0) {
            errors.push(`rings[${ri}].Bknee must be a finite positive number when present; got ${ring.Bknee}`);
          }
        }
        // For wound rings, validate the winding routing
        if (ring.element === "W" || ring.element === "C" || ring.element === "K") {
          try {
            const routing = resolveWinding(ring);
            if (routing) {
              const vResult = LIB.WindingModel.validate(routing);
              if (!vResult.ok) {
                for (const e of vResult.errors) {
                  errors.push(`rings[${ri}] winding: ${e}`);
                }
              }
            } else {
              errors.push(`rings[${ri}] is wound but has no winding property`);
            }
          } catch (e) {
            errors.push(`rings[${ri}] winding resolution error: ${e.message}`);
          }
        }
      }
    }

    // circuits
    const circuits = config.circuits;
    const validTerminalTypes = ["AC", "DC", "PULSE", "STEP", "OPEN", "SHORT", "CURRENT"];
    const validCommModes = ["none", "mechanical", "electronic-trap", "electronic-sine", "sequencer"];
    if (!Array.isArray(circuits)) {
      errors.push("circuits must be an array");
    } else {
      for (let ci = 0; ci < circuits.length; ci++) {
        const c = circuits[ci];
        if (!c || typeof c !== "object") {
          errors.push(`circuits[${ci}] must be a non-null object`);
          continue;
        }
        if (!c.terminal || !validTerminalTypes.includes(c.terminal.type)) {
          errors.push(`circuits[${ci}].terminal.type must be one of {${validTerminalTypes.join(",")}}; got ${c.terminal && c.terminal.type}`);
        }
        if (!c.commutation || !validCommModes.includes(c.commutation.mode)) {
          errors.push(`circuits[${ci}].commutation.mode must be one of {${validCommModes.join(",")}}; got ${c.commutation && c.commutation.mode}`);
        }
        if (typeof c.R !== "number" || !isFinite(c.R) || c.R < 0) {
          errors.push(`circuits[${ci}].R must be a finite number >= 0; got ${c.R}`);
        }
      }
    }

    // stack
    const stack = config.stack || {};
    const nSlices = stack.slices != null ? stack.slices : 1;
    if (!Number.isInteger(nSlices) || nSlices < 1) {
      errors.push(`stack.slices must be an integer >= 1; got ${nSlices}`);
    }
    if (stack.sliceOffsets != null) {
      if (!Array.isArray(stack.sliceOffsets) || stack.sliceOffsets.length !== nSlices) {
        errors.push(`stack.sliceOffsets.length must equal stack.slices (${nSlices}); got ${stack.sliceOffsets && stack.sliceOffsets.length}`);
      }
    }
    if (Array.isArray(stack.fluxSources)) {
      const ringCount = Array.isArray(rings) ? rings.length : 0;
      for (let fi = 0; fi < stack.fluxSources.length; fi++) {
        const fs = stack.fluxSources[fi];
        if (!Number.isInteger(fs.ringRef) || fs.ringRef < 0 || fs.ringRef >= ringCount) {
          errors.push(`stack.fluxSources[${fi}].ringRef (${fs.ringRef}) is out of range [0, ${ringCount})`);
        } else if (Array.isArray(rings) && rings[fs.ringRef] && rings[fs.ringRef].element !== "M") {
          errors.push(`stack.fluxSources[${fi}].ringRef points to ring ${fs.ringRef} which is not element "M"`);
        }
        if (!Array.isArray(fs.sliceSigns) || fs.sliceSigns.length !== nSlices) {
          errors.push(`stack.fluxSources[${fi}].sliceSigns.length must equal stack.slices (${nSlices})`);
        }
      }
    }

    // Validate that resolved circuit count matches config.circuits.length
    // (only if rings and circuits are valid enough to attempt)
    if (Array.isArray(rings) && Array.isArray(circuits)) {
      let resolvedTotal = 0;
      let resolvable = true;
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        if (!ring || typeof ring !== "object") { resolvable = false; break; }
        const el = ring.element;
        if (el === "W" || el === "C" || el === "K") {
          try {
            const routing = resolveWinding(ring);
            if (!routing) { resolvable = false; break; }
            const { nCircuits } = LIB.WindingModel.ampereConductors(routing);
            resolvedTotal += nCircuits;
          } catch (e) {
            resolvable = false;
            break;
          }
        }
      }
      if (resolvable && resolvedTotal !== circuits.length) {
        errors.push(
          `resolved circuit count (${resolvedTotal}) does not match circuits.length (${circuits.length})`
        );
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------------------
  //  Rotor cage end-ring coupling.
  //
  //  A cage is N bars joined at both ends by two conducting end rings. With one
  //  bar per slot (cageRouting), the bar currents i_k are the state and the FE
  //  mutual matrix carries the (now clean, direct) bar↔stator and bar↔bar
  //  magnetic coupling. The end rings add the ELECTRICAL coupling: eliminating
  //  the ring node potentials (each ring a cycle graph of N nodes, segment
  //  resistance R_e), the effective cage resistance matrix is
  //      R_cage = R_b·I + 2·R_e·Λ⁺
  //  where Λ is the cycle-graph Laplacian (circulant 2,−1,…,−1, singular on the
  //  all-ones mode) and Λ⁺ its pseudo-inverse on the Σi=0 subspace; the factor 2
  //  is the two rings (front+back) in series in each bar loop. A large
  //  common-mode penalty enforces the KCL constraint Σ i_bar = 0 — the rings can
  //  only redistribute current, there is no net axial rotor current (and a single
  //  one-bar-per-slot bar has no in-plane return, so Σi=0 is required for FE
  //  validity too).
  // ---------------------------------------------------------------------------
  function cycleLaplacianPinvGenerator(N) {
    // Circulant generator g[d] (d = 0..N-1) of Λ⁺ for the N-node cycle graph:
    // Λ⁺ = Σ_{j=1}^{N-1} (1/μ_j)·v_j v_jᵀ, μ_j = 2−2cos(2πj/N); g[d] is its IDFT.
    const g = new Float64Array(N);
    for (let d = 0; d < N; d++) {
      let s = 0;
      for (let j = 1; j < N; j++) {
        const mu = 2 - 2 * Math.cos((2 * Math.PI * j) / N);
        s += Math.cos((2 * Math.PI * j * d) / N) / mu;
      }
      g[d] = s / N;
    }
    return g;
  }

  function buildCageRcoupling(m, circuits, cage) {
    // Full m×m resistance matrix: per-circuit R on the diagonal for every
    // circuit, with the cage block [s0, s0+N) overwritten by the end-ring-coupled
    // circulant R_cage + the Σi=0 common-mode penalty.
    const R = new Float64Array(m * m);
    for (let k = 0; k < m; k++) R[k * m + k] = circuits[k].R;
    if (!cage) return R;
    const s0 = cage.startIndex, N = cage.bars, Re = cage.Re, Rb = cage.Rb;
    const g = cycleLaplacianPinvGenerator(N);
    const penalty = 1e6 * Math.max(Rb, 1e-9); // common-mode resistance ⇒ i_common≈0
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const d = (((a - b) % N) + N) % N;
        R[(s0 + a) * m + (s0 + b)] =
          (a === b ? Rb : 0) + 2 * Re * g[d] + penalty / N;
      }
    }
    return R;
  }

  //  expand(config) → expanded
  // ---------------------------------------------------------------------------
  function expand(config) {
    const rings = config.rings;
    const stack = config.stack || {};
    const N = stack.slices != null ? stack.slices : 1;
    const offsets = stack.sliceOffsets != null ? stack.sliceOffsets : new Array(N).fill(0);
    const fluxSources = Array.isArray(stack.fluxSources) ? stack.fluxSources : [];

    // Resolve gapBand: auto-derive unless gapBandMode === "manual"
    const gapBandMode = config.gapBandMode != null ? config.gapBandMode : "auto";
    let gapBand;
    if (gapBandMode === "manual") {
      gapBand = config.gapBand;
    } else {
      gapBand = deriveGapBand(config.grid, rings);
      if (gapBand === null) {
        throw new Error(
          "config-schema expand: auto gap-band derivation failed — " +
          "no contiguous pure-air run of width >= 2 between the outermost rotor row " +
          "and the innermost stator row. Check ring rRange values and member assignments."
        );
      }
    }

    // Build the base feature list with global circuit indexing
    const baseFeatures = [];
    let circuitBase = 0;
    let cageInfo = null;

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const el = ring.element;

      if (el === "I") {
        const ringFeatures = buildIronFeatures(ring);
        for (const f of ringFeatures) baseFeatures.push(f);
      } else if (el === "M") {
        const ringFeatures = buildMagnetFeatures(ring);
        for (const f of ringFeatures) baseFeatures.push(f);
      } else if (el === "W" || el === "K") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, "distributed");
        for (const f of ringFeatures) baseFeatures.push(f);
        const routing = resolveWinding(ring);
        if (el === "K" && ring.cage) {
          // Record the cage descriptor for end-ring-coupled R assembly below.
          // startIndex is the global index of this cage's first bar circuit
          // (BEFORE the circuitBase increment); ringRadius from the bar ring
          // geometry; ringAreaRatio = end-ring cross-section / bar cross-section.
          const rr = ring.rRange || ring.slotRRange;
          // Geometry-derived cage BAR resistance R_b = ρ·ell/A_bar. A real cast
          // cage bar is a conductor of axial length ell and cross-section
          //   A_bar = (radial slot height)·(bar arc),  bar arc = slotFraction·2π·r_m/N.
          // ρ defaults to aluminium (cast-cage standard, ~20°C). Override per ring
          // via cage.rho (resistivity, Ω·m) or cage.Rb (explicit Ω). Falls back to
          // the circuit R only if the slot geometry / ell is unavailable.
          // (The former fixed R=0.03 Ω was ~1000× too large → rotor τ=L/R ~1000×
          // too short [0.12 ms vs ~50-200 ms physical] → no slip torque, and the
          // rotor dynamics fell below one timestep. See cage-induction investigation.)
          const slotR = ring.slotRRange || ring.rRange;
          const ellAxial = (config.grid && config.grid.ell) || null;
          let RbDerived = null;
          if (ring.cage.Rb != null) {
            RbDerived = ring.cage.Rb;
          } else if (slotR && ellAxial) {
            const rMean = 0.5 * (slotR[0] + slotR[1]);
            const radialH = slotR[1] - slotR[0];
            const slotFrac = ring.slotFraction != null ? ring.slotFraction : 0.5;
            const arcW = slotFrac * (2 * Math.PI * rMean) / ring.cage.bars;
            const Abar = radialH * arcW;
            const rho = ring.cage.rho != null ? ring.cage.rho : 2.8e-8; // Ω·m, Al
            if (Abar > 0) RbDerived = (rho * ellAxial) / Abar;
          }
          cageInfo = {
            startIndex: circuitBase,
            bars: ring.cage.bars,
            ringRadius: rr ? 0.5 * (rr[0] + rr[1]) : null,
            ringAreaRatio: ring.cage.ringAreaRatio != null ? ring.cage.ringAreaRatio : 1.0,
            Rb: RbDerived,
          };
        }
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      } else if (el === "C") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, "concentrated");
        for (const f of ringFeatures) baseFeatures.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      }
    }

    const nCircuits = circuitBase;

    // End-ring-coupled cage resistance (off-diagonal). Geometry-derived end-ring
    // segment resistance R_e = R_b·(segment arc / bar length)/ringAreaRatio,
    // segment arc = 2π·R_ring/N. Null when there is no cage (diagonal-R path).
    let Rcoupling = null;
    let cage = null;
    if (cageInfo && cageInfo.ringRadius != null && config.grid && config.grid.ell) {
      const N = cageInfo.bars;
      // Geometry-derived bar resistance (computed at cage capture); fall back to
      // the placeholder circuit R only if geometry/ell were unavailable.
      const Rb = (cageInfo.Rb != null) ? cageInfo.Rb : config.circuits[cageInfo.startIndex].R;
      const ell = config.grid.ell;
      const Lseg = (2 * Math.PI * cageInfo.ringRadius) / N;
      const Re = (Rb * (Lseg / ell)) / cageInfo.ringAreaRatio;
      cage = { startIndex: cageInfo.startIndex, bars: N, Rb: Rb, Re: Re };
      Rcoupling = buildCageRcoupling(nCircuits, config.circuits, cage);
    }

    // Build per-slice sections, applying fluxSource sign flips to M rings
    const slices = [];
    for (let k = 0; k < N; k++) {
      const sliceFeatures = buildSliceFeatures(rings, fluxSources, k);

      slices.push({
        section: {
          grid: config.grid,
          gapBand,
          features: sliceFeatures,
        },
        offset: offsets[k],
      });
    }

    const mech = config.mechanical;

    return {
      grid: config.grid,
      gapBand,
      poles: config.poles,
      mechanical: {
        J: mech.J,
        damping: mech.damping != null ? mech.damping : 0,
        loadTorque: mech.loadTorque != null ? mech.loadTorque : 0,
        frictionTorque: mech.frictionTorque != null ? mech.frictionTorque : 0,
      },
      label: config.label != null ? config.label : "",
      nCircuits,
      circuits: config.circuits.slice(),
      slices,
      Rcoupling,
      cage,
    };
  }

  // Build the feature list for a specific slice k, applying fluxSource sign flips
  function buildSliceFeatures(rings, fluxSources, k) {
    // Build a Map from ringIndex → sliceSigns[k] for M rings referenced by fluxSources
    const signMap = new Map();
    for (const fs of fluxSources) {
      signMap.set(fs.ringRef, fs.sliceSigns[k]);
    }

    const features = [];
    let circuitBase = 0;

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const el = ring.element;

      if (el === "I") {
        const ringFeatures = buildIronFeatures(ring);
        for (const f of ringFeatures) features.push(f);
      } else if (el === "M") {
        const rawFeatures = buildMagnetFeatures(ring);
        const sign = signMap.has(ri) ? signMap.get(ri) : 1;
        for (const f of rawFeatures) {
          if (f.kind === "magnet") {
            features.push(Object.assign({}, f, {
              Mr: f.Mr * sign,
              Mtheta: f.Mtheta * sign,
            }));
          } else {
            // iron back-iron feature — unchanged
            features.push(f);
          }
        }
      } else if (el === "W" || el === "K") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, "distributed");
        for (const f of ringFeatures) features.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      } else if (el === "C") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, "concentrated");
        for (const f of ringFeatures) features.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      }
    }

    return features;
  }

  UM.ConfigSchema = { validate, expand };
})();
