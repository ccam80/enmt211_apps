"use strict";

// =============================================================================
//  LIB.Noise — coloured-noise stepping for stochastic disturbances.
//
//   ouStep(prev, sigma, tau, dt) → next
//     One Euler step of an Ornstein–Uhlenbeck process driven by white noise:
//        d x = (-x / τ) dt + σ √(2 dt / τ) · ξ,   ξ ~ N(0, 1)
//     Steady-state std ≈ σ; correlation time ≈ τ. Returns 0 immediately if
//     σ ≤ 0 or τ ≤ 0 (lets lessons disable the disturbance without branching).
//
//  Box–Muller is used for the Gaussian; the random number generator is the
//  default Math.random (good enough for visual disturbances).
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function gauss() {
    const u1 = Math.max(1e-9, Math.random());
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  LIB.Noise = {
    ouStep(prev, sigma, tau, dt) {
      if (!(sigma > 0) || !(tau > 0) || !(dt > 0)) return 0;
      return prev + (-prev / tau) * dt + sigma * Math.sqrt(2 * dt / tau) * gauss();
    },
    gauss,
  };
})();
