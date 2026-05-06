"use strict";

// =============================================================================
//  LIB.MatchHint — inertia-matching colour band + textual hint.
//
//  M = J_load,refl / J_motor.   M ≈ 1 → matched (best load acceleration).
//  M ≪ 1 → motor dominates;  M ≫ 1 → load dominates.
//
//  Zero dependencies (returns CSS var() refs that the page must define).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.MatchHint = {
    color(M) {
      if (!Number.isFinite(M) || M <= 0) return "var(--muted)";
      if (M >= 0.5 && M <= 2)   return "var(--good)";
      if (M >= 0.1 && M <= 10)  return "var(--cI)";
      return "var(--cP)";
    },
    hint(M) {
      if (!Number.isFinite(M) || M <= 0) return "—";
      if (M >= 0.5 && M <= 2)  return "matched";
      if (M < 1)               return "motor-dominated";
      return "load-dominated";
    },
  };
})();
