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

    // Warm-start cache for A_z from the previous solve.
    let _Az = null;

    // -------------------------------------------------------------------------
    //  solve(thetaR, currents) → { torque, fluxLinkages, field }
    // -------------------------------------------------------------------------
    function solve(thetaR, currents) {
      op.setRotorAngle(thetaR);

      const Jz = compiled.assembleJz(currents);
      const b = op.assembleRHS({ Jz, magnetization: compiled.magnetization });

      const res = backend.solveSaturated(op, b, {
        x0: _Az,
        tol: tol,
        ceiling: Object.assign({}, ceiling, { ironMask: compiled.ironMask }),
      });

      _Az = res.x;

      const { Br, Bt } = op.field(res.x);
      const fluxLinkages = op.fluxLinkage(res.x, compiled.coilMasks);
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
      clearWarmStart,
    };
  }

  LIB.MotorSlice = { create };
})();
