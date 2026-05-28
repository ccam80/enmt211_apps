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

    // Explicit override wins (D5)
    if (typeof material.k1 === "number" &&
        typeof material.k2 === "number" &&
        typeof material.k3 === "number") {
      const k1 = material.k1, k2 = material.k2, k3 = material.k3;
      const E = Math.exp(k3 * B2);
      return { ν: k1 + k2 * E, dν_dB2: k2 * k3 * E };
    }

    const muR = typeof material.muR === "number" ? material.muR : 1000;
    const k1 = 1 / (MU0 * muR);

    let Bk = (material.Bknee != null && Number.isFinite(material.Bknee))
      ? material.Bknee
      : BkneeDefault;
    if (!(Bk > 0)) Bk = 1.6;

    const k3 = 1 / (Bk * Bk);
    const norm = 1 / (Math.E - 1);
    const k2_eff = k1 * norm; // coefficient on the (exp − 1) form
    const E  = Math.exp(k3 * B2);
    return { ν: k1 + k2_eff * (E - 1), dν_dB2: k2_eff * k3 * E };
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
    const dNdx = new Float64Array(4);
    const dNdy = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      dNdx[i] = sh.dNds[i] * dsdx + sh.dNdt[i] * dtdx;
      dNdy[i] = sh.dNds[i] * dsdy + sh.dNdt[i] * dtdy;
    }
    return { dNdx, dNdy, detJ };
  }

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
    const dNdx = new Float64Array(3);
    const dNdy = new Float64Array(3);
    dNdx[0] = (y1 - y2) * inv2A;
    dNdx[1] = (y2 - y0) * inv2A;
    dNdx[2] = (y0 - y1) * inv2A;
    dNdy[0] = (x2 - x1) * inv2A;
    dNdy[1] = (x0 - x2) * inv2A;
    dNdy[2] = (x1 - x0) * inv2A;
    return { dNdx, dNdy, area, twoA };
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
  function assembleInteriorMagnetLoadAndJz(body, currents) {
    const NnBody = body.nodes.length / 2;
    const f = new Float64Array(NnBody);
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
        // Use element-center (s=0,t=0) Jacobian for the 1-point approximation of
        // the magnet load. For area, sum the 2x2 Gauss weights.
        let A = 0;
        const dNdxA = new Float64Array(4);
        const dNdyA = new Float64Array(4);
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
        // Average gradient = ∫ ∂N/∂x dA / area for use with (∇×M)·N_i
        for (let i = 0; i < 4; i++) {
          dNdxA[i] /= A;
          dNdyA[i] /= A;
        }
        dNdx_avg = dNdxA;
        dNdy_avg = dNdyA;
        nLocal = [n0, n1, n2, n3];
      }
      if (!(area > 0)) continue;

      // Jz contribution: distribute uniformly to nodes (mesh indexing)
      if (mat && mat.kind === "conductor") {
        const sid = body.srcId[e];
        if (sid >= 0) {
          const cur = (currents && sid < currents.length) ? currents[sid] : 0;
          const turns = body.turns[e];
          const Jz = (cur * turns) / area;
          const load = Jz * area / nLocal.length;
          for (let i = 0; i < nLocal.length; i++) {
            f[nLocal[i]] += load;
          }
        }
      } else if (mat && mat.kind === "magnet" && mat.mrMag > 0) {
        const dx = body.magDir[2 * e];
        const dy = body.magDir[2 * e + 1];
        const Mx = mat.mrMag * dx;
        const My = mat.mrMag * dy;
        for (let i = 0; i < nLocal.length; i++) {
          f[nLocal[i]] += (Mx * dNdy_avg[i] - My * dNdx_avg[i]) * area / MU0;
        }
      }
    }
    return f;
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
    const newtonOpts = Object.assign(
      { maxIter: 8, tol: 1e-6, residualTol: 1e-9 },
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

      // Pre-assemble RHS (body-interior parts only; harmonic rows are 0)
      const f = new Float64Array(nGlobal);

      const fR_mesh = assembleInteriorMagnetLoadAndJz(rotorMesh, currents);
      const fR      = applyConstraintsToF(fR_mesh, rotorMesh.constraints, renumR, nRotorFree);
      const fS_mesh = assembleInteriorMagnetLoadAndJz(statorMesh, currents);
      const fS      = applyConstraintsToF(fS_mesh, statorMesh.constraints, renumS, nStatorFree);

      for (let i = 0; i < nRotorFree; i++) f[i] = fR[i];
      for (let i = 0; i < nStatorFree; i++) f[nRotorFree + i] = fS[i];
      // harmonic rows stay 0

      // --------------- Linear-mode bypass ---------------
      if (!enabled) {
        const νR = linearNuFor(rotorMesh,  rotorMatTable);
        const νS = linearNuFor(statorMesh, statorMatTable);
        const trip = assembleCombinedTriplets_phi(phi, νR, νS);
        solverSat.setValues(trip.V);
        solverSat.factorize();
        const A = solverSat.solve(f);
        // Compute residual ‖K·A − f‖∞ / (‖f‖∞ + ε)
        // K·A = body contributions + harmonic. Stitch.
        const fullAR = recoverFullFromConstrained(
          subarrayBody(A, 0, nRotorFree),
          rotorMesh.constraints, renumR, rotorMesh.nodes.length / 2
        );
        const fullAS = recoverFullFromConstrained(
          subarrayBody(A, nRotorFree, nStatorFree),
          statorMesh.constraints, renumS, statorMesh.nodes.length / 2
        );
        const KAr = bodyKtimesA(rotorMesh, νR, renumR, fullAR, nRotorFree);
        const KAs = bodyKtimesA(statorMesh, νS, renumS, fullAS, nStatorFree);
        const KAh = harmonicKtimesA(phi, A);
        const KA = new Float64Array(nGlobal);
        for (let i = 0; i < nRotorFree; i++) KA[i] = KAr[i];
        for (let i = 0; i < nStatorFree; i++) KA[nRotorFree + i] = KAs[i];
        for (let i = 0; i < nGlobal; i++) KA[i] += KAh[i];

        let rMax = 0, fMax = 0;
        for (let i = 0; i < nGlobal; i++) {
          const r = KA[i] - f[i];
          if (Math.abs(r) > rMax) rMax = Math.abs(r);
          if (Math.abs(f[i]) > fMax) fMax = Math.abs(f[i]);
        }
        const residual = rMax / (fMax + 1e-30);

        const summary = { iters: 1, deltaNorm: 0, residual };
        lastNewton = summary;
        return { A, iters: 1, deltaNorm: 0, residual };
      }

      // --------------- Saturated Newton ---------------
      let A0 = (warmStart && warmStart.phi === phi)
        ? new Float64Array(warmStart.A)
        : new Float64Array(nGlobal);

      // assembleResidualAndTangent
      function build(A) {
        const fullAR = recoverFullFromConstrained(
          subarrayBody(A, 0, nRotorFree),
          rotorMesh.constraints, renumR, rotorMesh.nodes.length / 2
        );
        const fullAS = recoverFullFromConstrained(
          subarrayBody(A, nRotorFree, nStatorFree),
          statorMesh.constraints, renumS, statorMesh.nodes.length / 2
        );
        const νR_obj = νPerElemFromA(rotorMesh,  rotorMatTable,  fullAR);
        const νS_obj = νPerElemFromA(statorMesh, statorMatTable, fullAS);

        // Tangent (with dν rank-1) in mesh-node indexing, then constraint-distribute + renumber
        let rTrip = assembleBodyTangentTriplets(rotorMesh,  νR_obj.ν, νR_obj.dν, fullAR);
        let sTrip = assembleBodyTangentTriplets(statorMesh, νS_obj.ν, νS_obj.dν, fullAS);
        rTrip = applyConstraintsToTriplets(rTrip, rotorMesh.constraints, renumR);
        sTrip = applyConstraintsToTriplets(sTrip, statorMesh.constraints, renumS);
        const stamp = gap.stamp(phi);
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

        // Residual = K_lin(A)·A − f (note: this uses the secant K, not the
        // Newton tangent; for Picard-like residual we use ν(A) not the rank-1
        // augmented form. The Newton update step in the driver uses the
        // tangent K stored in K.V.)
        const KAr = bodyKtimesA(rotorMesh,  νR_obj.ν, renumR, fullAR, nRotorFree);
        const KAs = bodyKtimesA(statorMesh, νS_obj.ν, renumS, fullAS, nStatorFree);
        const KAh = harmonicKtimesA(phi, A);
        const residual = new Float64Array(nGlobal);
        for (let i = 0; i < nRotorFree; i++) residual[i] = KAr[i] - f[i];
        for (let i = 0; i < nStatorFree; i++) residual[nRotorFree + i] = KAs[i] - f[nRotorFree + i];
        for (let i = 0; i < nGlobal; i++) residual[i] += KAh[i];

        return { K: { I, J, V }, f, residual };
      }

      // Use solverSat
      const result = newtonSolve({
        solver: solverSat,
        A0,
        assembleResidualAndTangent: build,
        maxIter: newtonOpts.maxIter,
        tol: newtonOpts.tol,
        residualTol: newtonOpts.residualTol,
      });

      // Cache warm start
      warmStart = { phi, A: new Float64Array(result.A) };
      lastNewton = { iters: result.iters, deltaNorm: result.deltaNorm, residual: result.residual };
      return result;
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
      const arFree = subarrayBody(combinedA, 0, nRotorFree);
      const asFree = subarrayBody(combinedA, nRotorFree, nStatorFree);
      const NnR = rotorMesh.nodes.length / 2;
      const NnS = statorMesh.nodes.length / 2;
      const fullAR = recoverFullFromConstrained(arFree, rotorMesh.constraints, renumR, NnR);
      const fullAS = recoverFullFromConstrained(asFree, statorMesh.constraints, renumS, NnS);
      return { fullAR, fullAS };
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
    function fluxLinkagesFromFullA(fullAR, fullAS) {
      const out = new Float64Array(nCircuits);
      function accumulateBody(body, fullA) {
        const Ne = body.elems.length / 4;
        for (let e = 0; e < Ne; e++) {
          const sid = body.srcId[e];
          if (sid < 0 || sid >= nCircuits) continue;
          const n0 = body.elems[4*e];
          const n1 = body.elems[4*e+1];
          const n2 = body.elems[4*e+2];
          const n3 = body.elems[4*e+3];
          let Aavg;
          if (n3 === -1) {
            Aavg = (fullA[n0] + fullA[n1] + fullA[n2]) / 3;
          } else {
            Aavg = (fullA[n0] + fullA[n1] + fullA[n2] + fullA[n3]) / 4;
          }
          out[sid] += Aavg * body.turns[e];
        }
      }
      accumulateBody(rotorMesh,  fullAR);
      accumulateBody(statorMesh, fullAS);
      for (let k = 0; k < nCircuits; k++) out[k] *= ell;
      return out;
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
      for (let e = 0; e < Ne; e++) {
        const b = bElement(body, e, fullAbody);
        Bx[e] = b.Bx;
        By[e] = b.By;
        mag[e] = Math.hypot(b.Bx, b.By);
      }
      return { mag, Bx, By };
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
      const phi = thetaR;
      const zeroCurrents = new Float64Array(nCircuits);

      // RHS: magnetization only (Jz=0 because currents are zero).
      const fR_mesh = assembleInteriorMagnetLoadAndJz(rotorMesh,  zeroCurrents);
      const fS_mesh = assembleInteriorMagnetLoadAndJz(statorMesh, zeroCurrents);
      const fR = applyConstraintsToF(fR_mesh, rotorMesh.constraints, renumR, nRotorFree);
      const fS = applyConstraintsToF(fS_mesh, statorMesh.constraints, renumS, nStatorFree);
      const f = new Float64Array(nGlobal);
      for (let i = 0; i < nRotorFree; i++)  f[i] = fR[i];
      for (let i = 0; i < nStatorFree; i++) f[nRotorFree + i] = fS[i];

      // Linear-material operator: ν per element = linNu (no Brauer).
      const νR = linearNuFor(rotorMesh,  rotorMatTable);
      const νS = linearNuFor(statorMesh, statorMatTable);
      const trip = assembleCombinedTriplets_phi(phi, νR, νS);
      solverLin.setValues(trip.V);
      solverLin.factorize();
      return solverLin.solve(f);
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

      // Per-body full nodal A (pinned + constraint slaves recovered).
      const { fullAR, fullAS } = bodyFullNodalAFromCombined(combinedA);

      // Gap-circle nodal A.
      const rotorGapNodal  = gapNodalA(rotorMesh,  fullAR);
      const statorGapNodal = gapNodalA(statorMesh, fullAS);

      // Torque via the harmonic gap's Maxwell-stress integral.
      const torque = gap.torque(rotorGapNodal, statorGapNodal, thetaR);

      // Circuit flux linkages.
      const fluxLinkages = fluxLinkagesFromFullA(fullAR, fullAS);

      // Mesh-native field per D3.
      const rotorBelem  = bElemArrays(rotorMesh,  fullAR);
      const statorBelem = bElemArrays(statorMesh, fullAS);
      const harmonicsR = gap.project(rotorMesh.gapTheta,  rotorGapNodal);
      const harmonicsS = gap.project(statorMesh.gapTheta, statorGapNodal);

      const field = {
        rotor:  { mesh: rotorMesh,  Anode: fullAR, Belem: rotorBelem },
        stator: { mesh: statorMesh, Anode: fullAS, Belem: statorBelem },
        gap: {
          harmonics: { rotor: harmonicsR, stator: harmonicsS },
          phi: thetaR,
        },
      };

      return { torque, fluxLinkages, field };
    }

    // --------------- public coggingTorque(thetaR) ---------------
    function coggingTorque(thetaR) {
      // Zero-not-skip (§11.1#2): magnet-free section ⇒ exactly 0.
      if (!hasMagnetMaterial(rotorMesh) && !hasMagnetMaterial(statorMesh)) {
        return 0;
      }

      const combinedA = linearMagnetOnlySolve(thetaR);

      const { fullAR, fullAS } = bodyFullNodalAFromCombined(combinedA);
      const rotorGapNodal  = gapNodalA(rotorMesh,  fullAR);
      const statorGapNodal = gapNodalA(statorMesh, fullAS);
      return gap.torque(rotorGapNodal, statorGapNodal, thetaR);
    }

    // --------------- gapStampLog (test-only diagnostic) ---------------
    const gapStampLog = [];

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

    return {
      nCircuits: nCircuits,
      solve: solve,
      coggingTorque: coggingTorque,
      clearWarmStart: clearWarmStart,
      __internals: __internals,
    };
  }

  LIB.MotorSlice = { create: create };
})();
