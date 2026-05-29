(function () {
  "use strict";

  // ============================================================================
  //  LIB.MotorSlice — FEA slice (one z-stack section).
  //
  //  Phase 5 Wave 5.1 surface: prepare/assembly + static-rotor Brauer Newton.
  //  The public solve(thetaR, currents) / coggingTorque / extractCoeffs / etc.
  //  arrive in Waves 5.2 and 5.3. This file lays the foundation only.
  //
  //  Hard contract:
  //    - LIB.FeaSolver.init() MUST have resolved before LIB.MotorSlice.create
  //      is called. create() is synchronous; if init has not resolved it throws.
  //    - No machine-identity branching anywhere. Dispatch is on element kind
  //      (Q4/tri) and material kind (iron/magnet/conductor/air) only.
  //    - No DOM/canvas access at module load.
  // ============================================================================

  const LIB = window.LIB || (window.LIB = {});

  const MU0       = 4 * Math.PI * 1e-7;
  const TWO_PI    = 2 * Math.PI;
  const NU_AIR    = 1 / MU0;

  // --------------------------------------------------------------------------
  //  derivedSlots(section) — see D8 of phase-5-fea-slice.md
  //
  //  slots = max over the stator features of the periodic angular-count of
  //  each ring grouping. We have no per-feature angularCount field, so we
  //  count features that share (rRange[0], rRange[1], kind) on the stator
  //  member — that group corresponds 1-to-1 with one ring's emitted feature
  //  list. For a W stator with Q=6 the conductor group has 6 entries; an I
  //  stator with teeth=4 has 4 iron entries; a back-iron full-circle iron
  //  has 1.
  // --------------------------------------------------------------------------
  function derivedSlots(section) {
    const features = (section && section.features) ? section.features : [];
    const counts = new Map();
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (!f || f.member !== "stator") continue;
      if (f.kind !== "conductor" && f.kind !== "iron") continue;
      const r0 = f.rRange ? f.rRange[0] : 0;
      const r1 = f.rRange ? f.rRange[1] : 0;
      const key = f.kind + "|" + r0 + "|" + r1;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let slots = 1;
    for (const v of counts.values()) {
      if (v > slots) slots = v;
    }
    return slots;
  }

  function derivedPoles(opts) {
    const p = opts && opts.poles;
    if (typeof p === "number" && Number.isFinite(p) && p >= 1) return p;
    return 2;
  }

  // --------------------------------------------------------------------------
  //  brauerNu(B2, material, BkneeDefault) → { ν, dν_dB2 }
  //
  //  Locked decision D5. Per-iron-material Brauer reluctivity. Two modes:
  //
  //    EXPLICIT OVERRIDE (material.k1, k2, k3 all present):
  //      ν(B²) = k1 + k2·exp(k3·B²)
  //    FIT MODE (Bknee from material.Bknee ?? BkneeDefault):
  //      ν(B²) = k1·(1 + (exp(B²/Bk²) − 1)/(e − 1))
  //              = k1 + (k1/(e−1))·(exp(B²/Bk²) − 1)
  //      so ν(0) = k1 exactly and ν(Bk²) = 2·k1 exactly.
  //
  //  k1 = 1/(μ0·muR). The fit form satisfies the two constraints the spec
  //  asserts directly: (a) ν(0) = k1 and (b) ν(Bk²) = 2·k1.
  //
  //  Air / conductor / magnet → linear ν = 1/(μ0·muR), dν/dB² = 0.
  //  (Magnets stay linear per D5.)
  // --------------------------------------------------------------------------
  function brauerNu(B2, material, BkneeDefault) {
    if (!material || material.kind !== "iron") {
      const muR = material && typeof material.muR === "number" ? material.muR : 1;
      return { ν: 1 / (MU0 * muR), dν_dB2: 0 };
    }

    // Explicit (k1, k2, k3) override (D5). Pure Brauer exponential with the
    // user-supplied coefficients. Capped to ν_air (= 1/μ₀) and arg-clamped
    // at 50 to prevent Math.exp overflow that would NaN-out the K matrix
    // via 0·Infinity in the rank-1 tangent. The cap is physical: iron's
    // reluctivity asymptotes to vacuum permeability at full saturation.
    if (typeof material.k1 === "number" &&
        typeof material.k2 === "number" &&
        typeof material.k3 === "number") {
      const k1 = material.k1, k2 = material.k2, k3 = material.k3;
      const ν_air_cap = 1 / MU0;
      const arg = k3 * B2;
      if (arg < 50) {
        const E = Math.exp(arg);
        const ν_raw  = k1 + k2 * E;
        const dν_raw = k2 * k3 * E;
        if (ν_raw <= ν_air_cap) return { ν: ν_raw, dν_dB2: dν_raw };
      }
      return { ν: ν_air_cap, dν_dB2: 0 };
    }

    // Two-parameter Marrocco model for the default iron fit. Standard
    // bounded saturation curve used in production motor FEA (e.g. FEMM,
    // Ansys). Smooth, monotone, asymptotes correctly to ν_air at full
    // saturation, well-behaved derivative everywhere. Replaces the
    // previous Brauer exponential, which grew without bound and overflowed
    // Math.exp at B² above ~700·Bknee², feeding Infinity into the rank-1
    // tangent 2·dν·gA·gAᵀ and NaN-ing the K matrix via 0·Infinity at
    // boundary nodes.
    //
    //   ν(B²) = ν_air · (B²² + α) / (B²² + β)
    //   dν/dB² = ν_air · (β − α) · 2·B² / (B²² + β)²
    //
    // Parameters chosen to satisfy the slice-test contracts that have
    // historically pinned the iron model:
    //
    //   ν(0)         = ν_iron = 1/(μ₀·μᵣ)    "linear ν at B=0"
    //   ν(Bknee²)    = 2·ν_iron              "2·k1 at Bknee"
    //   ν(B² → ∞)    = ν_air = 1/μ₀          physical saturation limit
    //
    // Solving the two non-trivial constraints:
    //   ν(0) = ν_air · α/β = ν_iron     ⟹  α/β = 1/μᵣ        ⟹  β = α·μᵣ
    //   ν(Bknee²) = 2·ν_iron            ⟹  α = (μᵣ−2)·Bknee⁴/μᵣ
    //                                       β = (μᵣ−2)·Bknee⁴
    //
    // Exponent n=2 (so B²² appears in the formula) gives a knee shape
    // gentle enough that Newton's tangent is bounded everywhere, sharp
    // enough that B² below ~0.3·Bknee² is effectively unsaturated. Above
    // the knee, ν tracks toward ν_air smoothly — no exponential blow-up,
    // no clamp kink, no overflow risk.
    const muR = typeof material.muR === "number" ? material.muR : 1000;
    const ν_air = 1 / MU0;

    let Bk = (material.Bknee != null && Number.isFinite(material.Bknee))
      ? material.Bknee
      : BkneeDefault;
    if (!(Bk > 0)) Bk = 1.6;
    const Bk4 = Bk * Bk * Bk * Bk;

    const alpha = (muR - 2) * Bk4 / muR;
    const beta  = alpha * muR;  // = (muR - 2) * Bk⁴
    const u = B2 * B2;          // (B²)² for n=2
    const denom = u + beta;
    const ν = ν_air * (u + alpha) / denom;
    const dν_dB2 = ν_air * (beta - alpha) * 2 * B2 / (denom * denom);
    return { ν: ν, dν_dB2: dν_dB2 };
  }

  // --------------------------------------------------------------------------
  //  eliminateOuterStatorPin(rotorMesh, statorMesh, rOuter)
  //
  //  Builds the free-DOF renumbering for both bodies. Two classes of mesh
  //  nodes are removed from the free DOF list:
  //
  //  1. D6 outer-stator Dirichlet pin: stator nodes at |r − rOuter| < 1e-9
  //     (homogeneous Dirichlet A = 0, recovered as 0 in Anode).
  //  2. Constraint slaves: hanging-node slaves listed in body.constraints
  //     (recovered as a linear combination of their masters via the
  //     constraint weights).
  //
  //  Both classes get renumber index -1 so the interior assembly skips
  //  emitting triplets into slave/pinned rows or columns. The triplet-time
  //  constraint distribution (applyConstraintsToTriplets) then injects each
  //  slave's contribution directly into its masters' renumbered indices.
  //
  //  Returns:
  //    renumbering: { rotor: Int32Array(Nn_rotor), stator: Int32Array(Nn_stator) }
  //      where renumbering.<body>[i] = free-DOF index, or -1 if eliminated.
  //    pinned: Int32Array — original stator node indices that were Dirichlet-
  //      pinned (D6 only; slaves are not included here).
  //    nRotorFree, nStatorFree: integers.
  // --------------------------------------------------------------------------
  function eliminateOuterStatorPin(rotorMesh, statorMesh, rOuter) {
    const TOL = 1e-9;
    const NnR = rotorMesh.nodes.length / 2;
    const NnS = statorMesh.nodes.length / 2;

    function slaveSet(mesh) {
      const s = new Uint8Array(mesh.nodes.length / 2);
      if (mesh.constraints && mesh.constraints.slaves) {
        const sl = mesh.constraints.slaves;
        for (let k = 0; k < sl.length; k++) s[sl[k]] = 1;
      }
      return s;
    }
    const rSlaves = slaveSet(rotorMesh);
    const sSlaves = slaveSet(statorMesh);

    const renumR = new Int32Array(NnR);
    const renumS = new Int32Array(NnS);
    const pinned = [];

    let nR = 0;
    for (let i = 0; i < NnR; i++) {
      if (rSlaves[i]) {
        renumR[i] = -1;
      } else {
        renumR[i] = nR++;
      }
    }

    let nS = 0;
    for (let i = 0; i < NnS; i++) {
      const x = statorMesh.nodes[2 * i];
      const y = statorMesh.nodes[2 * i + 1];
      const r = Math.hypot(x, y);
      if (Math.abs(r - rOuter) < TOL) {
        renumS[i] = -1;
        pinned.push(i);
      } else if (sSlaves[i]) {
        renumS[i] = -1;
      } else {
        renumS[i] = nS++;
      }
    }

    return {
      renumbering: { rotor: renumR, stator: renumS },
      pinned: Int32Array.from(pinned),
      nRotorFree: nR,
      nStatorFree: nS,
    };
  }

  // --------------------------------------------------------------------------
  //  Element-level helpers
  // --------------------------------------------------------------------------

  // Q4 bilinear gradient + area at the element center (s=0,t=0).
  // Returns { dNdx: Float64Array(4), dNdy: Float64Array(4), area, xc, yc, J }
  // where J is the average Jacobian at center.
  //
  // For nonlinear nu(B²) we need the per-Gauss-point quadrature. Use 2×2 Gauss
  // explicitly: gaussQ4(elem nodes) → 4 gauss points each with N, dN/dx, dN/dy,
  // detJ.
  // --------------------------------------------------------------------------

  const GP4_1D = [-1 / Math.sqrt(3), 1 / Math.sqrt(3)];

  // shape function N_i(s,t) for Q4. motor-mesh's quad ordering (CCW):
  //   elems[4e+0] = (r0, θ0)     (small r, small θ)
  //   elems[4e+1] = (r1, θ0)     (large r, small θ)
  //   elems[4e+2] = (r1, θ1)     (large r, large θ)
  //   elems[4e+3] = (r0, θ1)     (small r, large θ)
  //
  // Standard CCW parametric mapping:
  //   n0 ↔ (s=-1, t=-1)
  //   n1 ↔ (s=+1, t=-1)
  //   n2 ↔ (s=+1, t=+1)
  //   n3 ↔ (s=-1, t=+1)
  function q4ShapeAt(s, t) {
    return {
      N: [
        0.25 * (1 - s) * (1 - t),  // n0: (s=-1,t=-1)
        0.25 * (1 + s) * (1 - t),  // n1: (s=+1,t=-1)
        0.25 * (1 + s) * (1 + t),  // n2: (s=+1,t=+1)
        0.25 * (1 - s) * (1 + t),  // n3: (s=-1,t=+1)
      ],
      dNds: [
        -0.25 * (1 - t),
         0.25 * (1 - t),
         0.25 * (1 + t),
        -0.25 * (1 + t),
      ],
      dNdt: [
        -0.25 * (1 - s),
        -0.25 * (1 + s),
         0.25 * (1 + s),
         0.25 * (1 - s),
      ],
    };
  }

  // Compute Jacobian and dN/dx, dN/dy at (s,t) for a Q4 with node coordinates
  // (x[0..3], y[0..3]). Returns { dNdx, dNdy, detJ }.
  // Module-level scratch for q4Jacobian's dN/dx and dN/dy outputs. q4Jacobian
  // is called millions of times per saturated solve (4 Gauss points x Ne
  // elements x per-iter); allocating Float64Array(4) inside it was responsible
  // for a substantial fraction of the GC pressure on this path. Returned
  // object's dNdx/dNdy arrays alias these statics — caller MUST consume the
  // result before the next q4Jacobian call (all current callers do).
  const _q4_dNdx = new Float64Array(4);
  const _q4_dNdy = new Float64Array(4);
  const _q4_result = { dNdx: _q4_dNdx, dNdy: _q4_dNdy, detJ: 0 };

  function q4Jacobian(xN, yN, s, t) {
    const sh = q4ShapeAt(s, t);
    let dxds = 0, dxdt = 0, dyds = 0, dydt = 0;
    for (let i = 0; i < 4; i++) {
      dxds += sh.dNds[i] * xN[i];
      dxdt += sh.dNdt[i] * xN[i];
      dyds += sh.dNds[i] * yN[i];
      dydt += sh.dNdt[i] * yN[i];
    }
    const detJ = dxds * dydt - dxdt * dyds;
    const inv = 1 / detJ;
    const dsdx =  dydt * inv;
    const dsdy = -dxdt * inv;
    const dtdx = -dyds * inv;
    const dtdy =  dxds * inv;
    const dNdx = _q4_dNdx;
    const dNdy = _q4_dNdy;
    for (let i = 0; i < 4; i++) {
      dNdx[i] = sh.dNds[i] * dsdx + sh.dNdt[i] * dtdx;
      dNdy[i] = sh.dNds[i] * dsdy + sh.dNdt[i] * dtdy;
    }
    _q4_result.detJ = detJ;
    return _q4_result;
  }

  // Same module-level scratch pattern as q4Jacobian — triGradients is called
  // for every tri element on every assemble pass.
  const _tri_dNdx = new Float64Array(3);
  const _tri_dNdy = new Float64Array(3);
  const _tri_result = { dNdx: _tri_dNdx, dNdy: _tri_dNdy, area: 0, twoA: 0 };

  // Linear tri (n3 == -1): single Gauss point at centroid; constant ∂N/∂x.
  function triGradients(xN, yN) {
    // Nodes 0,1,2. Shape N_i = (a_i + b_i·x + c_i·y) / (2·area).
    // b_i = y_j - y_k, c_i = x_k - x_j (cyclic).
    const x0 = xN[0], y0 = yN[0];
    const x1 = xN[1], y1 = yN[1];
    const x2 = xN[2], y2 = yN[2];
    const twoA = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const area = 0.5 * twoA;
    const inv2A = 1 / twoA;
    const dNdx = _tri_dNdx;
    const dNdy = _tri_dNdy;
    dNdx[0] = (y1 - y2) * inv2A;
    dNdx[1] = (y2 - y0) * inv2A;
    dNdx[2] = (y0 - y1) * inv2A;
    dNdy[0] = (x2 - x1) * inv2A;
    dNdy[1] = (x0 - x2) * inv2A;
    dNdy[2] = (x1 - x0) * inv2A;
    _tri_result.area = area;
    _tri_result.twoA = twoA;
    return _tri_result;
  }

  // --------------------------------------------------------------------------
  //  bElement(body, e, Anodal) → { Bx, By }
  //
  //  Element-center B for plotting / B² lookup. Bx = ∂A/∂y, By = -∂A/∂x.
  //  For Q4 evaluated at element center (s=0,t=0); for tri at the centroid.
  //  Anodal is the FULL nodal array (size Nn), values pre-restored.
  // --------------------------------------------------------------------------
  function bElement(body, e, Anodal) {
    const n0 = body.elems[4 * e];
    const n1 = body.elems[4 * e + 1];
    const n2 = body.elems[4 * e + 2];
    const n3 = body.elems[4 * e + 3];
    if (n3 === -1) {
      const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
      const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
      const g = triGradients(xN, yN);
      const A0 = Anodal[n0], A1 = Anodal[n1], A2 = Anodal[n2];
      const dAdx = g.dNdx[0]*A0 + g.dNdx[1]*A1 + g.dNdx[2]*A2;
      const dAdy = g.dNdy[0]*A0 + g.dNdy[1]*A1 + g.dNdy[2]*A2;
      return { Bx: dAdy, By: -dAdx };
    }
    const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
    const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
    const j = q4Jacobian(xN, yN, 0, 0);
    const A0 = Anodal[n0], A1 = Anodal[n1], A2 = Anodal[n2], A3 = Anodal[n3];
    const dAdx = j.dNdx[0]*A0 + j.dNdx[1]*A1 + j.dNdx[2]*A2 + j.dNdx[3]*A3;
    const dAdy = j.dNdy[0]*A0 + j.dNdy[1]*A1 + j.dNdy[2]*A2 + j.dNdy[3]*A3;
    return { Bx: dAdy, By: -dAdx };
  }

  // --------------------------------------------------------------------------
  //  assembleInteriorPatternAndValues(body, νPerElem)
  //
  //  Returns { I: Int32Array, J: Int32Array, V: Float64Array } of full-symmetric
  //  triplets for the body interior in MESH-node indexing (slaves and pinned
  //  nodes both still appear with their mesh-node index). Caller is responsible
  //  for the slave-distribution + renumbering step via applyConstraintsToTriplets.
  //
  //  Q4: 2×2 Gauss; tri: 1-point.
  //
  //  νPerElem is a Float64Array of length Ne giving the reluctivity for each
  //  element. When provided as null, defaults to material-linear ν.
  // --------------------------------------------------------------------------
  function assembleInteriorPatternAndValues(body, νPerElem) {
    const Ne = body.elems.length / 4;
    const I = [];
    const J = [];
    const V = [];

    for (let e = 0; e < Ne; e++) {
      const ν = νPerElem ? νPerElem[e] : NU_AIR;
      const n0 = body.elems[4*e];
      const n1 = body.elems[4*e+1];
      const n2 = body.elems[4*e+2];
      const n3 = body.elems[4*e+3];

      if (n3 === -1) {
        // linear tri, 1-point at centroid
        const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
        const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
        const g = triGradients(xN, yN);
        const area = g.area;
        if (!(area > 0)) continue;
        const dNdx = g.dNdx, dNdy = g.dNdy;
        const nLocal = [n0, n1, n2];
        for (let a = 0; a < 3; a++) {
          for (let b = 0; b < 3; b++) {
            const k = ν * (dNdx[a]*dNdx[b] + dNdy[a]*dNdy[b]) * area;
            I.push(nLocal[a]); J.push(nLocal[b]); V.push(k);
          }
        }
      } else {
        // Q4, 2x2 Gauss
        const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
        const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
        const nLocal = [n0, n1, n2, n3];

        // Local 4x4 stiffness for this element
        const Kloc = new Float64Array(16);
        for (let gs = 0; gs < 2; gs++) {
          for (let gt = 0; gt < 2; gt++) {
            const s = GP4_1D[gs];
            const t = GP4_1D[gt];
            const j = q4Jacobian(xN, yN, s, t);
            if (!(j.detJ > 0)) continue;
            const w = ν * j.detJ; // unit weights w_s = w_t = 1
            for (let a = 0; a < 4; a++) {
              for (let b = 0; b < 4; b++) {
                Kloc[a*4 + b] += w * (j.dNdx[a]*j.dNdx[b] + j.dNdy[a]*j.dNdy[b]);
              }
            }
          }
        }
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) {
            I.push(nLocal[a]); J.push(nLocal[b]); V.push(Kloc[a*4 + b]);
          }
        }
      }
    }

    return {
      I: Int32Array.from(I),
      J: Int32Array.from(J),
      V: Float64Array.from(V),
    };
  }

  // --------------------------------------------------------------------------
  //  assembleInteriorMagnetLoadAndJz(body, currents)
  //
  //  Returns the body's RHS contribution in MESH-node indexing (length =
  //  Nn_body). Caller applies the slave-distribution + renumbering via
  //  applyConstraintsToF.
  //
  //  RHS = ∫ Jz · N_i dA + ∫ (1/μ0)·(∇ × M) · N_i dA
  //
  //  Numerically:
  //    Jz term per element with constant Jz_e: contributes Jz_e · area/Nnodes to
  //    each of the element's nodes' RHS entries.
  //    Magnet term per element with M = (Mx, My) constant: contribution is
  //    `∫ (1/μ0)·(M_x · ∂N_i/∂y − M_y · ∂N_i/∂x) dA`
  //    For constant M and 1-point quadrature this is
  //    (1/μ0) · (M_x · <∂N_i/∂y> − M_y · <∂N_i/∂x>) · area.
  // --------------------------------------------------------------------------
  // Module-level scratch for assembleInteriorMagnetLoadAndJzInto. Reused
  // across every element of every call (motor-slice is single-threaded, so
  // no aliasing concern). dNdxAvg/dNdyAvg hold the area-weighted average of
  // ∂N/∂x and ∂N/∂y across the 2×2 Gauss points of a Q4 element.
  const _AILZ_dNdxAvg = new Float64Array(4);
  const _AILZ_dNdyAvg = new Float64Array(4);

  // assembleInteriorMagnetLoadAndJzInto(body, currents, out)
  //
  //   Writes the body's RHS contribution (mesh-node indexing, length NnBody)
  //   into `out`. Caller is responsible for sizing out correctly. The buffer
  //   is zeroed at the start of the call. No allocations.
  function assembleInteriorMagnetLoadAndJzInto(body, currents, out) {
    const NnBody = body.nodes.length / 2;
    for (let i = 0; i < NnBody; i++) out[i] = 0;
    const Ne = body.elems.length / 4;

    for (let e = 0; e < Ne; e++) {
      const mid  = body.matId[e];
      const mat  = body.materials[mid];
      const n0 = body.elems[4*e];
      const n1 = body.elems[4*e+1];
      const n2 = body.elems[4*e+2];
      const n3 = body.elems[4*e+3];

      // Compute element area + average grads + nodes list
      let area = 0;
      let dNdx_avg = null, dNdy_avg = null;
      let nLocal;

      if (n3 === -1) {
        const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
        const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
        const g = triGradients(xN, yN);
        area = g.area;
        dNdx_avg = g.dNdx;
        dNdy_avg = g.dNdy;
        nLocal = [n0, n1, n2];
      } else {
        const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
        const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
        let A = 0;
        const dNdxA = _AILZ_dNdxAvg;
        const dNdyA = _AILZ_dNdyAvg;
        dNdxA[0] = 0; dNdxA[1] = 0; dNdxA[2] = 0; dNdxA[3] = 0;
        dNdyA[0] = 0; dNdyA[1] = 0; dNdyA[2] = 0; dNdyA[3] = 0;
        for (let gs = 0; gs < 2; gs++) {
          for (let gt = 0; gt < 2; gt++) {
            const j = q4Jacobian(xN, yN, GP4_1D[gs], GP4_1D[gt]);
            const w = j.detJ;
            A += w;
            for (let i = 0; i < 4; i++) {
              dNdxA[i] += j.dNdx[i] * w;
              dNdyA[i] += j.dNdy[i] * w;
            }
          }
        }
        if (!(A > 0)) continue;
        area = A;
        for (let i = 0; i < 4; i++) {
          dNdxA[i] /= A;
          dNdyA[i] /= A;
        }
        dNdx_avg = dNdxA;
        dNdy_avg = dNdyA;
        nLocal = [n0, n1, n2, n3];
      }
      if (!(area > 0)) continue;

      if (mat && mat.kind === "conductor") {
        const sid = body.srcId[e];
        if (sid >= 0) {
          const cur = (currents && sid < currents.length) ? currents[sid] : 0;
          const turns = body.turns[e];
          const Jz = (cur * turns) / area;
          const load = Jz * area / nLocal.length;
          for (let i = 0; i < nLocal.length; i++) {
            out[nLocal[i]] += load;
          }
        }
      } else if (mat && mat.kind === "magnet" && mat.mrMag > 0) {
        // Magnet load — derivation from δW/δA = 0 with W = ∫(B²/(2μ₀) − M·B) dV:
        //
        //   ∫ ν·∇A·∇N dA = ∫ (M_x·∂N/∂y − M_y·∂N/∂x) dA           (in 2D axial-A)
        //   ───────────                ───────────────────────
        //         K                              f (no /μ₀)
        //
        // The previous code had `· area / MU0` on the RHS. That extra 1/μ₀ ≈ 8e+5
        // inflated the magnet load by six orders of magnitude, blowing up the
        // body A magnitude (1.37e+4 T·m for a moderate fixture, vs the ~1e-2 T·m
        // expected for the matching B values) and the downstream gap.torque
        // output to ~1e+11 N·m for ordinary configurations. The mesh-cache bug
        // that pinned mat.mrMag to a stale value hid this for the strong-magnet
        // tests; with the cache fixed and the magnet load correctly scaled,
        // torque comes out at physically reasonable N·m magnitudes that scale
        // as expected with Mr (linear → Mr², saturated → sub-quadratic).
        const dx = body.magDir[2 * e];
        const dy = body.magDir[2 * e + 1];
        const Mx = mat.mrMag * dx;
        const My = mat.mrMag * dy;
        for (let i = 0; i < nLocal.length; i++) {
          out[nLocal[i]] += (Mx * dNdy_avg[i] - My * dNdx_avg[i]) * area;
        }
      }
    }
    return out;
  }

  // Allocating wrapper preserved for test fixtures and create-time callers.
  function assembleInteriorMagnetLoadAndJz(body, currents) {
    const NnBody = body.nodes.length / 2;
    const f = new Float64Array(NnBody);
    return assembleInteriorMagnetLoadAndJzInto(body, currents, f);
  }

  // --------------------------------------------------------------------------
  //  Apply constraints: Cᵀ·K·C and Cᵀ·f, then renumber mesh-node → free-DOF
  //
  //  Inputs:
  //    triplets   — (I,J,V) in mesh-node indexing (slaves and pinned both
  //                 still appear with their mesh-node index).
  //    constraints — body.constraints or null.
  //    renumBody  — Int32Array(Nn) mapping mesh-node → free-DOF index, or -1
  //                 if pinned/slave (eliminated from the system).
  //
  //  Output: triplets in free-DOF indexing (length = nFreeBody). Slave
  //  rows/cols are distributed via the constraint weights into their
  //  masters; pinned rows/cols are dropped.
  // --------------------------------------------------------------------------
  function applyConstraintsToTriplets(triplets, constraints, renumBody) {
    // slaveMap: mesh-node slave index → [{ masterMeshIdx, weight }, ...]
    const slaveMap = new Map();
    if (constraints) {
      const slaves = constraints.slaves;
      const masters = constraints.masters;
      const S = slaves.length;
      for (let k = 0; k < S; k++) {
        const sMesh = slaves[k];
        const entry = [
          { master: masters[4*k],     w: masters[4*k + 1] },
          { master: masters[4*k + 2], w: masters[4*k + 3] },
        ];
        slaveMap.set(sMesh, entry);
      }
    }

    const I = triplets.I, J = triplets.J, V = triplets.V;
    const nt = I.length;
    const Io = [], Jo = [], Vo = [];

    // For each input triplet (i,j,v) — i and j are MESH node indices.
    // Expand slave entries through the master list (with weights), then
    // apply the renumbering. Triplets whose final renumbered index is -1
    // are dropped (pinned).
    for (let t = 0; t < nt; t++) {
      const i = I[t], j = J[t], v = V[t];
      const iList = slaveMap.has(i) ? slaveMap.get(i) : [{ master: i, w: 1 }];
      const jList = slaveMap.has(j) ? slaveMap.get(j) : [{ master: j, w: 1 }];
      for (let a = 0; a < iList.length; a++) {
        const im = iList[a];
        const iFree = renumBody[im.master];
        if (iFree < 0) continue;
        for (let b = 0; b < jList.length; b++) {
          const jm = jList[b];
          const jFree = renumBody[jm.master];
          if (jFree < 0) continue;
          Io.push(iFree);
          Jo.push(jFree);
          Vo.push(v * im.w * jm.w);
        }
      }
    }
    return {
      I: Int32Array.from(Io),
      J: Int32Array.from(Jo),
      V: Float64Array.from(Vo),
    };
  }

  // applyConstraintsToF(fMesh, constraints, renumBody, nFree)
  //
  //   fMesh — Float64Array(Nn_body) in mesh-node indexing.
  //   constraints — body.constraints or null.
  //   renumBody — Int32Array(Nn_body) mapping mesh idx → free-DOF idx (-1 if
  //               eliminated).
  //   nFree — output length.
  //
  // Returns Float64Array(nFree) in free-DOF indexing. Slave entries are
  // distributed to their masters via the constraint weights; pinned entries
  // are dropped.
  function applyConstraintsToF(fMesh, constraints, renumBody, nFree) {
    const slaveMap = new Map();
    if (constraints) {
      const slaves = constraints.slaves;
      const masters = constraints.masters;
      const S = slaves.length;
      for (let k = 0; k < S; k++) {
        const sMesh = slaves[k];
        const entry = [
          { master: masters[4*k],     w: masters[4*k + 1] },
          { master: masters[4*k + 2], w: masters[4*k + 3] },
        ];
        slaveMap.set(sMesh, entry);
      }
    }
    const out = new Float64Array(nFree);
    const N = fMesh.length;
    for (let i = 0; i < N; i++) {
      const v = fMesh[i];
      if (v === 0) continue;
      if (slaveMap.has(i)) {
        const list = slaveMap.get(i);
        for (let a = 0; a < list.length; a++) {
          const m = renumBody[list[a].master];
          if (m >= 0) out[m] += v * list[a].w;
        }
      } else {
        const fr = renumBody[i];
        if (fr >= 0) out[fr] += v;
      }
    }
    return out;
  }

  function recoverFullFromConstrained(Ahat, constraints, renumBody, NnBody) {
    // Build dense A_full of size NnBody. For free DOFs (renumBody[i]>=0) we
    // copy from Ahat[renumBody[i]]; pinned (renumBody[i]<0) get 0.
    const out = new Float64Array(NnBody);
    for (let i = 0; i < NnBody; i++) {
      const fi = renumBody[i];
      out[i] = (fi >= 0) ? Ahat[fi] : 0;
    }
    if (!constraints) return out;
    // Apply slave interpolation: out[slave] = Σ w·out[master]
    const slaves = constraints.slaves;
    const masters = constraints.masters;
    const S = slaves.length;
    for (let k = 0; k < S; k++) {
      const sNode = slaves[k];
      const mLnode = masters[4*k];
      const wL = masters[4*k + 1];
      const mRnode = masters[4*k + 2];
      const wR = masters[4*k + 3];
      out[sNode] = wL * out[mLnode] + wR * out[mRnode];
    }
    return out;
  }

  // --------------------------------------------------------------------------
  //  remapGapTriplets(localTriplets, gapLocalToGlobalRotor, gapLocalToGlobalStator,
  //                   nGr, nGs)
  //
  //  The harmonic stamp produces triplets in its own dofMap layout:
  //    [0..Ngr) rotor gap nodes (local), [Ngr..Ngr+Ngs) stator gap nodes,
  //    [Ngr+Ngs..Ngr+Ngs+perBody) rotor harmonics,
  //    [Ngr+Ngs+perBody..Ngr+Ngs+2*perBody) stator harmonics.
  //  We remap to GLOBAL combined indices.
  //
  //  gapLocalToGlobalRotor[i] = global index of rotor gap node i (in
  //  free-DOF rotor-then-stator concatenation; harmonics base = nRotorFree + nStatorFree).
  // --------------------------------------------------------------------------
  function remapGapTriplets(localTriplets, gapLocalToGlobalRotor, gapLocalToGlobalStator, nGr, nGs, harmonicBaseGlobal) {
    const I = localTriplets.I, J = localTriplets.J, V = localTriplets.V;
    const nt = I.length;
    const Io = new Int32Array(nt);
    const Jo = new Int32Array(nt);
    const Vo = new Float64Array(nt);
    function mapLocal(idx) {
      if (idx < nGr) return gapLocalToGlobalRotor[idx];
      if (idx < nGr + nGs) return gapLocalToGlobalStator[idx - nGr];
      return harmonicBaseGlobal + (idx - nGr - nGs);
    }
    for (let t = 0; t < nt; t++) {
      Io[t] = mapLocal(I[t]);
      Jo[t] = mapLocal(J[t]);
      Vo[t] = V[t];
    }
    return { I: Io, J: Jo, V: Vo };
  }

  // --------------------------------------------------------------------------
  //  newtonSolve({ solver, A0, assembleResidualAndTangent, maxIter, tol, residualTol })
  //
  //  Generic Brauer-Newton driver. assembleResidualAndTangent(A) returns
  //    { K: { I, J, V }, f: Float64Array, residual: Float64Array }
  //  where K is the FULL tangent (including 2·dν/dB² rank-1 updates), f is
  //  the RHS, and residual = K_lin(A)·A − f (the consistent residual).
  //
  //  Stopping:
  //    ΔA-norm: ‖ΔA‖∞ / (‖A‖∞ + ε) < tol
  //    residual: ‖K·A − f‖∞ / (‖f‖∞ + ε) < residualTol
  // --------------------------------------------------------------------------
  function newtonSolve(args) {
    const solver = args.solver;
    const A0 = args.A0;
    const f = args.assembleResidualAndTangent;
    const maxIter = args.maxIter != null ? args.maxIter : 8;
    const tol = args.tol != null ? args.tol : 1e-6;
    const residualTol = args.residualTol != null ? args.residualTol : 1e-9;
    const eps = 1e-30;

    const n = A0.length;
    let A = new Float64Array(n);
    A.set(A0);

    let iters = 0;
    let deltaNorm = Infinity;
    let residualScaled = Infinity;
    let converged = false;

    for (let it = 0; it < maxIter; it++) {
      iters = it + 1;
      const { K, f: rhs, residual } = f(A);
      // Push tangent into the solver
      solver.setValues(K.V);
      solver.factorize();

      // Solve J·ΔA = -residual  (Newton update)
      // residual was computed as K_current(A)·A − rhs (the current iterate's
      // residual). Wait — there are two valid formulations:
      //   (i) Picard: solve K(A_k)·A_{k+1} = f → "solve" then A_{k+1} = K^{-1}·f
      //   (ii) Newton: solve J(A_k)·ΔA = −R(A_k) where R = K_lin(A_k)·A_k − f
      //                and J = K_lin + (∂K/∂A)·A
      //
      // The "K" passed by assembleResidualAndTangent IS the Newton tangent J.
      // The "residual" is R(A_k). So compute ΔA = solver.solve(−R).
      const neg = new Float64Array(residual.length);
      for (let i = 0; i < residual.length; i++) neg[i] = -residual[i];
      const dA = solver.solve(neg);

      // Update A
      let aMax = 0, dMax = 0;
      for (let i = 0; i < n; i++) {
        if (Math.abs(A[i]) > aMax) aMax = Math.abs(A[i]);
        if (Math.abs(dA[i]) > dMax) dMax = Math.abs(dA[i]);
        A[i] += dA[i];
      }
      deltaNorm = dMax / (aMax + eps);

      // Residual check at NEW A (re-call f? expensive). Approximate with the
      // residual we just used pre-update — that is the residual at A_k.
      let rMax = 0, fMax = 0;
      for (let i = 0; i < residual.length; i++) {
        if (Math.abs(residual[i]) > rMax) rMax = Math.abs(residual[i]);
        if (Math.abs(rhs[i]) > fMax) fMax = Math.abs(rhs[i]);
      }
      residualScaled = rMax / (fMax + eps);

      if (deltaNorm < tol && residualScaled < residualTol) {
        converged = true;
        break;
      }
    }

    // One more residual check at the final A
    const final = f(A);
    let rMax = 0, fMax = 0;
    for (let i = 0; i < final.residual.length; i++) {
      if (Math.abs(final.residual[i]) > rMax) rMax = Math.abs(final.residual[i]);
      if (Math.abs(final.f[i]) > fMax) fMax = Math.abs(final.f[i]);
    }
    residualScaled = rMax / (fMax + eps);
    if (deltaNorm < tol && residualScaled < residualTol) converged = true;

    return { A, iters, deltaNorm, residual: residualScaled, converged };
  }

  // --------------------------------------------------------------------------
  //  create(section, opts) — public factory
  // --------------------------------------------------------------------------
  function create(section, opts) {
    if (!LIB.FeaSolver || typeof LIB.FeaSolver.isInitialized !== "function" ||
        !LIB.FeaSolver.isInitialized()) {
      throw new Error(
        "LIB.MotorSlice.create: LIB.FeaSolver.init() has not resolved; " +
        "await it before constructing a slice"
      );
    }

    opts = opts || {};
    const meshOpts = opts.mesh || {};
    const sat = Object.assign({ enabled: true, BkneeDefault: 1.6 }, opts.saturation || {});
    // residualTol = 1e-6: relative ‖K·A − f‖∞ / ‖f‖∞ at convergence.
    // The mesh-discretisation error on torque is ~1e-2 to 1e-3 in this slice
    // pipeline, so a Newton residual three orders tighter than the mesh
    // floor would just spend wall-clock iterations chasing arithmetic noise.
    // Was 1e-9 historically; loosened 2026-05-29 once the Brauer-overflow
    // false-convergence path was removed (the old gate of 1e-9 was met only
    // because residual values were NaN-masked to zero — see Phase 5 Wave 5.4
    // progress notes).
    const newtonOpts = Object.assign(
      { maxIter: 8, tol: 1e-6, residualTol: 1e-6 },
      opts.newton || {}
    );

    // ------------ Build meshes (Phase-2) ------------
    // Compose physics from the section's features and the caller's opts.poles.
    // We don't have the original config in hand. The mesher accepts a physics
    // object computed from a config. As a substitute, derive a minimal physics
    // from the section + opts.poles. The mesher uses physics primarily for
    // tangentialPhysicsTargets (slice-wide ν_max from windings); a windings
    // map keyed off the section's conductor features gives the same result.
    const slots = derivedSlots(section);
    const poles = derivedPoles(opts);

    // Build a synthetic physics object understood by motor-mesh.
    const windings = new Map();
    // Each unique (member, kind, rRange[0..1]) on the stator that has conductor
    // count > 1 contributes one wound entry; this matches the realistic ring
    // routing.
    let woundIdx = 0;
    const sFeats = (section.features || []).filter(f => f && f.member === "stator");
    const sCondGroups = new Map();
    for (const f of sFeats) {
      if (f.kind !== "conductor") continue;
      const key = f.rRange[0] + "|" + f.rRange[1];
      if (!sCondGroups.has(key)) sCondGroups.set(key, 0);
      sCondGroups.set(key, sCondGroups.get(key) + 1);
    }
    for (const Q of sCondGroups.values()) {
      windings.set(woundIdx++, { kind: "wound", m: 1, p: poles, Q, member: "stator" });
    }
    if (windings.size === 0) {
      windings.set(0, { kind: "wound", m: 1, p: poles, Q: slots, member: "stator" });
    }
    const physics = { circuits: [], windings, poles };

    // Pre-compute K so we can guarantee the mesher gives us N_gap >= 4K on
    // both bodies (Phase-4 build guard). gapMinNodes wins when the caller
    // hasn't asked for a larger value already.
    const K = (opts.K != null)
      ? opts.K
      : LIB.AirgapHarmonic.defaultK(slots, poles);
    const requiredGapNodes = 4 * K;
    const callerGapMin = meshOpts.gapMinNodes != null ? meshOpts.gapMinNodes : 0;
    const meshOptsFinal = Object.assign({}, meshOpts, {
      physics,
      gapMinNodes: Math.max(callerGapMin, requiredGapNodes),
    });

    const meshPair = LIB.MotorMesh.buildCached(section, meshOptsFinal);
    const rotorMesh = meshPair.rotor;
    const statorMesh = meshPair.stator;

    // ------------ Build harmonic gap (Phase-4) ------------
    const ell = section.grid.ell;

    const rotorGap = { gapTheta: rotorMesh.gapTheta, gapR: rotorMesh.gapR };
    const statorGap = { gapTheta: statorMesh.gapTheta, gapR: statorMesh.gapR };
    const gap = LIB.AirgapHarmonic.build(rotorGap, statorGap, { K, ell });

    // ------------ Outer-stator Dirichlet pin (D6) ------------
    const rOuter = section.grid.rOuter;
    const pinInfo = eliminateOuterStatorPin(rotorMesh, statorMesh, rOuter);
    const renumR = pinInfo.renumbering.rotor;
    const renumS = pinInfo.renumbering.stator;
    const nRotorFree  = pinInfo.nRotorFree;
    const nStatorFree = pinInfo.nStatorFree;

    // ------------ Global layout ------------
    const Ngr = rotorMesh.gapLoop.length;
    const Ngs = statorMesh.gapLoop.length;
    const perBody = 2 * K + 1;
    const nHarmonicDofs = 2 * perBody;
    const nGlobal = nRotorFree + nStatorFree + nHarmonicDofs;

    // gap-local → global index maps for body gap loops
    const gapLocalToGlobalRotor = new Int32Array(Ngr);
    for (let i = 0; i < Ngr; i++) {
      const orig = rotorMesh.gapLoop[i];
      const fr = renumR[orig];
      gapLocalToGlobalRotor[i] = fr; // rotor base = 0
    }
    const gapLocalToGlobalStator = new Int32Array(Ngs);
    for (let i = 0; i < Ngs; i++) {
      const orig = statorMesh.gapLoop[i];
      const fr = renumS[orig];
      gapLocalToGlobalStator[i] = nRotorFree + fr; // stator base offset
    }
    const harmonicBaseGlobal = nRotorFree + nStatorFree;

    // ------------ Slave-map precompute (Wave 5.4 A) ------------
    //
    // The Map-based slave lookup inside applyConstraintsToTriplets and
    // applyConstraintsToF is called several times per Newton iter and rebuilt
    // each time. Precompute a typed-array representation of the constraint
    // structure per body that lets us check "is i a slave?" in O(1) without
    // allocating a Map per call.
    //
    //   isSlave[i]    — 1 if node i is a slave, 0 otherwise
    //   masterL[i]    — left  master node index if slave (else -1)
    //   masterR[i]    — right master node index if slave (else -1)
    //   weightL[i]    — left  master weight if slave
    //   weightR[i]    — right master weight if slave
    //
    // Sized to the body's mesh node count so direct indexing works.
    function buildSlaveTable(mesh) {
      const NnBody = mesh.nodes.length / 2;
      const isSlave = new Uint8Array(NnBody);
      const masterL = new Int32Array(NnBody);
      const masterR = new Int32Array(NnBody);
      const weightL = new Float64Array(NnBody);
      const weightR = new Float64Array(NnBody);
      masterL.fill(-1);
      masterR.fill(-1);
      const c = mesh.constraints;
      if (c) {
        const slaves = c.slaves;
        const masters = c.masters;
        const S = slaves.length;
        for (let k = 0; k < S; k++) {
          const s = slaves[k];
          isSlave[s] = 1;
          masterL[s] = masters[4*k];
          weightL[s] = masters[4*k + 1];
          masterR[s] = masters[4*k + 2];
          weightR[s] = masters[4*k + 3];
        }
      }
      return { isSlave, masterL, masterR, weightL, weightR };
    }
    const slaveTableR = buildSlaveTable(rotorMesh);
    const slaveTableS = buildSlaveTable(statorMesh);

    // ------------ Material array dispatch tables ------------
    function buildMaterialTable(mesh) {
      // Returns Float64Array(nMats * 2): [linNu_i, isIron_i] arrays sized by
      // body.materials.length. We use full Maps to dispatch instead.
      const mats = mesh.materials;
      const linNu = new Float64Array(mats.length);
      const flags = new Int32Array(mats.length); // 0=air 1=iron 2=magnet 3=conductor
      for (let i = 0; i < mats.length; i++) {
        const m = mats[i];
        linNu[i] = 1 / (MU0 * (m.muR != null ? m.muR : 1));
        if (m.kind === "iron") flags[i] = 1;
        else if (m.kind === "magnet") flags[i] = 2;
        else if (m.kind === "conductor") flags[i] = 3;
        else flags[i] = 0;
      }
      return { linNu, flags };
    }
    const rotorMatTable  = buildMaterialTable(rotorMesh);
    const statorMatTable = buildMaterialTable(statorMesh);

    // ------------ Element-νPerElem helpers ------------
    function linearNuFor(body, table) {
      const Ne = body.elems.length / 4;
      const arr = new Float64Array(Ne);
      for (let e = 0; e < Ne; e++) {
        arr[e] = table.linNu[body.matId[e]];
      }
      return arr;
    }

    // Compute B² per element from a full nodal-A vector (Nn-long).
    function elementB2(body, Anodal) {
      const Ne = body.elems.length / 4;
      const out = new Float64Array(Ne);
      for (let e = 0; e < Ne; e++) {
        const b = bElement(body, e, Anodal);
        out[e] = b.Bx * b.Bx + b.By * b.By;
      }
      return out;
    }

    // ------------ Assemble combined triplets at angle phi ------------
    //
    // The combined-pattern function. For symmetry / φ-invariance tests we
    // assemble at any phi using linear-material ν per element.
    function assembleCombinedTriplets_phi(phi, νRotorPerElem, νStatorPerElem) {
      // Body interior in mesh-node indexing; then distribute slaves + renumber
      // into free-DOF indexing. Use the Newton-tangent assembly path with
      // dν=0 / dummy-A so the triplet count matches the pattern (which is set
      // with the rank-1 block emitted).
      const NnR_full = rotorMesh.nodes.length / 2;
      const NnS_full = statorMesh.nodes.length / 2;
      const zeroAR = new Float64Array(NnR_full);
      const zeroAS = new Float64Array(NnS_full);
      const dνR = new Float64Array(rotorMesh.elems.length / 4);
      const dνS = new Float64Array(statorMesh.elems.length / 4);
      for (let e = 0; e < dνR.length; e++) {
        if (rotorMesh.materials[rotorMesh.matId[e]].kind === "iron") dνR[e] = 0;
      }
      for (let e = 0; e < dνS.length; e++) {
        if (statorMesh.materials[statorMesh.matId[e]].kind === "iron") dνS[e] = 0;
      }
      // Pass non-null dνPerElem and dummy A so the rank-1 emission path runs
      // (emits zero-valued triplets at the same coordinates as the pattern).
      let rTrip = assembleBodyTangentTriplets(rotorMesh,  νRotorPerElem,  dνR, zeroAR);
      let sTrip = assembleBodyTangentTriplets(statorMesh, νStatorPerElem, dνS, zeroAS);

      rTrip = applyConstraintsToTriplets(rTrip, rotorMesh.constraints, renumR);
      sTrip = applyConstraintsToTriplets(sTrip, statorMesh.constraints, renumS);

      // Harmonic stamp triplets in local layout
      const stamp = gap.stamp(phi);
      const harmTrip = remapGapTriplets(
        stamp,
        gapLocalToGlobalRotor,
        gapLocalToGlobalStator,
        Ngr,
        Ngs,
        harmonicBaseGlobal
      );

      // Concatenate. Rotor indices stay as-is, stator indices offset by nRotorFree.
      const nt = rTrip.I.length + sTrip.I.length + harmTrip.I.length;
      const I = new Int32Array(nt);
      const J = new Int32Array(nt);
      const V = new Float64Array(nt);
      let p = 0;
      for (let t = 0; t < rTrip.I.length; t++) {
        I[p] = rTrip.I[t];
        J[p] = rTrip.J[t];
        V[p] = rTrip.V[t];
        p++;
      }
      for (let t = 0; t < sTrip.I.length; t++) {
        I[p] = sTrip.I[t] + nRotorFree;
        J[p] = sTrip.J[t] + nRotorFree;
        V[p] = sTrip.V[t];
        p++;
      }
      for (let t = 0; t < harmTrip.I.length; t++) {
        I[p] = harmTrip.I[t];
        J[p] = harmTrip.J[t];
        V[p] = harmTrip.V[t];
        p++;
      }
      return { I, J, V };
    }

    function assembleCombinedTriplets(sec, op, phi) {
      // sec/op currently ignored — slice already captured its section. The
      // signature matches the spec test wording.
      const νR = linearNuFor(rotorMesh,  rotorMatTable);
      const νS = linearNuFor(statorMesh, statorMatTable);
      return assembleCombinedTriplets_phi(phi, νR, νS);
    }

    // ------------ Solver instances (saturated + linear) ------------
    const solverSat = LIB.FeaSolver.create();
    const solverLin = LIB.FeaSolver.create();

    // Pattern assembly: include the Newton-tangent rank-1 entries so the
    // pattern matches the saturated assembly's triplet count. Duplicate (i,j)
    // coordinates are merged by the WASM scatter map; only the position set
    // matters for pattern + analyze. Values are recomputed every Newton iter
    // via setValues, so the placeholder dν=1 here just exercises the rank-1
    // emission path.
    function assemblePatternTriplets() {
      const νR = linearNuFor(rotorMesh,  rotorMatTable);
      const νS = linearNuFor(statorMesh, statorMatTable);
      const NnR_full = rotorMesh.nodes.length / 2;
      const NnS_full = statorMesh.nodes.length / 2;
      const dummyAR = new Float64Array(NnR_full);
      const dummyAS = new Float64Array(NnS_full);
      const dνR_pat = new Float64Array(rotorMesh.elems.length / 4);
      const dνS_pat = new Float64Array(statorMesh.elems.length / 4);
      // Mark every iron element with dν=1 so the rank-1 block is emitted.
      for (let e = 0; e < dνR_pat.length; e++) {
        if (rotorMesh.materials[rotorMesh.matId[e]].kind === "iron") dνR_pat[e] = 1;
      }
      for (let e = 0; e < dνS_pat.length; e++) {
        if (statorMesh.materials[statorMesh.matId[e]].kind === "iron") dνS_pat[e] = 1;
      }
      // Dummy A: a non-trivial vector so the gA gradient is non-zero (the
      // pattern coordinates are emitted regardless, but ensuring values are
      // non-zero defends against any future "skip if zero" optimisation).
      for (let i = 0; i < NnR_full; i++) dummyAR[i] = 1;
      for (let i = 0; i < NnS_full; i++) dummyAS[i] = 1;
      let rTrip = assembleBodyTangentTriplets(rotorMesh,  νR, dνR_pat, dummyAR);
      let sTrip = assembleBodyTangentTriplets(statorMesh, νS, dνS_pat, dummyAS);
      rTrip = applyConstraintsToTriplets(rTrip, rotorMesh.constraints, renumR);
      sTrip = applyConstraintsToTriplets(sTrip, statorMesh.constraints, renumS);
      const stamp = gap.stamp(0);
      const harmTrip = remapGapTriplets(
        stamp, gapLocalToGlobalRotor, gapLocalToGlobalStator, Ngr, Ngs, harmonicBaseGlobal
      );
      const nt = rTrip.I.length + sTrip.I.length + harmTrip.I.length;
      const I = new Int32Array(nt);
      const J = new Int32Array(nt);
      const V = new Float64Array(nt);
      let p = 0;
      for (let t = 0; t < rTrip.I.length; t++) {
        I[p] = rTrip.I[t]; J[p] = rTrip.J[t]; V[p] = rTrip.V[t]; p++;
      }
      for (let t = 0; t < sTrip.I.length; t++) {
        I[p] = sTrip.I[t] + nRotorFree; J[p] = sTrip.J[t] + nRotorFree; V[p] = sTrip.V[t]; p++;
      }
      for (let t = 0; t < harmTrip.I.length; t++) {
        I[p] = harmTrip.I[t]; J[p] = harmTrip.J[t]; V[p] = harmTrip.V[t]; p++;
      }
      return { I, J, V };
    }

    const patternTrip = assemblePatternTriplets();
    solverSat.setPattern(nGlobal, patternTrip.I, patternTrip.J);
    solverSat.setValues(patternTrip.V);
    solverSat.analyze();

    solverLin.setPattern(nGlobal, patternTrip.I, patternTrip.J);
    solverLin.setValues(patternTrip.V);
    solverLin.analyze();

    // ------------ Wave 5.4 A: scratch buffers + per-body triplet sizes ------------
    //
    // Probe the body+constraint triplet sizes once at create-time by replaying
    // assembleBodyTangentTriplets + applyConstraintsToTriplets on the same dummy
    // pattern data that assemblePatternTriplets used. The pattern emission path
    // is deterministic, so these counts are exact upper bounds for any
    // subsequent build() call at any (θ, A_iter).
    // ------------ Wave 5.4 B: per-element kernel cache ------------
    //
    // Precompute the element-local geometric stiffness K_geom and rank-1
    // gradient kernels (dNdx, dNdy at center / standard tri + area) per body.
    // These are phi-invariant AND A-invariant — they only depend on mesh
    // geometry. The hot path then computes K_lin V values as ν·K_geom and
    // the rank-1 augment as 2·dν·area·gA·gAᵀ from cached gradients, avoiding
    // q4Jacobian / triGradients per Newton iter.
    //
    // Memory: per body ~ Ne·16 floats for K_lin + Ne·9 floats for rank-1.
    // For a full-annulus zero-symmetry mesh that's ~250-400 KB per body —
    // negligible vs the 17 MB Schur Wave-C will allocate.
    function buildBodyKernels(body) {
      const Ne = body.elems.length / 4;
      const nodes = body.nodes;
      const elems = body.elems;
      const matId = body.matId;
      const materials = body.materials;

      // First pass: nLoc per element, then prefix-sum offsets into the
      // K_lin flat buffer.
      const nLoc = new Uint8Array(Ne);
      const offsets = new Int32Array(Ne + 1);
      let totalKlin = 0;
      for (let e = 0; e < Ne; e++) {
        const n = (elems[4*e + 3] === -1) ? 3 : 4;
        nLoc[e] = n;
        offsets[e] = totalKlin;
        totalKlin += n * n;
      }
      offsets[Ne] = totalKlin;

      const Klin   = new Float64Array(totalKlin);
      const r1dx   = new Float64Array(Ne * 4); // 4-wide always; tri uses first 3
      const r1dy   = new Float64Array(Ne * 4);
      const r1area = new Float64Array(Ne);
      const isIron = new Uint8Array(Ne);

      for (let e = 0; e < Ne; e++) {
        isIron[e] = (materials[matId[e]].kind === "iron") ? 1 : 0;
        const off = offsets[e];
        const n = nLoc[e];
        const n0 = elems[4*e],   n1 = elems[4*e+1];
        const n2 = elems[4*e+2], n3 = elems[4*e+3];
        if (n === 3) {
          const xN = [nodes[2*n0], nodes[2*n1], nodes[2*n2]];
          const yN = [nodes[2*n0+1], nodes[2*n1+1], nodes[2*n2+1]];
          const g = triGradients(xN, yN);
          const area = g.area;
          r1area[e] = area;
          if (area > 0) {
            const dNdx = g.dNdx, dNdy = g.dNdy;
            r1dx[4*e + 0] = dNdx[0]; r1dx[4*e + 1] = dNdx[1]; r1dx[4*e + 2] = dNdx[2];
            r1dy[4*e + 0] = dNdy[0]; r1dy[4*e + 1] = dNdy[1]; r1dy[4*e + 2] = dNdy[2];
            for (let a = 0; a < 3; a++) {
              for (let b = 0; b < 3; b++) {
                Klin[off + a*3 + b] = (dNdx[a]*dNdx[b] + dNdy[a]*dNdy[b]) * area;
              }
            }
          }
        } else {
          const xN = [nodes[2*n0], nodes[2*n1], nodes[2*n2], nodes[2*n3]];
          const yN = [nodes[2*n0+1], nodes[2*n1+1], nodes[2*n2+1], nodes[2*n3+1]];
          // K_lin: 2x2 Gauss, accumulate (dNdx·dNdx + dNdy·dNdy)·detJ per
          // node-pair into the 4x4 block.
          for (let gs = 0; gs < 2; gs++) {
            for (let gt = 0; gt < 2; gt++) {
              const j = q4Jacobian(xN, yN, GP4_1D[gs], GP4_1D[gt]);
              if (!(j.detJ > 0)) continue;
              const w = j.detJ;
              const jx = j.dNdx, jy = j.dNdy;
              for (let a = 0; a < 4; a++) {
                for (let b = 0; b < 4; b++) {
                  Klin[off + a*4 + b] += w * (jx[a]*jx[b] + jy[a]*jy[b]);
                }
              }
            }
          }
          // Rank-1 gradients: 1-pt at center (s=0, t=0). area = 4·detJ_center
          // matches the old assembleBodyTangentTriplets line `area = 4 * j.detJ`.
          const jc = q4Jacobian(xN, yN, 0, 0);
          r1area[e] = 4 * jc.detJ;
          r1dx[4*e + 0] = jc.dNdx[0]; r1dx[4*e + 1] = jc.dNdx[1];
          r1dx[4*e + 2] = jc.dNdx[2]; r1dx[4*e + 3] = jc.dNdx[3];
          r1dy[4*e + 0] = jc.dNdy[0]; r1dy[4*e + 1] = jc.dNdy[1];
          r1dy[4*e + 2] = jc.dNdy[2]; r1dy[4*e + 3] = jc.dNdy[3];
        }
      }

      return { Klin, offsets, nLoc, r1dx, r1dy, r1area, isIron };
    }
    const rotorKernels  = buildBodyKernels(rotorMesh);
    const statorKernels = buildBodyKernels(statorMesh);

    const _probeNuR = linearNuFor(rotorMesh,  rotorMatTable);
    const _probeNuS = linearNuFor(statorMesh, statorMatTable);
    const _probeAR  = new Float64Array(rotorMesh.nodes.length / 2);
    const _probeAS  = new Float64Array(statorMesh.nodes.length / 2);
    const _probeDnuR = new Float64Array(rotorMesh.elems.length / 4);
    const _probeDnuS = new Float64Array(statorMesh.elems.length / 4);
    for (let e = 0; e < _probeDnuR.length; e++) {
      if (rotorMesh.materials[rotorMesh.matId[e]].kind === "iron") _probeDnuR[e] = 1;
    }
    for (let e = 0; e < _probeDnuS.length; e++) {
      if (statorMesh.materials[statorMesh.matId[e]].kind === "iron") _probeDnuS[e] = 1;
    }
    for (let i = 0; i < _probeAR.length; i++) _probeAR[i] = 1;
    for (let i = 0; i < _probeAS.length; i++) _probeAS[i] = 1;
    const _probeRtripMesh = assembleBodyTangentTriplets(rotorMesh,  _probeNuR, _probeDnuR, _probeAR);
    const _probeStripMesh = assembleBodyTangentTriplets(statorMesh, _probeNuS, _probeDnuS, _probeAS);
    const _probeRtripConstr = applyConstraintsToTriplets(_probeRtripMesh, rotorMesh.constraints, renumR);
    const _probeStripConstr = applyConstraintsToTriplets(_probeStripMesh, statorMesh.constraints, renumS);
    const _probeStamp = gap.stamp(0);

    const maxBodyTripR_mesh   = _probeRtripMesh.I.length;
    const maxBodyTripS_mesh   = _probeStripMesh.I.length;
    const maxBodyTripR_constr = _probeRtripConstr.I.length;
    const maxBodyTripS_constr = _probeStripConstr.I.length;
    const harmTripCount       = _probeStamp.I.length;
    const combinedTripCount   = patternTrip.V.length;

    // Per-body mesh-node sizes used by the inline helpers below.
    const NnR_full = rotorMesh.nodes.length / 2;
    const NnS_full = statorMesh.nodes.length / 2;
    const NeR_full = rotorMesh.elems.length / 4;
    const NeS_full = statorMesh.elems.length / 4;

    const scratch = {
      // Full-A per body (recoverFullFromConstrained outputs)
      fullA_rotor:  new Float64Array(NnR_full),
      fullA_stator: new Float64Array(NnS_full),

      // ν / dν per element
      nu_rotor:  new Float64Array(NeR_full),
      dnu_rotor: new Float64Array(NeR_full),
      nu_stator: new Float64Array(NeS_full),
      dnu_stator: new Float64Array(NeS_full),

      // bodyKtimesAMesh outputs (mesh-node indexing)
      KAR_mesh: new Float64Array(NnR_full),
      KAS_mesh: new Float64Array(NnS_full),

      // applyConstraintsToF outputs (free-DOF indexing)
      KAR_free: new Float64Array(nRotorFree),
      KAS_free: new Float64Array(nStatorFree),

      // f mesh-side and free-side (rhs assembly)
      fR_mesh: new Float64Array(NnR_full),
      fS_mesh: new Float64Array(NnS_full),
      fR_free: new Float64Array(nRotorFree),
      fS_free: new Float64Array(nStatorFree),

      // Harmonic K·A and global residual / rhs / A_iter / neg / A_prev
      // A_prev: pre-step snapshot used by the damped-Newton line-search
      //         backtracker so it can rebuild A_iter at α·dA for any α.
      KAh:      new Float64Array(nGlobal),
      rhs:      new Float64Array(nGlobal),
      residual: new Float64Array(nGlobal),
      A_iter:   new Float64Array(nGlobal),
      A_prev:   new Float64Array(nGlobal),
      neg:      new Float64Array(nGlobal),

      // Body-tangent mesh-indexed triplets (per body)
      tripR_mesh_I: new Int32Array(maxBodyTripR_mesh),
      tripR_mesh_J: new Int32Array(maxBodyTripR_mesh),
      tripR_mesh_V: new Float64Array(maxBodyTripR_mesh),
      tripS_mesh_I: new Int32Array(maxBodyTripS_mesh),
      tripS_mesh_J: new Int32Array(maxBodyTripS_mesh),
      tripS_mesh_V: new Float64Array(maxBodyTripS_mesh),

      // Constrained free-DOF triplets (per body)
      tripR_constr_I: new Int32Array(maxBodyTripR_constr),
      tripR_constr_J: new Int32Array(maxBodyTripR_constr),
      tripR_constr_V: new Float64Array(maxBodyTripR_constr),
      tripS_constr_I: new Int32Array(maxBodyTripS_constr),
      tripS_constr_J: new Int32Array(maxBodyTripS_constr),
      tripS_constr_V: new Float64Array(maxBodyTripS_constr),

      // Harmonic stamp triplets in GLOBAL indexing (per-phi cache, refreshed
      // at the start of each solveStaticRotor call before any build() runs).
      harmTrip_I: new Int32Array(harmTripCount),
      harmTrip_J: new Int32Array(harmTripCount),
      harmTrip_V: new Float64Array(harmTripCount),
      harmTrip_n: harmTripCount,

      // Gap stamp scratch in LOCAL indexing (gap-local + harm-local). Sized
      // to gap.tripletCapacity. gap.stampInto writes here; remapStampInto
      // then copies into the per-call destination (harmTrip_* for the
      // saturated path, schurScratch.stamp* for the Schur path) with global
      // indexing.
      gapStampLocal_I: new Int32Array(gap.tripletCapacity),
      gapStampLocal_J: new Int32Array(gap.tripletCapacity),
      gapStampLocal_V: new Float64Array(gap.tripletCapacity),

      // solveInto targets for the saturated path: A_lin for the linear-mode
      // bypass result, dA for the Newton step. Both are nGlobal-sized.
      A_lin: new Float64Array(nGlobal),
      dA:    new Float64Array(nGlobal),

      // Gap-circle nodal A scratch — used by slice.solve and coggingTorque,
      // consumed by gap.torque/gap.project within the same call. Not part
      // of the returned field object (only the projected harmonics survive).
      gapNodal_R: new Float64Array(Ngr),
      gapNodal_S: new Float64Array(Ngs),

      // slice.solve output-field scratch. These arrays alias into the
      // returned `field` object — the caller must consume or snapshot them
      // before the next slice.solve call on this instance. See slice.solve
      // for the field-result object structure.
      fieldR_Anode:    null,  // = scratch.fullA_rotor (NnR_full); pointer added after scratch is built
      fieldS_Anode:    null,  // = scratch.fullA_stator (NnS_full)
      fieldR_Belem_mag: new Float64Array(NeR_full),
      fieldR_Belem_Bx:  new Float64Array(NeR_full),
      fieldR_Belem_By:  new Float64Array(NeR_full),
      fieldS_Belem_mag: new Float64Array(NeS_full),
      fieldS_Belem_Bx:  new Float64Array(NeS_full),
      fieldS_Belem_By:  new Float64Array(NeS_full),
      harmR_a: new Float64Array(K + 1),
      harmR_b: new Float64Array(K + 1),
      harmS_a: new Float64Array(K + 1),
      harmS_b: new Float64Array(K + 1),

      // Combined V buffer (in pattern order) handed to solver.setValues.
      V_combined: new Float64Array(combinedTripCount),
      combinedTripCount: combinedTripCount,
    };

    // Aliases — the slice.solve field-result wraps these scratch arrays.
    // We point fieldR_Anode at scratch.fullA_rotor (rather than a separate
    // buffer) because the recover step that fills field.rotor.Anode already
    // writes to scratch.fullA_rotor; the two names refer to the same memory.
    scratch.fieldR_Anode = scratch.fullA_rotor;
    scratch.fieldS_Anode = scratch.fullA_stator;

    // Pre-built result skeleton for slice.solve. Each call REUSES this
    // object and its typed-array members (which all alias scratch). The
    // caller MUST consume `field` / `fluxLinkages` before the next
    // slice.solve call on this instance — fluxLinkages is sized to nCircuits
    // and is wired in after computeNCircuits() runs.
    const _solveResultR_Belem = {
      mag: scratch.fieldR_Belem_mag,
      Bx:  scratch.fieldR_Belem_Bx,
      By:  scratch.fieldR_Belem_By,
    };
    const _solveResultS_Belem = {
      mag: scratch.fieldS_Belem_mag,
      Bx:  scratch.fieldS_Belem_Bx,
      By:  scratch.fieldS_Belem_By,
    };
    const _solveResultHarmR = { a: scratch.harmR_a, b: scratch.harmR_b };
    const _solveResultHarmS = { a: scratch.harmS_a, b: scratch.harmS_b };
    const _solveResultField = {
      rotor:  { mesh: rotorMesh,  Anode: scratch.fieldR_Anode, Belem: _solveResultR_Belem },
      stator: { mesh: statorMesh, Anode: scratch.fieldS_Anode, Belem: _solveResultS_Belem },
      gap: {
        harmonics: { rotor: _solveResultHarmR, stator: _solveResultHarmS },
        phi: 0,
      },
    };
    // Sized to nCircuits below.
    let _solveResultFluxLinkages = null;
    const _solveResult = { torque: 0, fluxLinkages: null, field: _solveResultField };

    // ------------ Wave 5.4 A: in-place helper variants ------------
    //
    // Each helper has a "*Into" variant taking preallocated output buffers.
    // Existing helpers (recoverFullFromConstrained, νPerElemFromA,
    // applyConstraintsToTriplets, etc.) keep their allocating signatures for
    // test compatibility; the hot path inside solveStaticRotor calls the
    // *Into variants directly.

    function recoverFullFromConstrainedInto(Ahat, slaveTable, renumBody, NnBody, out) {
      // Inline what recoverFullFromConstrained does, without allocation.
      const isSlave = slaveTable.isSlave;
      const masterL = slaveTable.masterL;
      const masterR = slaveTable.masterR;
      const weightL = slaveTable.weightL;
      const weightR = slaveTable.weightR;
      for (let i = 0; i < NnBody; i++) {
        if (isSlave[i]) { out[i] = 0; continue; }
        const fi = renumBody[i];
        out[i] = (fi >= 0) ? Ahat[fi] : 0;
      }
      // Slave interpolation pass — depends on master values already filled.
      for (let i = 0; i < NnBody; i++) {
        if (!isSlave[i]) continue;
        out[i] = weightL[i] * out[masterL[i]] + weightR[i] * out[masterR[i]];
      }
      return out;
    }

    // Read an Ahat sub-slice (offset, len) instead of allocating a sub-array.
    function recoverFullFromBigA_Into(Abig, baseOffset, len, slaveTable, renumBody, NnBody, out) {
      const isSlave = slaveTable.isSlave;
      const masterL = slaveTable.masterL;
      const masterR = slaveTable.masterR;
      const weightL = slaveTable.weightL;
      const weightR = slaveTable.weightR;
      for (let i = 0; i < NnBody; i++) {
        if (isSlave[i]) { out[i] = 0; continue; }
        const fi = renumBody[i];
        out[i] = (fi >= 0) ? Abig[baseOffset + fi] : 0;
      }
      for (let i = 0; i < NnBody; i++) {
        if (!isSlave[i]) continue;
        out[i] = weightL[i] * out[masterL[i]] + weightR[i] * out[masterR[i]];
      }
      return out;
    }

    function nuPerElemFromAInto(body, table, fullAbody, outNu, outDnu) {
      const Ne = body.elems.length / 4;
      const matId = body.matId;
      const materials = body.materials;
      const BkneeDefault = sat.BkneeDefault;
      for (let e = 0; e < Ne; e++) {
        const mat = materials[matId[e]];
        if (mat.kind === "iron") {
          const b = bElement(body, e, fullAbody);
          const B2 = b.Bx * b.Bx + b.By * b.By;
          const r = brauerNu(B2, mat, BkneeDefault);
          outNu[e] = r.ν;
          outDnu[e] = r.dν_dB2;
        } else {
          outNu[e] = table.linNu[matId[e]];
          outDnu[e] = 0;
        }
      }
    }

    function applyConstraintsToFInto(fMesh, slaveTable, renumBody, NnBody, nFree, out) {
      const isSlave = slaveTable.isSlave;
      const masterL = slaveTable.masterL;
      const masterR = slaveTable.masterR;
      const weightL = slaveTable.weightL;
      const weightR = slaveTable.weightR;
      for (let i = 0; i < nFree; i++) out[i] = 0;
      for (let i = 0; i < NnBody; i++) {
        const v = fMesh[i];
        if (v === 0) continue;
        if (isSlave[i]) {
          const mL = renumBody[masterL[i]];
          if (mL >= 0) out[mL] += v * weightL[i];
          const mR = renumBody[masterR[i]];
          if (mR >= 0) out[mR] += v * weightR[i];
        } else {
          const fr = renumBody[i];
          if (fr >= 0) out[fr] += v;
        }
      }
    }

    // Wave 5.4 B: cached-kernel K·A. Mathematically out[a] = Σ_b ν·K_geom[a][b]·A[b]
    // — using the cached K_geom (built via the same 2×2 Gauss formula as the
    // old per-Gauss-point accumulation) gives a numerically equivalent answer
    // with no per-call q4Jacobian / triGradients calls.
    function bodyKtimesAMeshInto(body, kernels, νPerElem, fullAbody, outMesh) {
      const NnBody = body.nodes.length / 2;
      for (let i = 0; i < NnBody; i++) outMesh[i] = 0;
      const Ne = body.elems.length / 4;
      const elems = body.elems;
      const Klin = kernels.Klin;
      const offsets = kernels.offsets;
      const nLoc = kernels.nLoc;
      for (let e = 0; e < Ne; e++) {
        const ν = νPerElem[e];
        const n0 = elems[4*e];
        const n1 = elems[4*e+1];
        const n2 = elems[4*e+2];
        const n3 = elems[4*e+3];
        const off = offsets[e];
        if (nLoc[e] === 3) {
          const A0 = fullAbody[n0], A1 = fullAbody[n1], A2 = fullAbody[n2];
          outMesh[n0] += ν * (Klin[off + 0]*A0 + Klin[off + 1]*A1 + Klin[off + 2]*A2);
          outMesh[n1] += ν * (Klin[off + 3]*A0 + Klin[off + 4]*A1 + Klin[off + 5]*A2);
          outMesh[n2] += ν * (Klin[off + 6]*A0 + Klin[off + 7]*A1 + Klin[off + 8]*A2);
        } else {
          const A0 = fullAbody[n0], A1 = fullAbody[n1], A2 = fullAbody[n2], A3 = fullAbody[n3];
          outMesh[n0] += ν * (Klin[off + 0]*A0  + Klin[off + 1]*A1  + Klin[off + 2]*A2  + Klin[off + 3]*A3);
          outMesh[n1] += ν * (Klin[off + 4]*A0  + Klin[off + 5]*A1  + Klin[off + 6]*A2  + Klin[off + 7]*A3);
          outMesh[n2] += ν * (Klin[off + 8]*A0  + Klin[off + 9]*A1  + Klin[off + 10]*A2 + Klin[off + 11]*A3);
          outMesh[n3] += ν * (Klin[off + 12]*A0 + Klin[off + 13]*A1 + Klin[off + 14]*A2 + Klin[off + 15]*A3);
        }
      }
    }

    // Wave 5.4 B: assemble body tangent triplets via cached K_geom + cached
    // rank-1 gradient kernels. Output ordering identical to the original
    // assembleBodyTangentTriplets: K_lin emission (one (a,b) block per
    // element), then per-iron-element rank-1 augment block.
    function assembleBodyTangentTripletsInto(body, kernels, νPerElem, dνPerElem, fullAbody, outI, outJ, outV) {
      const Ne = body.elems.length / 4;
      const elems = body.elems;
      const Klin = kernels.Klin;
      const offsets = kernels.offsets;
      const nLoc = kernels.nLoc;
      const isIron = kernels.isIron;
      let p = 0;

      // First pass: ν·K_geom emission. Matches assembleInteriorPatternAndValues.
      for (let e = 0; e < Ne; e++) {
        const ν = νPerElem[e];
        const n0 = elems[4*e];
        const n1 = elems[4*e+1];
        const n2 = elems[4*e+2];
        const n3 = elems[4*e+3];
        const off = offsets[e];
        if (nLoc[e] === 3) {
          // Skip degenerate tri (zero area) — the cache has Klin entries = 0 in
          // that case, but the original pattern build also skips emission
          // entirely. Match that by checking r1area.
          if (!(kernels.r1area[e] > 0)) continue;
          outI[p] = n0; outJ[p] = n0; outV[p] = ν * Klin[off + 0]; p++;
          outI[p] = n0; outJ[p] = n1; outV[p] = ν * Klin[off + 1]; p++;
          outI[p] = n0; outJ[p] = n2; outV[p] = ν * Klin[off + 2]; p++;
          outI[p] = n1; outJ[p] = n0; outV[p] = ν * Klin[off + 3]; p++;
          outI[p] = n1; outJ[p] = n1; outV[p] = ν * Klin[off + 4]; p++;
          outI[p] = n1; outJ[p] = n2; outV[p] = ν * Klin[off + 5]; p++;
          outI[p] = n2; outJ[p] = n0; outV[p] = ν * Klin[off + 6]; p++;
          outI[p] = n2; outJ[p] = n1; outV[p] = ν * Klin[off + 7]; p++;
          outI[p] = n2; outJ[p] = n2; outV[p] = ν * Klin[off + 8]; p++;
        } else {
          outI[p] = n0; outJ[p] = n0; outV[p] = ν * Klin[off + 0]; p++;
          outI[p] = n0; outJ[p] = n1; outV[p] = ν * Klin[off + 1]; p++;
          outI[p] = n0; outJ[p] = n2; outV[p] = ν * Klin[off + 2]; p++;
          outI[p] = n0; outJ[p] = n3; outV[p] = ν * Klin[off + 3]; p++;
          outI[p] = n1; outJ[p] = n0; outV[p] = ν * Klin[off + 4]; p++;
          outI[p] = n1; outJ[p] = n1; outV[p] = ν * Klin[off + 5]; p++;
          outI[p] = n1; outJ[p] = n2; outV[p] = ν * Klin[off + 6]; p++;
          outI[p] = n1; outJ[p] = n3; outV[p] = ν * Klin[off + 7]; p++;
          outI[p] = n2; outJ[p] = n0; outV[p] = ν * Klin[off + 8]; p++;
          outI[p] = n2; outJ[p] = n1; outV[p] = ν * Klin[off + 9]; p++;
          outI[p] = n2; outJ[p] = n2; outV[p] = ν * Klin[off + 10]; p++;
          outI[p] = n2; outJ[p] = n3; outV[p] = ν * Klin[off + 11]; p++;
          outI[p] = n3; outJ[p] = n0; outV[p] = ν * Klin[off + 12]; p++;
          outI[p] = n3; outJ[p] = n1; outV[p] = ν * Klin[off + 13]; p++;
          outI[p] = n3; outJ[p] = n2; outV[p] = ν * Klin[off + 14]; p++;
          outI[p] = n3; outJ[p] = n3; outV[p] = ν * Klin[off + 15]; p++;
        }
      }

      // Second pass: rank-1 dν·gA·gAᵀ augment per iron element. Emitted for
      // every iron element regardless of dν value (matching the pattern build),
      // so the triplet count stays in sync with setPattern.
      if (dνPerElem) {
        const r1dx = kernels.r1dx;
        const r1dy = kernels.r1dy;
        const r1area = kernels.r1area;
        for (let e = 0; e < Ne; e++) {
          if (!isIron[e]) continue;
          const area = r1area[e];
          if (!(area > 0)) continue;
          const dν = dνPerElem[e];
          const n0 = elems[4*e];
          const n1 = elems[4*e+1];
          const n2 = elems[4*e+2];
          const n3 = elems[4*e+3];
          const dxBase = 4 * e;
          const dx0 = r1dx[dxBase + 0], dx1 = r1dx[dxBase + 1];
          const dx2 = r1dx[dxBase + 2], dx3 = r1dx[dxBase + 3];
          const dy0 = r1dy[dxBase + 0], dy1 = r1dy[dxBase + 1];
          const dy2 = r1dy[dxBase + 2], dy3 = r1dy[dxBase + 3];
          if (nLoc[e] === 3) {
            const A0 = fullAbody[n0], A1 = fullAbody[n1], A2 = fullAbody[n2];
            const dAdx = dx0*A0 + dx1*A1 + dx2*A2;
            const dAdy = dy0*A0 + dy1*A1 + dy2*A2;
            const gA0 = dx0*dAdx + dy0*dAdy;
            const gA1 = dx1*dAdx + dy1*dAdy;
            const gA2 = dx2*dAdx + dy2*dAdy;
            const coef = 2 * dν * area;
            outI[p] = n0; outJ[p] = n0; outV[p] = coef * gA0 * gA0; p++;
            outI[p] = n0; outJ[p] = n1; outV[p] = coef * gA0 * gA1; p++;
            outI[p] = n0; outJ[p] = n2; outV[p] = coef * gA0 * gA2; p++;
            outI[p] = n1; outJ[p] = n0; outV[p] = coef * gA1 * gA0; p++;
            outI[p] = n1; outJ[p] = n1; outV[p] = coef * gA1 * gA1; p++;
            outI[p] = n1; outJ[p] = n2; outV[p] = coef * gA1 * gA2; p++;
            outI[p] = n2; outJ[p] = n0; outV[p] = coef * gA2 * gA0; p++;
            outI[p] = n2; outJ[p] = n1; outV[p] = coef * gA2 * gA1; p++;
            outI[p] = n2; outJ[p] = n2; outV[p] = coef * gA2 * gA2; p++;
          } else {
            const A0 = fullAbody[n0], A1 = fullAbody[n1];
            const A2 = fullAbody[n2], A3 = fullAbody[n3];
            const dAdx = dx0*A0 + dx1*A1 + dx2*A2 + dx3*A3;
            const dAdy = dy0*A0 + dy1*A1 + dy2*A2 + dy3*A3;
            const gA0 = dx0*dAdx + dy0*dAdy;
            const gA1 = dx1*dAdx + dy1*dAdy;
            const gA2 = dx2*dAdx + dy2*dAdy;
            const gA3 = dx3*dAdx + dy3*dAdy;
            const coef = 2 * dν * area;
            outI[p] = n0; outJ[p] = n0; outV[p] = coef * gA0 * gA0; p++;
            outI[p] = n0; outJ[p] = n1; outV[p] = coef * gA0 * gA1; p++;
            outI[p] = n0; outJ[p] = n2; outV[p] = coef * gA0 * gA2; p++;
            outI[p] = n0; outJ[p] = n3; outV[p] = coef * gA0 * gA3; p++;
            outI[p] = n1; outJ[p] = n0; outV[p] = coef * gA1 * gA0; p++;
            outI[p] = n1; outJ[p] = n1; outV[p] = coef * gA1 * gA1; p++;
            outI[p] = n1; outJ[p] = n2; outV[p] = coef * gA1 * gA2; p++;
            outI[p] = n1; outJ[p] = n3; outV[p] = coef * gA1 * gA3; p++;
            outI[p] = n2; outJ[p] = n0; outV[p] = coef * gA2 * gA0; p++;
            outI[p] = n2; outJ[p] = n1; outV[p] = coef * gA2 * gA1; p++;
            outI[p] = n2; outJ[p] = n2; outV[p] = coef * gA2 * gA2; p++;
            outI[p] = n2; outJ[p] = n3; outV[p] = coef * gA2 * gA3; p++;
            outI[p] = n3; outJ[p] = n0; outV[p] = coef * gA3 * gA0; p++;
            outI[p] = n3; outJ[p] = n1; outV[p] = coef * gA3 * gA1; p++;
            outI[p] = n3; outJ[p] = n2; outV[p] = coef * gA3 * gA2; p++;
            outI[p] = n3; outJ[p] = n3; outV[p] = coef * gA3 * gA3; p++;
          }
        }
      }
      return p;
    }

    // Apply constraints (slaves+pinned) to mesh-indexed triplets, emitting
    // expanded triplets in free-DOF indexing. Output ordering matches
    // applyConstraintsToTriplets. nIn = number of input triplets; returns
    // number of output triplets written.
    function applyConstraintsToTripletsInto(inI, inJ, inV, nIn, slaveTable, renumBody, outI, outJ, outV) {
      const isSlave = slaveTable.isSlave;
      const masterL = slaveTable.masterL;
      const masterR = slaveTable.masterR;
      const weightL = slaveTable.weightL;
      const weightR = slaveTable.weightR;
      let q = 0;
      for (let t = 0; t < nIn; t++) {
        const i = inI[t], j = inJ[t], v = inV[t];
        // Build the i-expansion (1 or 2 entries)
        let i0, w_i0, i1, w_i1, iN;
        if (isSlave[i]) {
          i0 = masterL[i]; w_i0 = weightL[i];
          i1 = masterR[i]; w_i1 = weightR[i];
          iN = 2;
        } else {
          i0 = i; w_i0 = 1; i1 = -1; w_i1 = 0; iN = 1;
        }
        // Build the j-expansion
        let j0, w_j0, j1, w_j1, jN;
        if (isSlave[j]) {
          j0 = masterL[j]; w_j0 = weightL[j];
          j1 = masterR[j]; w_j1 = weightR[j];
          jN = 2;
        } else {
          j0 = j; w_j0 = 1; j1 = -1; w_j1 = 0; jN = 1;
        }
        for (let a = 0; a < iN; a++) {
          const im = (a === 0) ? i0 : i1;
          const wi = (a === 0) ? w_i0 : w_i1;
          const iFree = renumBody[im];
          if (iFree < 0) continue;
          for (let b = 0; b < jN; b++) {
            const jm = (b === 0) ? j0 : j1;
            const wj = (b === 0) ? w_j0 : w_j1;
            const jFree = renumBody[jm];
            if (jFree < 0) continue;
            outI[q] = iFree;
            outJ[q] = jFree;
            outV[q] = v * wi * wj;
            q++;
          }
        }
      }
      return q;
    }

    function remapGapTripletsInto(stamp, outI, outJ, outV) {
      const I = stamp.I, J = stamp.J, V = stamp.V;
      const nt = I.length;
      for (let t = 0; t < nt; t++) {
        const ii = I[t];
        const jj = J[t];
        outI[t] = (ii < Ngr) ? gapLocalToGlobalRotor[ii]
                : (ii < Ngr + Ngs) ? gapLocalToGlobalStator[ii - Ngr]
                : harmonicBaseGlobal + (ii - Ngr - Ngs);
        outJ[t] = (jj < Ngr) ? gapLocalToGlobalRotor[jj]
                : (jj < Ngr + Ngs) ? gapLocalToGlobalStator[jj - Ngr]
                : harmonicBaseGlobal + (jj - Ngr - Ngs);
        outV[t] = V[t];
      }
      return nt;
    }

    // Same remap as remapGapTripletsInto but reads raw arrays + an explicit
    // count, so callers using gap.stampInto (no wrapper object) can remap
    // without allocating a temporary { I, J, V } wrapper.
    function remapStampInto(srcI, srcJ, srcV, nt, outI, outJ, outV) {
      for (let t = 0; t < nt; t++) {
        const ii = srcI[t];
        const jj = srcJ[t];
        outI[t] = (ii < Ngr) ? gapLocalToGlobalRotor[ii]
                : (ii < Ngr + Ngs) ? gapLocalToGlobalStator[ii - Ngr]
                : harmonicBaseGlobal + (ii - Ngr - Ngs);
        outJ[t] = (jj < Ngr) ? gapLocalToGlobalRotor[jj]
                : (jj < Ngr + Ngs) ? gapLocalToGlobalStator[jj - Ngr]
                : harmonicBaseGlobal + (jj - Ngr - Ngs);
        outV[t] = srcV[t];
      }
      return nt;
    }

    // ============================================================================
    //  Wave 5.4 C: G5 Schur condensation (LINEAR path)
    //
    //  The bordered system [[A, B], [B^T, D]]·[x_b; x_h] = [f_b; f_h] is reduced
    //  over the body block: A = K_b (body FE stiffness, ν₀-only, phi-invariant),
    //  B = stamp's body↔harm coupling (phi-invariant), D = stamp's harm↔harm
    //  block (phi-DEPENDENT via the R_k(φ) cross-coupling).
    //
    //  Prepare at create-time (one-time):
    //    1. Factor K_b once via a separate FeaSolver instance (solverKb).
    //    2. Build W = K_b⁻¹·B by 314 back-subs (one per harmonic DOF column).
    //    3. Compute BᵀW (cached dense nHarm×nHarm) for use in the Schur
    //       complement S = D − BᵀW.
    //
    //  Per call:
    //    1. linearSchurPrepare(phi): refresh D values from stamp(phi), assemble
    //       S = D − BᵀW into a dense buffer, dense-Cholesky factor S in place.
    //    2. linearSchurSolve(fBodyFree, outA): z = K_b⁻¹·f_b (1 back-sub),
    //       g = −Bᵀ·z (sparse multiply), A_harm = S⁻¹·g (dense forward/back),
    //       A_body = z − W·A_harm (dense matvec).
    // ============================================================================

    // Dense Cholesky LLT on an n×n SPD matrix stored row-major in M (Float64Array
    // of length n²). In-place: replaces the lower triangle of M with L
    // (M = L·Lᵀ).
    function denseCholeskyFactor(M, n) {
      // Left-looking LLT (same algorithm as before) with:
      //   - hoisted i*n / j*n base offsets out of the inner loop
      //   - 4-wide unrolling of the i-loop so each k-iteration reads
      //     M[j,k] once and reuses it across 4 i's (amortizes the second
      //     row's load and improves ILP / register pressure in the JIT).
      // Same numerical result as the scalar form; ~1.5–2× speedup on
      // n=314 in V8 because the dot-product inner is the bottleneck.
      for (let j = 0; j < n; j++) {
        const jBase = j * n;
        let djj = M[jBase + j];
        for (let k = 0; k < j; k++) {
          const ljk = M[jBase + k];
          djj -= ljk * ljk;
        }
        if (djj <= 0) {
          throw new Error("denseCholeskyFactor: matrix not PD at column " + j +
            " (djj=" + djj + ", n=" + n + ")");
        }
        const ljj = Math.sqrt(djj);
        M[jBase + j] = ljj;
        const inv = 1 / ljj;

        // 4-wide unrolled i-loop
        let i = j + 1;
        for (; i + 3 < n; i += 4) {
          const iBase0 = i * n;
          const iBase1 = iBase0 + n;
          const iBase2 = iBase1 + n;
          const iBase3 = iBase2 + n;
          let s0 = M[iBase0 + j];
          let s1 = M[iBase1 + j];
          let s2 = M[iBase2 + j];
          let s3 = M[iBase3 + j];
          for (let k = 0; k < j; k++) {
            const mjk = M[jBase + k];
            s0 -= M[iBase0 + k] * mjk;
            s1 -= M[iBase1 + k] * mjk;
            s2 -= M[iBase2 + k] * mjk;
            s3 -= M[iBase3 + k] * mjk;
          }
          M[iBase0 + j] = s0 * inv;
          M[iBase1 + j] = s1 * inv;
          M[iBase2 + j] = s2 * inv;
          M[iBase3 + j] = s3 * inv;
        }
        // Scalar tail
        for (; i < n; i++) {
          const iBase = i * n;
          let sum = M[iBase + j];
          for (let k = 0; k < j; k++) {
            sum -= M[iBase + k] * M[jBase + k];
          }
          M[iBase + j] = sum * inv;
        }
      }
    }

    // Solve L·Lᵀ·x = b. Reads lower triangle of L. b and out can be the same
    // array (in-place ok).
    function denseCholeskySolve(L, b, n, out) {
      // Forward sub: L·y = b
      for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= L[i*n + k] * out[k];
        out[i] = sum / L[i*n + i];
      }
      // Back sub: Lᵀ·x = y
      for (let i = n - 1; i >= 0; i--) {
        let sum = out[i];
        for (let k = i + 1; k < n; k++) sum -= L[k*n + i] * out[k];
        out[i] = sum / L[i*n + i];
      }
    }

    // Build K_b' = K_b body block AUGMENTED with a Lagrange-multiplier row/col
    // enforcing zero-average rotor A (i.e., Σ over rotor free DOFs of A = 0).
    //
    // K_b alone has a 1-D null space — the discrete rotor-uniform mode —
    // because the rotor body has no Dirichlet pin. The full bordered system
    // resolves this via the harmonic k=0 coupling, but when we Schur-condense
    // by isolating K_b we lose that coupling and K_b becomes singular. The
    // Lagrange augmentation adds back the equation
    //   Σ_(rotor free DOFs) A_i = 0
    // which fixes the gauge to "zero-average rotor A" (a refine-independent
    // gauge choice; gauge-invariant outputs — torque, dL/dθ, dλ_pm/dθ — are
    // unchanged; absolute λ_pm[rotor circuit] shifts by a constant).
    //
    // Augmented size: (nBody + 1) × (nBody + 1). Last row/col = the
    // multiplier α. K_b' is INDEFINITE saddle-point but invertible because
    // p ∈ null(K_b) and p^T·p ≠ 0. SimplicialLDLT (LDLT, not LLT) factors
    // it correctly. The Schur reduction over K_b' gives a small dense block
    // whose negative is SPD, so we can still use dense Cholesky on that.
    function buildKbTriplets() {
      const nBody = nRotorFree + nStatorFree;

      const νR_lin = linearNuFor(rotorMesh,  rotorMatTable);
      const νS_lin = linearNuFor(statorMesh, statorMatTable);
      const NnR_full_loc = rotorMesh.nodes.length / 2;
      const NnS_full_loc = statorMesh.nodes.length / 2;
      const zeroAR = new Float64Array(NnR_full_loc);
      const zeroAS = new Float64Array(NnS_full_loc);

      let rTrip = assembleBodyTangentTriplets(rotorMesh,  νR_lin, null, zeroAR);
      let sTrip = assembleBodyTangentTriplets(statorMesh, νS_lin, null, zeroAS);
      rTrip = applyConstraintsToTriplets(rTrip, rotorMesh.constraints, renumR);
      sTrip = applyConstraintsToTriplets(sTrip, statorMesh.constraints, renumS);

      const nRc = rTrip.I.length;
      const nSc = sTrip.I.length;
      // Body block + Lagrange row (nRotorFree entries) + Lagrange col (nRotorFree entries)
      // + zero diagonal at (nBody, nBody) (one entry, must exist for the pattern).
      const nKb = nRc + nSc + 2 * nRotorFree + 1;
      const I = new Int32Array(nKb);
      const J = new Int32Array(nKb);
      const V = new Float64Array(nKb);
      let p = 0;
      for (let t = 0; t < nRc; t++) { I[p] = rTrip.I[t]; J[p] = rTrip.J[t]; V[p] = rTrip.V[t]; p++; }
      for (let t = 0; t < nSc; t++) { I[p] = sTrip.I[t] + nRotorFree; J[p] = sTrip.J[t] + nRotorFree; V[p] = sTrip.V[t]; p++; }
      // Lagrange column: K_b'[i, nBody] = 1 for i in [0, nRotorFree)
      for (let i = 0; i < nRotorFree; i++) { I[p] = i;     J[p] = nBody; V[p] = 1; p++; }
      // Lagrange row:    K_b'[nBody, i] = 1 for i in [0, nRotorFree)
      for (let i = 0; i < nRotorFree; i++) { I[p] = nBody; J[p] = i;     V[p] = 1; p++; }
      // Zero diagonal at the multiplier DOF — must exist in the pattern so
      // SimplicialLDLT sees a structural entry there. Stored as +0; assembly
      // sum is 0.
      I[p] = nBody; J[p] = nBody; V[p] = 0; p++;
      return { I, J, V, nBody, nKbAug: nBody + 1 };
    }

    // Set up the augmented K_b' solver. K_b' is (nBody+1) × (nBody+1) —
    // saddle-point indefinite — and is factored once by SimplicialLDLT.
    const kbTrip = buildKbTriplets();
    const nBody = nRotorFree + nStatorFree;
    const nKbAug = kbTrip.nKbAug; // = nBody + 1
    const nHarm = nHarmonicDofs;
    const solverKb = LIB.FeaSolver.create();
    solverKb.setPattern(nKbAug, kbTrip.I, kbTrip.J);
    solverKb.setValues(kbTrip.V);
    solverKb.analyze();
    solverKb.factorize();

    // Extract B (body × harm coupling) from stamp(0). B is phi-invariant —
    // verified in the spec; the phi rotation is absorbed into the D block's
    // cross-coupling via R_k(φ).
    function extractB() {
      const stamp0 = gap.stamp(0);
      // Remap into a fresh buffer (one-time, not reused).
      const rI = new Int32Array(stamp0.I.length);
      const rJ = new Int32Array(stamp0.I.length);
      const rV = new Float64Array(stamp0.I.length);
      remapGapTripletsInto(stamp0, rI, rJ, rV);
      const harmBase = harmonicBaseGlobal;
      // Collect (bodyIdx, harmIdx, value) where I < harmBase AND J >= harmBase.
      // Use the (body, harm) direction; the (harm, body) direction has the same
      // values by symmetry.
      const bodyIdxs = [];
      const harmIdxs = [];
      const vals = [];
      for (let t = 0; t < rI.length; t++) {
        const i = rI[t], j = rJ[t];
        if (i < harmBase && j >= harmBase) {
          bodyIdxs.push(i);
          harmIdxs.push(j - harmBase); // store harm-local index in [0, nHarm)
          vals.push(rV[t]);
        }
      }
      return {
        n: bodyIdxs.length,
        bodyIdx: new Int32Array(bodyIdxs),
        harmIdx: new Int32Array(harmIdxs),
        value:   new Float64Array(vals),
      };
    }
    const B = extractB();

    // Build W = K_b⁻¹·B (dense nBody × nHarm, row-major). For each harm column
    // j, build a sparse RHS from B's entries with harmIdx == j, then back-sub
    // via solverKb.
    function buildW() {
      const W = new Float64Array(nBody * nHarm);
      const rhsCol = new Float64Array(nKbAug);
      // Pre-index B by harm column for fast lookup. B.harmIdx in [0, nHarm).
      // Group B entries by harmIdx.
      const colStart = new Int32Array(nHarm + 1);
      const order = new Int32Array(B.n);
      // Count entries per column.
      for (let t = 0; t < B.n; t++) colStart[B.harmIdx[t] + 1]++;
      for (let j = 0; j < nHarm; j++) colStart[j + 1] += colStart[j];
      const cursor = new Int32Array(nHarm);
      for (let t = 0; t < B.n; t++) {
        const j = B.harmIdx[t];
        order[colStart[j] + cursor[j]] = t;
        cursor[j]++;
      }

      for (let j = 0; j < nHarm; j++) {
        // Clear sparse RHS (full augmented size — last entry is the
        // multiplier RHS, which is 0 since B' has zero last row).
        for (let i = 0; i < nKbAug; i++) rhsCol[i] = 0;
        const lo = colStart[j], hi = colStart[j + 1];
        for (let k = lo; k < hi; k++) {
          const t = order[k];
          rhsCol[B.bodyIdx[t]] += B.value[t];
        }
        // Back-sub the augmented K_b' system. Only the top nBody entries
        // of colSol (the body response) enter BtW; the multiplier entry is
        // discarded.
        const colSol = solverKb.solve(rhsCol);
        // Copy into W column j (row-major: W[i*nHarm + j])
        for (let i = 0; i < nBody; i++) W[i * nHarm + j] = colSol[i];
      }
      return { W, colStart, order };
    }
    const Wbundle = buildW();
    const W_dense = Wbundle.W;
    const B_colStart = Wbundle.colStart;
    const B_order    = Wbundle.order;

    // Compute BᵀW (cached dense nHarm × nHarm, row-major).
    function buildBtW() {
      const BtW = new Float64Array(nHarm * nHarm);
      // BtW[i, j] = Σ_k B[k, i] · W[k, j]
      // Iterate B entries: each (bodyIdx, harmIdx_i, value) contributes
      //   value · W[bodyIdx, j] to BtW[harmIdx_i, j] for all j.
      for (let t = 0; t < B.n; t++) {
        const bi = B.bodyIdx[t];
        const hi = B.harmIdx[t];
        const v  = B.value[t];
        const wRowOff = bi * nHarm;
        const outOff  = hi * nHarm;
        for (let j = 0; j < nHarm; j++) {
          BtW[outOff + j] += v * W_dense[wRowOff + j];
        }
      }
      return BtW;
    }
    const BtW_dense = buildBtW();

    // Scratch buffers for the Schur per-phi/per-RHS path. fBodyAug and
    // z are sized to nKbAug (= nBody + 1) because solverKb operates on the
    // Lagrange-augmented system; the last entry is the multiplier slot.
    const schurScratch = {
      stampI:   new Int32Array(harmTripCount),
      stampJ:   new Int32Array(harmTripCount),
      stampV:   new Float64Array(harmTripCount),
      S:        new Float64Array(nHarm * nHarm),
      g:        new Float64Array(nHarm),
      A_harm:   new Float64Array(nHarm),
      fBodyAug: new Float64Array(nKbAug),
      z:        new Float64Array(nKbAug),   // solveInto target for K_b' back-sub
      // linearSchurSolve output buffers — reused across coggingTorque calls
      // and across the (m+1) RHS per evaluateAt call.
      A_magnet: new Float64Array(nGlobal),  // magnet-only Schur solve result
      A_j:      new Float64Array(nGlobal),  // unit-current Schur solve result
      lam_j:    null,  // sized to nCircuits below, after computeNCircuits()
    };

    // Refresh the SPD Schur factor S_pd = BᵀW − D(phi). The stamp's D block
    // is -M⁻¹ (negative definite), so S = D − BᵀW is negative definite. We
    // factor S_pd = -S instead, which is BᵀW + M⁻¹ (positive definite). The
    // solve then uses the equivalent equation S_pd · A_harm = Bᵀ·z (sign-
    // flipped from the original S · A_harm = -Bᵀ·z). The lower triangle of
    // schurScratch.S is overwritten with L (the Cholesky factor of S_pd).
    let _schurPrepCount = 0;
    let _schurSolveCount = 0;
    function linearSchurPrepare(phi) {
      _schurPrepCount++;
      const ntLocal = gap.stampInto(phi,
        scratch.gapStampLocal_I, scratch.gapStampLocal_J, scratch.gapStampLocal_V);
      const nt = remapStampInto(
        scratch.gapStampLocal_I, scratch.gapStampLocal_J, scratch.gapStampLocal_V, ntLocal,
        schurScratch.stampI, schurScratch.stampJ, schurScratch.stampV);
      const S = schurScratch.S;
      // DEBUG: probe BtW[0,0] and what the stamp says at the (0,0) of harm block
      if (process.env.SCHUR_DEBUG === '1') {
        console.log('[Schur] BtW[0,0]=', BtW_dense[0]);
        const harmBase = harmonicBaseGlobal;
        let stampAt00 = 0, stampAtPerBody = 0;
        for (let t = 0; t < nt; t++) {
          if (schurScratch.stampI[t] === harmBase && schurScratch.stampJ[t] === harmBase) {
            stampAt00 += schurScratch.stampV[t];
          }
        }
        console.log('[Schur] stamp at (harmBase, harmBase) sum=', stampAt00);
        // Also count how many B entries had harmIdx==0
        let b0count = 0, b0sumVal = 0;
        for (let t = 0; t < B.n; t++) {
          if (B.harmIdx[t] === 0) { b0count++; b0sumVal += B.value[t]; }
        }
        console.log('[Schur] B col 0: count=' + b0count + ' sumVal=' + b0sumVal);
        // BtW[0,0] sanity: should be Σ B[k,0] · W[k,0]
        let probe = 0;
        for (let t = 0; t < B.n; t++) {
          if (B.harmIdx[t] === 0) probe += B.value[t] * W_dense[B.bodyIdx[t] * nHarm + 0];
        }
        console.log('[Schur] BtW[0,0] recomputed=', probe);
        console.log('[Schur] nGlobalBoundary harmBase=', harmBase, 'nBody=', nBody);
      }
      // S_pd = BᵀW − D_stamp_values. The stamp writes -M⁻¹ into the harm-
      // harm block (negative values), so subtracting them adds +M⁻¹ →
      // S_pd = BᵀW + M⁻¹, which is SPD.
      for (let i = 0; i < nHarm * nHarm; i++) S[i] = BtW_dense[i];
      const harmBase = harmonicBaseGlobal;
      const Ii = schurScratch.stampI, Jj = schurScratch.stampJ, Vv = schurScratch.stampV;
      for (let t = 0; t < nt; t++) {
        const i = Ii[t], j = Jj[t];
        if (i >= harmBase && j >= harmBase) {
          S[(i - harmBase) * nHarm + (j - harmBase)] -= Vv[t];
        }
      }
      denseCholeskyFactor(S, nHarm);
    }

    // Solve the linear system given a prepared S_pd factor and a body-free
    // RHS (length nBody). Writes A_body into the first nBody entries of outA
    // and A_harm into the last nHarm entries.
    //
    //   z = K_b⁻¹·fBody             (1 sparse back-sub)
    //   rhs_h = +Bᵀ·z               (sign-flipped vs the original S form,
    //                                because we factored S_pd = -S)
    //   A_harm = S_pd⁻¹·rhs_h       (dense forward + back sub)
    //   A_body = z − W·A_harm       (dense matvec; sign matches the
    //                                original x_b = A⁻¹(f_b − B·x_h))
    function linearSchurSolve(fBody, outA) {
      _schurSolveCount++;
      // Pad fBody (length nBody) into the augmented RHS (length nKbAug)
      // with the multiplier RHS = 0 (zero-average rotor A is the constraint).
      const fAug = schurScratch.fBodyAug;
      for (let i = 0; i < nBody; i++) fAug[i] = fBody[i];
      fAug[nBody] = 0;
      // z' = K_b'⁻¹·fAug. Length nKbAug. z'[0:nBody] is the body response;
      // z'[nBody] is the multiplier — discard. solveInto avoids the per-call
      // Float64Array(nKbAug) allocation that solve() would do.
      const z = schurScratch.z;
      solverKb.solveInto(fAug, z);
      const g = schurScratch.g;
      for (let j = 0; j < nHarm; j++) g[j] = 0;
      for (let t = 0; t < B.n; t++) {
        g[B.harmIdx[t]] += B.value[t] * z[B.bodyIdx[t]];
      }
      const A_harm = schurScratch.A_harm;
      denseCholeskySolve(schurScratch.S, g, nHarm, A_harm);
      for (let i = 0; i < nBody; i++) {
        let dot = 0;
        const off = i * nHarm;
        for (let j = 0; j < nHarm; j++) dot += W_dense[off + j] * A_harm[j];
        outA[i] = z[i] - dot;
      }
      for (let j = 0; j < nHarm; j++) outA[nBody + j] = A_harm[j];
    }

    // ------------ nCircuits (D7) ------------
    function computeNCircuits() {
      let maxSrc = -1;
      const Rsrc = rotorMesh.srcId;
      const Ssrc = statorMesh.srcId;
      for (let i = 0; i < Rsrc.length; i++) if (Rsrc[i] > maxSrc) maxSrc = Rsrc[i];
      for (let i = 0; i < Ssrc.length; i++) if (Ssrc[i] > maxSrc) maxSrc = Ssrc[i];
      return maxSrc + 1;
    }
    const nCircuits = computeNCircuits();
    schurScratch.lam_j = new Float64Array(nCircuits);
    _solveResultFluxLinkages = new Float64Array(nCircuits);
    _solveResult.fluxLinkages = _solveResultFluxLinkages;

    // ------------ Conductor index by circuit (Wave 5.4 follow-up, item 6) ------------
    //
    // Pre-build per-body CSR-style lookups so fluxLinkagesFromFullA iterates
    // only the conductor elements (typically tens to a few hundred) instead
    // of all body elements (thousands per body × 2 bodies per call). At
    // 60 fps × 2 bodies × ~3000 elems = 360k srcId checks/sec → with this
    // index, the per-call inner loop is ~100× shorter for typical machines.
    function buildConductorIndex(body) {
      const Ne = body.elems.length / 4;
      const srcId = body.srcId;
      const turns = body.turns;
      // First pass: count per circuit
      const count = new Int32Array(nCircuits);
      for (let e = 0; e < Ne; e++) {
        const sid = srcId[e];
        if (sid >= 0 && sid < nCircuits) count[sid]++;
      }
      // CSR start offsets
      const start = new Int32Array(nCircuits + 1);
      for (let k = 0; k < nCircuits; k++) start[k + 1] = start[k] + count[k];
      const total = start[nCircuits];
      const elemIdx  = new Int32Array(total);
      const turnsArr = new Float64Array(total);
      // Second pass: fill (use cursor)
      const cursor = new Int32Array(nCircuits);
      for (let e = 0; e < Ne; e++) {
        const sid = srcId[e];
        if (sid < 0 || sid >= nCircuits) continue;
        const pos = start[sid] + cursor[sid];
        elemIdx[pos]  = e;
        turnsArr[pos] = turns[e];
        cursor[sid]++;
      }
      return { start, elemIdx, turns: turnsArr };
    }
    const conductorIndexRotor  = buildConductorIndex(rotorMesh);
    const conductorIndexStator = buildConductorIndex(statorMesh);

    // ------------ Warm-start cache ------------
    let warmStart = null; // { phi, A: Float64Array(nGlobal) }
    let lastNewton = null;

    function clearWarmStart() {
      warmStart = null;
    }

    // ------------ ν per element from current full-A vector ------------
    function νPerElemFromA(body, table, fullAbody) {
      const Ne = body.elems.length / 4;
      const out = new Float64Array(Ne);
      const dν = new Float64Array(Ne); // dν/dB² per element
      for (let e = 0; e < Ne; e++) {
        const matIdx = body.matId[e];
        const mat = body.materials[matIdx];
        if (mat.kind === "iron") {
          const b = bElement(body, e, fullAbody);
          const B2 = b.Bx * b.Bx + b.By * b.By;
          const r = brauerNu(B2, mat, sat.BkneeDefault);
          out[e] = r.ν;
          dν[e]  = r.dν_dB2;
        } else {
          out[e] = table.linNu[matIdx];
          dν[e]  = 0;
        }
      }
      return { ν: out, dν };
    }

    // ------------ Full Newton tangent for body (interior) ------------
    //
    // Returns triplets where the per-element 4×4 (or 3×3) block is
    //   K_e + 2·dν/dB² · gA gA^T (rank-1)
    // computed cell-by-cell. For Q4 we use 1-point (center) approximation of
    // the rank-1 term — sufficient for Newton tangent (within Newton's local
    // quadratic-convergence basin) and identical to the linearized assembly.
    function assembleBodyTangentTriplets(body, νPerElem, dνPerElem, fullAbody) {
      // Standard ν·K_geom assembly (mesh-node indexing):
      const lin = assembleInteriorPatternAndValues(body, νPerElem);
      if (!dνPerElem) return lin;

      // Add rank-1 per element from 2·dν/dB²·(gA)(gA)^T, where gA_i = ∇N_i·∇A.
      // Use 1-point Q4 at center / centroid tri. Output in mesh-node indexing.
      // Emit the rank-1 block for every iron element regardless of the current
      // dν value, so the triplet count matches the pattern (which is set with
      // dν=1 placeholder on every iron element).
      const Ne = body.elems.length / 4;
      const I = Array.from(lin.I);
      const J = Array.from(lin.J);
      const V = Array.from(lin.V);
      for (let e = 0; e < Ne; e++) {
        const matK = body.materials[body.matId[e]].kind;
        if (matK !== "iron") continue;
        const dν = dνPerElem[e];
        const n0 = body.elems[4*e];
        const n1 = body.elems[4*e+1];
        const n2 = body.elems[4*e+2];
        const n3 = body.elems[4*e+3];
        let nLocal, dNdx, dNdy, area;
        if (n3 === -1) {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
          const g = triGradients(xN, yN);
          area = g.area;
          dNdx = g.dNdx;
          dNdy = g.dNdy;
          nLocal = [n0, n1, n2];
        } else {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
          const j = q4Jacobian(xN, yN, 0, 0);
          area = 4 * j.detJ;
          dNdx = j.dNdx;
          dNdy = j.dNdy;
          nLocal = [n0, n1, n2, n3];
        }
        if (!(area > 0)) continue;
        let dAdx = 0, dAdy = 0;
        for (let i = 0; i < nLocal.length; i++) {
          dAdx += dNdx[i] * fullAbody[nLocal[i]];
          dAdy += dNdy[i] * fullAbody[nLocal[i]];
        }
        const gA = new Float64Array(nLocal.length);
        for (let i = 0; i < nLocal.length; i++) {
          gA[i] = dNdx[i] * dAdx + dNdy[i] * dAdy;
        }
        const coef = 2 * dν * area;
        for (let a = 0; a < nLocal.length; a++) {
          for (let b = 0; b < nLocal.length; b++) {
            I.push(nLocal[a]); J.push(nLocal[b]); V.push(coef * gA[a] * gA[b]);
          }
        }
      }
      return {
        I: Int32Array.from(I),
        J: Int32Array.from(J),
        V: Float64Array.from(V),
      };
    }

    // Compute residual K_lin(A)·A directly from per-element K_e contracted
    // with element nodal-A. Output in MESH-node indexing (caller applies
    // constraint distribution + renumbering).
    function bodyKtimesAMesh(body, νPerElem, fullAbody) {
      const NnBody = body.nodes.length / 2;
      const out = new Float64Array(NnBody);
      const Ne = body.elems.length / 4;
      for (let e = 0; e < Ne; e++) {
        const ν = νPerElem[e];
        const n0 = body.elems[4*e];
        const n1 = body.elems[4*e+1];
        const n2 = body.elems[4*e+2];
        const n3 = body.elems[4*e+3];
        let nLocal, dNdx, dNdy, area;
        if (n3 === -1) {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
          const g = triGradients(xN, yN);
          area = g.area;
          dNdx = g.dNdx;
          dNdy = g.dNdy;
          nLocal = [n0, n1, n2];
          if (!(area > 0)) continue;
          let dAdx = 0, dAdy = 0;
          for (let i = 0; i < 3; i++) {
            dAdx += dNdx[i] * fullAbody[nLocal[i]];
            dAdy += dNdy[i] * fullAbody[nLocal[i]];
          }
          const fac = ν * area;
          for (let i = 0; i < 3; i++) {
            out[nLocal[i]] += fac * (dNdx[i] * dAdx + dNdy[i] * dAdy);
          }
        } else {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
          nLocal = [n0, n1, n2, n3];
          for (let gs = 0; gs < 2; gs++) {
            for (let gt = 0; gt < 2; gt++) {
              const j = q4Jacobian(xN, yN, GP4_1D[gs], GP4_1D[gt]);
              if (!(j.detJ > 0)) continue;
              const w = ν * j.detJ;
              let dAdx = 0, dAdy = 0;
              for (let i = 0; i < 4; i++) {
                dAdx += j.dNdx[i] * fullAbody[nLocal[i]];
                dAdy += j.dNdy[i] * fullAbody[nLocal[i]];
              }
              for (let i = 0; i < 4; i++) {
                out[nLocal[i]] += w * (j.dNdx[i] * dAdx + j.dNdy[i] * dAdy);
              }
            }
          }
        }
      }
      return out;
    }

    // bodyKtimesA: project mesh-node K·A through the constraint distribution
    // into free-DOF space.
    function bodyKtimesA(body, νPerElem, renumBody, fullAbody, nFree) {
      const mesh = bodyKtimesAMesh(body, νPerElem, fullAbody);
      return applyConstraintsToF(mesh, body.constraints, renumBody, nFree);
    }

    // Apply harmonic stamp to full A vector → returns harmonic-row contribution
    // length nGlobal. Used to compute residual.
    function harmonicKtimesA(phi, A) {
      const stamp = gap.stamp(phi);
      const remapped = remapGapTriplets(
        stamp, gapLocalToGlobalRotor, gapLocalToGlobalStator, Ngr, Ngs, harmonicBaseGlobal
      );
      const out = new Float64Array(nGlobal);
      const I = remapped.I, J = remapped.J, V = remapped.V;
      for (let t = 0; t < I.length; t++) {
        out[I[t]] += V[t] * A[J[t]];
      }
      return out;
    }

    // --------------- The big one: solveStaticRotor(θ, currents) ---------------
    //
    // Assembles RHS and runs the Newton (or linear) loop. Returns
    //   { A: full nGlobal vector, iters, deltaNorm, residual }
    //
    // 'A' here is the full bordered vector (rotor-interior-free,
    // stator-interior-free, harmonics) in free-DOF numbering. To recover the
    // per-body full Anodal we expand pinned and constrained nodes separately.
    function solveStaticRotor(thetaR, currents) {
      const phi = thetaR;
      const enabled = !!sat.enabled;

      // -------- RHS assembly into scratch.rhs (Wave 5.4 A) --------
      // f = [fR_free; fS_free; 0] in free-DOF indexing.
      const f = scratch.rhs;
      for (let i = 0; i < nGlobal; i++) f[i] = 0;

      // Wave 5.4 follow-up: RHS build into scratch (zero allocations).
      // assembleInteriorMagnetLoadAndJzInto reuses module-level Q4 dN-avg
      // scratch across all elements of all bodies.
      assembleInteriorMagnetLoadAndJzInto(rotorMesh,  currents, scratch.fR_mesh);
      assembleInteriorMagnetLoadAndJzInto(statorMesh, currents, scratch.fS_mesh);
      applyConstraintsToFInto(scratch.fR_mesh, slaveTableR, renumR, NnR_full, nRotorFree, scratch.fR_free);
      applyConstraintsToFInto(scratch.fS_mesh, slaveTableS, renumS, NnS_full, nStatorFree, scratch.fS_free);
      const fR_free = scratch.fR_free;
      const fS_free = scratch.fS_free;
      for (let i = 0; i < nRotorFree; i++) f[i] = fR_free[i];
      for (let i = 0; i < nStatorFree; i++) f[nRotorFree + i] = fS_free[i];

      // -------- gap.stampInto(phi) + remap ONCE per solve (Wave 5.4 A) --------
      // Was called twice per build (once for K assembly, once inside
      // harmonicKtimesA) × 3-4 builds per solve = 8 stamps/solve. Now: 1.
      // Wave 5.4 follow-up: stampInto writes into pre-allocated local-index
      // scratch (scratch.gapStampLocal_*); remapStampInto then copies into
      // global-index scratch (scratch.harmTrip_*). Zero per-solve allocation.
      const ntLocal = gap.stampInto(phi,
        scratch.gapStampLocal_I, scratch.gapStampLocal_J, scratch.gapStampLocal_V);
      const harmN = remapStampInto(
        scratch.gapStampLocal_I, scratch.gapStampLocal_J, scratch.gapStampLocal_V, ntLocal,
        scratch.harmTrip_I, scratch.harmTrip_J, scratch.harmTrip_V);
      scratch.harmTrip_n = harmN;

      // -------- Linear-mode bypass --------
      if (!enabled) {
        const νR = linearNuFor(rotorMesh,  rotorMatTable);
        const νS = linearNuFor(statorMesh, statorMatTable);
        // Reuse the in-place hot-path assembly: dν=null so no rank-1 augment;
        // matches the linear K_lin(ν) emission.
        // But the pattern was built with dν=1 placeholders on every iron
        // element — assembleCombinedTriplets_phi at solve-time also emits
        // those (with dν=0 → contribution 0). We need the same triplet
        // ordering. Build via the *Into path with a zero dν vector.
        for (let e = 0; e < NeR_full; e++) {
          scratch.nu_rotor[e] = νR[e];
          scratch.dnu_rotor[e] = 0;
        }
        for (let e = 0; e < NeS_full; e++) {
          scratch.nu_stator[e] = νS[e];
          scratch.dnu_stator[e] = 0;
        }
        // Dummy A=0 for the rank-1 emission (gA=0 → triplet value 0).
        for (let i = 0; i < NnR_full; i++) scratch.fullA_rotor[i] = 0;
        for (let i = 0; i < NnS_full; i++) scratch.fullA_stator[i] = 0;
        const nR_mesh = assembleBodyTangentTripletsInto(rotorMesh, rotorKernels,
          scratch.nu_rotor, scratch.dnu_rotor, scratch.fullA_rotor,
          scratch.tripR_mesh_I, scratch.tripR_mesh_J, scratch.tripR_mesh_V);
        const nS_mesh = assembleBodyTangentTripletsInto(statorMesh, statorKernels,
          scratch.nu_stator, scratch.dnu_stator, scratch.fullA_stator,
          scratch.tripS_mesh_I, scratch.tripS_mesh_J, scratch.tripS_mesh_V);
        const nR_constr = applyConstraintsToTripletsInto(
          scratch.tripR_mesh_I, scratch.tripR_mesh_J, scratch.tripR_mesh_V, nR_mesh,
          slaveTableR, renumR,
          scratch.tripR_constr_I, scratch.tripR_constr_J, scratch.tripR_constr_V);
        const nS_constr = applyConstraintsToTripletsInto(
          scratch.tripS_mesh_I, scratch.tripS_mesh_J, scratch.tripS_mesh_V, nS_mesh,
          slaveTableS, renumS,
          scratch.tripS_constr_I, scratch.tripS_constr_J, scratch.tripS_constr_V);

        // Write V into the combined buffer in pattern order: rotor-constrained
        // V, stator-constrained V (indices already in body-local free-DOF
        // numbering; the offset by nRotorFree is structural and was baked into
        // the pattern), then harmonic V.
        const Vc = scratch.V_combined;
        let p = 0;
        for (let t = 0; t < nR_constr; t++) Vc[p++] = scratch.tripR_constr_V[t];
        for (let t = 0; t < nS_constr; t++) Vc[p++] = scratch.tripS_constr_V[t];
        for (let t = 0; t < harmN; t++)     Vc[p++] = scratch.harmTrip_V[t];

        solverSat.setValues(Vc);
        solverSat.factorize();
        const A = scratch.A_lin;
        solverSat.solveInto(f, A);

        // Residual: K_lin(ν)·A − f + K_h·A
        recoverFullFromBigA_Into(A, 0, nRotorFree, slaveTableR, renumR, NnR_full, scratch.fullA_rotor);
        recoverFullFromBigA_Into(A, nRotorFree, nStatorFree, slaveTableS, renumS, NnS_full, scratch.fullA_stator);
        bodyKtimesAMeshInto(rotorMesh,  rotorKernels,  scratch.nu_rotor,  scratch.fullA_rotor,  scratch.KAR_mesh);
        bodyKtimesAMeshInto(statorMesh, statorKernels, scratch.nu_stator, scratch.fullA_stator, scratch.KAS_mesh);
        applyConstraintsToFInto(scratch.KAR_mesh, slaveTableR, renumR, NnR_full, nRotorFree, scratch.KAR_free);
        applyConstraintsToFInto(scratch.KAS_mesh, slaveTableS, renumS, NnS_full, nStatorFree, scratch.KAS_free);
        const KAh = scratch.KAh;
        for (let i = 0; i < nGlobal; i++) KAh[i] = 0;
        const hI = scratch.harmTrip_I, hJ = scratch.harmTrip_J, hV = scratch.harmTrip_V;
        for (let t = 0; t < harmN; t++) KAh[hI[t]] += hV[t] * A[hJ[t]];

        let rMax = 0, fMax = 0;
        for (let i = 0; i < nRotorFree; i++) {
          const r = scratch.KAR_free[i] + KAh[i] - f[i];
          if (Math.abs(r) > rMax) rMax = Math.abs(r);
          if (Math.abs(f[i]) > fMax) fMax = Math.abs(f[i]);
        }
        for (let i = 0; i < nStatorFree; i++) {
          const gi = nRotorFree + i;
          const r = scratch.KAS_free[i] + KAh[gi] - f[gi];
          if (Math.abs(r) > rMax) rMax = Math.abs(r);
          if (Math.abs(f[gi]) > fMax) fMax = Math.abs(f[gi]);
        }
        for (let i = nRotorFree + nStatorFree; i < nGlobal; i++) {
          const r = KAh[i] - f[i];
          if (Math.abs(r) > rMax) rMax = Math.abs(r);
          if (Math.abs(f[i]) > fMax) fMax = Math.abs(f[i]);
        }
        const residual = rMax / (fMax + 1e-30);

        const summary = { iters: 1, deltaNorm: 0, residual };
        lastNewton = summary;
        return { A, iters: 1, deltaNorm: 0, residual };
      }

      // -------- Saturated Newton (inlined; uses scratch) --------
      // Warm-start policy: ALWAYS seed A_iter from the previous solve's A
      // when warmStart exists, regardless of phi. The previous solution at
      // nearby phi is a far better initial guess for Newton than zero —
      // even at large dθ, A_body is dominated by element-local geometry
      // (only the airgap stamp depends on phi), so the body interior of A
      // is mostly transferable and Newton converges in 1–2 iters instead
      // of 3. Strict phi-match is not required for warm-start to be a
      // valid starting point; it's only required for skipping Newton
      // entirely (the residual check inside the loop handles that case).
      const A_iter = scratch.A_iter;
      if (warmStart) {
        const ws = warmStart.A;
        for (let i = 0; i < nGlobal; i++) A_iter[i] = ws[i];
      } else {
        for (let i = 0; i < nGlobal; i++) A_iter[i] = 0;
      }

      const maxIter = newtonOpts.maxIter;
      const tol = newtonOpts.tol;
      const residualTol = newtonOpts.residualTol;
      const eps = 1e-30;

      // Per-iter build into scratch. Reads A_iter, writes scratch.V_combined
      // (passed to solver.setValues) and scratch.residual.
      function buildInto() {
        // 1. Recover full A per body
        recoverFullFromBigA_Into(A_iter, 0, nRotorFree, slaveTableR, renumR, NnR_full, scratch.fullA_rotor);
        recoverFullFromBigA_Into(A_iter, nRotorFree, nStatorFree, slaveTableS, renumS, NnS_full, scratch.fullA_stator);

        // 2. ν, dν per element
        nuPerElemFromAInto(rotorMesh,  rotorMatTable,  scratch.fullA_rotor,  scratch.nu_rotor,  scratch.dnu_rotor);
        nuPerElemFromAInto(statorMesh, statorMatTable, scratch.fullA_stator, scratch.nu_stator, scratch.dnu_stator);

        // 3. Body tangent triplets (mesh-indexed) into scratch
        const nR_mesh = assembleBodyTangentTripletsInto(rotorMesh, rotorKernels,
          scratch.nu_rotor, scratch.dnu_rotor, scratch.fullA_rotor,
          scratch.tripR_mesh_I, scratch.tripR_mesh_J, scratch.tripR_mesh_V);
        const nS_mesh = assembleBodyTangentTripletsInto(statorMesh, statorKernels,
          scratch.nu_stator, scratch.dnu_stator, scratch.fullA_stator,
          scratch.tripS_mesh_I, scratch.tripS_mesh_J, scratch.tripS_mesh_V);

        // 4. Apply constraints → free-DOF triplets
        const nR_constr = applyConstraintsToTripletsInto(
          scratch.tripR_mesh_I, scratch.tripR_mesh_J, scratch.tripR_mesh_V, nR_mesh,
          slaveTableR, renumR,
          scratch.tripR_constr_I, scratch.tripR_constr_J, scratch.tripR_constr_V);
        const nS_constr = applyConstraintsToTripletsInto(
          scratch.tripS_mesh_I, scratch.tripS_mesh_J, scratch.tripS_mesh_V, nS_mesh,
          slaveTableS, renumS,
          scratch.tripS_constr_I, scratch.tripS_constr_J, scratch.tripS_constr_V);

        // 5. Concatenate V into combined buffer (pattern order)
        const Vc = scratch.V_combined;
        let p = 0;
        for (let t = 0; t < nR_constr; t++) Vc[p++] = scratch.tripR_constr_V[t];
        for (let t = 0; t < nS_constr; t++) Vc[p++] = scratch.tripS_constr_V[t];
        for (let t = 0; t < harmN; t++)     Vc[p++] = scratch.harmTrip_V[t];

        // 6. Residual = K_lin(ν)·A − f + K_h·A (use secant K, not Newton tangent)
        bodyKtimesAMeshInto(rotorMesh,  rotorKernels,  scratch.nu_rotor,  scratch.fullA_rotor,  scratch.KAR_mesh);
        bodyKtimesAMeshInto(statorMesh, statorKernels, scratch.nu_stator, scratch.fullA_stator, scratch.KAS_mesh);
        applyConstraintsToFInto(scratch.KAR_mesh, slaveTableR, renumR, NnR_full, nRotorFree, scratch.KAR_free);
        applyConstraintsToFInto(scratch.KAS_mesh, slaveTableS, renumS, NnS_full, nStatorFree, scratch.KAS_free);
        const KAh = scratch.KAh;
        for (let i = 0; i < nGlobal; i++) KAh[i] = 0;
        const hI = scratch.harmTrip_I, hJ = scratch.harmTrip_J, hV = scratch.harmTrip_V;
        for (let t = 0; t < harmN; t++) KAh[hI[t]] += hV[t] * A_iter[hJ[t]];

        const residual = scratch.residual;
        for (let i = 0; i < nRotorFree; i++) {
          residual[i] = scratch.KAR_free[i] + KAh[i] - f[i];
        }
        for (let i = 0; i < nStatorFree; i++) {
          residual[nRotorFree + i] = scratch.KAS_free[i] + KAh[nRotorFree + i] - f[nRotorFree + i];
        }
        for (let i = nRotorFree + nStatorFree; i < nGlobal; i++) {
          residual[i] = KAh[i] - f[i];
        }
      }

      let iters = 0;
      let deltaNorm = 0;
      let residualScaled = Infinity;
      let converged = false;
      const neg = scratch.neg;
      const residual = scratch.residual;

      // Pre-Newton residual check. If the warm-started A_iter already
      // satisfies the residual tolerance for the NEW (theta, currents),
      // we can return immediately — no factorize, no solve, no Newton
      // iters. This is the "warm-start fully converged" fast path, hot
      // for the user-facing visualization loop where consecutive steps
      // at small dθ leave A nearly stationary.
      //
      // buildInto() also writes V_combined; we discard it on the fast
      // path (no factorize follows), so no harm. The buildInto cost
      // (~2-3 ms) is the residual evaluation we'd do anyway.
      buildInto();
      {
        let rMax0 = 0, fMax0 = 0;
        for (let i = 0; i < nGlobal; i++) {
          if (Math.abs(residual[i]) > rMax0) rMax0 = Math.abs(residual[i]);
          if (Math.abs(f[i]) > fMax0) fMax0 = Math.abs(f[i]);
        }
        const r0Scaled = rMax0 / (fMax0 + eps);
        if (r0Scaled < residualTol) {
          // Already converged from warm-start.
          residualScaled = r0Scaled;
          converged = true;
          iters = 0;
        }
      }

      // If not pre-converged, run damped Newton with backtracking line
      // search. From a cold start (A_iter=0) the full Newton step can
      // overshoot deep into the saturated regime — the linear K(ν₀) is
      // very compliant (μᵣ ≈ 1000), giving an iter-1 A magnitude that
      // would correspond to physically impossible B fields. The damped
      // step keeps A inside the linearisation neighbourhood; backtracking
      // shrinks α until the residual non-increases. With Frohlich's
      // bounded ν the failure mode is no longer NaN (it was 0·Infinity
      // in the old Brauer exponential), so this is a convergence aid
      // rather than a NaN guard — but both fixes are needed: bounded ν
      // alone leaves Newton lurching back and forth across the knee on
      // cold-start; damping alone is wasted if ν blows up.
      //
      // Hot path (warm-start near solution): α=1 is accepted on the
      // first try — one extra buildInto per Newton iter vs the old
      // non-damped path. That extra build is the cost of the residual
      // evaluation we need to test acceptance.
      let needsBuild = false;  // first iter: residual is already current
      let prevRes = residualScaled;
      for (let it = 0; !converged && it < maxIter; it++) {
        iters = it + 1;
        if (needsBuild) buildInto();
        needsBuild = false;  // about to do builds inside line search
        solverSat.setValues(scratch.V_combined);
        solverSat.factorize();
        // ΔA = solver.solve(-residual). solveInto avoids the per-iter
        // Float64Array(nGlobal) allocation that solve() would do.
        for (let i = 0; i < nGlobal; i++) neg[i] = -residual[i];
        const dA = scratch.dA;
        solverSat.solveInto(neg, dA);

        // Snapshot A_iter so the line-search can rebuild A_iter = A_prev + α·dA
        // at any α without re-solving.
        const A_prev = scratch.A_prev;
        for (let i = 0; i < nGlobal; i++) A_prev[i] = A_iter[i];

        // Backtracking: try α = 1, 0.5, 0.25, … Accept the first α for
        // which the new residual norm is finite and not larger than the
        // old one (small 1.001 slack to absorb roundoff). If even α ≈ 4e-4
        // doesn't reduce the residual, bail (further shrinking won't help).
        let alpha = 1.0;
        let accepted = false;
        let newRes = prevRes;
        const MAX_LS = 12;
        for (let ls = 0; ls < MAX_LS; ls++) {
          for (let i = 0; i < nGlobal; i++) A_iter[i] = A_prev[i] + alpha * dA[i];
          buildInto();
          let rMax = 0, fMax = 0;
          for (let i = 0; i < nGlobal; i++) {
            if (Math.abs(residual[i]) > rMax) rMax = Math.abs(residual[i]);
            if (Math.abs(f[i])        > fMax) fMax = Math.abs(f[i]);
          }
          newRes = rMax / (fMax + eps);
          if (Number.isFinite(newRes) && newRes <= prevRes * 1.001) {
            accepted = true;
            break;
          }
          alpha *= 0.5;
        }
        if (!accepted) {
          // Restore A_iter to the last attempted step (smallest α);
          // the caller sees this as a non-converged result via the
          // returned residual/deltaNorm fields.
          break;
        }
        residualScaled = newRes;
        prevRes = newRes;

        // Step norm uses the ACCEPTED step (α·dA) against the PRE-step A_prev.
        let aMax = 0, dMax = 0;
        for (let i = 0; i < nGlobal; i++) {
          const ap = A_prev[i];
          const di = alpha * dA[i];
          if (Math.abs(ap) > aMax) aMax = Math.abs(ap);
          if (Math.abs(di) > dMax) dMax = Math.abs(di);
        }
        deltaNorm = dMax / (aMax + eps);

        if (deltaNorm < tol && residualScaled < residualTol) {
          converged = true;
          break;
        }
      }

      // No final buildInto needed: the line-search's last accepted iter
      // already left scratch.residual / V_combined consistent with A_iter.

      // Return-shape parity with the previous newtonSolve-driven path. A must
      // be a freshly-allocated Float64Array (the caller may stash it in
      // warmStart and we don't want aliasing with scratch.A_iter, which we
      // overwrite next call).
      const A_out = new Float64Array(nGlobal);
      for (let i = 0; i < nGlobal; i++) A_out[i] = A_iter[i];

      warmStart = { phi, A: A_out };
      lastNewton = { iters, deltaNorm, residual: residualScaled };
      return { A: A_out, iters, deltaNorm, residual: residualScaled };
    }

    // Utility: extract slice [start, start+len) of a Float64Array A as a new
    // Float64Array (so the body-recover helpers see only their nodes).
    function subarrayBody(A, start, len) {
      const out = new Float64Array(len);
      for (let i = 0; i < len; i++) out[i] = A[start + i];
      return out;
    }

    // ----------------------------------------------------------------------
    //  Recover full per-body nodal A from a combined bordered free-DOF vector.
    //  Pinned (D6 outer-stator) nodes get A=0; constraint slaves are
    //  interpolated from their masters.
    // ----------------------------------------------------------------------
    function bodyFullNodalAFromCombined(combinedA) {
      // Allocates fresh fullAR/fullAS because they're returned in
      // slice.solve()'s field.{rotor,stator}.Anode and must survive across
      // calls (the contract test asserts r0.field.rotor.Anode is independent
      // from r03.field.rotor.Anode). Use recoverFullFromBigA_Into to avoid
      // the subarrayBody intermediates that the older path allocated.
      const fullAR = new Float64Array(NnR_full);
      const fullAS = new Float64Array(NnS_full);
      recoverFullFromBigA_Into(combinedA, 0,          nRotorFree,  slaveTableR, renumR, NnR_full, fullAR);
      recoverFullFromBigA_Into(combinedA, nRotorFree, nStatorFree, slaveTableS, renumS, NnS_full, fullAS);
      return { fullAR, fullAS };
    }

    // Allocation-free variant: writes the recovered per-body full nodal A
    // directly into scratch.fullA_rotor and scratch.fullA_stator. Callers
    // read from those buffers afterwards (gapNodalA, fluxLinkagesFromFullA,
    // bElemArrays). No fresh Float64Arrays.
    function bodyFullNodalAFromCombinedInto(combinedA) {
      recoverFullFromBigA_Into(combinedA, 0,           nRotorFree,  slaveTableR, renumR, NnR_full, scratch.fullA_rotor);
      recoverFullFromBigA_Into(combinedA, nRotorFree,  nStatorFree, slaveTableS, renumS, NnS_full, scratch.fullA_stator);
    }

    // ----------------------------------------------------------------------
    //  Extract gap-circle nodal A as Float64Array(Ngr/Ngs), in gapLoop order.
    // ----------------------------------------------------------------------
    function gapNodalA(body, fullAbody) {
      const N = body.gapLoop.length;
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) out[i] = fullAbody[body.gapLoop[i]];
      return out;
    }

    // Into variant — writes into caller's out buffer (length = body.gapLoop.length).
    function gapNodalAInto(body, fullAbody, out) {
      const N = body.gapLoop.length;
      const loop = body.gapLoop;
      for (let i = 0; i < N; i++) out[i] = fullAbody[loop[i]];
      return out;
    }

    // ----------------------------------------------------------------------
    //  fluxLinkagesFromFullA(currents-unused; A is the global solution) →
    //    Float64Array(nCircuits)
    //
    //  Bridge formula (mesh-native; the grid `coilMasks·dA` analog):
    //    λ_k = ell · Σ_{e: srcId(e) == k} A_elem · turns(e)
    //  where A_elem is the area-weighted average of the element's nodal A
    //  values (Q4 4-node mean / linear-tri 3-node mean — equivalent to
    //  (1/area)·∫ A dA for these shape functions).
    //
    //  Sum over BOTH bodies; circuit indices are global across rotor+stator.
    // ----------------------------------------------------------------------
    // fluxLinkagesFromFullAInto(fullAR, fullAS, out) — writes nCircuits-long
    // linkages into caller's out buffer using the pre-built conductor index.
    // No allocations. Inner loop iterates only conductor elements (typically
    // 50–200 total) rather than all 6000+ elements across both bodies.
    function fluxLinkagesFromFullAInto(fullAR, fullAS, out) {
      for (let k = 0; k < nCircuits; k++) out[k] = 0;
      // Rotor body
      {
        const idx = conductorIndexRotor;
        const start = idx.start;
        const elemIdx = idx.elemIdx;
        const turns = idx.turns;
        const elems = rotorMesh.elems;
        for (let k = 0; k < nCircuits; k++) {
          const lo = start[k], hi = start[k + 1];
          let acc = 0;
          for (let p = lo; p < hi; p++) {
            const e = elemIdx[p];
            const n0 = elems[4*e];
            const n1 = elems[4*e+1];
            const n2 = elems[4*e+2];
            const n3 = elems[4*e+3];
            const Aavg = (n3 === -1)
              ? (fullAR[n0] + fullAR[n1] + fullAR[n2]) / 3
              : (fullAR[n0] + fullAR[n1] + fullAR[n2] + fullAR[n3]) / 4;
            acc += Aavg * turns[p];
          }
          out[k] += acc;
        }
      }
      // Stator body
      {
        const idx = conductorIndexStator;
        const start = idx.start;
        const elemIdx = idx.elemIdx;
        const turns = idx.turns;
        const elems = statorMesh.elems;
        for (let k = 0; k < nCircuits; k++) {
          const lo = start[k], hi = start[k + 1];
          let acc = 0;
          for (let p = lo; p < hi; p++) {
            const e = elemIdx[p];
            const n0 = elems[4*e];
            const n1 = elems[4*e+1];
            const n2 = elems[4*e+2];
            const n3 = elems[4*e+3];
            const Aavg = (n3 === -1)
              ? (fullAS[n0] + fullAS[n1] + fullAS[n2]) / 3
              : (fullAS[n0] + fullAS[n1] + fullAS[n2] + fullAS[n3]) / 4;
            acc += Aavg * turns[p];
          }
          out[k] += acc;
        }
      }
      // Flux linkage is the physical loop integral of A (λ = ell·∮A·dl, the
      // Stokes/Ampère bridge): correct as-is with no π. (An independent
      // field-side computation λ = N·ell·(Ā_go − Ā_ret) matches this to ratio
      // 1.0, confirming the unscaled value is the physical webers used by
      // motor-run for back-EMF/circuit.) The harmonic-gap energy-measure π
      // (Bug #1) lives ONLY in the co-energy TORQUE — see
      // motor-stack.js coenergyTorque — NOT here on the λ readout.
      for (let k = 0; k < nCircuits; k++) out[k] *= ell;
      return out;
    }

    // Allocating wrapper preserved for slice.solve's return value (consumed
    // by motor-stack and discarded after entry-wise accumulation).
    function fluxLinkagesFromFullA(fullAR, fullAS) {
      const out = new Float64Array(nCircuits);
      return fluxLinkagesFromFullAInto(fullAR, fullAS, out);
    }

    // ----------------------------------------------------------------------
    //  Element-wise Belem (Bx, By, mag) for a body, given full nodal A.
    //  Returns { mag: Float64Array(Ne), Bx: Float64Array(Ne), By: Float64Array(Ne) }.
    // ----------------------------------------------------------------------
    function bElemArrays(body, fullAbody) {
      const Ne = body.elems.length / 4;
      const Bx = new Float64Array(Ne);
      const By = new Float64Array(Ne);
      const mag = new Float64Array(Ne);
      bElemArraysInto(body, fullAbody, mag, Bx, By);
      return { mag, Bx, By };
    }

    // Into variant: writes into caller-provided mag, Bx, By buffers (each
    // Float64Array(Ne)). No allocation.
    function bElemArraysInto(body, fullAbody, mag, Bx, By) {
      const Ne = body.elems.length / 4;
      for (let e = 0; e < Ne; e++) {
        const b = bElement(body, e, fullAbody);
        Bx[e] = b.Bx;
        By[e] = b.By;
        mag[e] = Math.hypot(b.Bx, b.By);
      }
    }

    // ----------------------------------------------------------------------
    //  hasMagnetMaterial(body) → bool
    // ----------------------------------------------------------------------
    function hasMagnetMaterial(body) {
      const mats = body.materials;
      for (let i = 0; i < mats.length; i++) {
        if (mats[i] && mats[i].kind === "magnet") return true;
      }
      return false;
    }

    // ----------------------------------------------------------------------
    //  linearMagnetOnlySolve(thetaR) → combined-A Float64Array(nGlobal)
    //
    //  A FRESH linear-material solve at the given rotor angle with zero
    //  external currents. Uses solverLin (independent factorization, no
    //  warm-start carry from solve()).
    // ----------------------------------------------------------------------
    function linearMagnetOnlySolve(thetaR) {
      // Wave 5.4 C: Schur via Lagrange-augmented K_b'. K_b' factor is built
      // once at create-time; per phi we factor only the small 314×314 dense
      // Schur complement -S = M⁻¹ + BᵀW (cached invariants: B, W, BtW).
      _ensureLinearSchurFactorAt(thetaR);
      // _magnetRhsCached is the nGlobal RHS with magnet load in body part
      // and zero harmonic rows. linearSchurSolve takes only the body part.
      // Output buffer is reused across coggingTorque calls (caller consumes
      // the returned A immediately and does not stash across calls).
      const A_out = schurScratch.A_magnet;
      linearSchurSolve(_magnetRhsCached, A_out);
      return A_out;
    }

    // ----------------------------------------------------------------------
    //  Wave 5.4 setup-sharing helpers.
    //
    //  _ensureLinearFactorAt(phi) — Build solverLin's K(phi) and factor it,
    //  unless the cached factor is already at this phi. The factor depends on
    //  (phi, materials); materials are frozen at create-time so phi is the
    //  only invalidator. Used by both linearMagnetOnlySolve and evaluateAt
    //  so back-to-back calls at the same phi (e.g. coggingTorque(θ) followed
    //  by extractCoeffs(θ)) reuse the factor; and within extractCoeffs's
    //  central-difference probe, adjacent calls at neighboring θ can share
    //  the center phi's factor.
    //
    //  _magnetRhsCached / _unitCurrentRhsCached[j] — combined nGlobal RHS
    //  vectors. Magnet load and unit-current load are both phi-invariant
    //  (magnet vectors are in the rotor frame; conductor currents are
    //  static), so we assemble them ONCE at create-time. Each call just
    //  picks the right cached vector.
    // ----------------------------------------------------------------------
    let _phiLinearCached = NaN;       // embed path (solverLin) cache key
    let _phiSchurCached  = NaN;       // Schur path (dense -S) cache key
    let _magnetRhsCached = null;
    let _unitCurrentRhsCached = null;
    let _linearNuRCached = null;
    let _linearNuSCached = null;

    function _ensureLinearFactorAt(phi) {
      if (_phiLinearCached === phi) return;
      const trip = assembleCombinedTriplets_phi(phi, _linearNuRCached, _linearNuSCached);
      solverLin.setValues(trip.V);
      solverLin.factorize();
      _phiLinearCached = phi;
    }

    function _ensureLinearSchurFactorAt(phi) {
      if (_phiSchurCached === phi) return;
      linearSchurPrepare(phi);
      _phiSchurCached = phi;
    }

    function _buildLinearRhsGlobal(fR_mesh, fS_mesh) {
      const fR = applyConstraintsToF(fR_mesh, rotorMesh.constraints, renumR, nRotorFree);
      const fS = applyConstraintsToF(fS_mesh, statorMesh.constraints, renumS, nStatorFree);
      const f = new Float64Array(nGlobal);
      for (let i = 0; i < nRotorFree; i++)  f[i] = fR[i];
      for (let i = 0; i < nStatorFree; i++) f[nRotorFree + i] = fS[i];
      // harmonic rows stay 0
      return f;
    }

    function _buildLinearRhsCaches() {
      _linearNuRCached = linearNuFor(rotorMesh,  rotorMatTable);
      _linearNuSCached = linearNuFor(statorMesh, statorMatTable);
      const zeroCurrents = new Float64Array(nCircuits);
      _magnetRhsCached = _buildLinearRhsGlobal(
        assembleInteriorMagnetLoadAndJz(rotorMesh,  zeroCurrents),
        assembleInteriorMagnetLoadAndJz(statorMesh, zeroCurrents)
      );
      _unitCurrentRhsCached = new Array(nCircuits);
      for (let j = 0; j < nCircuits; j++) {
        _unitCurrentRhsCached[j] = _buildLinearRhsGlobal(
          assembleUnitCurrentRhs(rotorMesh,  j),
          assembleUnitCurrentRhs(statorMesh, j)
        );
      }
    }

    // --------------- public solve(thetaR, currents) ---------------
    function solve(thetaR, currents) {
      const m = nCircuits;
      const cur = (currents instanceof Float64Array && currents.length === m)
        ? currents
        : (function () {
            const c = new Float64Array(m);
            if (currents) {
              const n = Math.min(m, currents.length);
              for (let i = 0; i < n; i++) c[i] = currents[i];
            }
            return c;
          })();

      const r = solveStaticRotor(thetaR, cur);
      const combinedA = r.A;

      // Per-body full nodal A into scratch (= field.{rotor,stator}.Anode
      // via the alias set up at create-time).
      bodyFullNodalAFromCombinedInto(combinedA);
      const fullAR = scratch.fullA_rotor;
      const fullAS = scratch.fullA_stator;

      // Gap-circle nodal A into scratch.
      gapNodalAInto(rotorMesh,  fullAR, scratch.gapNodal_R);
      gapNodalAInto(statorMesh, fullAS, scratch.gapNodal_S);

      // Torque via the harmonic gap's Maxwell-stress integral.
      _solveResult.torque = gap.torque(scratch.gapNodal_R, scratch.gapNodal_S, thetaR);

      // Circuit flux linkages into the pre-allocated scratch (aliased into
      // the result object).
      fluxLinkagesFromFullAInto(fullAR, fullAS, _solveResultFluxLinkages);

      // Mesh-native B-field per body into Belem scratch.
      bElemArraysInto(rotorMesh,  fullAR,
        scratch.fieldR_Belem_mag, scratch.fieldR_Belem_Bx, scratch.fieldR_Belem_By);
      bElemArraysInto(statorMesh, fullAS,
        scratch.fieldS_Belem_mag, scratch.fieldS_Belem_Bx, scratch.fieldS_Belem_By);

      // Gap-circle harmonic projections into scratch.
      gap.projectInto(rotorMesh.gapTheta,  scratch.gapNodal_R, scratch.harmR_a, scratch.harmR_b);
      gap.projectInto(statorMesh.gapTheta, scratch.gapNodal_S, scratch.harmS_a, scratch.harmS_b);

      _solveResult.field.gap.phi = thetaR;
      return _solveResult;
    }

    // --------------- public coggingTorque(thetaR) ---------------
    function coggingTorque(thetaR) {
      // Zero-not-skip (§11.1#2): magnet-free section ⇒ exactly 0.
      if (!hasMagnetMaterial(rotorMesh) && !hasMagnetMaterial(statorMesh)) {
        return 0;
      }

      const combinedA = linearMagnetOnlySolve(thetaR);

      // Use scratch for the body-full A and gap-nodal A — coggingTorque
      // does not return them, only the torque scalar.
      bodyFullNodalAFromCombinedInto(combinedA);
      gapNodalAInto(rotorMesh,  scratch.fullA_rotor,  scratch.gapNodal_R);
      gapNodalAInto(statorMesh, scratch.fullA_stator, scratch.gapNodal_S);
      return gap.torque(scratch.gapNodal_R, scratch.gapNodal_S, thetaR);
    }

    // --------------- gapStampLog (test-only diagnostic) ---------------
    const gapStampLog = [];

    // --------------------------------------------------------------------------
    //  extractCoeffs(thetaR, opts2) → { L, dLdth, lambdaPm, dLambdaPmdth }
    //
    //  The §10 staggered probe done natively on the FEA slice. For each of
    //  three angles {thetaR - h, thetaR, thetaR + h}:
    //    1. gap.stamp(angle) — rebuild harmonic-coupling border values (interior
    //       is φ-independent for the linear-material operator).
    //    2. solverLin.setValues + factorize.
    //    3. One magnetization-only solve → λ_pm(angle) for each circuit.
    //    4. m unit-current solves (Jz = turnsDensity_j, magnetization=0)
    //       → column j of L(angle).
    //  Then central-difference dL/dθ and dλ_pm/dθ. All probes use the linear
    //  material (no Brauer); the warm-start cache is not consulted.
    //
    //  derivStep defaults to the machine-aware derived step Math.PI/(poles·1e5).
    // --------------------------------------------------------------------------

    // Assemble linear-material magnet-only RHS for a body at angle thetaR (just
    // the magnetization curl — Jz = 0).
    function assembleMagnetRhs(body) {
      const NnBody = body.nodes.length / 2;
      const f = new Float64Array(NnBody);
      const zeroCurrents = new Float64Array(nCircuits);
      const fMesh = assembleInteriorMagnetLoadAndJz(body, zeroCurrents);
      for (let i = 0; i < NnBody; i++) f[i] = fMesh[i];
      return f;
    }

    // Assemble unit-current RHS for a body and circuit j: every conductor element
    // with srcId == j contributes Jz = turns(elem)/area(elem) (a 1 A excitation).
    function assembleUnitCurrentRhs(body, j) {
      const NnBody = body.nodes.length / 2;
      const f = new Float64Array(NnBody);
      const Ne = body.elems.length / 4;
      for (let e = 0; e < Ne; e++) {
        const sid = body.srcId[e];
        if (sid !== j) continue;
        const mid = body.matId[e];
        const mat = body.materials[mid];
        if (!mat || mat.kind !== "conductor") continue;
        const n0 = body.elems[4*e];
        const n1 = body.elems[4*e+1];
        const n2 = body.elems[4*e+2];
        const n3 = body.elems[4*e+3];
        let area;
        let nLocal;
        if (n3 === -1) {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1]];
          const g = triGradients(xN, yN);
          area = g.area;
          nLocal = [n0, n1, n2];
        } else {
          const xN = [body.nodes[2*n0], body.nodes[2*n1], body.nodes[2*n2], body.nodes[2*n3]];
          const yN = [body.nodes[2*n0+1], body.nodes[2*n1+1], body.nodes[2*n2+1], body.nodes[2*n3+1]];
          let A = 0;
          for (let gs = 0; gs < 2; gs++) {
            for (let gt = 0; gt < 2; gt++) {
              const jac = q4Jacobian(xN, yN, GP4_1D[gs], GP4_1D[gt]);
              A += jac.detJ;
            }
          }
          area = A;
          nLocal = [n0, n1, n2, n3];
        }
        if (!(area > 0)) continue;
        const turns = body.turns[e];
        const Jz = turns / area; // unit current * turnsDensity
        const load = Jz * area / nLocal.length;
        for (let i = 0; i < nLocal.length; i++) f[nLocal[i]] += load;
      }
      return f;
    }

    // Combine per-body RHS (mesh-node) into the global free-DOF vector.
    function combineBodyRhs(fR_mesh, fS_mesh) {
      const fR = applyConstraintsToF(fR_mesh, rotorMesh.constraints, renumR, nRotorFree);
      const fS = applyConstraintsToF(fS_mesh, statorMesh.constraints, renumS, nStatorFree);
      const fGlobal = new Float64Array(nGlobal);
      for (let i = 0; i < nRotorFree; i++) fGlobal[i] = fR[i];
      for (let i = 0; i < nStatorFree; i++) fGlobal[nRotorFree + i] = fS[i];
      // harmonic rows stay 0
      return fGlobal;
    }

    // Compute flux linkages from a combined-A vector (linear-material
    // context). Uses scratch.fullA_rotor/stator as the per-body recovery
    // buffers (overwritten on each call; safe because callers consume the
    // returned λ vector immediately).
    function fluxLinkagesFromCombined(combinedA) {
      bodyFullNodalAFromCombinedInto(combinedA);
      const out = new Float64Array(nCircuits);
      return fluxLinkagesFromFullAInto(scratch.fullA_rotor, scratch.fullA_stator, out);
    }

    // Into variant: writes into caller's out (length nCircuits). No alloc.
    function fluxLinkagesFromCombinedInto(combinedA, out) {
      bodyFullNodalAFromCombinedInto(combinedA);
      return fluxLinkagesFromFullAInto(scratch.fullA_rotor, scratch.fullA_stator, out);
    }

    // Wave 5.4 setup-sharing: at the same phi, all (m+1) RHS reuse the
    // same factorization via _ensureLinearFactorAt. RHS vectors (magnet,
    // unit-current per circuit) are phi-invariant and cached at create-time
    // in `_magnetRhsCached` and `_unitCurrentRhsCached`.
    function evaluateAt(angle) {
      const phi = angle;
      gapStampLog.push(phi);

      // 1. Prepare the small dense Schur factor -S at this phi. K_b' factor
      //    is reused from create-time.
      _ensureLinearSchurFactorAt(phi);

      const m = nCircuits;
      // Reuse schurScratch.A_magnet and schurScratch.A_j across both the
      // m+1 RHS within one evaluateAt call AND across the 3 evaluateAt calls
      // per extractCoeffs (the caller never stashes the A vector — it only
      // consumes lambdaPm/lam_j entries).
      const A_pm = schurScratch.A_magnet;
      linearSchurSolve(_magnetRhsCached, A_pm);
      const lambdaPm = fluxLinkagesFromCombined(A_pm);

      const L = new Float64Array(m * m);
      const A_j = schurScratch.A_j;
      const lam_j = schurScratch.lam_j;
      for (let j = 0; j < m; j++) {
        linearSchurSolve(_unitCurrentRhsCached[j], A_j);
        fluxLinkagesFromCombinedInto(A_j, lam_j);
        for (let i = 0; i < m; i++) {
          L[i * m + j] = lam_j[i];
        }
      }

      return { L, lambdaPm };
    }

    function extractCoeffs(thetaR, opts2) {
      opts2 = opts2 || {};
      // Default derivStep is machine-aware (derived in spec §"extractCoeffs
      // derivStep — derivation"): h_opt ≈ 1.8e-5·(π/poles) rad. A caller-
      // supplied override must lie within [1e-7, π/(10·poles)] — too-small
      // steps amplify round-off, too-large steps lose the smoothness
      // assumption behind the central-difference truncation bound.
      let h;
      if (opts2.derivStep != null) {
        h = opts2.derivStep;
        const hMax = Math.PI / (10 * poles);
        if (!(h >= 1e-7 && h <= hMax)) {
          throw new Error(
            "extractCoeffs derivStep " + h + " out of range [1e-7, " +
            hMax + " = π/(10·poles)] for poles=" + poles);
        }
      } else {
        h = Math.PI / (poles * 1e5);
      }
      const m = nCircuits;

      // Clear the per-extract gapStampLog diagnostic.
      gapStampLog.length = 0;

      // Three evaluations for central differences. Spec order: -h, center, +h.
      const minus  = evaluateAt(thetaR - h);
      const center = evaluateAt(thetaR);
      const plus   = evaluateAt(thetaR + h);

      const inv2h = 1 / (2 * h);
      const dLdth = new Float64Array(m * m);
      for (let k = 0; k < m * m; k++) {
        dLdth[k] = (plus.L[k] - minus.L[k]) * inv2h;
      }
      const dLambdaPmdth = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        dLambdaPmdth[k] = (plus.lambdaPm[k] - minus.lambdaPm[k]) * inv2h;
      }

      return {
        L: center.L,
        dLdth: dLdth,
        lambdaPm: center.lambdaPm,
        dLambdaPmdth: dLambdaPmdth,
      };
    }

    // --------------- __internals (test-only hatch) ---------------
    const __internals = {
      prepare: function () {
        // No-op (everything happened in create). Kept for the spec-listed key.
        return {
          rotorMesh, statorMesh, gap,
          renumbering: pinInfo.renumbering,
          pinned: pinInfo.pinned,
          nGlobal,
        };
      },
      assembleInteriorPatternAndValues: function (body, νPerElem) {
        return assembleInteriorPatternAndValues(body, νPerElem);
      },
      assembleInteriorMagnetLoadAndJz: function (body, currents/*, νPerElem */) {
        return assembleInteriorMagnetLoadAndJz(body, currents);
      },
      assembleCombinedTriplets: assembleCombinedTriplets,
      brauerNu: function (B2, material, BkneeDefault) {
        return brauerNu(B2, material,
          BkneeDefault != null ? BkneeDefault : sat.BkneeDefault);
      },
      newtonSolve: newtonSolve,
      solveStaticRotor: solveStaticRotor,
      eliminateOuterStatorPin: function (rMesh, sMesh, ro) {
        return eliminateOuterStatorPin(
          rMesh || rotorMesh,
          sMesh || statorMesh,
          ro != null ? ro : rOuter
        );
      },
      remapGapTriplets: remapGapTriplets,
      globalLayout: {
        Nn_rotor_free: nRotorFree,
        Nn_stator_free: nStatorFree,
        nHarmonicDofs: nHarmonicDofs,
        n: nGlobal,
      },
      K: K,
      derivedSlots: slots,
      derivedPoles: poles,
      bodies: { rotor: rotorMesh, stator: statorMesh },
      // Wave 5.4 C diagnostics.
      solverKb: solverKb,
      kbTrip: kbTrip,
      W_dense: W_dense,
      BtW_dense: BtW_dense,
      B_extracted: B,
      get schurPrepCount() { return _schurPrepCount; },
      get schurSolveCount() { return _schurSolveCount; },
      solverSat: solverSat,
      solverLin: solverLin,
      get lastNewton() { return lastNewton; },
      gapStampLog: gapStampLog,
      // Plus internals other waves will need; harmless to expose now:
      _gapLocalToGlobalRotor:  gapLocalToGlobalRotor,
      _gapLocalToGlobalStator: gapLocalToGlobalStator,
      _harmonicBaseGlobal:     harmonicBaseGlobal,
      _Ngr: Ngr,
      _Ngs: Ngs,
      _gap: gap,
    };

    // Wave 5.4 setup-sharing: build linear-path RHS caches at create-time.
    // All RHS used by coggingTorque/extractCoeffs are phi-invariant.
    _buildLinearRhsCaches();

    return {
      nCircuits: nCircuits,
      solve: solve,
      extractCoeffs: extractCoeffs,
      coggingTorque: coggingTorque,
      clearWarmStart: clearWarmStart,
      __internals: __internals,
    };
  }

  LIB.MotorSlice = { create: create };
})();
