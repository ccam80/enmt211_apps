(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // ===========================================================================
  //  LIB.HarmonicSet — geometry-driven harmonic basis for the air-gap operator.
  //
  //  The §9 harmonic gap (airgap-harmonic.js) couples rotor↔stator through a
  //  truncated Fourier basis. The legacy truncation K = 3·max(slots,poles) is a
  //  blind heuristic: the gap field is concentrated in a handful of orders
  //  (pole/MMF harmonics + slot bands), so the dense basis carries ~10× more
  //  harmonics than the physics needs, and the bordered coupling — which scales
  //  O(|basis|²) — dominates assembly.
  //
  //  derive() builds the SMALLEST basis that still spans the gap field for any
  //  excitation the solver can be handed. The correctness argument is exact, not
  //  heuristic: in the linear magnetostatic regime the gap field for an arbitrary
  //  current vector is, by SUPERPOSITION, a linear combination of the per-circuit
  //  unit-excitation fields. So the union over circuits of "harmonics needed to
  //  reconstruct that circuit's gap field to tolerance ε" spans the entire linear
  //  excitable space. Magnets (fixed sources) and a saturated operating point
  //  (the nonlinear margin superposition cannot see) are added as extra probes.
  //
  //  Why reconstruction-to-ε and NOT an energy threshold: a harmonic can carry
  //  tiny field energy yet be REQUIRED for correctness (e.g. the triplen 3·p/2,
  //  which cancels under balanced excitation but is excited single-phase; or slot
  //  harmonics that carry the cogging). A ">x% energy" cut silently drops these.
  //  Keeping orders until the DROPPED energy per probe falls below ε² keeps every
  //  order that matters at the ε field-accuracy level while still discarding the
  //  high-order content that decays across the gap (localized rotor-bar fields).
  // ===========================================================================

  // derive(probe, opts) → {
  //   kList:       sorted positive integer harmonic orders (the basis),
  //   needed:      orders from the field-reconstruction pass (pre slot-band),
  //   perBody:     2·kList.length + 1,
  //   perBodyFull: 2·Kmax + 1,
  //   coverage:    worst-case captured-energy fraction across all probes,
  // }
  //
  // probe = {
  //   nCircuits:   number of circuit current DOFs,
  //   Kmax:        full harmonic order to probe up to (the reference truncation),
  //   slotCounts:  [Q_s, Q_r, …] stator/rotor slot & bar counts (slot-band seeds),
  //   gapSpectra(currents, theta) → [{a,b}, …]   one {a,b} per gap circle
  //       (rotor + stator); a[k]/b[k] are the value-indexed cos/sin amplitudes
  //       of the gap field at order k (0..Kmax). The basis must span BOTH circles.
  //   saturatedCurrents? Float64Array  — a representative loaded/saturated point.
  // }
  //
  // opts = {
  //   epsilon:      gap-field reconstruction tolerance (default 0.01 = 1%),
  //   angles:       rotor angles to probe (slot harmonics are θ-modulated),
  //   unitCurrent:  per-circuit probe magnitude (default 10),
  //   slotBandOrders: how many slot multiples to seed (default 2 → ±Q, ±2Q),
  // }
  function derive(probe, opts) {
    opts = opts || {};
    if (!probe || typeof probe.gapSpectra !== "function") {
      throw new Error("HarmonicSet.derive: probe.gapSpectra(currents, theta) is required");
    }
    const nCircuits = probe.nCircuits;
    const Kmax = probe.Kmax;
    const slotCounts = probe.slotCounts || [];
    if (!Number.isInteger(nCircuits) || nCircuits < 0) throw new Error("HarmonicSet.derive: probe.nCircuits invalid");
    if (!Number.isInteger(Kmax) || Kmax < 1) throw new Error("HarmonicSet.derive: probe.Kmax invalid");

    const eps = (opts.epsilon != null) ? opts.epsilon : 0.01;
    const dropFrac = eps * eps;                       // dropped-energy budget per probe
    const angles = opts.angles || [0, 0.041, 0.083];  // a few θ so slot bands appear
    const unitMag = (opts.unitCurrent != null) ? opts.unitCurrent : 10;
    const slotBandOrders = (opts.slotBandOrders != null) ? opts.slotBandOrders : 2;

    const need = new Set();
    // Track, per probe, the captured-energy fraction the FINAL kList achieves so
    // derive() can report worst-case coverage (a self-check, not the gate).
    const probeSpectra = [];

    function probeAt(currents, theta) {
      const circles = probe.gapSpectra(currents, theta);
      for (let ci = 0; ci < circles.length; ci++) {
        const s = circles[ci];
        const E = [];
        let tot = 0;
        for (let k = 1; k <= Kmax; k++) {
          const e = s.a[k] * s.a[k] + s.b[k] * s.b[k];
          if (e > 0) { E.push([k, e]); tot += e; }
        }
        if (tot <= 0) continue;
        // Keep the largest orders until the dropped energy falls below ε²·tot —
        // i.e. this circle's gap field is reconstructed to relative L2 error < ε.
        E.sort((x, y) => y[1] - x[1]);
        let kept = 0;
        for (let i = 0; i < E.length; i++) {
          need.add(E[i][0]);
          kept += E[i][1];
          if (tot - kept < dropFrac * tot) break;
        }
        probeSpectra.push({ E, tot });
      }
    }

    // (1) Magnet / baseline field — zero circuit current isolates fixed sources.
    const zero = new Float64Array(nCircuits);
    for (let t = 0; t < angles.length; t++) probeAt(zero, angles[t]);

    // (2) Per-circuit unit excitation — spans the linear excitable space exactly.
    for (let c = 0; c < nCircuits; c++) {
      const cur = new Float64Array(nCircuits);
      cur[c] = unitMag;
      for (let t = 0; t < angles.length; t++) probeAt(cur, angles[t]);
    }

    // (3) Saturated operating point — the nonlinear margin superposition misses.
    if (probe.saturatedCurrents) {
      for (let t = 0; t < angles.length; t++) probeAt(probe.saturatedCurrents, angles[t]);
    }

    // (4) Slot/permeance sidebands. The θ-swept probes above already surface the
    // dominant slot harmonics, but seed work ± n·Q explicitly so a coarse angle
    // set can never silently drop a cogging band.
    const kset = new Set(need);
    for (const k0 of need) {
      for (let qi = 0; qi < slotCounts.length; qi++) {
        const Q = slotCounts[qi];
        if (!(Q >= 1)) continue;
        for (let n = 1; n <= slotBandOrders; n++) {
          const kp = k0 + n * Q, km = k0 - n * Q;
          if (kp >= 1 && kp <= Kmax) kset.add(kp);
          if (km >= 1 && km <= Kmax) kset.add(km);
        }
      }
    }

    const kList = [...kset].sort((a, b) => a - b);

    // Self-check: worst-case captured-energy fraction the final kList achieves
    // across every probe (1 = perfect). Reported, not enforced — the binding gate
    // is the downstream torque/back-EMF/field test in harmonic-set.test.js.
    const inList = new Set(kList);
    let worst = 1;
    for (let p = 0; p < probeSpectra.length; p++) {
      const { E, tot } = probeSpectra[p];
      let cap = 0;
      for (let i = 0; i < E.length; i++) if (inList.has(E[i][0])) cap += E[i][1];
      const frac = tot > 0 ? cap / tot : 1;
      if (frac < worst) worst = frac;
    }

    return {
      kList,
      needed: [...need].sort((a, b) => a - b),
      perBody: 2 * kList.length + 1,
      perBodyFull: 2 * Kmax + 1,
      coverage: worst,
    };
  }

  // Convenience: build a `probe` from a built MotorStack (full-K) + slot counts.
  // The gap field on each circle is read from the solve result's harmonics.
  function probeFromStack(stack, slotCounts, opts) {
    opts = opts || {};
    const Kmax = stack.slices[0].__internals.K;
    return {
      nCircuits: stack.nCircuits,
      Kmax,
      slotCounts: slotCounts || [],
      saturatedCurrents: opts.saturatedCurrents || null,
      gapSpectra(currents, theta) {
        const r = stack.solve(theta, currents);
        const H = r.perSliceField[0].gap.harmonics;
        return [H.rotor, H.stator];
      },
    };
  }

  LIB.HarmonicSet = { derive, probeFromStack };
})();
