"use strict";

// =============================================================================
//  LIB.RigidCoupling — penalty-spring rigid coupling between an angular DOF
//  (θ, ω) and a linear DOF (x, v) through an effective radius r.
//
//  Lifted from the conveyor lesson's K_RIGID/C_RIGID block. The same shape
//  appears in ball-screw, the rigid branch of the lead-screw whole-system
//  lesson, and the new transmission-tutorial gear-belt-payload lesson.
//
//      ψ    = x − θ·r
//      ψ̇   = v − ω·r
//      F    = −K·ψ − C·ψ̇             // force on the load
//      τ_on_motor = −r·F              // back-action on the angular side
//
//  Lessons read F directly and apply τ_on_motor in their dxdt; the helper
//  exposes K and C as fields so the lesson can fold them into its Jacobian
//  using its own DOF layout (the partials are dF/dx = −K, dF/dv = −C,
//  dF/dθ = +K·r, dF/dω = +C·r).
//
//   create({ K = 2.0e5, C = 1.0e3 }) → coupling
//       coupling.K, coupling.C
//       coupling.force(theta, omega, x, v, r) → F
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function create(opts) {
    opts = opts || {};
    const K = (opts.K != null) ? +opts.K : 2.0e5;
    const C = (opts.C != null) ? +opts.C : 1.0e3;
    return {
      K, C,
      force(theta, omega, x, v, r) {
        const psi    = x - theta * r;
        const psiDot = v - omega * r;
        return -K * psi - C * psiDot;
      },
    };
  }

  LIB.RigidCoupling = { create };
})();
