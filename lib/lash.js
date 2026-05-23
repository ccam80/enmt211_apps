"use strict";

// =============================================================================
//  LIB.Lash — unilateral finite-flank contact between two coupled DOF.
//
//  Used by:
//    • lead-screw / ball-screw — single mesh between (load.x, motor.θ·r)
//    • rotational backlash     — N−1 meshes between adjacent wheels
//    • whole-system lead mode  — same shape as lead-screw
//
//  The lash coordinate ψ is some signed measure of the gap; this module is
//  agnostic about how it's computed. ψ̇ is its time derivative. H is the half-
//  width of the lash window — flanks make contact at ψ = ±H, free-flight
//  inside |ψ| < H.
//
//  Contact model — unilateral spring with compression-only damping
//  ---------------------------------------------------------------
//  Real flanks can only push apart, never pull. The spring is one-sided
//  outside ±H; the damper is one-sided in the compression direction so it
//  cannot drag the trailing flank along on rebound:
//
//      ψ > +H :  F = -K(ψ-H) - C·max(0, ψ̇)
//      ψ < -H :  F = -K(ψ+H) - C·min(0, ψ̇)
//      else   :  F = 0
//
//  Trade-off: this dissipates energy when ψ̇ is into the flank but rebounds
//  elastically (ψ̇ leaving the flank sees no contact damping). Couples the
//  rebound velocity to gap-flight viscous drag only.
//
//  H = 0 collapses to a bilateral rigid mesh (`F = -K·ψ - C·ψ̇`) — used by
//  gear / belt / conveyor couplings that have no free-play.
//
//  Public surface
//  --------------
//
//    LIB.Lash.contactForce(psi, psiDot, H, K, C) → number
//    LIB.Lash.engagementOf(psi, H)              → -1 | 0 | +1   (readout label)
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function contactForce(psi, psiDot, H, K, C) {
    if (H <= 1e-9) {
      return -K * psi - C * psiDot;
    }
    if (psi > H) {
      const damp = (psiDot > 0) ? -C * psiDot : 0;
      return -K * (psi - H) + damp;
    }
    if (psi < -H) {
      const damp = (psiDot < 0) ? -C * psiDot : 0;
      return -K * (psi + H) + damp;
    }
    return 0;
  }

  function engagementOf(psi, H) {
    if (H <= 1e-9) return (psi >= 0) ? +1 : -1;
    if (psi >  H) return +1;
    if (psi < -H) return -1;
    return 0;
  }

  LIB.Lash = { contactForce, engagementOf };
})();
