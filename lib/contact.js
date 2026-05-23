"use strict";

// =============================================================================
//  LIB.Contact — penalty contact between two bodies along a 1D axis.
//
//  Counterpart to LIB.EndStop (which is a body-vs-wall penalty). Used by
//  lessons with multiple colliding bodies — three-cart spring train, future
//  conveyor pile-ups, mass-on-mass demos. The same shape recurs in lib/lash.js
//  for thread-flank contact, but lash carries an engagement latch on top.
//
//   pair1D(xa, va, xb, vb, gap, k, c) → Fc
//     Returns the (non-negative) magnitude of the contact force when bodies
//     overlap (i.e. (xb − xa) < gap). Returns 0 when not in contact.
//     Caller applies signs:  F[a] -= Fc;  F[b] += Fc;
//     Damping kicks in only on the closing component of relative velocity
//     (so separating bodies aren't yanked back together by drag).
//
//  Convention: xa is the LEFT body, xb is the RIGHT body. Distance "a → b"
//  is xb − xa (always intended to be positive at rest). gap is the minimum
//  centre-to-centre separation before penetration counts (e.g. 2 × half-width
//  for two equal-sized carts).
//
//  Zero deps.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.Contact = {
    pair1D(xa, va, xb, vb, gap, k, c) {
      const pen = gap - (xb - xa);
      if (pen <= 0) return 0;
      const closing = Math.max(0, va - vb);
      return k * pen + (c || 0) * closing;
    },
  };
})();
