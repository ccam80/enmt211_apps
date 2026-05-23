"use strict";

// =============================================================================
//  LIB.ThreePhase — shared math for three-phase AC lessons.
//
//  One source of truth for the per-winding indexing and phase convention used
//  by every three-phase lesson (rotating-field, three-phase-rotor, …):
//
//    Winding k ∈ {0, 1, 2} corresponds to phases a, b, c respectively.
//    Phase-k signal at integrated drive phase φ:
//      s_k(φ) = amp · cos(φ − 2π·k/3)
//    Winding-k dipole axis in the cavity end-view (2D, x–y):
//      u_k = (cos(2π·k/3), sin(2π·k/3))
//    Winding-k dipole axis when the rotor's rotation axis is world-x (3D,
//    y–z plane):
//      u_k = (0, cos(2π·k/3), sin(2π·k/3))
//
//  `swap` flips phases b↔c which reverses the rotation direction of the
//  composite field without changing per-winding amplitude.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  const TWO_PI_3 = (2 * Math.PI) / 3;

  function effK(k, swap) {
    if (!swap) return k;
    if (k === 1) return 2;
    if (k === 2) return 1;
    return 0;
  }

  function phaseOf(k, swap) { return TWO_PI_3 * effK(k, swap); }

  function signal(k, phi, swap, amp) {
    return (amp != null ? +amp : 1) * Math.cos(phi - phaseOf(k, swap));
  }

  function axis2D(k) {
    const a = TWO_PI_3 * k;
    return { x: Math.cos(a), y: Math.sin(a) };
  }

  // Three-phase axis in the y–z plane, used by 3D lessons whose rotor spins
  // about world-x. Matches the convention in squirrel-cage.js where rotor
  // diametral pairs were placed with normal (0, sin(α), cos(α)) — except here
  // we want winding 0 along +y, so we reverse: (0, cos(α), sin(α)).
  function axisInYZ(k) {
    const a = TWO_PI_3 * k;
    return { x: 0, y: Math.cos(a), z: Math.sin(a) };
  }

  LIB.ThreePhase = {
    TWO_PI_3,
    effK, phaseOf, signal, axis2D, axisInYZ,
  };
})();
