(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // ============================================================================
  //  LIB.WindingModel — pure routing algebra, no field outputs.
  //
  //  Resolves series/parallel conductor routing into independent current paths
  //  (circuits), produces a per-slot signed ampere-conductor matrix, and expands
  //  that into the conductor-feature list that motor-compile rasterizes.
  //
  //  Exports exactly: validate, ampereConductors, conductorFeatures, standardWinding
  // ============================================================================

  // ---------------------------------------------------------------------------
  //  validate(routing) → { ok:boolean, errors:string[] }
  //
  //  Checks routing invariants without throwing. Returns ok:false and one
  //  human-readable string per violation if any rule is broken.
  // ---------------------------------------------------------------------------
  function validate(routing) {
    const errors = [];

    if (!routing || typeof routing !== "object") {
      errors.push("routing must be a non-null object");
      return { ok: false, errors };
    }

    const { nSlots, slotTheta, phases } = routing;

    if (!Number.isInteger(nSlots) || nSlots < 1) {
      errors.push(`nSlots must be an integer >= 1; got ${nSlots}`);
    }

    if (!Array.isArray(slotTheta)) {
      errors.push("slotTheta must be an array");
    } else if (Number.isInteger(nSlots) && nSlots >= 1 && slotTheta.length !== nSlots) {
      errors.push(
        `slotTheta.length (${slotTheta.length}) must equal nSlots (${nSlots})`
      );
    }

    if (!Array.isArray(phases) || phases.length === 0) {
      errors.push("phases must be a non-empty array");
    } else {
      for (let pi = 0; pi < phases.length; pi++) {
        const phase = phases[pi];
        if (!phase || !Array.isArray(phase.branches) || phase.branches.length === 0) {
          errors.push(`phase[${pi}] must have at least one branch`);
          continue;
        }
        for (let bi = 0; bi < phase.branches.length; bi++) {
          const branch = phase.branches[bi];
          if (!branch || !Array.isArray(branch.coils) || branch.coils.length === 0) {
            errors.push(`phase[${pi}].branches[${bi}] must have at least one coil`);
            continue;
          }
          for (let ci = 0; ci < branch.coils.length; ci++) {
            const coil = branch.coils[ci];
            const validNSlots = Number.isInteger(nSlots) && nSlots >= 1;

            if (!Number.isInteger(coil.slotGo) || coil.slotGo < 0 || (validNSlots && coil.slotGo >= nSlots)) {
              errors.push(
                `phase[${pi}].branches[${bi}].coils[${ci}].slotGo (${coil.slotGo}) out of range [0, ${nSlots})`
              );
            }
            if (!Number.isInteger(coil.slotReturn) || coil.slotReturn < 0 || (validNSlots && coil.slotReturn >= nSlots)) {
              errors.push(
                `phase[${pi}].branches[${bi}].coils[${ci}].slotReturn (${coil.slotReturn}) out of range [0, ${nSlots})`
              );
            }
            if (
              Number.isInteger(coil.slotGo) && coil.slotGo >= 0 &&
              Number.isInteger(coil.slotReturn) && coil.slotReturn >= 0 &&
              coil.slotGo === coil.slotReturn
            ) {
              errors.push(
                `phase[${pi}].branches[${bi}].coils[${ci}]: slotGo === slotReturn (${coil.slotGo}); a coil must span two distinct slots`
              );
            }
            if (
              typeof coil.turns !== "number" ||
              !isFinite(coil.turns) ||
              coil.turns === 0
            ) {
              errors.push(
                `phase[${pi}].branches[${bi}].coils[${ci}].turns must be a finite non-zero number; got ${coil.turns}`
              );
            }
          }
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------------------
  //  ampereConductors(routing) → { nCircuits, nSlots, turns, circuitMeta }
  //
  //  Resolves circuits (one circuit per branch, phase-then-branch order).
  //  turns: Float64Array(nCircuits * nSlots), row-major c*nSlots + s.
  //  For each coil in circuit c: turns[c*nSlots + slotGo] += +coil.turns,
  //                              turns[c*nSlots + slotReturn] += -coil.turns.
  //  circuitMeta: array length nCircuits of { phaseId, branchIndex }.
  //  Assumes valid routing (call validate first).
  // ---------------------------------------------------------------------------
  function ampereConductors(routing) {
    const { nSlots, phases } = routing;

    const circuitMeta = [];
    for (let pi = 0; pi < phases.length; pi++) {
      const phase = phases[pi];
      for (let bi = 0; bi < phase.branches.length; bi++) {
        circuitMeta.push({ phaseId: phase.id, branchIndex: bi });
      }
    }

    const nCircuits = circuitMeta.length;
    const turns = new Float64Array(nCircuits * nSlots);

    let circuitIndex = 0;
    for (let pi = 0; pi < phases.length; pi++) {
      const phase = phases[pi];
      for (let bi = 0; bi < phase.branches.length; bi++) {
        const branch = phase.branches[bi];
        for (const coil of branch.coils) {
          turns[circuitIndex * nSlots + coil.slotGo] += coil.turns;
          turns[circuitIndex * nSlots + coil.slotReturn] -= coil.turns;
        }
        circuitIndex++;
      }
    }

    return { nCircuits, nSlots, turns, circuitMeta };
  }

  // ---------------------------------------------------------------------------
  //  conductorFeatures(routing, slotGeom) → feature[]
  //
  //  slotGeom = { rRange:[r0,r1], member, angularWidth } (uniform across slots).
  //  For each circuit c and slot s with non-zero accumulated turns T, emits:
  //  { kind:"conductor", member, rRange, thetaRange:[slotTheta[s]-w/2, slotTheta[s]+w/2],
  //    circuit:c, turns:T }.
  //  Slots with zero net turns emit nothing.
  // ---------------------------------------------------------------------------
  function conductorFeatures(routing, slotGeom) {
    const { slotTheta } = routing;
    const { rRange, member, angularWidth } = slotGeom;
    const { nCircuits, nSlots, turns } = ampereConductors(routing);

    const features = [];
    const halfW = angularWidth / 2;

    for (let c = 0; c < nCircuits; c++) {
      for (let s = 0; s < nSlots; s++) {
        const T = turns[c * nSlots + s];
        if (T === 0) continue;
        const theta = slotTheta[s];
        features.push({
          kind: "conductor",
          member,
          rRange,
          thetaRange: [theta - halfW, theta + halfW],
          circuit: c,
          turns: T,
        });
      }
    }

    return features;
  }

  // ---------------------------------------------------------------------------
  //  standardWinding({ m, p, Q, coilPitch, turns, member, rRange, slotTheta })
  //  → routing
  //
  //  Generates a canonical double-layer lap winding using the 60°-phase-belt rule.
  //
  //  Phase-belt rule (general m):
  //    slot electrical angle: alpha(s) = (p/2) * s * (2*pi/Q)
  //    belt index: b = floor(alpha(s) / (pi/m)) mod (2*m)
  //    polarity: b even → +, b odd → −
  //    phase index into label sequence: floor(b/2) mod m
  //    label sequence for m phases: [0, m-1, 1, m-2, 2, ...] (interleaved)
  //
  //  For m=3 the sequence is [A(0), C(2), B(1)] → label indices [0,2,1].
  //  Each phase is one branch (series). Parallel branches are not generated here.
  // ---------------------------------------------------------------------------
  function standardWinding({ m, p, Q, coilPitch, turns, member, rRange, slotTheta }) {
    if (!Number.isInteger(Q) || !Number.isInteger(m) || !Number.isInteger(p)) {
      throw new Error(
        `standardWinding: m, p, Q must be integers; got m=${m}, p=${p}, Q=${Q}`
      );
    }
    if (Q % (m * p) !== 0) {
      throw new Error(
        `standardWinding: Q (${Q}) must be divisible by m*p (${m * p})`
      );
    }
    if (coilPitch < 1 || coilPitch > Q / p) {
      throw new Error(
        `standardWinding: coilPitch (${coilPitch}) must be in [1, Q/p=${Q / p}]`
      );
    }

    // Build the label sequence: interleaved [0, m-1, 1, m-2, 2, ...]
    const labelSeq = [];
    let lo = 0, hi = m - 1;
    while (labelSeq.length < m) {
      if (lo <= hi) { labelSeq.push(lo); lo++; }
      if (lo <= hi && labelSeq.length < m) { labelSeq.push(hi); hi--; }
    }

    // Default uniform slot angles
    if (!slotTheta) {
      slotTheta = [];
      for (let s = 0; s < Q; s++) {
        slotTheta.push(s * 2 * Math.PI / Q);
      }
    }

    // Build one branch (series) per phase
    const phaseBranches = [];
    for (let ph = 0; ph < m; ph++) {
      phaseBranches.push([]);
    }

    const TWO_PI = 2 * Math.PI;
    const beltWidth = Math.PI / m;

    for (let s = 0; s < Q; s++) {
      const alpha = (p / 2) * s * (TWO_PI / Q);
      const b = Math.floor(alpha / beltWidth) % (2 * m);
      const polarity = (b % 2 === 0) ? 1 : -1;
      const phaseIdx = labelSeq[Math.floor(b / 2) % m];

      const slotReturn = (s + coilPitch) % Q;
      phaseBranches[phaseIdx].push({
        slotGo: s,
        slotReturn,
        turns: turns * polarity,
      });
    }

    // Produce the canonical phase label strings
    const phaseLabels = [];
    for (let ph = 0; ph < m; ph++) {
      phaseLabels.push(String.fromCharCode(65 + ph)); // A, B, C, ...
    }

    const phases = [];
    for (let ph = 0; ph < m; ph++) {
      phases.push({
        id: phaseLabels[ph],
        branches: [{ coils: phaseBranches[ph] }],
      });
    }

    return {
      nSlots: Q,
      slotTheta,
      phases,
    };
  }

  LIB.WindingModel = {
    validate,
    ampereConductors,
    conductorFeatures,
    standardWinding,
  };
})();
