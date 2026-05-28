"use strict";

// =============================================================================
//  LIB.MotorStack — universal N≥1 spatial aggregator
//
//  Builds one LIB.MotorSlice per expanded slice and always loops over all
//  slices (no single-slice bypass — invariant #5). Applies each slice's
//  rotor-angle offset, sums per-circuit flux linkages, sums torque, and
//  aggregates the L(θ) coefficients.
//
//  Reads no element letter or machine identity.
//  No DOM/canvas access at module load.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  // ---------------------------------------------------------------------------
  //  LIB.MotorStack.create(expanded, opts = {}) → stack
  //
  //  expanded = {
  //    slices:     [ { section, offset }, … ],   // length N≥1
  //    nCircuits:  number,                       // global circuit count
  //    poles:      number,                       // forwarded to each slice (D8)
  //    …
  //  }
  //
  //  opts are forwarded to LIB.MotorSlice.create for each slice. The stack
  //  additionally injects opts.poles = expanded.poles per Phase 5 D8 so the
  //  slice's K = AirgapHarmonic.defaultK(slots, poles) derivation gets the
  //  caller-provided pole count.
  // ---------------------------------------------------------------------------
  function create(expanded, opts) {
    opts = opts || {};

    const nCircuits = expanded.nCircuits;
    const expandedSlices = expanded.slices;

    // Build one MotorSlice per slice entry. Always iterates — no fast path.
    const slices = expandedSlices.map(function (s) {
      const slice = LIB.MotorSlice.create(s.section, Object.assign({}, opts, { poles: expanded.poles }));
      if (slice.nCircuits !== nCircuits) {
        throw new Error(
          "MotorStack: slice has nCircuits=" + slice.nCircuits +
          " but global nCircuits=" + nCircuits +
          ". config-schema global-index guarantee violated."
        );
      }
      return { slice: slice, offset: s.offset };
    });

    const nSlices = slices.length;

    // -------------------------------------------------------------------------
    //  stack.solve(thetaR, currents) → { torque, fluxLinkages, perSliceField }
    //
    //  Unconditional loop — no if (nSlices === 1) fast path.
    // -------------------------------------------------------------------------
    function solve(thetaR, currents) {
      var torque = 0;
      var fluxLinkages = new Float64Array(nCircuits);
      var perSliceField = [];

      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        var r = entry.slice.solve(thetaR + entry.offset, currents);
        torque += r.torque;
        for (var k = 0; k < nCircuits; k++) {
          fluxLinkages[k] += r.fluxLinkages[k];
        }
        perSliceField.push(r.field);
      }

      return { torque: torque, fluxLinkages: fluxLinkages, perSliceField: perSliceField };
    }

    // -------------------------------------------------------------------------
    //  stack.extractCoeffs(thetaR) → { L, dLdth, lambdaPm, dLambdaPmdth }
    //
    //  Zero-initializes the aggregate arrays, then adds each slice's
    //  contribution entrywise (shared-circuit inductances sum across slices).
    // -------------------------------------------------------------------------
    function extractCoeffs(thetaR) {
      var m = nCircuits;
      var L = new Float64Array(m * m);
      var dLdth = new Float64Array(m * m);
      var lambdaPm = new Float64Array(m);
      var dLambdaPmdth = new Float64Array(m);

      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        var c = entry.slice.extractCoeffs(thetaR + entry.offset);
        for (var idx = 0; idx < m * m; idx++) {
          L[idx] += c.L[idx];
          dLdth[idx] += c.dLdth[idx];
        }
        for (var k = 0; k < m; k++) {
          lambdaPm[k] += c.lambdaPm[k];
          dLambdaPmdth[k] += c.dLambdaPmdth[k];
        }
      }

      return { L: L, dLdth: dLdth, lambdaPm: lambdaPm, dLambdaPmdth: dLambdaPmdth };
    }

    // -------------------------------------------------------------------------
    //  stack.coenergyTorque(thetaR, currents, coeffs = null)
    //    → { reluctance, pm, mutual, cogging, total }
    //
    //  Complete co-energy torque decomposition:
    //    reluctance = ½ Σ_k i_k² · dL_kk/dθ        (self-inductance saliency)
    //    mutual     = ½ Σ_{k≠l} i_k·i_l · dL_kl/dθ (mutual saliency)
    //    pm         = Σ_k i_k · dλ_pm,k/dθ         (PM alignment torque)
    //    cogging    = ∂W'_pm/∂θ                    (zero-current PM detent torque)
    //    total      = reluctance + mutual + pm + cogging
    //
    //  The cogging term is the magnet-only Maxwell-stress torque (each slice's
    //  coggingTorque at its rotor offset), the part Arkkio includes but the
    //  current-dependent co-energy terms structurally omit — so total is the
    //  COMPLETE torque matching the Maxwell-stress (Arkkio) result for salient-PM
    //  machines at every rotor angle.
    //
    //  coeffs (the current-dependent dL/dθ and dλ_pm/dθ) is extracted if not
    //  supplied.
    // -------------------------------------------------------------------------
    function coenergyTorque(thetaR, currents, coeffs) {
      if (coeffs == null) {
        coeffs = extractCoeffs(thetaR);
      }
      var m = nCircuits;
      var dL = coeffs.dLdth;
      var dLpm = coeffs.dLambdaPmdth;

      var reluctance = 0;
      var mutual = 0;
      var pm = 0;

      for (var k = 0; k < m; k++) {
        // Self-inductance (diagonal) contribution
        reluctance += 0.5 * currents[k] * currents[k] * dL[k * m + k];
        // PM torque
        pm += currents[k] * dLpm[k];
        // Mutual (off-diagonal) contributions
        for (var l = 0; l < m; l++) {
          if (l !== k) {
            mutual += 0.5 * currents[k] * currents[l] * dL[k * m + l];
          }
        }
      }

      // Zero-current PM detent (cogging) torque: sum each slice's magnet-only
      // Maxwell-stress torque at its rotor-angle offset.
      var cogging = 0;
      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        cogging += entry.slice.coggingTorque(thetaR + entry.offset);
      }

      var total = reluctance + mutual + pm + cogging;
      return {
        reluctance: reluctance,
        pm: pm,
        mutual: mutual,
        cogging: cogging,
        total: total,
      };
    }

    // -------------------------------------------------------------------------
    //  stack.sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }
    //
    //  Returns slice k's pair of Phase-2 body meshes. The FEA replacement for
    //  the deleted grid-shaped sliceGrid (Phase 5 D2).
    // -------------------------------------------------------------------------
    function sliceMesh(k) {
      var b = slices[k].slice.__internals.bodies;
      return { rotor: b.rotor, stator: b.stator };
    }

    // -------------------------------------------------------------------------
    //  stack.clearWarmStart() — clears warm-start cache on every slice
    // -------------------------------------------------------------------------
    function clearWarmStart() {
      for (var s = 0; s < nSlices; s++) {
        slices[s].slice.clearWarmStart();
      }
    }

    return {
      nCircuits: nCircuits,
      nSlices: nSlices,
      // The expanded config this stack was built from. Lets a consumer rebuild a
      // variant stack (e.g. saturation-disabled, for the linear Maxwell-vs-co-energy
      // cross-check) without re-threading the config through every call site.
      expanded: expanded,
      slices: slices.map(function (e) { return e.slice; }),
      solve: solve,
      extractCoeffs: extractCoeffs,
      coenergyTorque: coenergyTorque,
      sliceMesh: sliceMesh,
      clearWarmStart: clearWarmStart,
    };
  }

  LIB.MotorStack = { create: create };
})();
