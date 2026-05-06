"use strict";

// =============================================================================
//  LIB.PositionTorque — cascaded position-PID → velocity-P → motor torque.
//
//  Replaces the original LIB.Controller. Wraps LIB.PID so the cascade lessons
//  call the same advance() / pure-effort primitives as every other lesson —
//  just composed through an intermediate velocity demand.
//
//  Loop topology
//  -------------
//                       ┌── outer position PID ──┐
//                       │  (kp, ki, kd, vCap)    │
//      xTarget ── err ──┤   advance + demand     ├── vDemand ──┐
//      x       ─────────┘                                       │
//                                                               │
//                       ┌── inner velocity-P loop ───────────── ┘
//                       │  (kp_v, tCap)
//      ω       ── err ──┤   torque
//                       └── tau (saturated)
//
//  The outer loop's anti-windup clamp is the velocity cap (vCap) so the
//  integral term alone can't demand a velocity outside ±vCap.
//
//  Calling pattern (matches LIB.PID's advance + pure-effort split)
//  ---------------------------------------------------------------
//    state.<slot> = { I: 0, ePrev: 0 };          // reserve a loop slot
//
//    preStep(state, p, dt) {
//      LIB.PositionTorque.advance(state.posLoop,
//                                 p.xTarget, state.x, dt,
//                                 { ki: p.KiPos, vCap: p.wTarget });
//    }
//
//    function vDemand(state, p) {
//      return LIB.PositionTorque.demand(state.posLoop,
//        p.xTarget, state.x, state.v,
//        { kp: p.KpPos, kd: p.KdPos, vCap: p.wTarget });
//    }
//
//    function motorTorque(state, p) {
//      return LIB.PositionTorque.torque(state.omega, vDemand(state, p),
//                                       p.Kp, p.Tmax);
//    }
//
//  Both demand() and torque() are pure of state mutation, so they're safe
//  to call from inside dxdt across an integrator's sub-evaluations.
//
//  Dependencies: lib/pid.js
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.PID) throw new Error("LIB.PositionTorque requires lib/pid.js");

  function advance(loopState, ref, x, dt, gains) {
    const vCap = (gains && gains.vCap != null) ? +gains.vCap : Infinity;
    LIB.PID.advance(loopState, ref - x, dt,
      { ki: gains && gains.ki, iClamp: vCap });
  }

  function demand(loopState, ref, x, v, gains) {
    const vCap = (gains && gains.vCap != null) ? +gains.vCap : Infinity;
    return LIB.PID.effort(loopState, ref - x, v,
      { kp: gains && gains.kp, kd: gains && gains.kd, uCap: vCap }).u;
  }

  function torque(omega, vDemand, kp, tCap) {
    let tau = (+kp || 0) * (vDemand - omega);
    const cap = (tCap != null) ? +tCap : Infinity;
    if (tau >  cap) tau =  cap;
    if (tau < -cap) tau = -cap;
    return tau;
  }

  LIB.PositionTorque = { advance, demand, torque };
})();
