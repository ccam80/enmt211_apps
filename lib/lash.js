"use strict";

// =============================================================================
//  LIB.Lash — finite-flank lash contact between two coupled DOF.
//
//  Pulled out of lead-screw's per-step lash machinery so any mesh that has a
//  free-play window can use the same primitives:
//
//   • lead-screw / ball-screw — one mesh between (load.x, motor.θ·r).
//   • rotational gear chain (backlash) — N−1 meshes between adjacent wheels.
//   • whole-system translational lead mode — same shape as lead-screw.
//
//  The lash coordinate ψ is some signed measure of the gap inside the window;
//  this module is agnostic about how the caller computes it. ψ̇ is its time
//  derivative. H is the half-width of the window; the engaged flank sits at
//  ψ = ±H. `engaged ∈ {-1, 0, +1}` is the engagement state, with 0 meaning
//  free-flight (no contact force).
//
//  Public surface
//  --------------
//
//    LIB.Lash.contactForce(psi, psiDot, engaged, H, K, C) → number
//        Spring + damper force when engaged; 0 when free.
//        engaged = +1 → target = +H; engaged = -1 → target = -H.
//        F = -K(ψ − target) − C·ψ̇.
//
//    LIB.Lash.latchEngagement(prevEngaged, opts) → -1 | 0 | +1
//        Latched transition (engagement carries across steps; release is
//        explicit, not redetected from instantaneous ψ alone).
//
//        Engage when ψ has crossed (or end-of-step ψ would cross) ±H.
//        Release when a caller-supplied predicate fires OR ψ has retracted
//        past H · retractFraction toward zero.
//
//        opts: {
//          psi,                              // current ψ
//          psiDot,                           // current ψ̇ (used only when H ≈ 0)
//          psiEnd?,                          // optional end-of-step ψ predict
//          H,                                // window half-width (= lash/2)
//          releaseAtPos? : () => bool,       // fires → release from +1
//          releaseAtNeg? : () => bool,       // fires → release from -1
//          retractFraction? : 0.5,           // |ψ| past H·this → release
//          eps? : Math.max(1e-7, H * 1e-3),  // boundary tolerance
//        }
//
//        Release predicates are case-specific:
//          • lead-screw: motor commands ω opposite to the engaged flank.
//          • backlash:   free acceleration of ψ pushes away from boundary.
//
//        If H ≤ 1e-9 (no lash), there's no free-flight regime and the result
//        is +1 if ψ̇ ≥ 0, else -1.
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function contactForce(psi, psiDot, engaged, H, K, C) {
    if (engaged === 0) return 0;
    const target = engaged > 0 ? +H : -H;
    return -K * (psi - target) - C * psiDot;
  }

  function latchEngagement(prevEngaged, opts) {
    const H = +opts.H;
    if (H <= 1e-9) {
      return ((+opts.psiDot || 0) >= 0) ? +1 : -1;
    }
    const psi    = +opts.psi;
    const psiEnd = (opts.psiEnd != null) ? +opts.psiEnd : psi;
    const eps    = (opts.eps != null) ? +opts.eps : Math.max(1e-7, H * 1e-3);
    const retract = (opts.retractFraction != null) ? +opts.retractFraction : 0.5;

    let engaged = prevEngaged | 0;

    // ENGAGE: ψ at-or-past boundary, or end-of-step would cross.
    if (engaged !== +1 && (psi >=  H - eps || psiEnd >=  H)) engaged = +1;
    else if (engaged !== -1 && (psi <= -H + eps || psiEnd <= -H)) engaged = -1;

    // RELEASE: caller's predicate OR ψ retracted past H·retractFraction.
    if (engaged === +1) {
      if ((opts.releaseAtPos && opts.releaseAtPos()) || psi <  H * retract) {
        engaged = 0;
      }
    } else if (engaged === -1) {
      if ((opts.releaseAtNeg && opts.releaseAtNeg()) || psi > -H * retract) {
        engaged = 0;
      }
    }

    return engaged;
  }

  LIB.Lash = { contactForce, latchEngagement };
})();
