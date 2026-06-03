"use strict";

// =============================================================================
//  LIB.BDF — variable-step, variable-order implicit integrator with local
//  truncation-error (LTE) step control.
//
//  A clean, self-contained adaptive integrator for stiff first-order systems
//
//      dy/dt = f(t, y)          y ∈ ℝⁿ
//
//  written in companion-model form so the caller owns the (possibly very
//  expensive, possibly nonlinear) implicit solve:
//
//      f(t_{n+1}, y) = ag0 · y + histTerm          (BDF: solve for y)
//
//  The integrator manages dt, order (1–2), the y/Δt history, the divided-
//  difference LTE estimate, accept/reject, and order promotion. It calls a
//  user `stepSolve(t, dt, ag0, histTerm, yGuess, out)` that returns the y
//  satisfying the line above. This keeps the integrator agnostic to whether
//  the implicit solve is a 2×2 dense Newton (a unit test) or a bordered FE
//  Newton over (A, i, ω, θ) (the motor) — it only sees y and the residual
//  scalar coupling ag0/histTerm.
//
//  Method = Gear/BDF (L-stable, orders 1–2) by default, or trapezoidal
//  (energy-neutral, no numerical damping on oscillators) via opts.method.
//  The LTE control bounds the per-step error (including BDF's artificial
//  damping) to atol + rtol·|y| regardless of method.
//
//  Coefficient algebra (computeAg) and the divided-difference LTE (lteDt)
//  follow ngspice's NIcomCof / CKTterr (faithful, but de-ngspiced: no
//  breakpoints, no XSPICE, single state-tolerance instead of charge/volt
//  split, and the dt root is by (order+1) — dimensionally exact — rather
//  than ngspice's by-order quirk).
//
//  No DOM, no allocation in the hot loop (scratch is pre-sized at create()).
// =============================================================================

(function () {
  const LIB = (typeof window !== "undefined" ? window : globalThis).LIB ||
    ((typeof window !== "undefined" ? window : globalThis).LIB = {});

  // BDF/Gear leading error constants by order (ngspice gearCoeff[]). Used to
  // scale the (order+1)-th divided difference into a local-error magnitude.
  const GEAR_LTE = [0.5, 0.2222222222, 0.1363636364, 0.096];
  const TRAP_LTE = [0.5, 0.08333333333];

  // ---------------------------------------------------------------------------
  //  computeAg(dt, deltaOld, order, method, xmu, ag)
  //
  //  Fills ag[0..order] with the companion coefficients so that
  //    dy/dt ≈ ag[0]·y_n + ag[1]·y_{n-1} + … + ag[order]·y_{n-order}   (Gear)
  //  deltaOld[0]=dt (current), deltaOld[1]=h_{n-1}, … (variable step).
  //  Port of ngspice nicomcof.c (gear branch = Vandermonde collocation).
  // ---------------------------------------------------------------------------
  function computeAg(dt, deltaOld, order, method, xmu, ag, scratch) {
    if (dt <= 0) { for (let i = 0; i < ag.length; i++) ag[i] = 0; return; }

    if (method === "trapezoidal") {
      if (order === 1) { ag[0] = 1 / dt; ag[1] = -1 / dt; }
      else { ag[0] = 1.0 / dt / (1.0 - xmu); ag[1] = xmu / (1.0 - xmu); }
      return;
    }

    // Gear (BDF). Order 1 uses the trap-1 (= backward-Euler) coefficients.
    if (order === 1) { ag[0] = 1 / dt; ag[1] = -1 / dt; return; }

    // Order ≥ 2: Vandermonde collocation (ngspice nicomcof.c:52-127).
    const stride = order + 1;
    for (let i = 0; i < stride * stride; i++) scratch[i] = 0;
    for (let i = 0; i <= order; i++) ag[i] = 0;
    ag[1] = -1 / dt;
    for (let i = 0; i <= order; i++) scratch[0 * stride + i] = 1;
    for (let i = 1; i <= order; i++) scratch[i * stride + 0] = 0;
    let arg = 0;
    for (let i = 1; i <= order; i++) {
      arg += deltaOld[i - 1] > 0 ? deltaOld[i - 1] : dt;
      let arg1 = 1;
      for (let j = 1; j <= order; j++) { arg1 *= arg / dt; scratch[j * stride + i] = arg1; }
    }
    // LU (start at col 1; col 0 trivial).
    for (let i = 1; i <= order; i++) {
      for (let j = i + 1; j <= order; j++) {
        const piv = scratch[i * stride + i];
        if (Math.abs(piv) < 1e-300) { ag[0] = 1 / dt; ag[1] = -1 / dt; for (let k = 2; k <= order; k++) ag[k] = 0; return; }
        scratch[j * stride + i] /= piv;
        for (let k = i + 1; k <= order; k++) scratch[j * stride + k] -= scratch[j * stride + i] * scratch[i * stride + k];
      }
    }
    for (let i = 1; i <= order; i++)
      for (let j = i + 1; j <= order; j++) ag[j] -= scratch[j * stride + i] * ag[i];
    ag[order] /= scratch[order * stride + order];
    for (let i = order - 1; i >= 0; i--) {
      for (let j = i + 1; j <= order; j++) ag[i] -= scratch[i * stride + j] * ag[j];
      ag[i] /= scratch[i * stride + i];
    }
  }

  // ---------------------------------------------------------------------------
  //  dividedDiff(yHist, deltaOld, order) → (order+1)-th divided difference
  //  of one state's history. yHist[0]=y_n, yHist[1]=y_{n-1}, … (length ≥ order+2).
  //  Unrolled for order 1 (3 pts) and order 2 (4 pts) — ngspice cktterr.c.
  // ---------------------------------------------------------------------------
  function dividedDiff(y0, y1, y2, y3, dt, deltaOld, order) {
    const h0 = dt;
    const h1 = deltaOld.length > 1 && deltaOld[1] > 0 ? deltaOld[1] : dt;
    const h2 = deltaOld.length > 2 && deltaOld[2] > 0 ? deltaOld[2] : h1;
    if (order === 1) {
      let d0 = (y0 - y1) / h0;
      const d1 = (y1 - y2) / h1;
      d0 = (d0 - d1) / (h1 + h0);
      return Math.abs(d0);
    }
    let d0 = (y0 - y1) / h0;
    let d1 = (y1 - y2) / h1;
    const d2 = (y2 - y3) / h2;
    d0 = (d0 - d1) / (h1 + h0);
    d1 = (d1 - d2) / (h2 + h1);
    d0 = (d0 - d1) / (h2 + h1 + h0);
    return Math.abs(d0);
  }

  // ---------------------------------------------------------------------------
  //  LIB.BDF.create(opts) → integrator
  //
  //  opts: {
  //    n,                       // state dimension
  //    rtol = 1e-4, atol = 1e-7,
  //    dtMin = 1e-12, dtMax = Infinity, dtStart,
  //    maxOrder = 2,            // 1 or 2
  //    method = "gear",         // "gear" (L-stable) | "trapezoidal" (no damping)
  //    safety = 0.9, maxGrow = 4, minShrink = 0.1,
  //    maxRejects = 12,
  //  }
  //
  //  integrator API:
  //    .setState(y0, t0, dt0?)         — seed (clears history, order→1)
  //    .step(stepSolve) → {dt, order, rejects, accepted}
  //         advance ONE accepted step; stepSolve(t,dt,ag0,histTerm,yGuess,out)
  //         solves f(t,y)=ag0·y+histTerm for y, writes into out.
  //    .advance(tEnd, stepSolve) → nSteps  — loop .step to tEnd (lands exactly).
  //    .t, .y, .dt, .order                  — live state
  // ---------------------------------------------------------------------------
  function create(opts) {
    const n = opts.n | 0;
    // Per-component tolerances. atol/rtol may be a scalar (broadcast) or a
    // length-n array, so each physical state can carry its own error scale:
    // the LTE weight is atol_i + rtol_i·|y_i| (ngspice per-state form). A scalar
    // atol across states of unlike units/magnitudes (flux ~1e-3, speed ~1e2,
    // angle growing) mis-scales the practical error — the caller passes a vector
    // anchored to each state's physical scale instead.
    const rtolIn = opts.rtol != null ? opts.rtol : 1e-4;
    const atolIn = opts.atol != null ? opts.atol : 1e-7;
    const rtolArr = new Float64Array(n);
    const atolArr = new Float64Array(n);
    const _isArr = function (x) { return x != null && x.length != null; };
    for (let _i = 0; _i < n; _i++) {
      rtolArr[_i] = _isArr(rtolIn) ? rtolIn[_i] : rtolIn;
      atolArr[_i] = _isArr(atolIn) ? atolIn[_i] : atolIn;
    }
    const dtMin = opts.dtMin != null ? opts.dtMin : 1e-12;
    const dtMax = opts.dtMax != null ? opts.dtMax : Infinity;
    const maxOrder = opts.maxOrder != null ? opts.maxOrder : 2;
    const method = opts.method || "gear";
    const xmu = opts.xmu != null ? opts.xmu : 0.5;
    const safety = opts.safety != null ? opts.safety : 0.9;
    const maxGrow = opts.maxGrow != null ? opts.maxGrow : 4;
    const minShrink = opts.minShrink != null ? opts.minShrink : 0.1;
    const maxRejects = opts.maxRejects != null ? opts.maxRejects : 12;

    // State + history rings (y_n … y_{n-3}); deltaOld[0]=dt, [1..]=past steps.
    const y = new Float64Array(n);
    const yh1 = new Float64Array(n), yh2 = new Float64Array(n), yh3 = new Float64Array(n);
    const fh1 = new Float64Array(n);   // previous derivative f_{n-1} (trapezoidal needs it)
    const yTrial = new Float64Array(n);
    const histTerm = new Float64Array(n);
    const deltaOld = [0, 0, 0, 0, 0, 0, 0];
    const ag = new Float64Array(8);
    const agScratch = new Float64Array(9);

    const self = {
      t: 0, dt: 0, order: 1, y: y,
      _nAccepted: 0,
    };

    self.setState = function (y0, t0, dt0) {
      for (let i = 0; i < n; i++) { y[i] = y0[i]; yh1[i] = y0[i]; yh2[i] = y0[i]; yh3[i] = y0[i]; }
      self.t = t0 || 0;
      self.dt = dt0 != null ? dt0 : (opts.dtStart != null ? opts.dtStart : (isFinite(dtMax) ? dtMax * 0.01 : 1e-6));
      self.order = 1;
      self._nAccepted = 0;
      for (let i = 0; i < deltaOld.length; i++) deltaOld[i] = self.dt;
    };

    // One accepted step (internally retries rejected trials).
    self.step = function (stepSolve) {
      let rejects = 0;
      let dt = self.dt;
      const orderCap = Math.min(maxOrder, self._nAccepted + 1); // build order up from cold start

      for (;;) {
        if (dt < dtMin) dt = dtMin;
        const order = Math.min(self.order, orderCap);
        deltaOld[0] = dt;

        computeAg(dt, deltaOld, order, method, xmu, ag, agScratch);

        // histTerm so that the caller solves f(t,y) = ag0·y + histTerm.
        //   Gear: histTerm = Σ_{k≥1} ag[k]·y_{n-k}  (pure charge history).
        //   Trap order≥2: f_n = (2/dt)(y_n−y_{n-1}) − f_{n-1}, i.e.
        //                 histTerm = −ag0·y_{n-1} − f_{n-1}  (needs prev derivative).
        const trap2 = (method === "trapezoidal" && order >= 2);
        for (let i = 0; i < n; i++) {
          if (trap2) {
            histTerm[i] = -ag[0] * yh1[i] - fh1[i];
          } else {
            let h = ag[1] * yh1[i];
            if (order >= 2) h += ag[2] * yh2[i];
            histTerm[i] = h;
          }
        }

        const tNew = self.t + dt;
        stepSolve(tNew, dt, ag[0], histTerm, y, yTrial); // caller solves f=ag0·y+hist

        // LTE: largest scaled (order+1)-th divided difference over states.
        const factor = (method === "trapezoidal" ? TRAP_LTE : GEAR_LTE)[Math.min(order - 1, 3)];
        let worst = 0; // = (dt / dt_allowed)^(order+1), >1 ⇒ reject
        let dtAllowed = Infinity;
        for (let i = 0; i < n; i++) {
          const dd = dividedDiff(yTrial[i], yh1[i], yh2[i], yh3[i], dt, deltaOld, order);
          const tol = atolArr[i] + rtolArr[i] * Math.max(Math.abs(yTrial[i]), Math.abs(yh1[i]));
          if (dd > 0) {
            // local error ≈ factor·dt^(order+1)·dd ; want ≤ tol
            const errRatio = factor * Math.pow(dt, order + 1) * dd / tol;
            if (errRatio > worst) worst = errRatio;
            const di = Math.pow(tol / (factor * dd), 1 / (order + 1));
            if (di < dtAllowed) dtAllowed = di;
          }
        }

        if (worst <= 1 || dt <= dtMin) {
          // ----- accept -----
          for (let i = 0; i < n; i++) {
            fh1[i] = ag[0] * yTrial[i] + histTerm[i];   // f_n (= dy/dt at the new point)
            yh3[i] = yh2[i]; yh2[i] = yh1[i]; yh1[i] = yTrial[i]; y[i] = yTrial[i];
          }
          for (let k = 6; k >= 1; k--) deltaOld[k] = deltaOld[k - 1];
          deltaOld[0] = dt;
          self.t = tNew;
          self._nAccepted++;
          // promote order once enough history exists
          if (self.order < maxOrder && self._nAccepted >= self.order + 1) self.order++;
          // next dt from the error estimate
          let grow = safety * Math.pow(Math.max(worst, 1e-30), -1 / (order + 1));
          if (grow > maxGrow) grow = maxGrow;
          if (grow < minShrink) grow = minShrink;
          let dtNext = dt * grow;
          if (isFinite(dtAllowed)) dtNext = Math.min(dtNext, safety * dtAllowed * maxGrow);
          if (dtNext > dtMax) dtNext = dtMax;
          if (dtNext < dtMin) dtNext = dtMin;
          self.dt = dtNext;
          return { dt: dt, order: order, rejects: rejects, accepted: true };
        }

        // ----- reject: shrink and retry -----
        rejects++;
        let shrink = safety * Math.pow(worst, -1 / (order + 1));
        if (shrink < minShrink) shrink = minShrink;
        if (shrink > 0.9) shrink = 0.9;
        dt = dt * shrink;
        if (rejects > maxRejects) {
          // give up shrinking; force the smallest step (keeps the sim alive)
          dt = Math.max(dtMin, dt);
        }
      }
    };

    self.advance = function (tEnd, stepSolve) {
      let nSteps = 0;
      while (self.t < tEnd - 1e-15) {
        if (self.t + self.dt > tEnd) self.dt = tEnd - self.t; // land exactly
        self.step(stepSolve);
        nSteps++;
        if (nSteps > 5e6) break;
      }
      return nSteps;
    };

    return self;
  }

  LIB.BDF = { create: create, _computeAg: computeAg, _dividedDiff: dividedDiff };
})();
