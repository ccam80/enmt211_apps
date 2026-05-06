"use strict";

// =============================================================================
//  LIB.PID + LIB.BangBang — generic single-loop control primitives.
//
//  Every controller in the repo (pidapp's direct-force PID, the linear-
//  transmission family's outer position PID and inner velocity-P loop, the
//  rotational whole-system's PI on motor ω, the controltutorial car/heli/
//  rover lessons) is a different wrapping of the same single piece of math:
//
//      I    += ki · err · dt           (trapezoidal, anti-windup clamps |I|)
//      u_raw = kp · err + I + kd · (-dmeas)
//      u     = clamp(u_raw, ±uCap)
//
//  Bang-bang is genuinely different math (a hysteresis FSM), but the same
//  calling shape — advance() once per step to update latched state, effort()
//  to read the resulting force — keeps lesson code uniform.
//
//  Calling convention (uniform across lessons)
//  --------------------------------------------
//    state.<slot> reserves a loop-state object: { I, ePrev } for PID,
//    { bbOn } for BangBang.latch, { bbDir } for BangBang.flip. Lessons pick
//    the slot name (e.g. `state.posLoop`, `state.ctrlLoop`) so multiple loops
//    don't collide.
//
//      preStep(state, params, dt) {
//        const err = params.ref - state.x;
//        if (params.mode === "pid") {
//          LIB.PID.advance(state.ctrlLoop, err, dt,
//                          { ki: p.ki, iClamp: p.iClamp });
//        } else {
//          // pidapp-style latched bang-bang: dir externally supplied
//          // (e.g. sign of (ref − plant equilibrium))
//          LIB.BangBang.latch.advance(state.ctrlLoop, err, dir,
//                                     { dead: p.dead });
//        }
//      }
//      dxdt(state, params, t) {
//        const err = params.ref - state.x;
//        const u = (params.mode === "pid")
//          ? LIB.PID.effort(state.ctrlLoop, err, state.v,
//                           { kp: p.kp, kd: p.kd, uCap: p.uMax }).u
//          : LIB.BangBang.latch.effort(state.ctrlLoop, dir,
//                                      { effort: p.effort, uCap: p.uMax }).u;
//        // ... apply u to plant ...
//      }
//
//  effort() never mutates loopState — safe to call from inside an
//  integrator's sub-evaluations (RK4 calls dxdt 4× per step,
//  implicit-Euler uses it for the Jacobian).
//
//  Bang-bang flavours
//  ------------------
//    LIB.BangBang.latch — output is 0 or ±effort. Caller supplies `dir`
//                         (sign of ref vs plant equilibrium). bbOn latches
//                         on hysteresis. Pidapp's pattern.
//    LIB.BangBang.flip  — output is always ±effort. dir is internal, flips
//                         when error crosses past the OPPOSITE deadband
//                         edge. Controltutorial's pattern.
//
//  Zero deps.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  function clamp(v, cap) {
    return (v >  cap) ?  cap
         : (v < -cap) ? -cap
         : v;
  }

  // ---------------------------------------------------------------------------
  //  LIB.PID — one continuous loop of the standard PID law.
  // ---------------------------------------------------------------------------

  function pidAdvance(loopState, err, dt, gains) {
    const ki = +(gains && gains.ki) || 0;
    const Inew = (loopState.I || 0) + ki * 0.5 * (err + (loopState.ePrev || 0)) * dt;
    const cap = (gains && gains.iClamp != null) ? +gains.iClamp : Infinity;
    loopState.I = clamp(Inew, cap);
    loopState.ePrev = err;
  }

  function pidEffort(loopState, err, dmeas, gains) {
    const kp = +(gains && gains.kp) || 0;
    const kd = +(gains && gains.kd) || 0;
    const uP = kp * err;
    const uI = loopState.I || 0;
    const uD = kd * (-dmeas);                 // derivative-on-measurement
    const cap = (gains && gains.uCap != null) ? +gains.uCap : Infinity;
    const u = clamp(uP + uI + uD, cap);
    return { u, uP, uI, uD };
  }

  // ---------------------------------------------------------------------------
  //  LIB.BangBang.latch — pidapp-style on/off latched. dir externally supplied.
  //    advance() updates loopState.bbOn.
  //    effort() returns 0 or dir*effort, capped at uCap.
  // ---------------------------------------------------------------------------

  function latchAdvance(loopState, err, dir, p) {
    const half = +((p && p.dead) || 0) / 2;
    if (dir > 0) {
      if (err >  half) loopState.bbOn = true;
      else if (err < -half) loopState.bbOn = false;
    } else if (dir < 0) {
      if (err < -half) loopState.bbOn = true;
      else if (err >  half) loopState.bbOn = false;
    } else {
      loopState.bbOn = false;
    }
  }

  function latchEffort(loopState, dir, p) {
    const e   = +((p && p.effort) || 0);
    const cap = (p && p.uCap != null) ? +p.uCap : Infinity;
    return { u: clamp(loopState.bbOn ? dir * e : 0, cap) };
  }

  // ---------------------------------------------------------------------------
  //  LIB.BangBang.flip — controltutorial-style always-on. dir is internal,
  //  flips on hysteresis. Output is always ±effort.
  // ---------------------------------------------------------------------------

  function flipAdvance(loopState, err, p) {
    const half = +((p && p.dead) || 0) / 2;
    let dir = +loopState.bbDir || 0;
    if (dir === 0) dir = (err >= 0) ? +1 : -1;
    else if (dir > 0 && err < -half) dir = -1;
    else if (dir < 0 && err >  half) dir = +1;
    loopState.bbDir = dir;
  }

  function flipEffort(loopState, p) {
    const e   = +((p && p.effort) || 0);
    const cap = (p && p.uCap != null) ? +p.uCap : Infinity;
    return { u: clamp((+loopState.bbDir || 0) * e, cap) };
  }

  LIB.PID = { advance: pidAdvance, effort: pidEffort };
  LIB.BangBang = {
    latch: { advance: latchAdvance, effort: latchEffort },
    flip:  { advance: flipAdvance,  effort: flipEffort  },
  };
})();
