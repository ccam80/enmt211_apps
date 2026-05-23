"use strict";

// =============================================================================
//  LIB.AirgapGrid — structured polar thin-annulus FV operator
//
//  Solves  −∇·(ν∇A_z) = J_z  on an Nr×Ntheta polar grid.
//  Grid arrays: row-major Float64Array, idx = i*Ntheta + j
//    i = radial index 0..Nr-1 (inner → outer)
//    j = angular index 0..Ntheta-1 (periodic)
//  Gauge: one reference node pinned to A_z = 0 (index 0).
//
//  μ₀ = 4π × 1e-7  (declared once here)
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const MU0 = 4 * Math.PI * 1e-7;

  // Harmonic mean of two positive values (safe against zero).
  function harmonic(a, b) {
    const s = a + b;
    if (s === 0) return 0;
    return (2 * a * b) / s;
  }

  // ---------------------------------------------------------------------------
  //  create({ Nr, Ntheta, rInner, rOuter, ell }) → GridOperator
  // ---------------------------------------------------------------------------
  function create({ Nr = 12, Ntheta = 256, rInner, rOuter, ell = 1 }) {
    const N = Nr * Ntheta;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = (2 * Math.PI) / Ntheta;

    // Cell-centre radii: r[i] = rInner + (i + 0.5) * dr
    const r = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) r[i] = rInner + (i + 0.5) * dr;

    // Per-cell area: dA[i*Ntheta+j] = r[i] * dr * dtheta
    const dA = new Float64Array(N);
    for (let i = 0; i < Nr; i++) {
      const area = r[i] * dr * dtheta;
      for (let j = 0; j < Ntheta; j++) dA[i * Ntheta + j] = area;
    }

    // Pinned gauge node: index 0
    const pin = 0;

    // Stencil coefficient arrays (assembled by setMaterials / recomputeCoeffs)
    // aP[idx] = centre, aE = east (j+1), aW = west (j-1), aN = north (i+1), aS = south (i-1)
    let aP = new Float64Array(N);
    let aE = new Float64Array(N);
    let aW = new Float64Array(N);
    let aN = new Float64Array(N);
    let aS = new Float64Array(N);

    // Active per-cell reluctivity (updated by setMaterials, setRotorAngle, setIronScale, setIronReluctivity)
    let nu = new Float64Array(N);
    // Base reluctivity (set by setMaterials, rotor-shift template is separate)
    let nuBase = new Float64Array(N);

    // Rotor region state
    let rotorMask = null;         // Uint8Array, 1 = rotor cell
    let rotorNuTemplate = null;   // Float64Array, rotor cells' base nu at thetaR=0

    // Gap band
    let gapBand = { iInner: 0, iOuter: 0 };

    // ---- stencil assembly ----
    // Face-averaged reluctivities:
    //   East face (j+½):  harmonic(nu[i,j], nu[i,j+1])   × r[i]·dtheta / dr
    //   West face (j-½):  harmonic(nu[i,j], nu[i,j-1])   × r[i]·dtheta / dr
    //   North face (i+½): harmonic(nu[i,j], nu[i+1,j])   × r[i+½]·dr   / (r[i]·dtheta)
    //                     where r[i+½] = 0.5*(r[i]+r[i+1])
    //   South face (i-½): harmonic(nu[i,j], nu[i-1,j])   × r[i-½]·dr   / (r[i]·dtheta)
    //                     where r[i-½] = 0.5*(r[i]+r[i-1])
    //
    // The discrete operator (finite-volume) reads:
    //   (aP·A[idx] - aE·A[E] - aW·A[W] - aN·A[N] - aS·A[S]) = source
    // which implements −∇·(ν∇·) in the sense that matvec returns A_P coeff × x_P - off-diag × x_nbr.

    function computeAllCoeffs() {
      for (let i = 0; i < Nr; i++) {
        const ri = r[i];
        // Face-area geometric factors
        const angFaceLen = ri * dtheta; // angular-face arc length (for radial coupling)
        const radFaceLen = dr;           // radial-face length (for angular coupling)

        for (let j = 0; j < Ntheta; j++) {
          const idx = i * Ntheta + j;
          if (idx === pin) {
            aP[pin] = 1; aE[pin] = 0; aW[pin] = 0; aN[pin] = 0; aS[pin] = 0;
            continue;
          }

          const nuij = nu[idx];

          // East: j+1 (periodic)
          const jE = (j + 1) % Ntheta;
          const nuE = nu[i * Ntheta + jE];
          // coefficient = harmonic_nu_face * (r_i * dtheta) / dr
          // Flux through east face: ν_e * r_i * dtheta * (A[j+1]-A[j]) / dr → coeff = ν_e * r_i * dtheta / dr
          const cE = harmonic(nuij, nuE) * angFaceLen / dr;

          // West: j-1 (periodic)
          const jW = (j + Ntheta - 1) % Ntheta;
          const nuW = nu[i * Ntheta + jW];
          const cW = harmonic(nuij, nuW) * angFaceLen / dr;

          // North: i+1 (if exists)
          let cN = 0;
          if (i + 1 < Nr) {
            const nuN = nu[(i + 1) * Ntheta + j];
            const rN_face = 0.5 * (r[i] + r[i + 1]);
            // Flux through north face: ν_n * r_{i+½} * dr * (A[i+1]-A[i]) / (r_i * dtheta)
            // coeff = ν_n * r_{i+½} * dr / (r_i * dtheta)
            cN = harmonic(nuij, nuN) * rN_face * dr / (ri * dtheta);
          }

          // South: i-1 (if exists)
          let cS = 0;
          if (i > 0) {
            const nuS = nu[(i - 1) * Ntheta + j];
            const rS_face = 0.5 * (r[i] + r[i - 1]);
            cS = harmonic(nuij, nuS) * rS_face * dr / (ri * dtheta);
          }

          aE[idx] = cE;
          aW[idx] = cW;
          aN[idx] = cN;
          aS[idx] = cS;
          aP[idx] = cE + cW + cN + cS;
        }
      }
    }

    // Recompute coefficients only for cells in a mask (and their angular/radial neighbours).
    // For correctness we recompute the full coefficients of every cell that SHARES a face
    // with a masked cell. This is done by expanding the affected set.
    function recomputeCoeffsForMask(mask) {
      // Build set of cells whose coefficients may change:
      // - the cell itself (its nu changed → affects all 4 off-diag and aP)
      // - angular neighbours (their aE or aW toward this cell changed)
      // - radial neighbours (their aN or aS toward this cell changed)
      const affected = new Uint8Array(N);
      for (let idx = 0; idx < N; idx++) {
        if (!mask[idx]) continue;
        const i = (idx / Ntheta) | 0;
        const j = idx % Ntheta;
        affected[idx] = 1;
        // East and West angular neighbours
        affected[i * Ntheta + ((j + 1) % Ntheta)] = 1;
        affected[i * Ntheta + ((j + Ntheta - 1) % Ntheta)] = 1;
        // North and South radial neighbours
        if (i + 1 < Nr) affected[(i + 1) * Ntheta + j] = 1;
        if (i > 0)       affected[(i - 1) * Ntheta + j] = 1;
      }

      for (let idx = 0; idx < N; idx++) {
        if (!affected[idx]) continue;
        if (idx === pin) {
          aP[pin] = 1; aE[pin] = 0; aW[pin] = 0; aN[pin] = 0; aS[pin] = 0;
          continue;
        }
        const i = (idx / Ntheta) | 0;
        const j = idx % Ntheta;
        const ri = r[i];
        const angFaceLen = ri * dtheta;

        const nuij = nu[idx];

        const jE = (j + 1) % Ntheta;
        const cE = harmonic(nuij, nu[i * Ntheta + jE]) * angFaceLen / dr;

        const jW = (j + Ntheta - 1) % Ntheta;
        const cW = harmonic(nuij, nu[i * Ntheta + jW]) * angFaceLen / dr;

        let cN = 0;
        if (i + 1 < Nr) {
          const rN_face = 0.5 * (r[i] + r[i + 1]);
          cN = harmonic(nuij, nu[(i + 1) * Ntheta + j]) * rN_face * dr / (ri * dtheta);
        }

        let cS = 0;
        if (i > 0) {
          const rS_face = 0.5 * (r[i] + r[i - 1]);
          cS = harmonic(nuij, nu[(i - 1) * Ntheta + j]) * rS_face * dr / (ri * dtheta);
        }

        aE[idx] = cE;
        aW[idx] = cW;
        aN[idx] = cN;
        aS[idx] = cS;
        aP[idx] = cE + cW + cN + cS;
      }
    }

    // ---- public operator object ----
    const op = {
      // Public read-only properties
      get ell() { return ell; },
      get r() { return r; },
      get dr() { return dr; },
      get dtheta() { return dtheta; },
      get Nr() { return Nr; },
      get Ntheta() { return Ntheta; },
      get gapBand() { return gapBand; },
      get dA() { return dA; },

      // ---- setMaterials ----
      setMaterials({ nu: nuIn }) {
        // Copy into active and base arrays
        for (let idx = 0; idx < N; idx++) {
          nu[idx] = nuIn[idx];
          nuBase[idx] = nuIn[idx];
        }
        computeAllCoeffs();
      },

      // ---- setRotorRegion ----
      setRotorRegion({ rotorMask: mask }) {
        rotorMask = mask;
        // Snapshot the rotor cells' nu from the current base nu as the thetaR=0 template
        rotorNuTemplate = new Float64Array(N);
        for (let idx = 0; idx < N; idx++) {
          if (mask[idx]) rotorNuTemplate[idx] = nuBase[idx];
        }
      },

      // ---- setRotorAngle ----
      // Shift the rotor-region template by thetaR using 1st-order linear interpolation
      // on the periodic angular index.
      setRotorAngle(thetaR) {
        if (!rotorMask || !rotorNuTemplate) return;

        // shift in fractional angular indices
        const shift = thetaR / dtheta;
        const s0 = Math.floor(shift);
        const frac = shift - s0;

        // For each rotor cell (i, j), compute the template value at shifted angle:
        // The template is indexed by (i, j_shifted) where j_shifted = j - shift (mod Ntheta)
        // Equivalently: nu_rotor(i, j) at thetaR = template at (i, (j - s0) % Ntheta) * (1-frac)
        //                                         + template at (i, (j - s0 - 1) % Ntheta) * frac
        // We use the mask to identify rotor rows and columns.
        // Build a temporary array for updated rotor nu values.
        const nuNew = new Float64Array(N);
        for (let idx = 0; idx < N; idx++) nuNew[idx] = nu[idx];

        for (let i = 0; i < Nr; i++) {
          // Check if this radial ring has any rotor cells
          let hasRotor = false;
          for (let j = 0; j < Ntheta; j++) {
            if (rotorMask[i * Ntheta + j]) { hasRotor = true; break; }
          }
          if (!hasRotor) continue;

          for (let j = 0; j < Ntheta; j++) {
            const idx = i * Ntheta + j;
            if (!rotorMask[idx]) continue;

            // Source angular index in template (shift backward by s0 + frac)
            const j0 = ((j - s0) % Ntheta + Ntheta) % Ntheta;
            const j1 = (j0 - 1 + Ntheta) % Ntheta;

            const v0 = rotorNuTemplate[i * Ntheta + j0];
            const v1 = rotorNuTemplate[i * Ntheta + j1];
            nuNew[idx] = v0 * (1 - frac) + v1 * frac;
          }
        }

        // Write back and recompute
        for (let idx = 0; idx < N; idx++) nu[idx] = nuNew[idx];
        recomputeCoeffsForMask(rotorMask);
      },

      // ---- setIronScale ----
      setIronScale(s, ironMask) {
        // Scale the nu of iron cells by s relative to nuBase
        for (let idx = 0; idx < N; idx++) {
          if (ironMask[idx]) nu[idx] = nuBase[idx] * s;
        }
        recomputeCoeffsForMask(ironMask);
      },

      // ---- getReluctivity ----
      getReluctivity() {
        return nu.slice(); // copy
      },

      // ---- setIronReluctivity ----
      setIronReluctivity(nuValues, ironMask) {
        // Write absolute nu values for iron cells only
        for (let idx = 0; idx < N; idx++) {
          if (ironMask[idx]) nu[idx] = nuValues[idx];
        }
        recomputeCoeffsForMask(ironMask);
      },

      // ---- matvec ----
      matvec(x, out = null) {
        if (!out) out = new Float64Array(N);
        for (let i = 0; i < Nr; i++) {
          for (let j = 0; j < Ntheta; j++) {
            const idx = i * Ntheta + j;
            if (idx === pin) {
              out[pin] = x[pin];
              continue;
            }

            const jE = (j + 1) % Ntheta;
            const jW = (j + Ntheta - 1) % Ntheta;

            let val = aP[idx] * x[idx]
                    - aE[idx] * x[i * Ntheta + jE]
                    - aW[idx] * x[i * Ntheta + jW];

            if (i + 1 < Nr) val -= aN[idx] * x[(i + 1) * Ntheta + j];
            if (i > 0)       val -= aS[idx] * x[(i - 1) * Ntheta + j];

            out[idx] = val;
          }
        }
        return out;
      },

      // ---- diagonal ----
      diagonal() {
        return aP.slice();
      },

      // ---- assembleRHS ----
      assembleRHS({ Jz = null, magnetization = null }) {
        const b = new Float64Array(N);

        // J_z contribution: b[idx] += Jz[idx] * dA[idx]
        if (Jz) {
          for (let idx = 0; idx < N; idx++) {
            b[idx] += Jz[idx] * dA[idx];
          }
        }

        // Magnetization contribution: surface current via Stokes theorem (FV form)
        // M = {Mr, Mtheta}: cell-centred radial and angular components
        //
        // b[idx] += ∮_{∂cell} M · ds_perp
        //
        // Angular faces (i±½, constant θ): carry Mr-derived flux.
        //   North face (i+½): contribution −½(Mr[idx] + Mr[i+1,j]) * r_{i+½} * dtheta
        //   South face (i-½): contribution +½(Mr[idx] + Mr[i-1,j]) * r_{i-½} * dtheta
        //   (radial end faces contribute zero)
        //
        // Radial faces (j±½, constant r): carry Mtheta-derived flux.
        //   East face (j+½): contribution +½(Mtheta[idx] + Mtheta[i,j+1]) * dr
        //   West face (j-½): contribution −½(Mtheta[idx] + Mtheta[i,j-1]) * dr

        if (magnetization) {
          const { Mr, Mtheta } = magnetization; // Mtheta is angular component (Mθ)
          const Mt = Mtheta; // alias

          for (let i = 0; i < Nr; i++) {
            for (let j = 0; j < Ntheta; j++) {
              const idx = i * Ntheta + j;
              let contrib = 0;

              // North face (i+½): −½(Mr[idx]+Mr[i+1,j]) * r_{i+½} * dtheta
              if (i + 1 < Nr) {
                const rN = 0.5 * (r[i] + r[i + 1]);
                const idxN = (i + 1) * Ntheta + j;
                contrib -= 0.5 * (Mr[idx] + Mr[idxN]) * rN * dtheta;
              }

              // South face (i-½): +½(Mr[idx]+Mr[i-1,j]) * r_{i-½} * dtheta
              if (i > 0) {
                const rS = 0.5 * (r[i] + r[i - 1]);
                const idxS = (i - 1) * Ntheta + j;
                contrib += 0.5 * (Mr[idx] + Mr[idxS]) * rS * dtheta;
              }

              // East face (j+½): +½(Mtheta[idx]+Mtheta[i,j+1]) * dr
              const jE = (j + 1) % Ntheta;
              const idxE = i * Ntheta + jE;
              contrib += 0.5 * (Mt[idx] + Mt[idxE]) * dr;

              // West face (j-½): −½(Mtheta[idx]+Mtheta[i,j-1]) * dr
              const jW = (j + Ntheta - 1) % Ntheta;
              const idxW = i * Ntheta + jW;
              contrib -= 0.5 * (Mt[idx] + Mt[idxW]) * dr;

              b[idx] += contrib;
            }
          }
        }

        // Force b[pin] = 0
        b[pin] = 0;
        return b;
      },

      // ---- field ----
      // Br[idx] = (1/r) * ∂A_z/∂θ  (central diff in θ, periodic)
      // Bt[idx] = −∂A_z/∂r         (central diff in r, one-sided at rims)
      field(Az) {
        const Br = new Float64Array(N);
        const Bt = new Float64Array(N);
        for (let i = 0; i < Nr; i++) {
          const ri = r[i];
          for (let j = 0; j < Ntheta; j++) {
            const idx = i * Ntheta + j;

            // Br = (1/r) * ∂A_z/∂θ  — central difference (periodic)
            const jP = (j + 1) % Ntheta;
            const jM = (j + Ntheta - 1) % Ntheta;
            Br[idx] = (Az[i * Ntheta + jP] - Az[i * Ntheta + jM]) / (2 * dtheta * ri);

            // Bt = −∂A_z/∂r  — central diff interior, one-sided at rims
            if (i === 0) {
              // one-sided forward
              Bt[idx] = -(Az[(i + 1) * Ntheta + j] - Az[idx]) / dr;
            } else if (i === Nr - 1) {
              // one-sided backward
              Bt[idx] = -(Az[idx] - Az[(i - 1) * Ntheta + j]) / dr;
            } else {
              // central
              Bt[idx] = -(Az[(i + 1) * Ntheta + j] - Az[(i - 1) * Ntheta + j]) / (2 * dr);
            }
          }
        }
        return { Br, Bt };
      },

      // ---- fluxLinkage ----
      // λ_k = Σ_idx Az[idx] * coilMasks[k][idx] * dA[idx]
      fluxLinkage(Az, coilMasks) {
        const K = coilMasks.length;
        const result = new Float64Array(K);
        for (let k = 0; k < K; k++) {
          const mask = coilMasks[k];
          let sum = 0;
          for (let idx = 0; idx < N; idx++) {
            sum += Az[idx] * mask[idx] * dA[idx];
          }
          result[k] = sum;
        }
        return result;
      },

      // ---- setGapBand ----
      setGapBand({ iInner, iOuter }) {
        gapBand = { iInner, iOuter };
      },
    };

    return op;
  }

  LIB.AirgapGrid = { create, MU0 };
})();
