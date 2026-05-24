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

  // Build a standard routing object from { standard:{m,p,Q,coilPitch,turns} }
  // or return the explicit routing object directly.
  function resolveWinding(ring) {
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
    const spanFraction = ring.spanFraction != null ? ring.spanFraction : 0.5;
    const theta0 = ring.theta0 != null ? ring.theta0 : 0;

    for (let t = 0; t < count; t++) {
      const centre = theta0 + t * TWO_PI / count;
      const h = spanFraction * (Math.PI / count);
      features.push({
        kind: "iron",
        member,
        rRange,
        thetaRange: [centre - h, centre + h],
        muR,
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
      });
    }

    return features;
  }

  function buildWoundFeatures(ring, circuitBase, includeTeeth) {
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

    // Back-iron feature spanning the full ring rRange
    features.push({
      kind: "iron",
      member,
      rRange: ring.ironRRange != null ? ring.ironRRange : ring.rRange,
      thetaRange: [0, TWO_PI],
      muR,
    });

    // Concentrated coil ("C") also emits salient tooth iron features (one per slot)
    if (includeTeeth) {
      const spanFraction = ring.spanFraction != null ? ring.spanFraction : 0.5;
      const slotTheta = routing.slotTheta;
      for (let s = 0; s < nSlots; s++) {
        const centre = slotTheta[s];
        const h = spanFraction * (Math.PI / nSlots);
        features.push({
          kind: "iron",
          member,
          rRange: ring.rRange,
          thetaRange: [centre - h, centre + h],
          muR,
        });
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

    // gapBand
    const gb = config.gapBand;
    if (!gb || typeof gb !== "object") {
      errors.push("gapBand must be a non-null object");
    } else {
      const Nr = g && isFinitePositiveInt(g.Nr) ? g.Nr : null;
      if (!Number.isInteger(gb.iInner) || gb.iInner < 0 || (Nr !== null && gb.iInner >= Nr)) {
        errors.push(`gapBand.iInner must be an integer in [0, Nr); got ${gb.iInner}`);
      }
      if (!Number.isInteger(gb.iOuter) || gb.iOuter < 0 || (Nr !== null && gb.iOuter >= Nr)) {
        errors.push(`gapBand.iOuter must be an integer in [0, Nr); got ${gb.iOuter}`);
      }
      if (Number.isInteger(gb.iInner) && Number.isInteger(gb.iOuter) && gb.iInner >= gb.iOuter) {
        errors.push(`gapBand.iInner (${gb.iInner}) must be < gapBand.iOuter (${gb.iOuter})`);
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
    const validTerminalTypes = ["AC", "DC", "PULSE", "STEP", "OPEN", "SHORT"];
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
  //  expand(config) → expanded
  // ---------------------------------------------------------------------------
  function expand(config) {
    const rings = config.rings;
    const stack = config.stack || {};
    const N = stack.slices != null ? stack.slices : 1;
    const offsets = stack.sliceOffsets != null ? stack.sliceOffsets : new Array(N).fill(0);
    const fluxSources = Array.isArray(stack.fluxSources) ? stack.fluxSources : [];

    // Build the base feature list with global circuit indexing
    const baseFeatures = [];
    let circuitBase = 0;

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
        const ringFeatures = buildWoundFeatures(ring, circuitBase, false);
        for (const f of ringFeatures) baseFeatures.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      } else if (el === "C") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, true);
        for (const f of ringFeatures) baseFeatures.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      }
    }

    const nCircuits = circuitBase;

    // Build per-slice sections
    // For each slice k, copy the base features but apply fluxSource sign flips to M rings
    const slices = [];
    for (let k = 0; k < N; k++) {
      // Build a set of (featureIndex → magnet index) for flux-source-referenced magnet features
      // We need to know which features in baseFeatures came from M rings referenced by fluxSources.
      // We rebuild the feature list per slice to apply per-slice sign flips.
      const sliceFeatures = buildSliceFeatures(rings, fluxSources, k);

      slices.push({
        section: {
          grid: config.grid,
          gapBand: config.gapBand,
          features: sliceFeatures,
        },
        offset: offsets[k],
      });
    }

    const mech = config.mechanical;

    return {
      grid: config.grid,
      gapBand: config.gapBand,
      poles: config.poles,
      mechanical: {
        J: mech.J,
        damping: mech.damping != null ? mech.damping : 0,
        loadTorque: mech.loadTorque != null ? mech.loadTorque : 0,
      },
      label: config.label != null ? config.label : "",
      nCircuits,
      circuits: config.circuits.slice(),
      slices,
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
        const ringFeatures = buildWoundFeatures(ring, circuitBase, false);
        for (const f of ringFeatures) features.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      } else if (el === "C") {
        const ringFeatures = buildWoundFeatures(ring, circuitBase, true);
        for (const f of ringFeatures) features.push(f);
        const routing = resolveWinding(ring);
        circuitBase += LIB.WindingModel.ampereConductors(routing).nCircuits;
      }
    }

    return features;
  }

  UM.ConfigSchema = { validate, expand };
})();
