"use strict";

// =============================================================================
//  LIB.ScrewPhysics — lead-screw + nut coupling helpers.
//
//  Wraps the rigid + lash coupling for screw-driven lessons (lead-screw,
//  ball-screw, transmission-tutorial Q2). The dynamic coupling itself stays
//  ideal (energy-conserving) — η appears explicitly in the readouts that
//  illustrate the textbook formulas (holding torque, reflected inertia,
//  forward-drive torque demand). The simulator stays simple; the η story is
//  taught through the readouts the student sees move with the slider.
//
//  Public surface:
//
//    LIB.ScrewPhysics.reff(pitch, starts) → r
//        r = pitch · starts / (2π).  Lessons read this as the effective
//        "radius" used in every rigid θ↔x coupling.
//
//    LIB.ScrewPhysics.coupling({ K, C, K_LASH, C_LASH }) → c
//        c.K, c.C, c.K_LASH, c.C_LASH
//        c.force(x, v, theta, omega, r, lashH) → F
//          • lashH ≤ 0 → bilateral rigid spring (− K · ψ − C · ψ̇).
//          • lashH > 0 → LIB.Lash.contactForce — unilateral, dead-band ±lashH.
//
//    LIB.ScrewPhysics.gravityForce(m, vertical, g = 9.81) → F
//        −m·g when vertical (load pulls toward −x), 0 when horizontal.
//        Lessons add this to the load force sum and to their Jacobian's
//        constant column (it does not depend on x or v).
//
//    LIB.ScrewPhysics.holdingTorque(m, r, eta, vertical, g = 9.81) → τ
//        m·g·r / η when vertical and η > 0, else 0.
//
//    LIB.ScrewPhysics.effectiveJ({ Jmotor, Jscrew, m, r, eta }) → J
//        Jmotor + Jscrew + m·r² / η  (treats the η loss as inflating the
//        reflected mass, the standard textbook form).
//
//  Depends on lib/lash.js (for lash-window contact force).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Lash) throw new Error("LIB.ScrewPhysics requires lib/lash.js");

  const G_EARTH = 9.81;
  const K_RIGID_DEFAULT = 2.0e5;
  const C_RIGID_DEFAULT = 1.0e3;
  const K_LASH_DEFAULT  = 2.0e5;
  const C_LASH_DEFAULT  = 2.5e3;

  function reff(pitch, starts) {
    return ((+pitch) || 0) * ((+starts) || 0) / (2 * Math.PI);
  }

  function coupling(opts) {
    opts = opts || {};
    const K       = (opts.K       != null) ? +opts.K       : K_RIGID_DEFAULT;
    const C       = (opts.C       != null) ? +opts.C       : C_RIGID_DEFAULT;
    const K_LASH  = (opts.K_LASH  != null) ? +opts.K_LASH  : K_LASH_DEFAULT;
    const C_LASH  = (opts.C_LASH  != null) ? +opts.C_LASH  : C_LASH_DEFAULT;
    return {
      K, C, K_LASH, C_LASH,
      force(x, v, theta, omega, r, lashH) {
        const psi    = x - theta * r;
        const psiDot = v - omega * r;
        if (lashH > 1e-12) {
          return LIB.Lash.contactForce(psi, psiDot, lashH, K_LASH, C_LASH);
        }
        return -K * psi - C * psiDot;
      },
    };
  }

  function gravityForce(m, vertical, g) {
    if (!vertical) return 0;
    return -((+m) || 0) * ((g != null) ? +g : G_EARTH);
  }

  function holdingTorque(m, r, eta, vertical, g) {
    if (!vertical) return 0;
    const e = +eta;
    if (!Number.isFinite(e) || e <= 0) return Infinity;
    return ((+m) || 0) * ((g != null) ? +g : G_EARTH) * ((+r) || 0) / e;
  }

  function effectiveJ(opts) {
    opts = opts || {};
    const Jmotor = +opts.Jmotor || 0;
    const Jscrew = +opts.Jscrew || 0;
    const m      = +opts.m      || 0;
    const r      = +opts.r      || 0;
    const eta    = (opts.eta != null && +opts.eta > 0) ? +opts.eta : 1;
    return Jmotor + Jscrew + m * r * r / eta;
  }

  LIB.ScrewPhysics = {
    G_EARTH,
    reff, coupling,
    gravityForce, holdingTorque, effectiveJ,
  };
})();
