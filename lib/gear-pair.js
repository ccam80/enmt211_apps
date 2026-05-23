"use strict";

// =============================================================================
//  LIB.GearPair — kinematic + efficiency math for a single mating pair of
//  gears (one external mesh between r_in and r_out). Lessons that don't need
//  the full N-wheel chain (LIB.WheelChain) read their textbook ratio /
//  reflected-inertia / output-torque numbers from here so the formulas stay
//  in one place.
//
//  Sign convention matches LIB.WheelChain.pairRatio: an external gear mesh
//  reverses direction, so ω_out / ω_in = − r_in / r_out. Magnitudes are
//  exposed alongside the signed forms because the tutorial readouts (and the
//  forward-power formula for τ_out through η) are intrinsically magnitudes.
//
//   speedRatio(rIn, rOut)        → −r_in/r_out                  (signed, ω-ratio)
//   speedRatioMag(rIn, rOut)     →  r_in/r_out                  (magnitude)
//   torqueOutMag(tauIn, eta, rIn, rOut)
//        → |τ_out| = |τ_in| · η · r_out/r_in
//        Forward direction (motor → load) with mesh efficiency η.
//   reflectedJ({ Jin, Jout, rIn, rOut })
//        → Jin + Jout · (rIn/rOut)²    (kinematic-only, no η)
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function ratioMagSafe(rIn, rOut) {
    const rO = +rOut;
    if (!Number.isFinite(rO) || Math.abs(rO) < 1e-12) return 0;
    return Math.abs(((+rIn) || 0) / rO);
  }

  function speedRatio(rIn, rOut) {
    const rO = +rOut;
    if (!Number.isFinite(rO) || Math.abs(rO) < 1e-12) return 0;
    return -((+rIn) || 0) / rO;
  }

  function speedRatioMag(rIn, rOut) {
    return ratioMagSafe(rIn, rOut);
  }

  function torqueOutMag(tauIn, eta, rIn, rOut) {
    const k = ratioMagSafe(rIn, rOut);
    if (k <= 0) return 0;
    const e = (+eta);
    if (!Number.isFinite(e) || e <= 0) return 0;
    return Math.abs((+tauIn) || 0) * e / k;
  }

  function reflectedJ(opts) {
    opts = opts || {};
    const Jin  = +opts.Jin  || 0;
    const Jout = +opts.Jout || 0;
    const rIn  = +opts.rIn  || 0;
    const rOut = +opts.rOut || 0;
    if (!Number.isFinite(rOut) || Math.abs(rOut) < 1e-12) return Jin;
    const k = rIn / rOut;
    return Jin + Jout * k * k;
  }

  LIB.GearPair = {
    speedRatio, speedRatioMag,
    torqueOutMag,
    reflectedJ,
  };
})();
