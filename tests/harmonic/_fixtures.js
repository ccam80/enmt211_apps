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
//  annulusOracle({ rIn, rOut, nTheta, nRad, ell, mu0, integrationFrac? }) → { solve, solveAtRadius }
//
//  Self-contained dense meshed-annulus FEM (D2.2).
//  Structured nTheta×nRad quad mesh on [rIn, rOut] with ν=1/μ0 Laplace stiffness.
//
//  integrationFrac (default 0.5) selects which radial layer the Arkkio
//  Maxwell-stress integral is evaluated at when solve() reports torque:
//    0   ⇒ inner circle (r = rIn)
//    1   ⇒ outer circle (r = rOut)
//    0.5 ⇒ mid-annulus (default — preserves legacy call-site behavior)
//
//  solve(aInnerNodal, aOuterNodal) → { fluxInner, fluxOuter, torque }
//    Uses opts.integrationFrac for the torque integration radius.
//
//  solveAtRadius(aInnerNodal, aOuterNodal, integrationRadius) → { torque }
//    Solves once and evaluates the Arkkio Maxwell-stress integral at the
//    explicit integration radius (must satisfy rIn ≤ integrationRadius ≤ rOut).
//    Useful for asserting radius-independence in one solve.
//
//  Node ordering: [inner-circle nodes 0..nTheta-1 | radial layers | outer-circle nodes]
//  Each circle has nTheta nodes at θ_i = 2π·i/nTheta (uniform).
//
//  Returns:
//    fluxInner: Float64Array(nTheta) — consistent nodal reaction flux on inner circle
//    fluxOuter: Float64Array(nTheta) — consistent nodal reaction flux on outer circle
//    torque: number — Arkkio Maxwell-stress torque at integrationFrac
// ---------------------------------------------------------------------------
function annulusOracle(opts) {
  const { rIn, rOut, nTheta, nRad, ell, mu0 } = opts;
  const integrationFrac = (opts.integrationFrac != null) ? opts.integrationFrac : 0.5;

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
    const u_full = solveFull(aInnerNodal, aOuterNodal);

    // Inner/outer node global indices, used for the reaction-flux assembly.
    const innerDofs = new Array(nTheta);
    const outerDofs = new Array(nTheta);
    for (let j = 0; j < nTheta; j++) {
      innerDofs[j] = nodeIdx(0, j);
      outerDofs[j] = nodeIdx(nRad, j);
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

    // Maxwell stress tensor torque (Arkkio volume integral version, per Arkkio 1987):
    //   T = (ell / (μ0 · (r2²-r1²))) · 2·∫_{gap annulus} r · B_r · B_θ dV
    // In our 2D per-unit-length form, evaluated on a single circle at r_eval:
    //   T = (ell / μ0) · r_eval² · ∫_0^{2π} B_r(r_eval,θ) · B_θ(r_eval,θ) dθ
    //   B_r = (1/r)·∂A/∂θ,  B_θ = -∂A/∂r
    //
    // For a source-free Laplace field on the annulus the integrand is
    // exactly r-independent in the continuum, so the value of r_eval is a
    // free parameter — opts.integrationFrac (default 0.5) selects the
    // radial layer used by solve().

    const torque = arkkioAtRadius(u_full, integrationFrac);

    return { fluxInner, fluxOuter, torque };
  }

  // Compute the Arkkio Maxwell-stress integral on the circle at
  // r_eval = rIn + frac·(rOut − rIn) given the full FEM solution u_full.
  // Uses two adjacent radial rings for ∂A/∂r and linear-interp + central
  // angular differencing for ∂A/∂θ.
  function arkkioAtRadius(u_full, frac) {
    const r_eval = rIn + frac * (rOut - rIn);

    // Pick the radial-ring stencil. When r_eval lands inside the annulus,
    // straddle it with rings (ir_below, ir_above). When r_eval is at the
    // outer boundary (frac=1), shift the stencil down one cell so we still
    // have two distinct rings without indexing past nRad.
    let ir_below = Math.floor(frac * nRad);
    if (ir_below >= nRad) ir_below = nRad - 1;
    if (ir_below < 0)     ir_below = 0;
    const ir_above = ir_below + 1;
    const r_below  = rings_r[ir_below];
    const r_above  = rings_r[ir_above];
    const denom_r  = r_above - r_below;
    const rfrac    = (r_eval - r_below) / denom_r;

    const dth_arkkio = TWO_PI / nTheta;
    let T_arkkio = 0;

    for (let j = 0; j < nTheta; j++) {
      const A_bel    = u_full[nodeIdx(ir_below, j)];
      const A_abv    = u_full[nodeIdx(ir_above, j)];
      const A_bel1   = u_full[nodeIdx(ir_below, (j + 1) % nTheta)];
      const A_abv1   = u_full[nodeIdx(ir_above, (j + 1) % nTheta)];
      const A_belm1  = u_full[nodeIdx(ir_below, (j - 1 + nTheta) % nTheta)];
      const A_abvm1  = u_full[nodeIdx(ir_above, (j - 1 + nTheta) % nTheta)];

      // ∂A/∂r at r_eval: finite difference across the straddling rings.
      const dAdr_eval = (A_abv - A_bel) / denom_r;

      // ∂A/∂θ at r_eval: linear interp the two ring samples to r_eval,
      // then central difference in θ.
      const A_plus  = (1 - rfrac) * A_bel1  + rfrac * A_abv1;
      const A_minus = (1 - rfrac) * A_belm1 + rfrac * A_abvm1;
      const dAdth_eval = (A_plus - A_minus) / (2 * dth_arkkio);

      // B_r = (1/r)·∂A/∂θ,  B_θ = -∂A/∂r
      const Br  = dAdth_eval / r_eval;
      const Bth = -dAdr_eval;

      // Per-θ contribution: r_eval · B_r · B_θ · dθ; the second r_eval and
      // ell/μ0 prefactor are applied after the loop.
      T_arkkio += r_eval * Br * Bth * dth_arkkio;
    }
    return T_arkkio * r_eval * ell / mu0;
  }

  // Solve once and evaluate the Arkkio Maxwell-stress integral at an
  // explicit radius (rIn ≤ integrationRadius ≤ rOut). Returns { torque }.
  // Used by the radius-independence test to compare inner-vs-outer
  // integration on a single FEM solution without re-factorizing.
  function solveAtRadius(aInnerNodal, aOuterNodal, integrationRadius) {
    if (integrationRadius < rIn - 1e-12 || integrationRadius > rOut + 1e-12) {
      throw new Error(
        "solveAtRadius: integrationRadius " + integrationRadius +
        " is outside [" + rIn + ", " + rOut + "]"
      );
    }
    const u_full = solveFull(aInnerNodal, aOuterNodal);
    const frac = (integrationRadius - rIn) / (rOut - rIn);
    return { torque: arkkioAtRadius(u_full, frac) };
  }

  // Internal: same dense FEM solve as solve(), but returns only u_full
  // (no boundary flux assembly). Factored out so solveAtRadius can
  // evaluate the Arkkio integral at any radius without re-solving the
  // unrelated nodal-flux reactions.
  function solveFull(aInnerNodal, aOuterNodal) {
    const nInner = nTheta;
    const nOuter = nTheta;
    const nInterior = (nRad - 1) * nTheta;
    const nDirichlet = nInner + nOuter;

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

    const f = new Float64Array(nF);
    for (let i = 0; i < nF; i++) {
      let s = 0;
      for (let j = 0; j < nD; j++) {
        s += K_fd[i * nD + j] * dirichletVals[j];
      }
      f[i] = -s;
    }

    const u_int = denseSolveGeneral(nF, K_ff, f);

    const u_full = new Float64Array(nNodes);
    for (let i = 0; i < nF; i++) {
      u_full[interiorDofs[i]] = u_int[i];
    }
    for (let j = 0; j < nTheta; j++) {
      u_full[innerDofs[j]] = aInnerNodal[j];
      u_full[outerDofs[j]] = aOuterNodal[j];
    }
    return u_full;
  }

  return { solve, solveAtRadius };
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
