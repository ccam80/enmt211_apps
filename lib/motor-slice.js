"use strict";

// =============================================================================
//  LIB.MotorSlice — single-section field solver
//
//  Wraps one compiled section into a single-section solve:
//    solve(thetaR, currents) → { torque, fluxLinkages, field }
//    extractCoeffs(thetaR, opts) → { L, dLdth, lambdaPm, dLambdaPmdth }
//    clearWarmStart()
//
//  Field-solve tier is injected via opts.backend (SolveBackend interface).
//  The coarse PCG backend is the default (defined below).
//
//  No winding/element/machine knowledge. Reads only compiled arrays.
//  No DOM/canvas access at module load.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  // ---------------------------------------------------------------------------
  //  coarseBackend — default SolveBackend (PCG + global ceiling)
  //
  //  prepare(section) → { op, compiled }
  //    Builds the GridOperator at section.grid, compiles features,
  //    registers materials, rotor region, and gap band.
  //
  //  solveSaturated(op, b, opts) → { x, iters, residual, satScale }
  //    Delegates to LIB.AirgapSolve.solveSaturated.
  //
  //  linearSolve(op, b, opts) → { x, iters, residual }
  //    Delegates to LIB.AirgapSolve.pcg.
  // ---------------------------------------------------------------------------
  const coarseBackend = {
    prepare(section) {
      const op = LIB.AirgapGrid.create(section.grid);
      const compiled = LIB.MotorCompile.compile(section);
      op.setMaterials({ nu: compiled.nu });
      op.setRotorRegion({
        rotorMask: compiled.rotorMask,
        magnetization: compiled.magnetization,
      });
      // Register the conductor maps so rotor-member windings rotate with thetaR.
      op.setRotorCoilMasks(compiled.coilMasks);
      op.setGapBand(section.gapBand);
      return { op, compiled };
    },

    solveSaturated(op, b, opts) {
      return LIB.AirgapSolve.solveSaturated(op, b, opts);
    },

    linearSolve(op, b, opts) {
      return LIB.AirgapSolve.pcg(op, b, opts);
    },
  };

  // ---------------------------------------------------------------------------
  //  LIB.MotorSlice.create(section, opts) → slice
  //
  //  opts = {
  //    backend:  SolveBackend (default: coarseBackend),
  //    tol:      solver tolerance (default: 1e-6),
  //    ceiling:  { enabled, Bknee, p } (default: { enabled:true, Bknee:1.6, p:2 }),
  //  }
  // ---------------------------------------------------------------------------
  function create(section, opts) {
    opts = opts || {};

    const backend = opts.backend || coarseBackend;
    const { op, compiled } = backend.prepare(section);

    const ceiling = opts.ceiling !== undefined
      ? opts.ceiling
      : { enabled: true, Bknee: 1.6, p: 2 };

    const tol = opts.tol !== undefined ? opts.tol : 1e-6;

    // Cell count of the OPERATOR's grid (which may be refined relative to
    // section.grid when a refining backend is in use). compiled.nu is always
    // grid-sized, so it is the authoritative length for source assembly.
    const N = compiled.nu.length;

    // Assemble J_z = Σ_k currents[k]·masks[k] from an arbitrary mask set (the
    // rotor-rotated masks at the current thetaR), mirroring compiled.assembleJz
    // but consuming masks that move with the rotor.
    function assembleJzFrom(masks, currents) {
      const Jz = new Float64Array(N);
      for (let k = 0; k < masks.length; k++) {
        const ik = currents[k];
        if (ik === 0) continue;
        const mask = masks[k];
        for (let idx = 0; idx < N; idx++) {
          Jz[idx] += ik * mask[idx];
        }
      }
      return Jz;
    }

    // Warm-start cache for A_z from the previous solve.
    let _Az = null;

    // -------------------------------------------------------------------------
    //  solve(thetaR, currents) → { torque, fluxLinkages, field }
    // -------------------------------------------------------------------------
    function solve(thetaR, currents) {
      op.setRotorAngle(thetaR);

      // Use the rotor-rotated conductor maps so a wound rotor's current pattern
      // and flux linkage reflect the moved conductors at this thetaR.
      const masks = op.rotatedCoilMasks() || compiled.coilMasks;
      const Jz = assembleJzFrom(masks, currents);
      const b = op.assembleRHS({ Jz, magnetization: compiled.magnetization });

      const res = backend.solveSaturated(op, b, {
        x0: _Az,
        tol: tol,
        ceiling: Object.assign({}, ceiling, { ironMask: compiled.ironMask }),
      });

      _Az = res.x;

      const { Br, Bt } = op.field(res.x);
      const fluxLinkages = op.fluxLinkage(res.x, masks);
      const torque = LIB.AirgapTorque.arkkio(op, res.x);

      return {
        torque,
        fluxLinkages,
        field: {
          Az: res.x,
          Br,
          Bt,
          satScale: res.satScale,
        },
      };
    }

    // -------------------------------------------------------------------------
    //  extractCoeffs(thetaR, opts2) → { L, dLdth, lambdaPm, dLambdaPmdth }
    // -------------------------------------------------------------------------
    function extractCoeffs(thetaR, opts2) {
      return LIB.MotorCircuit.extract(
        op,
        backend.linearSolve.bind(backend),
        {
          jzBasis: compiled.coilMasks,
          coilMasks: compiled.coilMasks,
          magnetization: compiled.magnetization,
        },
        thetaR,
        opts2 || {}
      );
    }

    // -------------------------------------------------------------------------
    //  coggingTorque(thetaR) → number
    //
    //  Zero-current PM detent torque: the Maxwell-stress (Arkkio) torque of the
    //  magnetization-only field with every winding current set to zero. This is
    //  ∂W'_pm/∂θ — the rotor-position gradient of the magnet co-energy — and is
    //  the part of the total torque the current-dependent co-energy decomposition
    //  (½iᵀ(dL/dθ)i + iᵀ(dλpm/dθ)) structurally omits.
    //
    //  Computed on the LINEAR material via backend.linearSolve (no saturation
    //  ceiling), matching the linear co-energy decomposition, and with a fresh
    //  x0 so the magnet-only field is independent of any warm-start cache. When
    //  the section has no magnetization the detent torque is zero (zero-not-skip).
    // -------------------------------------------------------------------------
    function coggingTorque(thetaR) {
      if (compiled.magnetization === null) return 0;
      op.setRotorAngle(thetaR);
      const b = op.assembleRHS({ Jz: null, magnetization: compiled.magnetization });
      const res = backend.linearSolve(op, b, { x0: null, tol: tol });
      return LIB.AirgapTorque.arkkio(op, res.x);
    }

    // -------------------------------------------------------------------------
    //  clearWarmStart() — resets the A_z warm-start cache
    // -------------------------------------------------------------------------
    function clearWarmStart() {
      _Az = null;
    }

    return {
      nCircuits: compiled.nCircuits,
      grid: compiled.grid,
      solve,
      extractCoeffs,
      coggingTorque,
      clearWarmStart,
    };
  }

  LIB.MotorSlice = { create };
})();
