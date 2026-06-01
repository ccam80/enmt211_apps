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
  //  Exports exactly: validate, ampereConductors, conductorFeatures,
  //                   standardWinding, cageRouting
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
            // slotReturn === null is an END-RING return: the conductor closes
            // through the end ring (a circuit-level loop), occupying NO second
            // slot. This is the cage bar — exactly one conductor per
            // slot. Any non-null slotReturn must be a valid distinct slot.
            const endRingReturn = (coil.slotReturn == null);
            if (!endRingReturn) {
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
  //  A coil whose slotReturn is null (END-RING return) contributes ONLY its
  //  +turns at slotGo: the return current closes through the end-ring conductor
  //  (a separate circuit-level loop), not through another stator/rotor slot.
  //  This is the cage bar — exactly one conductor per slot.
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
          if (coil.slotReturn != null) {
            turns[circuitIndex * nSlots + coil.slotReturn] -= coil.turns;
          }
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
    const r0 = rRange[0], r1 = rRange[1];

    // Iterate per SLOT. A double-layer winding has two coil sides (two circuits)
    // in one slot; emitting both at the full slot rRange would overlap, and a mesh
    // element can carry only one srcId — so the circuit listed second is silently
    // dropped (its elements get the other circuit's id), making nCircuits read low
    // and tripping the global-index guarantee. Instead, stack the circuits present
    // in a slot as RADIAL layers (top/bottom), so each conductor owns its own
    // elements. A single-occupant slot keeps the full rRange (unchanged behaviour).
    for (let s = 0; s < nSlots; s++) {
      const present = [];
      for (let c = 0; c < nCircuits; c++) {
        if (turns[c * nSlots + s] !== 0) present.push(c);
      }
      if (present.length === 0) continue;
      const theta = slotTheta[s];
      const dr = (r1 - r0) / present.length;
      for (let k = 0; k < present.length; k++) {
        const c = present[k];
        features.push({
          kind: "conductor",
          member,
          rRange: present.length === 1 ? rRange : [r0 + k * dr, r0 + (k + 1) * dr],
          thetaRange: [theta - halfW, theta + halfW],
          circuit: c,
          turns: turns[c * nSlots + s],
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
  //  p is the pole-count (number of poles, always an even positive integer).
  //  The formula alpha(s) = (p/2) * s * (2*pi/Q) uses pole-count, not pole-pairs.
  //
  //  Phase-belt rule (general m):
  //    slot electrical angle: alpha(s) = (p/2) * s * (2*pi/Q)
  //    belt index: b = floor(alpha(s) / (pi/m)) mod (2*m)
  //    polarity: b even → +, b odd → −
  //    phase index = reorderedLabels[b mod m], where reorderedLabels = [0, m-1, 1, m-2, ...]
  //
  //  For m=3 the sequence is [0, 2, 1] = [A, C, B], yielding the canonical map
  //  b: 0→A+, 1→C−, 2→B+, 3→A−, 4→C+, 5→B−.
  //  Each phase is one branch (series). Parallel branches are not generated here.
  //
  //  When Q % (m*p) !== 0, q = Q/(m*p) is non-integer (fractional-slot winding).
  //  standardWinding still produces a determinate winding by assigning each slot
  //  via the belt-index rule — the result is an asymmetric distributed winding
  //  where phase groups are unequal in size.
  // ---------------------------------------------------------------------------
  function standardWinding({ m, p, Q, coilPitch, turns, member, rRange, slotTheta }) {
    if (!Number.isInteger(Q) || !Number.isInteger(m) || !Number.isInteger(p)) {
      throw new Error(
        `standardWinding: m, p, Q must be integers; got m=${m}, p=${p}, Q=${Q}`
      );
    }
    if (p % 2 !== 0 || p < 2) {
      throw new Error(
        `standardWinding: p must be an even integer >= 2 (pole-count); got p=${p}`
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
      // Phase-belt polarity + phase assignment.
      //  ODD m: the canonical interleaved-labelSeq + alternating-(b%2) rule yields
      //    a correct winding (a phase lands at belts b and b+m, which have OPPOSITE
      //    parity -> opposite polarity -> a proper north/south pole pair).
      //  EVEN m: that rule degenerates — belts b and b+m have the SAME parity ->
      //    same polarity -> the winding collapses to spatial order = m (its order-1
      //    fundamental vanishes) and adjacent phases share an axis (no rotating
      //    field). The general-correct layout is "first m belts +, next m belts -,
      //    phase = b mod m" (each phase occupies one belt under each pole, phases in
      //    quadrature). Applied ONLY for even m so the validated odd-m windings
      //    (m=1, m=3) remain byte-identical. (Fix 2026-05-25: the m=2 split-phase
      //    stator of induction-1ph produced a pure order-2 MMF and could not couple
      //    to the cage nor form a cap-start rotating field; see spec/progress.md.)
      let polarity, phaseIdx;
      if (m % 2 === 1) {
        polarity = (b % 2 === 0) ? 1 : -1;
        phaseIdx = labelSeq[b % m];
      } else {
        polarity = (Math.floor(b / m) % 2 === 0) ? 1 : -1;
        phaseIdx = b % m;
      }

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

  // ---------------------------------------------------------------------------
  //  cageRouting({ bars, member, rRange, slotTheta }) → routing
  //
  //  Generates a proper END-RING-COUPLED cage routing: N bar circuits,
  //  EXACTLY ONE BAR PER SLOT.
  //
  //  Formulation. A real cage is N axial rotor bars joined at both ends
  //  by two conducting END RINGS. The physical state variables are the N bar
  //  currents i_bar,k. The end rings:
  //    (a) impose the cage's only conservation law — KCL at the ring node forces
  //        Σ_k i_bar,k = 0 (no net axial current; the cage's zero-sequence /
  //        common-mode is SHORTED out by the rings, it cannot circulate);
  //    (b) add a per-segment series resistance R_e and leakage L_e between each
  //        pair of adjacent bars — a CIRCULANT coupling around the ring.
  //  The bar↔bar and bar↔stator magnetic coupling comes from the FEA mutual
  //  matrix. With one bar per slot, M[stator, bar_k] is the DIRECT flux linking
  //  bar k (a clean cos(pθ/2) traveling-wave pickup), NOT the difference of two
  //  nearly-equal adjacent-bar fluxes — so dM/dθ is a coherent traveling wave
  //  and the induced bar currents form the slip-frequency rotor wave that makes
  //  torque.
  //
  //  WHY the previous adjacent-bar-ISOLATED model was non-physical. It modelled
  //  the cage as N loops, loop k = {slot k:+1, slot (k+1)%N:−1}. Rasterizing that
  //  put TWO conductors (loop k's go and loop k−1's return) into EACH slot; the
  //  mesh assigns one srcId per element, so one of the two was overwritten — the
  //  seam bars went dead (L[0,0]≈2e-8, L[N−1,N−1]=0). Worse, each loop's mutual
  //  to the stator was A(θ_k)−A(θ_{k+1}) over a ~13° span: a tiny difference of
  //  two ~5e-5 numbers swamped by a position-independent common-mode, so its
  //  θ-derivative was broadband rasterization noise (≈9% order-2 energy) instead
  //  of a cos(2θ) wave — no coherent dL/dθ, hence wrong-sign ±1e-2 N·m torque at
  //  all slips. One-bar-per-slot removes the differencing AND the collision.
  //
  //  Topology emitted here: circuit k is the single bar in slot k —
  //  { slotGo: k, slotReturn: null }. slotReturn:null is the END-RING return
  //  (ampereConductors omits the −turns; the conductor occupies only slot k).
  //  No two circuits share a slot ⇒ all N bars are live, seam included. The
  //  end-ring R/L circulant and the Σi=0 closure live in the circuit assembly
  //  (config-schema endRing → motor-circuit), driven by the cage config only.
  //
  //  bars: number of rotor bars (positive integer).
  //  member: "rotor" (default if omitted).
  //  rRange: [r0, r1] radial extent of the bar region (optional, unused by routing
  //          itself but passed through for downstream feature builders).
  //  slotTheta: explicit slot angles (optional; defaults to uniform).
  //
  //  The resulting routing has:
  //    nSlots = bars
  //    phases.length = bars  (nCircuits = bars via ampereConductors)
  //    Each phase has one branch with one single-bar (end-ring-return) coil.
  //    No coilPitch, no phase grouping, no pole-pair structure.
  //    cageRing: { bars } marker so the circuit assembler can add the end ring.
  // ---------------------------------------------------------------------------
  function cageRouting({ bars, member, rRange, slotTheta }) {
    if (!Number.isInteger(bars) || bars < 1) {
      throw new Error(
        `cageRouting: bars must be a positive integer; got ${bars}`
      );
    }

    if (!slotTheta) {
      slotTheta = [];
      for (let b = 0; b < bars; b++) {
        slotTheta.push(b * 2 * Math.PI / bars);
      }
    }

    const phases = [];
    for (let b = 0; b < bars; b++) {
      phases.push({
        id: `bar${b}`,
        branches: [
          {
            // One bar in slot b; current returns through the end ring (no slot).
            coils: [
              { slotGo: b, slotReturn: null, turns: 1 },
            ],
          },
        ],
      });
    }

    return {
      nSlots: bars,
      slotTheta,
      phases,
      cageRing: { bars },
    };
  }

  LIB.WindingModel = {
    validate,
    ampereConductors,
    conductorFeatures,
    standardWinding,
    cageRouting,
  };
})();
