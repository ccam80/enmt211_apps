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

  // Build a routing object from a winding descriptor (a cage component carries
  // ring.cage = { bars }; a distributed/concentrated winding carries
  // ring.winding.standard or an explicit routing object).
  function resolveWinding(ring) {
    if (ring.cage) {
      if (!Number.isInteger(ring.cage.bars)) {
        throw new Error(
          `resolveWinding: cage requires cage.bars (integer); got ${JSON.stringify(ring.cage)}`
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
  //  Body identity: geometry (inner/outer) vs kinematics (rotor/stator).
  //
  //  A ring's `member` is its geometric side of the air gap — "inner" | "outer".
  //  `config.motion` says which side rotates. The engine, gap-eval, and renderers
  //  key on the kinematic role, so features are always tagged "rotor"/"stator"
  //  (resolveRole). Gap derivation keys on the geometric side (positionSide). The
  //  two are independent: an outrunner is member "outer" with
  //  motion.outer === "rotating".
  // ---------------------------------------------------------------------------
  function resolveRole(ring, motion) {
    const m = ring.member;
    const mode = (motion && motion[m]) ? motion[m]
      : (m === "inner" ? "rotating" : "static");
    return mode === "rotating" ? "rotor" : "stator";
  }

  function positionSide(ring) {
    return ring.member === "outer" ? "outer" : "inner";
  }

  // ---------------------------------------------------------------------------
  //  deriveGapBand(grid, rings) → { iInner, iOuter } | null
  //
  //  Automatically finds the longest contiguous pure-air radial run between the
  //  outermost inner-side row and the innermost outer-side row.
  //  Returns null if no valid band of width >= 2 exists.
  //
  //  Dispatch is ONLY on ring.member (geometric side) / ring.components (and
  //  their sub-ranges). No machine identity is used.
  // ---------------------------------------------------------------------------
  function deriveGapBand(grid, rings) {
    const { Nr, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;

    // Compute cell-centre radii
    const rCentre = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) {
      rCentre[i] = rInner + (i + 0.5) * dr;
    }

    // Mark each row as occupied ("inner" | "outer" | null) by geometric side.
    // A row is occupied if its cell centre lies in any ring footprint.
    // Uses the SAME cell-centre test as coveredCells: r0 <= r[i] < r1.
    const rowMember = new Array(Nr).fill(null);

    for (const ring of rings) {
      const member = positionSide(ring);

      // Collect rRange segments that this ring's components occupy
      const segments = [];
      for (const comp of (ring.components || [])) {
        if (comp.rRange) segments.push(comp.rRange);
        if (comp.slotRRange) segments.push(comp.slotRRange);
      }

      for (const seg of segments) {
        if (!Array.isArray(seg) || seg.length < 2) continue;
        const r0 = seg[0];
        const r1 = seg[1];
        for (let i = 0; i < Nr; i++) {
          if (rCentre[i] >= r0 && rCentre[i] < r1) {
            // Mark as occupied; inner wins over outer if both claim the same row
            // (should not happen in a valid config, but be deterministic)
            if (rowMember[i] === null) {
              rowMember[i] = member;
            }
          }
        }
      }
    }

    // Find outermost inner-side row and innermost outer-side row
    let outermostInner = -1;
    let innermostOuter = Nr;

    for (let i = 0; i < Nr; i++) {
      if (rowMember[i] === "inner") {
        outermostInner = i;
      }
    }
    for (let i = 0; i < Nr; i++) {
      if (rowMember[i] === "outer") {
        innermostOuter = i;
        break;
      }
    }

    if (outermostInner < 0 || innermostOuter >= Nr) {
      return null;
    }

    // Air annulus: unoccupied rows strictly between outermostInner and innermostOuter
    // i.e. rows i where outermostInner < i < innermostOuter and rowMember[i] === null
    const airStart = outermostInner + 1;
    const airEnd = innermostOuter; // exclusive

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
      for (const comp of (ring.components || [])) {
        for (const seg of [comp.rRange, comp.slotRRange]) {
          if (!Array.isArray(seg) || seg.length < 2) continue;
          if (rc >= seg[0] && rc < seg[1]) return false;
        }
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  //  Element→feature builders
  //  Each returns an array of feature objects for the given ring.
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
      flankPlacement: teethMode === "concentrated",
    };

    // Build conductor features and offset circuit index
    const rawFeatures = LIB.WindingModel.conductorFeatures(routing, slotGeom);
    for (const f of rawFeatures) {
      features.push(Object.assign({}, f, { circuit: f.circuit + circuitBase }));
    }

    const BkneeWound = ring.Bknee != null ? ring.Bknee : null;

    // Iron teeth between the conductor slots/bars. The yoke/back-iron is the
    // winding's own separate iron component, so it is not emitted here.
    //  - "concentrated": salient teeth centred ON each slot (the coil wraps a
    //    tooth), spanning the full rRange. With poleTeeth set, each pole instead
    //    carries a GROUP of fine teeth (see below).
    //  - "distributed": teeth fill the INTER-slot complement of the slot band
    //    (slotRRange), so gap-crossing magnetizing flux reaches the back-iron
    //    through iron teeth instead of a phantom non-magnetic slot gap. Without
    //    these the whole slotRRange band is conductors + air (zero iron in the
    //    radial flux path), which makes the magnetizing inductance gap/μ-blind.
    const slotTheta = routing.slotTheta;
    if (teethMode === "concentrated") {
      if (ring.poleTeeth) {
        // Grouped pole-face teeth: each of the nSlots poles carries `count` fine
        // iron teeth at `pitch` (the rotor tooth pitch), centred on the pole, with
        // gaps between poles. This is the salient-pole hybrid/SR structure — the
        // teeth are clustered on each energised pole rather than spread evenly
        // around the bore, so the gap-tooth vernier against the rotor teeth is the
        // genuine geometry. The per-pole phase progression that makes such a machine
        // step is the pole pq θ = s·2π/nSlots versus the tooth pitch: pole s aligns
        // with the rotor teeth at phase (s·Nr/nSlots) mod 1, which advances by the
        // non-integer pole/rotor-tooth ratio.
        const count = ring.poleTeeth.count;
        const pitch = ring.poleTeeth.pitch;
        const span  = ring.poleTeeth.span != null ? ring.poleTeeth.span : 0.5;
        const h = span * pitch / 2;
        for (let s = 0; s < nSlots; s++) {
          // The wound pole sits BETWEEN the coil's two slots (the coil wraps it),
          // so the fine-tooth cluster is centred at the inter-slot midpoint.
          const base = slotTheta[s] + 0.5 * (TWO_PI / nSlots);
          for (let j = 0; j < count; j++) {
            const centre = base + (j - (count - 1) / 2) * pitch;
            features.push({
              kind: "iron",
              member,
              rRange: ring.rRange,
              thetaRange: [centre - h, centre + h],
              muR,
              Bknee: BkneeWound,
            });
          }
        }
      } else {
        // Salient teeth, one per slot, sitting BETWEEN the conductor slots — the
        // coil wraps the tooth. The tooth half-width defaults to the slot's
        // angular complement so tooth and coil tile the pitch (no overlap, which
        // is what restores the saliency); spanFraction overrides it. Full radial
        // depth so the tooth reads as a salient pole.
        const pitch = TWO_PI / nSlots;
        const h = ring.spanFraction != null
          ? ring.spanFraction * (Math.PI / nSlots)
          : 0.5 * Math.max(0, pitch - angularWidth);
        if (h > 0) {
          for (let s = 0; s < nSlots; s++) {
            const centre = slotTheta[s] + 0.5 * pitch;
            features.push({
              kind: "iron",
              member,
              rRange: ring.rRange,
              thetaRange: [centre - h, centre + h],
              muR,
              Bknee: BkneeWound,
            });
          }
        }
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
  //  Component model
  //
  //  A ring is { member, components: [ component, ... ] }. Each component is an
  //  explicit layer that emits features; there is no hidden element layering.
  //    { kind:"iron",                rRange, teeth?, spanFraction?, theta0?, muR?, Bknee?, alpha? }
  //    { kind:"magnet",              rRange, poles?, Mr?, muR?, Bknee?, alpha? }
  //    { kind:"distributed-winding", rRange, slotRRange?, winding|cage, slotWidth?, slotFraction?, muR?, Bknee?, alpha? }
  //    { kind:"concentrated-winding",rRange, slotRRange?, winding, spanFraction?, poleTeeth?, slotWidth?, slotFraction?, muR?, Bknee?, alpha? }
  //    { kind:"cage",                rRange, slotRRange?, cage, slotFraction?, muR?, Bknee?, alpha? }
  //  The back-iron of a winding is its own `iron` component (independently sized).
  // ---------------------------------------------------------------------------

  // Geometry-derived cage descriptor for one cage component, keyed at the
  // component's first bar circuit index.
  function computeCageInfo(synth, comp, startIndex, config) {
    const rr = synth.rRange || synth.slotRRange;
    const slotR = synth.slotRRange || synth.rRange;
    const ellAxial = (config && config.grid && config.grid.ell) || null;
    let RbDerived = null;
    if (comp.cage.Rb != null) {
      RbDerived = comp.cage.Rb;
    } else if (slotR && ellAxial) {
      const rMean = 0.5 * (slotR[0] + slotR[1]);
      const radialH = slotR[1] - slotR[0];
      const slotFrac = synth.slotFraction != null ? synth.slotFraction : 0.5;
      const arcW = slotFrac * (2 * Math.PI * rMean) / comp.cage.bars;
      const Abar = radialH * arcW;
      const rho = comp.cage.rho != null ? comp.cage.rho : 2.8e-8;
      if (Abar > 0) RbDerived = (rho * ellAxial) / Abar;
    }
    return {
      startIndex: startIndex,
      bars: comp.cage.bars,
      ringRadius: rr ? 0.5 * (rr[0] + rr[1]) : null,
      ringAreaRatio: comp.cage.ringAreaRatio != null ? comp.cage.ringAreaRatio : 1.0,
      Rb: RbDerived,
    };
  }

  // Per-component end-winding connectivity for the 3-D renderer: the real coil
  // list (slotGo→slotReturn) that the field model collapses into per-slot net
  // turns. kind ∈ {"distributed","concentrated"}; coils carry absolute circuit
  // indices. Cage bars (slotReturn null) close through the end ring, so they
  // contribute no coil here.
  function buildWindingMeta(synth, circuitBase, kind) {
    const routing = resolveWinding(synth);
    if (!routing || !Array.isArray(routing.phases)) return null;
    const slotRRange = synth.slotRRange != null ? synth.slotRRange : synth.rRange;
    const nSlots = routing.nSlots;
    const slotTheta = routing.slotTheta;
    const angularWidth = synth.slotWidth != null
      ? synth.slotWidth
      : (synth.slotFraction != null ? synth.slotFraction : 0.5) * (TWO_PI / nSlots);

    // Resolve the actual per-(circuit, slot) conductor geometry the field model
    // assigned — concentrated coils split each slot into two angular flank
    // bundles, double-layer distributed slots stack radial sub-bands — so the
    // end turns land on the same conductors the cap face and in-slot bars draw.
    // Falls back to the full centred slot band where a slot is unresolved.
    const raw = LIB.WindingModel.conductorFeatures(routing,
      { rRange: slotRRange, member: synth.member, angularWidth: angularWidth,
        flankPlacement: kind === "concentrated" });
    const geomOf = new Map();
    for (const f of raw) {
      const center = (f.thetaRange[0] + f.thetaRange[1]) / 2;
      let s = 0, best = Infinity;
      for (let i = 0; i < nSlots; i++) {
        let d = Math.abs(slotTheta[i] - center);
        if (d > Math.PI) d = TWO_PI - d;
        if (d < best) { best = d; s = i; }
      }
      geomOf.set(f.circuit + ":" + s, { rRange: f.rRange, thetaRange: f.thetaRange });
    }

    const coils = [];
    let circuitIndex = 0;
    for (const phase of routing.phases) {
      for (const branch of phase.branches) {
        for (const coil of branch.coils) {
          if (coil.slotReturn != null) {
            const gg = geomOf.get(circuitIndex + ":" + coil.slotGo);
            const rg = geomOf.get(circuitIndex + ":" + coil.slotReturn);
            coils.push({
              circuit: circuitBase + circuitIndex,
              slotGo: coil.slotGo,
              slotReturn: coil.slotReturn,
              turns: coil.turns,
              goRRange:  gg ? gg.rRange.slice() : slotRRange.slice(),
              retRRange: rg ? rg.rRange.slice() : slotRRange.slice(),
              goThetaC:  gg ? 0.5 * (gg.thetaRange[0] + gg.thetaRange[1]) : slotTheta[coil.slotGo],
              retThetaC: rg ? 0.5 * (rg.thetaRange[0] + rg.thetaRange[1]) : slotTheta[coil.slotReturn],
              goW:  gg ? (gg.thetaRange[1] - gg.thetaRange[0]) : angularWidth,
              retW: rg ? (rg.thetaRange[1] - rg.thetaRange[0]) : angularWidth,
            });
          }
        }
        circuitIndex++;
      }
    }
    return {
      kind: kind,
      member: synth.member,
      slotRRange: slotRRange.slice(),
      angularWidth: angularWidth,
      slotTheta: slotTheta.slice(),
      coils: coils,
    };
  }

  // Build features for one component ring. Returns { features, nCircuits,
  // cageInfo, windings }. sliceSign flips magnet magnetization for fluxSource-
  // driven slices. config is needed only for cage R derivation (pass null when
  // not building cage geometry). motion (config.motion) resolves the ring's
  // inner/outer side to its kinematic role; features are always tagged
  // "rotor"/"stator".
  function buildComponentRingFeatures(ring, circuitBase, sliceSign, config, motion) {
    const member = resolveRole(ring, motion);
    const features = [];
    const windings = [];
    let nCircuits = 0;
    let cageInfo = null;

    for (const comp of ring.components) {
      const a = comp.alpha != null ? comp.alpha : 1;
      let feats = [];

      if (comp.kind === "iron") {
        feats = buildIronFeatures({ member, rRange: comp.rRange, teeth: comp.teeth,
          spanFraction: comp.spanFraction, theta0: comp.theta0, muR: comp.muR, Bknee: comp.Bknee });
      } else if (comp.kind === "magnet") {
        feats = buildMagnetFeatures({ member, rRange: comp.rRange, magnets: comp.poles,
          Mr: comp.Mr, muR: comp.muR, Bknee: comp.Bknee });
        if (sliceSign !== 1) {
          feats = feats.map(function (f) {
            return f.kind === "magnet"
              ? Object.assign({}, f, { Mr: f.Mr * sliceSign, Mtheta: f.Mtheta * sliceSign })
              : f;
          });
        }
      } else if (comp.kind === "distributed-winding" || comp.kind === "concentrated-winding" || comp.kind === "cage") {
        const mode = comp.kind === "concentrated-winding" ? "concentrated" : "distributed";
        const synth = { member, rRange: comp.rRange, slotRRange: comp.slotRRange,
          winding: comp.winding, cage: comp.cage, slotWidth: comp.slotWidth, slotFraction: comp.slotFraction,
          spanFraction: comp.spanFraction, poleTeeth: comp.poleTeeth, muR: comp.muR, Bknee: comp.Bknee };
        feats = buildWoundFeatures(synth, circuitBase + nCircuits, mode);
        if (comp.kind === "cage" && comp.cage && config) {
          cageInfo = computeCageInfo(synth, comp, circuitBase + nCircuits, config);
        } else if (comp.kind !== "cage") {
          const meta = buildWindingMeta(synth, circuitBase + nCircuits, mode);
          if (meta) windings.push(meta);
        }
        nCircuits += LIB.WindingModel.ampereConductors(resolveWinding(synth)).nCircuits;
      }

      for (const f of feats) {
        f.alpha = a;
        f.component = comp.id != null ? comp.id : comp.kind;
        features.push(f);
      }
    }

    return { features, nCircuits, cageInfo, windings };
  }

  // Validate one component ring's components array. Pushes messages into errors.
  function validateComponents(ring, ri, errors, rInner, rOuter) {
    const kinds = ["iron", "magnet", "distributed-winding", "concentrated-winding", "cage"];
    if (!Array.isArray(ring.components) || ring.components.length === 0) {
      errors.push(`rings[${ri}].components must be a non-empty array`);
      return;
    }
    for (let ci = 0; ci < ring.components.length; ci++) {
      const c = ring.components[ci];
      const tag = `rings[${ri}].components[${ci}]`;
      if (!c || typeof c !== "object") { errors.push(`${tag} must be a non-null object`); continue; }
      if (!kinds.includes(c.kind)) errors.push(`${tag}.kind must be one of {${kinds.join(",")}}; got ${c.kind}`);

      if (!Array.isArray(c.rRange) || c.rRange.length !== 2) {
        errors.push(`${tag}.rRange must be a [r0, r1] array`);
      } else {
        const [r0, r1] = c.rRange;
        if (typeof r0 !== "number" || typeof r1 !== "number" || !isFinite(r0) || !isFinite(r1)) {
          errors.push(`${tag}.rRange values must be finite numbers`);
        } else {
          if (rInner !== null && r0 < rInner) errors.push(`${tag}.rRange[0] (${r0}) must be >= grid.rInner (${rInner})`);
          if (rOuter !== null && r1 > rOuter) errors.push(`${tag}.rRange[1] (${r1}) must be <= grid.rOuter (${rOuter})`);
          if (r0 >= r1) errors.push(`${tag}.rRange[0] (${r0}) must be < rRange[1] (${r1})`);
        }
      }
      if (c.alpha != null && (typeof c.alpha !== "number" || !(c.alpha >= 0 && c.alpha <= 1))) {
        errors.push(`${tag}.alpha must be a number in [0, 1]; got ${c.alpha}`);
      }
      if (c.muR != null && (typeof c.muR !== "number" || !isFinite(c.muR) || c.muR <= 0)) {
        errors.push(`${tag}.muR must be a finite positive number; got ${c.muR}`);
      }
      if (c.Bknee != null && (typeof c.Bknee !== "number" || !isFinite(c.Bknee) || c.Bknee <= 0)) {
        errors.push(`${tag}.Bknee must be a finite positive number; got ${c.Bknee}`);
      }
      if (c.kind === "magnet") {
        if (c.poles != null && !isFinitePositiveInt(c.poles)) errors.push(`${tag}.poles must be an integer >= 1; got ${c.poles}`);
        if (c.Mr != null && (typeof c.Mr !== "number" || !isFinite(c.Mr))) errors.push(`${tag}.Mr must be a finite number; got ${c.Mr}`);
      }
      if (c.kind === "distributed-winding" || c.kind === "concentrated-winding" || c.kind === "cage") {
        const synth = { member: ring.member, rRange: c.rRange, slotRRange: c.slotRRange,
          winding: c.winding, cage: c.cage, slotWidth: c.slotWidth, slotFraction: c.slotFraction,
          spanFraction: c.spanFraction, poleTeeth: c.poleTeeth };
        try {
          const routing = resolveWinding(synth);
          if (routing) {
            const v = LIB.WindingModel.validate(routing);
            if (!v.ok) for (const e of v.errors) errors.push(`${tag} winding: ${e}`);
          } else {
            errors.push(`${tag} is a winding component but has no winding/cage routing`);
          }
        } catch (e) {
          errors.push(`${tag} winding resolution error: ${e.message}`);
        }
        if (c.poleTeeth != null) {
          if (c.kind !== "concentrated-winding") errors.push(`${tag}.poleTeeth is only valid on a concentrated-winding component`);
          const pt = c.poleTeeth;
          if (!isFinitePositiveInt(pt.count)) errors.push(`${tag}.poleTeeth.count must be an integer >= 1; got ${pt.count}`);
          if (typeof pt.pitch !== "number" || !isFinite(pt.pitch) || pt.pitch <= 0) errors.push(`${tag}.poleTeeth.pitch must be a finite positive number; got ${pt.pitch}`);
          if (pt.span != null && (typeof pt.span !== "number" || !(pt.span > 0 && pt.span <= 1))) errors.push(`${tag}.poleTeeth.span must be in (0, 1]; got ${pt.span}`);
        }
      }
    }
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
          let hasInner = false;
          let hasOuter = false;
          for (const ring of config.rings) {
            const side = positionSide(ring);
            if (side === "inner") hasInner = true;
            if (side === "outer") hasOuter = true;
          }
          if (!hasInner) {
            errors.push("auto gap-band derivation failed: no inner-side ring found");
          } else if (!hasOuter) {
            errors.push("auto gap-band derivation failed: no outer-side ring found");
          } else {
            errors.push("auto gap-band derivation failed: no contiguous pure-air run of width >= 2 between outermost inner-side and innermost outer-side rows");
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
        if (ring.member !== "inner" && ring.member !== "outer") {
          errors.push(`rings[${ri}].member must be "inner" or "outer"; got ${ring.member}`);
        }
        if (!Array.isArray(ring.components)) {
          errors.push(`rings[${ri}] must have a components array`);
          continue;
        }
        validateComponents(ring, ri, errors, rInner, rOuter);
      }
    }

    // motion — required when any ring is geometric (inner/outer). Exactly one of
    // the two sides rotates (one rotor, one stator, matching the engine).
    if (Array.isArray(rings)) {
      const usesSides = rings.some(function (r) { return r && (r.member === "inner" || r.member === "outer"); });
      if (usesSides) {
        const motion = config.motion;
        if (!motion || typeof motion !== "object") {
          errors.push("motion must be a non-null object when rings use inner/outer members");
        } else {
          let rotatingCount = 0;
          for (const side of ["inner", "outer"]) {
            const v = motion[side];
            if (v !== "rotating" && v !== "static") {
              errors.push(`motion.${side} must be "rotating" or "static"; got ${v}`);
            } else if (v === "rotating") {
              rotatingCount++;
            }
          }
          if (rotatingCount !== 1) {
            errors.push(`exactly one of motion.inner / motion.outer must be "rotating"; got ${rotatingCount} rotating`);
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
        } else if (Array.isArray(rings) && rings[fs.ringRef]) {
          const rr = rings[fs.ringRef];
          const isMagnet = Array.isArray(rr.components) &&
            rr.components.some(function (c) { return c.kind === "magnet"; });
          if (!isMagnet) {
            errors.push(`stack.fluxSources[${fi}].ringRef points to ring ${fs.ringRef} which has no magnet`);
          }
        }
        if (!Array.isArray(fs.sliceSigns) || fs.sliceSigns.length !== nSlices) {
          errors.push(`stack.fluxSources[${fi}].sliceSigns.length must equal stack.slices (${nSlices})`);
        }
      }
    }
    // axial-flux netlist
    if (stack.axial != null) {
      const ax = stack.axial;
      const defs = ax.branches || {};
      if (!Array.isArray(ax.loops) || ax.loops.length < 1) {
        errors.push(`stack.axial.loops must be a non-empty array`);
      } else {
        for (let li = 0; li < ax.loops.length; li++) {
          const loop = ax.loops[li];
          if (!Array.isArray(loop.slices) || loop.slices.length < 1) {
            errors.push(`stack.axial.loops[${li}].slices must be a non-empty array of {s, sign}`);
          } else {
            for (const e of loop.slices) {
              if (!Number.isInteger(e.s) || e.s < 0 || e.s >= nSlices) errors.push(`stack.axial.loops[${li}] slice index ${e.s} out of range [0, ${nSlices})`);
              if (e.sign !== 1 && e.sign !== -1) errors.push(`stack.axial.loops[${li}] slice ${e.s} sign must be ±1; got ${e.sign}`);
            }
          }
          if (loop.branches != null) {
            if (!Array.isArray(loop.branches)) errors.push(`stack.axial.loops[${li}].branches must be an array of branch names`);
            else for (const bn of loop.branches) if (defs[bn] == null) errors.push(`stack.axial.loops[${li}] references undefined branch "${bn}"`);
          }
          if (loop.Raxial != null && (typeof loop.Raxial !== "number" || loop.Raxial < 0)) errors.push(`stack.axial.loops[${li}].Raxial must be a non-negative number`);
          if (loop.Fpm != null && typeof loop.Fpm !== "number") errors.push(`stack.axial.loops[${li}].Fpm must be a number`);
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
        if (!ring || typeof ring !== "object" || !Array.isArray(ring.components)) { resolvable = false; break; }
        for (const c of ring.components) {
          if (c.kind !== "distributed-winding" && c.kind !== "concentrated-winding" && c.kind !== "cage") continue;
          const synth = { member: ring.member, rRange: c.rRange, slotRRange: c.slotRRange,
            winding: c.winding, cage: c.cage, slotFraction: c.slotFraction };
          try {
            const routing = resolveWinding(synth);
            if (!routing) { resolvable = false; break; }
            resolvedTotal += LIB.WindingModel.ampereConductors(routing).nCircuits;
          } catch (e) { resolvable = false; break; }
        }
        if (!resolvable) break;
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
    const windings = [];
    let circuitBase = 0;
    let cageInfo = null;

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];

      const cr = buildComponentRingFeatures(ring, circuitBase, 1, config, config.motion);
      for (const f of cr.features) baseFeatures.push(f);
      circuitBase += cr.nCircuits;
      if (cr.cageInfo) cageInfo = cr.cageInfo;
      if (cr.windings) for (const w of cr.windings) windings.push(w);
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
      const sliceFeatures = buildSliceFeatures(rings, fluxSources, k, config.motion);

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
      windings,
      endCapAlpha: config.endCapAlpha != null ? config.endCapAlpha : 1,
      Rcoupling,
      cage,
      axial: buildAxial(stack, config.grid.ell),
    };
  }

  // Build the axial-flux netlist consumed by MotorStack.solveCoupled. Each loop is a
  // magnetic circuit threading a signed set of slices (their net-radial-flux DOFs Ψ_s)
  // with a lumped axial reluctance R_axial and PM MMF F_pm. Quantities are in the 2-D
  // per-length convention the field solve uses: F_pm is the magnet MMF in A-turns
  // (Br·ℓ_pm/μ0); a lumped branch reluctance scales by the stack length ell (R_2D =
  // ell·R_3D). A loop may give Raxial/Fpm directly (raw) or reference named branches
  // (geometry length/area/muR → reluctance, Br/length → MMF; or raw reluctance/mmf).
  function buildAxial(stack, ell) {
    if (!stack || !stack.axial || !Array.isArray(stack.axial.loops)) return null;
    const MU0 = 4e-7 * Math.PI;
    const defs = stack.axial.branches || {};
    function rel(name) {
      const b = defs[name]; if (!b) return 0;
      if (b.reluctance != null) return b.reluctance;
      if (b.length != null && b.area != null) return ell * b.length / (MU0 * (b.muR != null ? b.muR : 1) * b.area);
      return 0;
    }
    function mmf(name) {
      const b = defs[name]; if (!b) return 0;
      if (b.mmf != null) return b.mmf;
      if (b.Br != null && b.length != null) return b.Br * b.length / MU0;
      return 0;
    }
    const loops = stack.axial.loops.map(function (loop) {
      let Rax = loop.Raxial != null ? loop.Raxial : 0;
      let Fpm = loop.Fpm != null ? loop.Fpm : 0;
      if (Array.isArray(loop.branches)) for (const bn of loop.branches) { Rax += rel(bn); Fpm += mmf(bn); }
      return { slices: loop.slices, Raxial: Rax, Fpm: Fpm };
    });
    return { loops: loops };
  }

  // Build the feature list for a specific slice k, applying fluxSource sign flips
  function buildSliceFeatures(rings, fluxSources, k, motion) {
    // Build a Map from ringIndex → sliceSigns[k] for M rings referenced by fluxSources
    const signMap = new Map();
    for (const fs of fluxSources) {
      signMap.set(fs.ringRef, fs.sliceSigns[k]);
    }

    const features = [];
    let circuitBase = 0;

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      const sign = signMap.has(ri) ? signMap.get(ri) : 1;
      const cr = buildComponentRingFeatures(ring, circuitBase, sign, null, motion);
      for (const f of cr.features) features.push(f);
      circuitBase += cr.nCircuits;
    }

    return features;
  }

  UM.ConfigSchema = { validate, expand };
})();
