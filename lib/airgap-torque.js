"use strict";

// =============================================================================
//  LIB.AirgapTorque — Arkkio gap-band torque + co-energy decomposition
//
//  arkkio(op, Az, { gapBand }) → number
//    Radial-averaged Maxwell-stress torque over the air gap. The continuum
//    Arkkio integral is
//        T = (ell / (μ₀ · (rOuter_gap − rInner_gap))) · ∫∫_gap r² · Br · Bθ · dr · dθ,
//    where one r is the moment arm and one comes from the polar area element
//    dS = r·dr·dθ. Discretely the radial average is evaluated on the gap band's
//    INTERNAL radial faces (faces i+½ for i ∈ [iInner, iOuter−1)). On each such
//    face the azimuthal field Bθ = −∂A_z/∂r is the exact air-side face
//    difference (it never straddles a rotor/stator iron interface), and the
//    radial field Br = (1/r)·∂A_z/∂θ is the face-average of the two adjacent
//    cell-centred values from op.field. This is the contour form of the same
//    continuum integral; a cell-centred sum that reached into the bounding iron
//    rows would contaminate Bθ there. Result: every internal gap face yields the
//    same physical torque, so the radial average equals the true torque.
//
//  coenergy(op, solveFn, { thetaR, currents, coilMasks, magnetization,
//                          ironMask, dTheta }) → { reluctance, pm, mutual, total }
//    Co-energy decomposition via central-difference dL/dθ and dλ_pm/dθ.
//    All terms always computed (zero-not-skip for PM).
//
//  μ₀ = 4π × 1e-7
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const MU0 = 4 * Math.PI * 1e-7;

  // ---------------------------------------------------------------------------
  //  arkkio(op, Az, { gapBand=op.gapBand }) → number
  // ---------------------------------------------------------------------------
  function arkkio(op, Az, { gapBand = op.gapBand } = {}) {
    const { iInner, iOuter } = gapBand;
    const ell = op.ell;
    const r = op.r;
    const dr = op.dr;
    const dtheta = op.dtheta;
    const Ntheta = op.Ntheta;

    // Br (radial field, (1/r)∂A_z/∂θ) is periodic and clean at every cell.
    // Bθ (azimuthal field, −∂A_z/∂r) is taken as the air-side face difference
    // on the gap's internal radial faces, so it never reaches into iron.
    const { Br } = op.field(Az);

    // Radial extent spanned by the internal faces (face-centre to face-centre):
    // faces sit at r[i]+dr/2 for i ∈ [iInner, iOuter−1). The radial average is
    // over that span, so each face's contour torque T(r_face) is weighted by dr.
    const nFaces = iOuter - 1 - iInner;
    const span = nFaces * dr;

    let sum = 0;
    for (let i = iInner; i < iOuter - 1; i++) {
      const rFace = 0.5 * (r[i] + r[i + 1]);
      const rFace2 = rFace * rFace;
      const baseLo = i * Ntheta;
      const baseHi = (i + 1) * Ntheta;
      for (let j = 0; j < Ntheta; j++) {
        // Azimuthal field at the face (exact air-side radial difference).
        const Bt = -(Az[baseHi + j] - Az[baseLo + j]) / dr;
        // Radial field at the face: average of the two adjacent cell-centres.
        const Brf = 0.5 * (Br[baseLo + j] + Br[baseHi + j]);
        sum += rFace2 * Brf * Bt * dr * dtheta;
      }
    }

    return (ell / (MU0 * span)) * sum;
  }

  // ---------------------------------------------------------------------------
  //  coenergy(op, solveFn, { thetaR, currents, coilMasks, magnetization,
  //                          ironMask=null, dTheta=op.dtheta })
  //  → { reluctance, pm, mutual, total }
  // ---------------------------------------------------------------------------
  function coenergy(op, solveFn, {
    thetaR,
    currents,
    coilMasks,
    magnetization = null,
    ironMask = null,
    dTheta = op.dtheta,
  }) {
    const nCircuits = coilMasks.length;
    const N = op.Nr * op.Ntheta;

    // Build dL_kl/dθ matrix via unit-current solves at thetaR ± dTheta.
    // dL_kl/dθ ≈ (L_kl(θ+) − L_kl(θ−)) / (2·dTheta)
    //
    // For each circuit l: solve field with Jz = coilMasks[l] (unit current)
    // at θ+ and θ−, then for each k: L_kl(θ±) = fluxLinkage(Az±, coilMasks[k])
    //
    // dL[k][l] = (L_kl_plus - L_kl_minus) / (2*dTheta)

    // L_kl matrices at θ+ and θ−
    const L_plus  = [];
    const L_minus = [];
    for (let k = 0; k < nCircuits; k++) {
      L_plus.push(new Float64Array(nCircuits));
      L_minus.push(new Float64Array(nCircuits));
    }

    for (let l = 0; l < nCircuits; l++) {
      // Unit-current source: Jz = coilMasks[l]
      const Jz_l = coilMasks[l];

      // Solve at θ+
      op.setRotorAngle(thetaR + dTheta);
      const b_plus = op.assembleRHS({ Jz: Jz_l, magnetization: null });
      const { x: Az_plus } = solveFn(op, b_plus, { x0: null });

      // Solve at θ−
      op.setRotorAngle(thetaR - dTheta);
      const b_minus = op.assembleRHS({ Jz: Jz_l, magnetization: null });
      const { x: Az_minus } = solveFn(op, b_minus, { x0: null });

      // Flux linkage for each circuit k
      const lam_plus  = op.fluxLinkage(Az_plus,  coilMasks);
      const lam_minus = op.fluxLinkage(Az_minus, coilMasks);

      for (let k = 0; k < nCircuits; k++) {
        L_plus[k][l]  = lam_plus[k];
        L_minus[k][l] = lam_minus[k];
      }
    }

    // dL[k][l]/dθ ≈ (L_plus[k][l] - L_minus[k][l]) / (2*dTheta)
    const dLdtheta = [];
    for (let k = 0; k < nCircuits; k++) {
      dLdtheta.push(new Float64Array(nCircuits));
      for (let l = 0; l < nCircuits; l++) {
        dLdtheta[k][l] = (L_plus[k][l] - L_minus[k][l]) / (2 * dTheta);
      }
    }

    // PM flux linkage gradient dλ_pm,k/dθ via magnetization-only solve (Jz=0)
    // Zero-not-skip: if no magnetization, dλ_pm,k/dθ = 0 naturally.
    const dlam_pm = new Float64Array(nCircuits);

    if (magnetization !== null) {
      op.setRotorAngle(thetaR + dTheta);
      const b_pm_plus = op.assembleRHS({ Jz: null, magnetization });
      const { x: Az_pm_plus } = solveFn(op, b_pm_plus, { x0: null });

      op.setRotorAngle(thetaR - dTheta);
      const b_pm_minus = op.assembleRHS({ Jz: null, magnetization });
      const { x: Az_pm_minus } = solveFn(op, b_pm_minus, { x0: null });

      const lam_pm_plus  = op.fluxLinkage(Az_pm_plus,  coilMasks);
      const lam_pm_minus = op.fluxLinkage(Az_pm_minus, coilMasks);

      for (let k = 0; k < nCircuits; k++) {
        dlam_pm[k] = (lam_pm_plus[k] - lam_pm_minus[k]) / (2 * dTheta);
      }
    }

    // Restore rotor angle
    op.setRotorAngle(thetaR);

    // Compose torque components
    // reluctance = ½ Σ_k currents[k]² · dL_kk/dθ
    let reluctance = 0;
    for (let k = 0; k < nCircuits; k++) {
      reluctance += 0.5 * currents[k] * currents[k] * dLdtheta[k][k];
    }

    // mutual = ½ Σ_{k≠l} currents[k]·currents[l] · dL_kl/dθ
    let mutual = 0;
    for (let k = 0; k < nCircuits; k++) {
      for (let l = 0; l < nCircuits; l++) {
        if (k !== l) {
          mutual += 0.5 * currents[k] * currents[l] * dLdtheta[k][l];
        }
      }
    }

    // pm = Σ_k currents[k] · dλ_pm,k/dθ
    let pm = 0;
    for (let k = 0; k < nCircuits; k++) {
      pm += currents[k] * dlam_pm[k];
    }

    const total = reluctance + mutual + pm;

    return { reluctance, pm, mutual, total };
  }

  LIB.AirgapTorque = { arkkio, coenergy, MU0 };
})();
