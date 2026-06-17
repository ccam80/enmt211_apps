"use strict";

// =============================================================================
//  LIB.MotorStack — universal N≥1 spatial aggregator
//
//  Builds one LIB.MotorSlice per expanded slice and always loops over all
//  slices (no single-slice bypass). Applies each slice's
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
  //  additionally injects opts.poles = expanded.poles so each slice gets the
  //  caller-provided pole count.
  // ---------------------------------------------------------------------------
  function create(expanded, opts) {
    opts = opts || {};

    const nCircuits = expanded.nCircuits;
    const expandedSlices = expanded.slices;

    // ---- Axial-flux netlist (2.5-D coupling) ----------------------------------
    // expanded.axial.loops = [{ slices:[{s,sign},…], Raxial, Fpm }, …]. Each loop is
    // an independent magnetic flux path: a signed set of slices (their net-radial-flux
    // DOFs Ψ_s) in series with a lumped axial reluctance Raxial and PM MMF Fpm. The
    // slices participating in any loop carry a flux DOF (fluxDof:true); the loop fluxes
    // Φ_l become reduced unknowns in solveCoupled. Absent ⇒ no flux DOFs ⇒ today's solve.
    const axial = expanded.axial || null;
    const axialLoops = [];
    const sliceFluxDof = [];
    if (axial && Array.isArray(axial.loops)) {
      for (const loop of axial.loops) {
        const incid = {};
        for (const e of loop.slices) incid[e.s] = e.sign;
        axialLoops.push({ incid: incid, Raxial: loop.Raxial || 0, Fpm: loop.Fpm || 0 });
      }
      for (let s = 0; s < expandedSlices.length; s++) {
        sliceFluxDof[s] = axialLoops.some(function (L) { return L.incid[s] !== undefined; });
      }
    }
    const L_loops = axialLoops.length;

    // Build one MotorSlice per slice entry. Always iterates — no fast path.
    const slices = expandedSlices.map(function (s, si) {
      const slice = LIB.MotorSlice.create(s.section, Object.assign({}, opts, {
        poles: expanded.poles,
        fluxDof: !!sliceFluxDof[si],   // allocate this slice's net-radial-flux DOF if it's in a loop
        // Forward the per-circuit commutation config so the slice can build the
        // brush/commutator spatial current-sheet remap for mechanically-
        // commutated armatures (dispatch on commutation.mode === "mechanical"
        // only; agnostic — no machine identity). circuits[k] is global-indexed
        // to match srcId, by the config-schema circuit-index guarantee.
        circuits: expanded.circuits,
      }));
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
      var iters = 0;   // Σ Newton iterations across slices = the solve's cost unit

      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        var r = entry.slice.solve(thetaR + entry.offset, currents);
        torque += r.torque;
        for (var k = 0; k < nCircuits; k++) {
          fluxLinkages[k] += r.fluxLinkages[k];
        }
        perSliceField.push(r.field);
        iters += r.iters || 0;
      }

      return { torque: torque, fluxLinkages: fluxLinkages, perSliceField: perSliceField, iters: iters };
    }

    // -------------------------------------------------------------------------
    //  stack.solveCoupled(opts) → { A, i, omega, theta, lambda, torque, iters,
    //                               converged, fieldResid, redResid }
    //
    //  ONE monolithic field-circuit-motion Newton over (A_s…, i, ω, θ) for a
    //  single BDF step. The field blocks A_s are Schur-condensed per slice
    //  (schurCondense), reducing to an (nf+2)×(nf+2) system over the free
    //  currents + ω + θ. Differential variables are flux [λ,ω,θ] (full
    //  field-coupling): R_ckt,k = ag0·λ_k(A,θ) + histλ_k + Σ_l R_kl·i_l − V_k.
    //
    //  opts = {
    //    ag0, hist: Float64Array(m+2) = [histλ_0…, histω, histθ],
    //    cond:  [{ kind:'voltage'|'current'|'open'|'short', V, I }, …] (pre-eval),
    //    Rof(ka,kb) | R: Float64Array(m) diagonal,
    //    J, damping, loadTorque, frictionTorque,
    //    warm: { A:[Float64Array per slice], i:Float64Array(m), omega, theta },
    //    tol, tolField, maxIter, schurMode ('schur'),
    //  }
    // -------------------------------------------------------------------------
    function solveCoupled(o) {
      var m = nCircuits, IDX_W = m, IDX_TH = m + 1;
      var ag0 = o.ag0, hist = o.hist;
      var cond = o.cond;
      var Rof = o.Rof || function (ka, kb) { return ka === kb ? o.R[ka] : 0; };
      var J = o.J, damping = o.damping || 0, loadTorque = o.loadTorque || 0;
      // Regularized Coulomb (static + kinetic) friction: −τ_f·ω/√(ω²+ε²). Saturates
      // to ∓τ_f for |ω|≫ε (kinetic Coulomb) and ramps smoothly through ω=0 over the
      // stick band ε, so a sub-threshold torque leaves only an O(ε) creep — i.e. the
      // rotor is held at rest. Smooth, so it adds one clean ∂R_mech/∂ω Jacobian term.
      var frictionTorque = o.frictionTorque || 0;
      var FRIC_EPS = 0.1;   // rad/s — stick-band half-width (≈1 rpm; ≪ any running speed)
      // Convergence is PER-EQUATION RELATIVE: each residual is divided by its own
      // physical scale (the magnitude of its largest term — volts for the circuit
      // rows, N·m for the mechanical row, rad/s for the angle row, ‖f‖ for the
      // field). A single relTol then means "every physical balance is satisfied to
      // relTol of its own size", dimensionally clean and machine-independent —
      // unlike an absolute max-norm across volts/N·m/rad/s (which over-converges
      // the small-scale equations to the double-precision floor, burning iters).
      var relTol = o.relTol != null ? o.relTol : 1e-6;
      var absFloor = o.absFloor != null ? o.absFloor : 1e-30; // divide-by-zero guard only
      var maxIter = o.maxIter != null ? o.maxIter : 25;

      // Free circuits (voltage/short) are Newton unknowns; current/open are pinned.
      var freeIdx = [], k, l, s, a, b;
      for (k = 0; k < m; k++) if (cond[k].kind === "voltage" || cond[k].kind === "short") freeIdx.push(k);
      // delta layout: [i_free, ω, θ, Φ_0..Φ_{L-1}]; θ is col nf+1, loop fluxes from PHI0.
      var nf = freeIdx.length, L = L_loops, PHI0 = nf + 2, nu = nf + 2 + L, THcol = nf;
      var nbatch = nf + 2 + (L > 0 ? 1 : 0);   // Schur batch cols: [Rfield | −uRHS×nf | dRdth | (cFlux)]

      // State (warm-started copies).
      var nG = slices.map(function (e) { return e.slice.__internals.globalLayout.n; });
      var ellS = slices.map(function (e) { return e.slice.__internals.ell; });
      var A = slices.map(function (e, si) { var v = new Float64Array(nG[si]); if (o.warm && o.warm.A && o.warm.A[si]) v.set(o.warm.A[si]); return v; });
      var i = new Float64Array(m); if (o.warm && o.warm.i) i.set(o.warm.i);
      var om = o.warm ? o.warm.omega : 0, th = o.warm ? o.warm.theta : 0;
      var Phi = new Float64Array(L); if (o.warm && o.warm.Phi) Phi.set(o.warm.Phi);   // loop fluxes
      for (k = 0; k < m; k++) { if (cond[k].kind === "current") i[k] = cond[k].I; else if (cond[k].kind === "open") i[k] = 0; }

      // Per-slice border scratch (allocate once for this solve).
      var Rfield = nG.map(function (n) { return new Float64Array(n); });
      var dRdth  = nG.map(function (n) { return new Float64Array(n); });
      var dTdA   = nG.map(function (n) { return new Float64Array(n); });
      var dLamdth = slices.map(function () { return new Float64Array(m); });
      var uRHS = slices.map(function (e, si) { var arr = []; for (a = 0; a < nf; a++) arr.push(new Float64Array(nG[si])); return arr; });
      var xr   = nG.map(function (n) { return new Float64Array(n); });
      // xcol[s][c]: c ∈ [0,nf) free-current columns, c = nf the θ column, c = nf+1 the
      // flux column K⁻¹c_s (present only when L>0).
      var xcol = slices.map(function (e, si) { var arr = []; for (a = 0; a < nf + 1 + (L > 0 ? 1 : 0); a++) arr.push(new Float64Array(nG[si])); return arr; });
      // Batched RHS / solution blocks for the multi-RHS condensation solve:
      // column-major nG×nbatch = [Rfield | −uRHS_0..−uRHS_{nf-1} | dRdth | (cFlux)].
      var rhsBlk = nG.map(function (n) { return new Float64Array(n * nbatch); });
      var xBlk   = nG.map(function (n) { return new Float64Array(n * nbatch); });
      // Axial-flux per-slice scratch (only when loops are present).
      var cFlux = L ? slices.map(function (e, si) { return new Float64Array(nG[si]); }) : null;  // c_s
      var dFlux = L ? new Float64Array(nSlices) : null;       // d_s
      var PsiS  = L ? new Float64Array(nSlices) : null;       // Ψ_s = Σ σ(s,l) Φ_l
      var phiScaleArr = L ? new Float64Array(L) : null;       // per-loop residual scale

      var lambda = new Float64Array(m);
      var lamS = slices.map(function () { return new Float64Array(m); });   // per-slice λ-center
      var TsS  = new Float64Array(nSlices);                                  // per-slice T-center
      var S = new Float64Array(nu * nu), rRed = new Float64Array(nu), rCond = new Float64Array(nu), delta = new Float64Array(nu);
      var ukIdx = new Int32Array(nG.reduce(function (a, b) { return Math.max(a, b); }, 0)); // sparse-uRHS pattern scratch

      var iters = 0, converged = false, fieldResid = 0, redResid = 0, T = 0, dTdth = 0;
      for (var it = 0; it < maxIter; it++) {
        iters = it + 1;
        // ---- Stage A: assemble (NO factorize) + the residual quantities only.
        // The factorize and the Jacobian borders are deferred past the convergence
        // check — a converged iter pays neither.
        T = 0;
        var fNorm = 0;
        for (k = 0; k < m; k++) lambda[k] = 0;
        for (s = 0; s < nSlices; s++) {
          var slice = slices[s].slice, thS = th + slices[s].offset;
          slice.coupledThetaPreEval(A[s], i, thS);   // θ−h eval (must precede the factorize)
          TsS[s] = slice.coupledAssembleNoFactor(A[s], i, thS, Rfield[s]);
          T += TsS[s];
          var fns = slice.coupledRhsNorm(); if (fns > fNorm) fNorm = fns;
          slice.coupledFluxInto(A[s], thS, lamS[s]);
          for (k = 0; k < m; k++) lambda[k] += lamS[s][k];
          if (L) {
            // c_s (flux coupling) + d_s, and fold the flux drive into the field
            // residual: R_field,s += c_s·Ψ_s with Ψ_s = Σ_l σ(s,l)·Φ_l.
            dFlux[s] = slice.coupledFluxRhsInto(thS, cFlux[s]);
            var Psi_s = 0;
            for (l = 0; l < L; l++) { var sgl = axialLoops[l].incid[s]; if (sgl !== undefined) Psi_s += sgl * Phi[l]; }
            PsiS[s] = Psi_s;
            // The flux drive c_s·Ψ_s is a genuine field RHS term — fold its magnitude
            // into fNorm so the relative field-residual scale is right even when the
            // ordinary sources f are small (else fieldResid blows up at f≈0).
            if (Psi_s !== 0) for (var nn = 0; nn < nG[s]; nn++) { var addv = cFlux[s][nn] * Psi_s; Rfield[s][nn] += addv; var aav = Math.abs(addv); if (aav > fNorm) fNorm = aav; }
          }
        }
        // ---- reduced residual ----
        for (a = 0; a < nf; a++) {
          k = freeIdx[a];
          var rk = ag0 * lambda[k] + hist[k] - (cond[k].kind === "short" ? 0 : cond[k].V);
          for (l = 0; l < m; l++) rk += Rof(k, l) * i[l];
          rRed[a] = rk;
        }
        rRed[nf]     = (J * ag0 + damping) * om + J * hist[IDX_W] - T + loadTorque
                   + frictionTorque * om / Math.sqrt(om * om + FRIC_EPS * FRIC_EPS);
        rRed[nf + 1] = ag0 * th + hist[IDX_TH] - om;

        // ---- flux-loop (Φ) residuals: KVL  Σσ(c_sᵀA_s + d_sΨ_s) + R_axial·Φ − F_pm ----
        for (l = 0; l < L; l++) {
          var Rphi = axialLoops[l].Raxial * Phi[l] - axialLoops[l].Fpm;
          var phiSc = Math.max(Math.abs(axialLoops[l].Fpm), Math.abs(axialLoops[l].Raxial * Phi[l]));
          for (s = 0; s < nSlices; s++) {
            var sgl = axialLoops[l].incid[s]; if (sgl === undefined) continue;
            var cA = 0, cf = cFlux[s], As = A[s], ng2 = nG[s];
            for (var nn2 = 0; nn2 < ng2; nn2++) cA += cf[nn2] * As[nn2];
            var term = sgl * (cA + dFlux[s] * PsiS[s]);
            Rphi += term; if (Math.abs(term) > phiSc) phiSc = Math.abs(term);
          }
          rRed[PHI0 + l] = Rphi; phiScaleArr[l] = phiSc;
        }

        // ---- convergence: per-equation RELATIVE residuals ----
        // field: ‖R_field‖∞ / ‖f‖∞
        var frAbs = 0;
        for (s = 0; s < nSlices; s++) for (var n = 0; n < nG[s]; n++) { var av = Math.abs(Rfield[s][n]); if (av > frAbs) frAbs = av; }
        fieldResid = frAbs / Math.max(fNorm, absFloor);
        // reduced: each row / |its largest term|
        redResid = 0;
        for (a = 0; a < nf; a++) {
          k = freeIdx[a];
          var sc = Math.abs(ag0 * lambda[k]);
          var t1 = Math.abs(hist[k]); if (t1 > sc) sc = t1;
          var t2 = Math.abs(cond[k].kind === "short" ? 0 : cond[k].V); if (t2 > sc) sc = t2;
          var t3 = Math.abs(Rof(k, k) * i[k]); if (t3 > sc) sc = t3;
          var rr = Math.abs(rRed[a]) / Math.max(sc, absFloor); if (rr > redResid) redResid = rr;
        }
        var mechSc = Math.abs(T);
        var m1 = Math.abs((J * ag0 + damping) * om); if (m1 > mechSc) mechSc = m1;
        var m2 = Math.abs(J * hist[IDX_W]); if (m2 > mechSc) mechSc = m2;
        var m3 = Math.abs(loadTorque); if (m3 > mechSc) mechSc = m3;
        var m4 = Math.abs(frictionTorque); if (m4 > mechSc) mechSc = m4;
        var rrm = Math.abs(rRed[nf]) / Math.max(mechSc, absFloor); if (rrm > redResid) redResid = rrm;
        var angSc = Math.abs(ag0 * th);
        var n1 = Math.abs(hist[IDX_TH]); if (n1 > angSc) angSc = n1;
        var n2 = Math.abs(om); if (n2 > angSc) angSc = n2;
        var rra = Math.abs(rRed[nf + 1]) / Math.max(angSc, absFloor); if (rra > redResid) redResid = rra;
        for (l = 0; l < L; l++) { var rrp = Math.abs(rRed[PHI0 + l]) / Math.max(phiScaleArr[l], absFloor); if (rrp > redResid) redResid = rrp; }

        if (fieldResid < relTol && redResid < relTol) { converged = true; break; }

        // ---- Stage B: factorize + Jacobian borders (only reached when NOT
        // converged — the work that feeds the Schur, skipped on the final iter).
        dTdth = 0;
        for (s = 0; s < nSlices; s++) {
          var slc = slices[s].slice, thSb = th + slices[s].offset;
          slc.coupledFactorize();   // numeric LDLᵀ
          dTdth += slc.coupledThetaPostDiff(thSb, lamS[s], TsS[s], dRdth[s], dLamdth[s]);
          slc.coupledDTdAInto(thSb, dTdA[s]);
          for (a = 0; a < nf; a++) slc.coupledUnitRhsInto(freeIdx[a], thSb, uRHS[s][a]);
        }

        // ---- reduced (non-field) Jacobian D into S ----
        for (a = 0; a < nu * nu; a++) S[a] = 0;
        for (a = 0; a < nf; a++) {
          k = freeIdx[a];
          for (b = 0; b < nf; b++) S[a * nu + b] = Rof(k, freeIdx[b]);
          S[a * nu + (nf + 1)] = ag0 * dLamdth_total(dLamdth, k); // ∂R_ckt,k/∂θ
        }
        S[nf * nu + nf]       = J * ag0 + damping    // ∂R_mech/∂ω
          + frictionTorque * FRIC_EPS * FRIC_EPS / Math.pow(om * om + FRIC_EPS * FRIC_EPS, 1.5);
        S[nf * nu + (nf + 1)] = -dTdth;              // ∂R_mech/∂θ
        S[(nf + 1) * nu + nf]       = -1;            // ∂R_ang/∂ω
        S[(nf + 1) * nu + (nf + 1)] = ag0;           // ∂R_ang/∂θ
        for (l = 0; l < L; l++) S[(PHI0 + l) * nu + (PHI0 + l)] = axialLoops[l].Raxial;  // lumped axial reluctance
        for (a = 0; a < nu; a++) rCond[a] = rRed[a];

        // ---- field condensation: S -= C·A⁻¹·B ,  rCond -= C·A⁻¹·R_field ----
        for (s = 0; s < nSlices; s++) {
          var sl = slices[s].slice;
          var ng = nG[s];
          // Batch all nf+2 RHS into one column-major block → one multi-RHS solve
          // (Eigen streams the L factor once for all columns; bit-identical to
          // looping coupledSolveAgainst per column).
          var blk = rhsBlk[s], xb = xBlk[s], Rf = Rfield[s];
          for (n = 0; n < ng; n++) blk[n] = Rf[n];                                   // col 0: Rfield
          for (b = 0; b < nf; b++) { var ub = uRHS[s][b], ou = (1 + b) * ng; for (n = 0; n < ng; n++) blk[ou + n] = -ub[n]; }  // cols 1..nf
          var dR = dRdth[s], od = (nf + 1) * ng; for (n = 0; n < ng; n++) blk[od + n] = dR[n];   // col nf+1: dRdth
          if (L) { var cfb = cFlux[s], ofx = (nf + 2) * ng; for (n = 0; n < ng; n++) blk[ofx + n] = cfb[n]; }  // col nf+2: cFlux
          sl.coupledSolveMultiAgainst(blk, nbatch, xb);
          var xrS = xr[s]; for (n = 0; n < ng; n++) xrS[n] = xb[n];
          for (b = 0; b < nf; b++) { var xc = xcol[s][b], ob = (1 + b) * ng; for (n = 0; n < ng; n++) xc[n] = xb[ob + n]; }
          var xct = xcol[s][nf], oc = (nf + 1) * ng; for (n = 0; n < ng; n++) xct[n] = xb[oc + n];
          if (L) { var xcf = xcol[s][nf + 1], ocf = (nf + 2) * ng; for (n = 0; n < ng; n++) xcf[n] = xb[ocf + n]; }  // K⁻¹c_s
          var coef = ag0 * ellS[s];
          for (a = 0; a < nf; a++) {
            k = freeIdx[a];
            var uk = uRHS[s][a];
            // uRHS_k is SPARSE (only circuit k's winding/bar nodes). Gather its
            // nonzero pattern once, then dot over those rather than all nGlobal —
            // turns the C·A⁻¹·B step from O(nf²·nGlobal) into O(nf²·nnz).
            var un = 0; for (n = 0; n < nG[s]; n++) if (uk[n] !== 0) ukIdx[un++] = n;
            for (b = 0; b < nf; b++) S[a * nu + b]       -= coef * sparseDot(uk, ukIdx, un, xcol[s][b]);
            S[a * nu + (nf + 1)] -= coef * sparseDot(uk, ukIdx, un, xcol[s][nf]);   // θ col
            for (l = 0; l < L; l++) { var sgla = axialLoops[l].incid[s]; if (sgla !== undefined) S[a * nu + (PHI0 + l)] -= coef * sgla * sparseDot(uk, ukIdx, un, xcol[s][nf + 1]); }
            rCond[a] -= coef * sparseDot(uk, ukIdx, un, xr[s]);
          }
          // mech row: C_mech = −dTdA  ⇒  S -= (−dTdA)·xcol = +dTdA·xcol
          for (b = 0; b < nf; b++) S[nf * nu + b]       += dot(dTdA[s], xcol[s][b], nG[s]);
          S[nf * nu + (nf + 1)] += dot(dTdA[s], xcol[s][nf], nG[s]);
          rCond[nf] += dot(dTdA[s], xr[s], nG[s]);

          // ---- flux-loop (Φ) Schur contributions for this slice ----
          if (L) {
            var cf2 = cFlux[s], ng3 = nG[s];
            var cKc = dot(cf2, xcol[s][nf + 1], ng3);   // c_sᵀ K⁻¹ c_s  ⇒ d_s − cKc = R_field,s
            for (l = 0; l < L; l++) {
              var sgl = axialLoops[l].incid[s]; if (sgl === undefined) continue;
              var prow = (PHI0 + l) * nu;
              // mech-row × Φ_l col:  S[mech, Φl] += σ · dTdAᵀ·K⁻¹c_s
              S[nf * nu + (PHI0 + l)] += sgl * dot(dTdA[s], xcol[s][nf + 1], ng3);
              // Φ_l row × (current, θ) cols:  S[Φl, q] −= σ · c_sᵀ·xcol_q
              for (b = 0; b < nf; b++) S[prow + b] -= sgl * dot(cf2, xcol[s][b], ng3);
              S[prow + (nf + 1)] -= sgl * dot(cf2, xcol[s][nf], ng3);
              // Φ_l × Φ_m block:  σ(s,l)σ(s,m)·(d_s − c_sᵀK⁻¹c_s)
              for (var mm = 0; mm < L; mm++) { var sgm = axialLoops[mm].incid[s]; if (sgm !== undefined) S[prow + (PHI0 + mm)] += sgl * sgm * (dFlux[s] - cKc); }
              // Φ_l residual condensation:  rCond[Φl] −= σ · c_sᵀ·K⁻¹R_field
              rCond[PHI0 + l] -= sgl * dot(cf2, xr[s], ng3);
            }
          }
        }

        // ---- solve S·δ = −rCond ----
        for (a = 0; a < nu; a++) delta[a] = -rCond[a];
        denseSolve(S, delta, nu);

        // ---- back-sub δA_s and update ----
        for (s = 0; s < nSlices; s++) {
          for (n = 0; n < nG[s]; n++) {
            var dA = -xr[s][n];
            for (b = 0; b < nf; b++) dA -= delta[b] * xcol[s][b][n];
            dA -= delta[nf + 1] * xcol[s][nf][n];   // δθ · θ-column
            if (L) for (l = 0; l < L; l++) { var sgl = axialLoops[l].incid[s]; if (sgl !== undefined) dA -= delta[PHI0 + l] * sgl * xcol[s][nf + 1][n]; }   // δΦ_l · σ · K⁻¹c_s
            A[s][n] += dA;
          }
        }
        for (a = 0; a < nf; a++) i[freeIdx[a]] += delta[a];
        om += delta[nf]; th += delta[nf + 1];
        for (l = 0; l < L; l++) Phi[l] += delta[PHI0 + l];
        for (k = 0; k < m; k++) { if (cond[k].kind === "current") i[k] = cond[k].I; else if (cond[k].kind === "open") i[k] = 0; }
      }

      return { A: A, i: i, omega: om, theta: th, lambda: lambda, torque: T, Phi: Phi,
               iters: iters, converged: converged, fieldResid: fieldResid, redResid: redResid };
    }

    function dot(u, v, n) { var s = 0; for (var p = 0; p < n; p++) s += u[p] * v[p]; return s; }
    // Sparse dot: u·v summed only over u's nonzero indices idx[0..un).
    function sparseDot(u, idx, un, v) { var s = 0; for (var p = 0; p < un; p++) { var j = idx[p]; s += u[j] * v[j]; } return s; }
    function dLamdth_total(arr, k) { var s = 0; for (var ss = 0; ss < arr.length; ss++) s += arr[ss][k]; return s; }

    // Build the render bundle (per-slice field + summed torque/flux) from a
    // coupled solution's per-slice converged A, WITHOUT a field re-solve — each
    // slice just post-processes its A via buildFieldBundle. Mirrors solve()'s
    // aggregate shape so lastSolve is identical from either path.
    function fieldBundle(Aarray, thetaR) {
      var torque = 0;
      var fluxLinkages = new Float64Array(nCircuits);
      var perSliceField = [];
      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        var r = entry.slice.buildFieldBundle(Aarray[s], thetaR + entry.offset);
        torque += r.torque;
        for (var k = 0; k < nCircuits; k++) fluxLinkages[k] += r.fluxLinkages[k];
        perSliceField.push(r.field);
      }
      return { torque: torque, fluxLinkages: fluxLinkages, perSliceField: perSliceField, iters: 0 };
    }

    // Dense Gaussian elimination, partial pivot, n×n row-major; solution overwrites b.
    function denseSolve(M, bb, n) {
      var col, r, cc;
      for (col = 0; col < n; col++) {
        var piv = col, best = Math.abs(M[col * n + col]);
        for (r = col + 1; r < n; r++) { var v = Math.abs(M[r * n + col]); if (v > best) { best = v; piv = r; } }
        if (piv !== col) { for (cc = 0; cc < n; cc++) { var tmp = M[col * n + cc]; M[col * n + cc] = M[piv * n + cc]; M[piv * n + cc] = tmp; } var tb = bb[col]; bb[col] = bb[piv]; bb[piv] = tb; }
        var d0 = M[col * n + col]; if (Math.abs(d0) < 1e-300) d0 = d0 < 0 ? -1e-300 : 1e-300;
        for (r = col + 1; r < n; r++) { var f = M[r * n + col] / d0; if (f === 0) continue; for (cc = col; cc < n; cc++) M[r * n + cc] -= f * M[col * n + cc]; bb[r] -= f * bb[col]; }
      }
      for (r = n - 1; r >= 0; r--) { var sm = bb[r]; for (cc = r + 1; cc < n; cc++) sm -= M[r * n + cc] * bb[cc]; var dd = M[r * n + r]; if (Math.abs(dd) < 1e-300) dd = dd < 0 ? -1e-300 : 1e-300; bb[r] = sm / dd; }
    }

    // -------------------------------------------------------------------------
    //  stack.linearFluxLinkages(thetaR, currents) → Float64Array(nCircuits)
    //
    //  Sums each slice's saturation-disabled flux linkages at the given currents
    //  (shared circuits add across slices). MotorRun calls this at setup to size
    //  the integrator's per-state tolerances.
    // -------------------------------------------------------------------------
    function linearFluxLinkages(thetaR, currents) {
      var lam = new Float64Array(nCircuits);
      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        var c = entry.slice.linearFluxLinkages(thetaR + entry.offset, currents);
        for (var k = 0; k < nCircuits; k++) lam[k] += c[k];
      }
      return lam;
    }

    // -------------------------------------------------------------------------
    //  stack.sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }
    //
    //  Returns slice k's pair of FEA body meshes (rotor + stator).
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
      solveCoupled: solveCoupled,
      fieldBundle: fieldBundle,
      linearFluxLinkages: linearFluxLinkages,
      sliceMesh: sliceMesh,
      clearWarmStart: clearWarmStart,
    };
  }

  LIB.MotorStack = { create: create };
})();
