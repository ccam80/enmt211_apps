"use strict";

// =============================================================================
//  Shared fixtures and helpers for airgap-harmonic tests.
//  Not a test file — no .test.js suffix.
//
//  Sets up the window global, loads lib modules, and exports test helpers.
// =============================================================================

const path = require("path");
const assert = require("node:assert/strict");

// Shim: install window global
if (!globalThis.window) globalThis.window = globalThis;

const ROOT = path.join(__dirname, "..", "..");

function loadLib(name) {
  require(path.join(ROOT, "lib", name));
}

function loadLesson(relPath) {
  require(path.join(ROOT, relPath));
}

// Load in dependency order
loadLib("util.js");
loadLib("winding-model.js");
loadLesson("lessons/unified_motor/config-schema.js");
loadLib("motor-mesh.js");
loadLib("airgap-harmonic.js");

const AH  = window.LIB.AirgapHarmonic;
const TWO_PI = 2 * Math.PI;

// Re-export from tests/_assert.js
const { assertClose } = require("../_assert.js");

// ---------------------------------------------------------------------------
//  relErrInf(x, ref) → number
//  Relative infinity-norm error: max_i |x[i] - ref[i]| / max(1, max_i |ref[i]|)
// ---------------------------------------------------------------------------
function relErrInf(x, ref) {
  let maxErr = 0;
  let maxRef = 0;
  const n = Math.min(x.length, ref.length);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(x[i] - ref[i]);
    if (e > maxErr) maxErr = e;
    const r = Math.abs(ref[i]);
    if (r > maxRef) maxRef = r;
  }
  return maxErr / Math.max(1, maxRef);
}

// ---------------------------------------------------------------------------
//  uniformCircle(N, R) → { gapTheta: Float64Array(N), gapR: R }
//  gapTheta[i] = 2π·i/N
// ---------------------------------------------------------------------------
function uniformCircle(N, R) {
  const gapTheta = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    gapTheta[i] = (TWO_PI * i) / N;
  }
  return { gapTheta, gapR: R };
}

// ---------------------------------------------------------------------------
//  manufactured(coeffs) → { sample, dAdr, surfaceFluxAt }
//
//  Analytic annulus field (D2.1):
//    A(r,θ) = a0 + b0·ln(r)
//           + Σ_{k=1..Kc} [(ac[k]·r^k + bc[k]·r^{-k})·cos(kθ)
//                         +(as[k]·r^k + bs[k]·r^{-k})·sin(kθ)]
//
//  coeffs = { a0, b0, ac:[...], bc:[...], as:[...], bs:[...] }
//  Lengths of ac/bc/as/bs arrays define Kc (index 0 unused; k=1..Kc).
//
//  sample(r, gapTheta) → Float64Array — A sampled at given angles at radius r
//  dAdr(r, gapTheta)   → Float64Array — ∂A/∂r sampled at given angles at radius r
// ---------------------------------------------------------------------------
function manufactured(coeffs) {
  const a0 = coeffs.a0 != null ? coeffs.a0 : 0;
  const b0 = coeffs.b0 != null ? coeffs.b0 : 0;
  const ac = coeffs.ac || [];
  const bc = coeffs.bc || [];
  const as = coeffs.as || [];
  const bs = coeffs.bs || [];
  const Kc = Math.max(ac.length - 1, bc.length - 1, as.length - 1, bs.length - 1);

  function getCoeff(arr, k) {
    return (arr && k < arr.length) ? arr[k] : 0;
  }

  function sample(r, gapTheta) {
    const N = gapTheta.length;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const th = gapTheta[i];
      let v = a0 + b0 * Math.log(r);
      for (let k = 1; k <= Kc; k++) {
        const rk  = Math.pow(r,  k);
        const rnk = Math.pow(r, -k);
        v += (getCoeff(ac, k) * rk + getCoeff(bc, k) * rnk) * Math.cos(k * th);
        v += (getCoeff(as, k) * rk + getCoeff(bs, k) * rnk) * Math.sin(k * th);
      }
      out[i] = v;
    }
    return out;
  }

  function dAdr(r, gapTheta) {
    const N = gapTheta.length;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const th = gapTheta[i];
      let v = b0 / r;
      for (let k = 1; k <= Kc; k++) {
        const rk_1  = Math.pow(r,  k - 1);
        const rnk_1 = Math.pow(r, -(k + 1));
        v += (getCoeff(ac, k) * k * rk_1 - getCoeff(bc, k) * k * rnk_1) * Math.cos(k * th);
        v += (getCoeff(as, k) * k * rk_1 - getCoeff(bs, k) * k * rnk_1) * Math.sin(k * th);
      }
      out[i] = v;
    }
    return out;
  }

  return { sample, dAdr };
}

// ---------------------------------------------------------------------------
//  annulusOracle({ rIn, rOut, nTheta, nRad, ell, mu0 }) → { solve }
//
//  Self-contained dense meshed-annulus FEM (D2.2).
//  Structured nTheta×nRad quad mesh on [rIn, rOut] with ν=1/μ0 Laplace stiffness.
//
//  solve(aInnerNodal, aOuterNodal) → { fluxInner, fluxOuter, torque }
//
//  Node ordering: [inner-circle nodes 0..nTheta-1 | radial layers | outer-circle nodes]
//  Each circle has nTheta nodes at θ_i = 2π·i/nTheta (uniform).
//
//  Returns:
//    fluxInner: Float64Array(nTheta) — consistent nodal reaction flux on inner circle
//    fluxOuter: Float64Array(nTheta) — consistent nodal reaction flux on outer circle
//    torque: number — Arkkio mid-annulus Maxwell-stress torque
// ---------------------------------------------------------------------------
function annulusOracle(opts) {
  const { rIn, rOut, nTheta, nRad, ell, mu0 } = opts;

  // Total nodes: (nRad+1) rings × nTheta nodes per ring
  const nRings = nRad + 1;
  const nNodes = nRings * nTheta;

  // Node index helper
  function nodeIdx(ring, col) {
    return ring * nTheta + (col % nTheta);
  }

  // Radii of each ring
  const rings_r = new Float64Array(nRings);
  for (let ir = 0; ir <= nRad; ir++) {
    rings_r[ir] = rIn + (rOut - rIn) * ir / nRad;
  }

  // Angles
  const theta_j = new Float64Array(nTheta);
  for (let j = 0; j < nTheta; j++) {
    theta_j[j] = (TWO_PI * j) / nTheta;
  }

  // Assemble stiffness matrix (dense, nNodes×nNodes)
  const K_mat = new Float64Array(nNodes * nNodes);

  function K_add(i, j, val) {
    K_mat[i * nNodes + j] += val;
  }

  // For each quad element (ring ir=0..nRad-1, column j=0..nTheta-1):
  // Nodes: n00=nodeIdx(ir,j), n10=nodeIdx(ir+1,j), n11=nodeIdx(ir+1,j+1), n01=nodeIdx(ir,j+1)
  // Use bilinear quad stiffness for ∇·(ν∇A) with ν=1/μ0 in polar coords (r,θ).
  // For a structured quad in (r,θ) space, use the weak form:
  //   ∫∫ ν · ∇u·∇v · r dr dθ
  // which in polar coords becomes:
  //   ∫∫ ν · (∂u/∂r·∂v/∂r + (1/r²)·∂u/∂θ·∂v/∂θ) · r dr dθ

  for (let ir = 0; ir < nRad; ir++) {
    const r0 = rings_r[ir];
    const r1 = rings_r[ir + 1];
    const dr = r1 - r0;
    const dth = TWO_PI / nTheta;

    for (let j = 0; j < nTheta; j++) {
      const n00 = nodeIdx(ir,   j    );
      const n10 = nodeIdx(ir+1, j    );
      const n11 = nodeIdx(ir+1, j + 1);
      const n01 = nodeIdx(ir,   j + 1);

      const nodes = [n00, n10, n11, n01];

      // Use 2×2 Gauss quadrature in local (s,t) ∈ [-1,1]²
      // s maps to r: r = r0 + (1+s)/2 * dr
      // t maps to θ: θ = θ_j + (1+t)/2 * dth
      const gp = [-1/Math.sqrt(3), 1/Math.sqrt(3)];
      const w  = [1, 1];

      for (let gi = 0; gi < 2; gi++) {
        for (let gj = 0; gj < 2; gj++) {
          const s = gp[gi];
          const t = gp[gj];
          const ws = w[gi];
          const wt = w[gj];

          // Physical coords
          const r   = r0 + (1 + s) / 2 * dr;
          const rg  = r; // mid-radius for this Gauss point

          // Bilinear shape functions in (s,t):
          // N0 = (1-s)(1-t)/4,  N1 = (1+s)(1-t)/4,
          // N2 = (1+s)(1+t)/4,  N3 = (1-s)(1+t)/4
          // ∂N/∂s and ∂N/∂t:
          const dNs = [
            -(1-t)/4,  (1-t)/4,  (1+t)/4, -(1+t)/4,
          ];
          const dNt = [
            -(1-s)/4, -(1+s)/4,  (1+s)/4,  (1-s)/4,
          ];

          // Jacobian: ∂(r,θ)/∂(s,t)
          // ∂r/∂s = dr/2, ∂r/∂t = 0
          // ∂θ/∂s = 0,    ∂θ/∂t = dth/2
          const J11 = dr / 2;
          const J22 = dth / 2;
          const detJ = J11 * J22;

          // ∂N/∂r = (1/J11)·∂N/∂s,  ∂N/∂θ = (1/J22)·∂N/∂t
          const dNr = dNs.map(v => v / J11);
          const dNth = dNt.map(v => v / J22);

          // Stiffness integrand: ν · r · (∂N_i/∂r·∂N_j/∂r + (1/r²)·∂N_i/∂θ·∂N_j/∂θ) · detJ · ds·dt
          // where ν = 1/μ0
          const nu = 1 / mu0;
          const fac = nu * rg * detJ * ws * wt;

          for (let a = 0; a < 4; a++) {
            for (let b = 0; b < 4; b++) {
              const kij = fac * (dNr[a] * dNr[b] + (1 / (rg * rg)) * dNth[a] * dNth[b]);
              K_add(nodes[a], nodes[b], kij);
            }
          }
        }
      }
    }
  }

  function solve(aInnerNodal, aOuterNodal) {
    // Partition DOFs: inner (ir=0) and outer (ir=nRad) are Dirichlet; interior is free.
    // Inner nodes: nodeIdx(0, j) for j=0..nTheta-1
    // Outer nodes: nodeIdx(nRad, j) for j=0..nTheta-1
    // Interior: nodeIdx(ir, j) for ir=1..nRad-1

    const nInner = nTheta;
    const nOuter = nTheta;
    const nInterior = (nRad - 1) * nTheta;
    const nDirichlet = nInner + nOuter;

    // Reorder DOFs: [interior | inner | outer]
    // interior_dofs[i] = nodeIdx(1 + Math.floor(i/nTheta), i%nTheta)
    const interiorDofs = [];
    for (let ir = 1; ir < nRad; ir++) {
      for (let j = 0; j < nTheta; j++) {
        interiorDofs.push(nodeIdx(ir, j));
      }
    }

    const innerDofs = [];
    const outerDofs = [];
    for (let j = 0; j < nTheta; j++) {
      innerDofs.push(nodeIdx(0, j));
      outerDofs.push(nodeIdx(nRad, j));
    }

    const dirichletDofs = innerDofs.concat(outerDofs);
    const dirichletVals = new Float64Array(nDirichlet);
    for (let j = 0; j < nTheta; j++) {
      dirichletVals[j]          = aInnerNodal[j];
      dirichletVals[nTheta + j] = aOuterNodal[j];
    }

    // Build K_ff (interior × interior) and K_fd (interior × dirichlet)
    const nF = nInterior;
    const nD = nDirichlet;
    const K_ff = new Float64Array(nF * nF);
    const K_fd = new Float64Array(nF * nD);

    for (let i = 0; i < nF; i++) {
      const gi = interiorDofs[i];
      for (let j = 0; j < nF; j++) {
        const gj = interiorDofs[j];
        K_ff[i * nF + j] = K_mat[gi * nNodes + gj];
      }
      for (let j = 0; j < nD; j++) {
        const gj = dirichletDofs[j];
        K_fd[i * nD + j] = K_mat[gi * nNodes + gj];
      }
    }

    // RHS: f = -K_fd · d
    const f = new Float64Array(nF);
    for (let i = 0; i < nF; i++) {
      let s = 0;
      for (let j = 0; j < nD; j++) {
        s += K_fd[i * nD + j] * dirichletVals[j];
      }
      f[i] = -s;
    }

    // Solve K_ff · u = f by LDLT (dense Cholesky for SPD)
    const u_int = denseSolveGeneral(nF, K_ff, f);

    // Full solution vector
    const u_full = new Float64Array(nNodes);
    for (let i = 0; i < nF; i++) {
      u_full[interiorDofs[i]] = u_int[i];
    }
    for (let j = 0; j < nTheta; j++) {
      u_full[innerDofs[j]] = aInnerNodal[j];
      u_full[outerDofs[j]] = aOuterNodal[j];
    }

    // Compute consistent reaction fluxes on inner and outer circles.
    // Reaction flux at Dirichlet node i: f_i = Σ_j K[i,j] · u[j]
    // (this is the total force — internal rows are constrained so we compute
    // the reaction as the product of the full stiffness row with the solution)
    const fluxInner = new Float64Array(nTheta);
    const fluxOuter = new Float64Array(nTheta);

    // Stiffness was assembled per-unit-axial-length (no ell factor in fac).
    // The FEM consistent nodal reaction f_i = ∫ (1/μ0)·∂A/∂n_out · N_i dΓ is
    // therefore also per-unit-length. With dΓ ≈ r·dθ at each circle node,
    //   f_i ≈ r · (1/μ0)·∂A/∂n_out · dθ.
    // Dividing by dθ recovers r·(1/μ0)·∂A/∂n_out, matching the M_weak
    // surfaceFlux convention.
    const dth_div = TWO_PI / nTheta;

    for (let j = 0; j < nTheta; j++) {
      const gi = innerDofs[j];
      let fi = 0;
      for (let k2 = 0; k2 < nNodes; k2++) {
        fi += K_mat[gi * nNodes + k2] * u_full[k2];
      }
      fluxInner[j] = fi / dth_div;
    }

    for (let j = 0; j < nTheta; j++) {
      const gi = outerDofs[j];
      let fi = 0;
      for (let k2 = 0; k2 < nNodes; k2++) {
        fi += K_mat[gi * nNodes + k2] * u_full[k2];
      }
      fluxOuter[j] = fi / dth_div;
    }

    // Arkkio mid-annulus Maxwell-stress torque
    // T = (ell/μ0) ∫_Γ_mid r · B_r · B_θ dΓ
    //   = (ell/(μ0)) ∫_0^{2π} r · (1/r·∂A/∂θ) · (-∂A/∂r) · r · dθ  ... wrong signs
    // Standard form: T = (ell/μ0) · r_mid² · ∫_0^{2π} B_r · B_θ dθ
    //   B_r = (1/r)·∂A/∂θ,  B_θ = -∂A/∂r
    //   T = (ell·r_mid/μ0) · ∫_0^{2π} (∂A/∂θ) · (-∂A/∂r) dθ   ... still need sign check
    //
    // Maxwell stress tensor torque (Arkkio volume integral version, per Arkkio 1987):
    //   T = (ell / (μ0 · (r2²-r1²))) · 2·∫_{gap annulus} r · B_r · B_θ dV
    // In our 2D per-unit-length version:
    //   T = (ell / μ0) · ∫_0^{2π} r_mid · B_r(r_mid,θ) · B_θ(r_mid,θ) dθ
    // where integration is at the mid-radius r_mid = (rIn+rOut)/2 in the gap.
    //
    // We interpolate u at the mid-radius ring to get B_r and B_θ numerically.
    // The mid-radius ring is at r_mid_idx = floor(nRad/2) or we interpolate.

    const r_mid = (rIn + rOut) / 2;
    const ir_below = Math.floor((r_mid - rIn) / (rOut - rIn) * nRad);
    const ir_above = Math.min(ir_below + 1, nRad);
    const frac = (r_mid - rings_r[ir_below]) / (rings_r[ir_above] - rings_r[ir_below] + 1e-30);

    const dth_arkkio = TWO_PI / nTheta;
    let T_arkkio = 0;

    for (let j = 0; j < nTheta; j++) {
      // A at mid-radius (linear interpolation between rings)
      const A_bel = u_full[nodeIdx(ir_below, j)];
      const A_abv = u_full[nodeIdx(ir_above, j)];
      const A_bel1 = u_full[nodeIdx(ir_below, (j + 1) % nTheta)];
      const A_abv1 = u_full[nodeIdx(ir_above, (j + 1) % nTheta)];
      const A_belm1 = u_full[nodeIdx(ir_below, (j - 1 + nTheta) % nTheta)];
      const A_abvm1 = u_full[nodeIdx(ir_above, (j - 1 + nTheta) % nTheta)];

      // ∂A/∂r at mid: finite difference between rings
      const dAdr_mid = (A_abv - A_bel) / (rings_r[ir_above] - rings_r[ir_below]);

      // ∂A/∂θ at mid: central difference in θ at the interpolated radius
      const A_mid_plus  = (1 - frac) * A_bel1  + frac * A_abv1;
      const A_mid_minus = (1 - frac) * A_belm1 + frac * A_abvm1;
      const dAdth_mid = (A_mid_plus - A_mid_minus) / (2 * dth_arkkio);

      // B_r = (1/r)·∂A/∂θ,  B_θ = -∂A/∂r
      const Br  = dAdth_mid / r_mid;
      const Bth = -dAdr_mid;

      // Contribution to torque: r_mid · B_r · B_θ · dθ · r_mid  (×ell/μ0 outside)
      T_arkkio += r_mid * Br * Bth * dth_arkkio;
    }
    T_arkkio *= r_mid * ell / mu0;

    return { fluxInner, fluxOuter, torque: T_arkkio };
  }

  return { solve };
}

// ---------------------------------------------------------------------------
//  denseSolveGeneral(n, A_flat, b) → Float64Array
//  Gaussian elimination with partial pivoting on the n×n dense system A·x = b.
//  A_flat is row-major Float64Array(n×n). Returns solution x.
// ---------------------------------------------------------------------------
function denseSolveGeneral(n, A_flat, b) {
  // Copy augmented matrix [A|b]
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      M[i * (n + 1) + j] = A_flat[i * n + j];
    }
    M[i * (n + 1) + n] = b[i];
  }

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let pivotRow = col;
    let pivotVal = Math.abs(M[col * (n + 1) + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row * (n + 1) + col]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = row;
      }
    }
    // Swap rows
    if (pivotRow !== col) {
      for (let j = 0; j <= n; j++) {
        const tmp = M[col * (n + 1) + j];
        M[col * (n + 1) + j] = M[pivotRow * (n + 1) + j];
        M[pivotRow * (n + 1) + j] = tmp;
      }
    }
    const diag = M[col * (n + 1) + col];
    if (Math.abs(diag) < 1e-30) continue;
    for (let row = col + 1; row < n; row++) {
      const factor = M[row * (n + 1) + col] / diag;
      for (let j = col; j <= n; j++) {
        M[row * (n + 1) + j] -= factor * M[col * (n + 1) + j];
      }
    }
  }

  // Back substitution
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) {
      s -= M[i * (n + 1) + j] * x[j];
    }
    const diag = M[i * (n + 1) + i];
    x[i] = Math.abs(diag) < 1e-30 ? 0 : s / diag;
  }
  return x;
}

// ---------------------------------------------------------------------------
//  denseSolveSPD(nLocal, I, J, V, b) → Float64Array
//
//  Assembles a dense nLocal×nLocal matrix from triplets (I,J,V) by summing
//  duplicate entries, then solves A·x = b by Gaussian elimination.
//  Used to drive the stamp result for the stamp↔surfaceFlux consistency test.
// ---------------------------------------------------------------------------
function denseSolveSPD(nLocal, I, J, V, b) {
  const A = new Float64Array(nLocal * nLocal);
  const nt = I.length;
  for (let t = 0; t < nt; t++) {
    const i = I[t];
    const j = J[t];
    const v = V[t];
    A[i * nLocal + j] += v;
  }
  return denseSolveGeneral(nLocal, A, b);
}

// ---------------------------------------------------------------------------
//  patternKeys(stampResult) → Set<string>
//  Returns a Set of "i,j" strings for every triplet in the stamp result.
//  Used for φ-invariance assertions in T4.2.1.
// ---------------------------------------------------------------------------
function patternKeys(stampResult) {
  const { I, J } = stampResult;
  const s = new Set();
  for (let t = 0; t < I.length; t++) {
    s.add(I[t] + "," + J[t]);
  }
  return s;
}

// ---------------------------------------------------------------------------
//  loadFixture(id) → { config }
//  Loads lessons/unified_motor/machines/<id>.js and returns the config.
// ---------------------------------------------------------------------------
function loadFixture(id) {
  loadLesson("lessons/unified_motor/machines/" + id + ".js");
  const machines = window.UnifiedMotor.MACHINES;
  const entry = machines.find(function (m) { return m.id === id; });
  if (!entry) throw new Error("loadFixture: machine id '" + id + "' not found");
  return { config: entry.config };
}

// ---------------------------------------------------------------------------
//  gapLoopsFromConfig(config) → { rotorGap, statorGap, slots, poles }
//  Runs CS.expand(config) to get the section, builds the mesh, and returns
//  each body's { gapTheta, gapR } plus slots and poles.
// ---------------------------------------------------------------------------
function gapLoopsFromConfig(config) {
  const CS = window.UnifiedMotor.ConfigSchema;
  const UM_mesh = window.LIB.MotorMesh;

  const expanded = CS.expand(config);
  const section  = expanded.slices[0].section;
  const poles    = expanded.poles;

  // slots = max angularCount across the compiled feature list. Matches the
  // Phase-5 derivation (D8) so K = defaultK(slots, poles) is identical on
  // both phases for any given fixture.
  const features = section.features;
  const slots = Math.max(1, ...features.map(function (f) { return f.angularCount || 1; }));

  // MotorMesh.build consumes the FULL section (both rotor and stator features
  // together) and computes the gap geometry from rRotorSurface/rStatorBore at
  // once. Splitting features per body would break the gap-radius derivation
  // (each side would fall back to a default for the missing member).
  const physics = UM_mesh.physicsFromConfig(config);
  const result  = UM_mesh.build(section, { physics });

  const rotorMesh  = result.rotor;
  const statorMesh = result.stator;

  return {
    rotorGap:  { gapTheta: rotorMesh.gapTheta,  gapR: rotorMesh.gapR  },
    statorGap: { gapTheta: statorMesh.gapTheta, gapR: statorMesh.gapR },
    slots,
    poles,
  };
}

module.exports = {
  AH,
  assertClose,
  relErrInf,
  uniformCircle,
  manufactured,
  annulusOracle,
  denseSolveSPD,
  patternKeys,
  loadFixture,
  gapLoopsFromConfig,
};
