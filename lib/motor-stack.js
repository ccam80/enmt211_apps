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
  //    poles:      number,                       // forwarded to each slice (D8)
  //    …
  //  }
  //
  //  opts are forwarded to LIB.MotorSlice.create for each slice. The stack
  //  additionally injects opts.poles = expanded.poles per Phase 5 D8 so the
  //  slice's K = AirgapHarmonic.defaultK(slots, poles) derivation gets the
  //  caller-provided pole count.
  // ---------------------------------------------------------------------------
  function create(expanded, opts) {
    opts = opts || {};

    const nCircuits = expanded.nCircuits;
    const expandedSlices = expanded.slices;

    // Build one MotorSlice per slice entry. Always iterates — no fast path.
    const slices = expandedSlices.map(function (s) {
      const slice = LIB.MotorSlice.create(s.section, Object.assign({}, opts, {
        poles: expanded.poles,
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
    //    J, damping, loadTorque,
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
      var nf = freeIdx.length, nu = nf + 2, THcol = nf; // delta layout: [i_free, ω, θ]; θ is col nf+1

      // State (warm-started copies).
      var nG = slices.map(function (e) { return e.slice.__internals.globalLayout.n; });
      var ellS = slices.map(function (e) { return e.slice.__internals.ell; });
      var A = slices.map(function (e, si) { var v = new Float64Array(nG[si]); if (o.warm && o.warm.A && o.warm.A[si]) v.set(o.warm.A[si]); return v; });
      var i = new Float64Array(m); if (o.warm && o.warm.i) i.set(o.warm.i);
      var om = o.warm ? o.warm.omega : 0, th = o.warm ? o.warm.theta : 0;
      for (k = 0; k < m; k++) { if (cond[k].kind === "current") i[k] = cond[k].I; else if (cond[k].kind === "open") i[k] = 0; }

      // Per-slice border scratch (allocate once for this solve).
      var Rfield = nG.map(function (n) { return new Float64Array(n); });
      var dRdth  = nG.map(function (n) { return new Float64Array(n); });
      var dTdA   = nG.map(function (n) { return new Float64Array(n); });
      var dLamdth = slices.map(function () { return new Float64Array(m); });
      var uRHS = slices.map(function (e, si) { var arr = []; for (a = 0; a < nf; a++) arr.push(new Float64Array(nG[si])); return arr; });
      var xr   = nG.map(function (n) { return new Float64Array(n); });
      // xcol[s][c]: c ∈ [0,nf) free-current columns, c = nf the θ column.
      var xcol = slices.map(function (e, si) { var arr = []; for (a = 0; a < nf + 1; a++) arr.push(new Float64Array(nG[si])); return arr; });

      var lambda = new Float64Array(m);
      var lamS = slices.map(function () { return new Float64Array(m); });   // per-slice λ-center
      var TsS  = new Float64Array(nSlices);                                  // per-slice T-center
      var S = new Float64Array(nu * nu), rRed = new Float64Array(nu), rCond = new Float64Array(nu), delta = new Float64Array(nu);
      var negU = new Float64Array(0); // resized per slice below
      var ukIdx = new Int32Array(nG.reduce(function (a, b) { return Math.max(a, b); }, 0)); // sparse-uRHS pattern scratch

      var iters = 0, converged = false, fieldResid = 0, redResid = 0, T = 0, dTdth = 0;
      for (var it = 0; it < maxIter; it++) {
        iters = it + 1;
        // ---- Phase 1a: assemble (NO factorize) + the residual quantities only.
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
        }
        // ---- reduced residual ----
        for (a = 0; a < nf; a++) {
          k = freeIdx[a];
          var rk = ag0 * lambda[k] + hist[k] - (cond[k].kind === "short" ? 0 : cond[k].V);
          for (l = 0; l < m; l++) rk += Rof(k, l) * i[l];
          rRed[a] = rk;
        }
        rRed[nf]     = (J * ag0 + damping) * om + J * hist[IDX_W] - T + loadTorque;
        rRed[nf + 1] = ag0 * th + hist[IDX_TH] - om;

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
        var rrm = Math.abs(rRed[nf]) / Math.max(mechSc, absFloor); if (rrm > redResid) redResid = rrm;
        var angSc = Math.abs(ag0 * th);
        var n1 = Math.abs(hist[IDX_TH]); if (n1 > angSc) angSc = n1;
        var n2 = Math.abs(om); if (n2 > angSc) angSc = n2;
        var rra = Math.abs(rRed[nf + 1]) / Math.max(angSc, absFloor); if (rra > redResid) redResid = rra;

        if (fieldResid < relTol && redResid < relTol) { converged = true; break; }

        // ---- Phase 1b: factorize + Jacobian borders (only reached when NOT
        // converged — the work that feeds the Schur, skipped on the final iter).
        dTdth = 0;
        for (s = 0; s < nSlices; s++) {
          var slc = slices[s].slice, thSb = th + slices[s].offset;
          slc.coupledFactorize();   // numeric LDLᵀ (the deferred 1.57ms)
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
        S[nf * nu + nf]       = J * ag0 + damping;   // ∂R_mech/∂ω
        S[nf * nu + (nf + 1)] = -dTdth;              // ∂R_mech/∂θ
        S[(nf + 1) * nu + nf]       = -1;            // ∂R_ang/∂ω
        S[(nf + 1) * nu + (nf + 1)] = ag0;           // ∂R_ang/∂θ
        for (a = 0; a < nu; a++) rCond[a] = rRed[a];

        // ---- field condensation: S -= C·A⁻¹·B ,  rCond -= C·A⁻¹·R_field ----
        for (s = 0; s < nSlices; s++) {
          var sl = slices[s].slice;
          if (negU.length !== nG[s]) negU = new Float64Array(nG[s]);
          sl.coupledSolveAgainst(Rfield[s], xr[s]);
          for (b = 0; b < nf; b++) {
            for (n = 0; n < nG[s]; n++) negU[n] = -uRHS[s][b][n];
            sl.coupledSolveAgainst(negU, xcol[s][b]);
          }
          sl.coupledSolveAgainst(dRdth[s], xcol[s][nf]); // θ column
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
            rCond[a] -= coef * sparseDot(uk, ukIdx, un, xr[s]);
          }
          // mech row: C_mech = −dTdA  ⇒  S -= (−dTdA)·xcol = +dTdA·xcol
          for (b = 0; b < nf; b++) S[nf * nu + b]       += dot(dTdA[s], xcol[s][b], nG[s]);
          S[nf * nu + (nf + 1)] += dot(dTdA[s], xcol[s][nf], nG[s]);
          rCond[nf] += dot(dTdA[s], xr[s], nG[s]);
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
            A[s][n] += dA;
          }
        }
        for (a = 0; a < nf; a++) i[freeIdx[a]] += delta[a];
        om += delta[nf]; th += delta[nf + 1];
        for (k = 0; k < m; k++) { if (cond[k].kind === "current") i[k] = cond[k].I; else if (cond[k].kind === "open") i[k] = 0; }
      }

      return { A: A, i: i, omega: om, theta: th, lambda: lambda, torque: T,
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
    //    → { reluctance, pm, mutual, cogging, total }
    //
    //  Complete co-energy torque decomposition:
    //    reluctance = ½ Σ_k i_k² · dL_kk/dθ        (self-inductance saliency)
    //    mutual     = ½ Σ_{k≠l} i_k·i_l · dL_kl/dθ (mutual saliency)
    //    pm         = Σ_k i_k · dλ_pm,k/dθ         (PM alignment torque)
    //    cogging    = ∂W'_pm/∂θ                    (zero-current PM detent torque)
    //    total      = reluctance + mutual + pm + cogging
    //
    //  The cogging term is the magnet-only Maxwell-stress torque (each slice's
    //  coggingTorque at its rotor offset), the part Arkkio includes but the
    //  current-dependent co-energy terms structurally omit — so total is the
    //  COMPLETE torque matching the Maxwell-stress (Arkkio) result for salient-PM
    //  machines at every rotor angle.
    //
    //  coeffs (the current-dependent dL/dθ and dλ_pm/dθ) is extracted if not
    //  supplied.
    // -------------------------------------------------------------------------
    function coenergyTorque(thetaR, currents, coeffs) {
      if (coeffs == null) {
        coeffs = extractCoeffs(thetaR);
      }
      var m = nCircuits;
      // Pad the current vector to length m (missing entries → 0) so a short
      // stator-only current array (cage/rotor bar currents implied zero) does
      // not read `undefined` → NaN. solve() pads its current vector to length
      // m identically; coenergyTorque must match it to stay consistent.
      var curIn = currents;
      currents = new Float64Array(m);
      if (curIn != null) {
        var nIn = curIn.length < m ? curIn.length : m;
        for (var ci = 0; ci < nIn; ci++) currents[ci] = curIn[ci];
      }
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

      // Zero-current PM detent (cogging) torque: sum each slice's magnet-only
      // Maxwell-stress torque at its rotor-angle offset.
      var cogging = 0;
      for (var s = 0; s < nSlices; s++) {
        var entry = slices[s];
        cogging += entry.slice.coggingTorque(thetaR + entry.offset);
      }

      // Gap-coupling energy measure. The λ-derived co-energy terms
      // (reluctance/mutual/pm, built from dL/dθ and dλpm/dθ) come from
      // real-space flux linkages λ=∫A·J — they are PHYSICAL (measure-1), so the
      // textbook reluctance torque ½iᵀ(dL/dθ)i carries NO Parseval factor.
      //
      // History: the 2026-05-29 "Bug #1" multiplied these by π to match the old
      // HARMONIC-gap Arkkio torque. That harmonic torque was ITSELF π-inflated
      // (it carried the ∫cos²=π basis measure), so the ×π was compensating one
      // error with another. With the harmonic engine deleted and mortar's
      // real-space Maxwell-stress torque proven correct (analytical formula-field
      // test: a closed-form gap field with exact torque T=(2πk²ℓ/μ0)(bc−ad) is
      // recovered to <1% at low k, →1.000 as gap→0), the ×π is a naked over-count.
      // It also contradicted the back-EMF in motor-slice.js, which already uses
      // measure-1 on the SAME dL/dθ — energy conservation (Tω=Σeₖiₖ) forbids the
      // EMF being measure-1 while the torque is measure-π. Confirmed empirically:
      // de-π'd co-energy matches the true Arkkio for pmsm (1.02–1.04) and SRM.
      // The cogging term comes from gap.torque (full Maxwell stress), measure-1.
      var GAP_MEASURE = 1;
      reluctance *= GAP_MEASURE;
      mutual *= GAP_MEASURE;
      pm *= GAP_MEASURE;
      var total = reluctance + mutual + pm + cogging;
      return {
        reluctance: reluctance,
        pm: pm,
        mutual: mutual,
        cogging: cogging,
        total: total,
      };
    }

    // -------------------------------------------------------------------------
    //  stack.sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }
    //
    //  Returns slice k's pair of Phase-2 body meshes. The FEA replacement for
    //  the deleted grid-shaped sliceGrid (Phase 5 D2).
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
      extractCoeffs: extractCoeffs,
      coenergyTorque: coenergyTorque,
      sliceMesh: sliceMesh,
      clearWarmStart: clearWarmStart,
    };
  }

  LIB.MotorStack = { create: create };
})();
