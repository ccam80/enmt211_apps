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
  //    …
  //  }
  //
  //  opts are forwarded to LIB.MotorSlice.create for each slice.
  // ---------------------------------------------------------------------------
  function create(expanded, opts) {
    opts = opts || {};

    const nCircuits = expanded.nCircuits;
    const expandedSlices = expanded.slices;

    // Build one MotorSlice per slice entry. Always iterates — no fast path.
    const slices = expandedSlices.map(function (s) {
      const slice = LIB.MotorSlice.create(s.section, opts);
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
    //    → { reluctance, pm, mutual, total }
    //
    //  Co-energy decomposition. coeffs is extracted if not supplied.
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

      var total = reluctance + mutual + pm;
      return { reluctance: reluctance, pm: pm, mutual: mutual, total: total };
    }

    // -------------------------------------------------------------------------
    //  stack.sliceGrid(k) → { Nr, Ntheta, rInner, rOuter, r }
    //
    //  Returns slice k's compiled grid for the mount's gap-field viz.
    // -------------------------------------------------------------------------
    function sliceGrid(k) {
      var g = slices[k].slice.grid;
      return {
        Nr: g.Nr,
        Ntheta: g.Ntheta,
        rInner: g.rInner,
        rOuter: g.rOuter,
        r: g.r,
      };
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
      solve: solve,
      extractCoeffs: extractCoeffs,
      coenergyTorque: coenergyTorque,
      sliceGrid: sliceGrid,
      clearWarmStart: clearWarmStart,
    };
  }

  LIB.MotorStack = { create: create };
})();
