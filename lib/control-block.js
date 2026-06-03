"use strict";

// =============================================================================
//  LIB.ControlBlock — declarative wrapper around LIB.PID + LIB.BangBang for
//  the spec-driven shell.
//
//  Every PID-flavoured lesson in the repo follows the same six-line dance:
//    1. ensure state[slot] (loop state object) exists
//    2. compute err  = ref - meas
//    3. branch on params.mode → PID vs BangBang
//    4. advance the loop
//    5. read effort
//    6. stash {e, u, uP, uI, uD} in state.lastE/lastUP/...  for plot+readout
//
//  This module is the (1)..(5) of that dance. The shell drives it via
//  spec.controllers (lib/app.js) so step (6) becomes "the shell wrote it
//  there for you". Lessons can still maintain their own per-frame work in
//  preStep/postStep — the controller block runs BETWEEN preStep and the
//  integrator, so dxdt sees state[output].u as a constant during rk4 stages
//  (a ZOH pattern).
//
//   advance(state, params, dt, blockSpec)
//
//   blockSpec = {
//     slot:    "ctrlLoop",        // state[slot] reserves { I, ePrev, bbDir }
//     output:  "ctrlOut",         // state[output] = { e, u, uP, uI, uD }
//     enable:  (s, p) => bool,    // optional gate (e.g. arrival-radius)
//     resetIWhenDisabled: true,   // default true
//     modeKey: "mode",            // optional — picks pid/bangbang at runtime
//
//     pid: {
//       err:   (s, p) => err,
//       dmeas: (s, p) => measDot,
//       gains: (s, p) => ({ kp, ki, kd, iClamp, uCap }),
//     },
//
//     bangbang: {
//       flavor: "flip" | "latch",
//       err:    (s, p) => err,
//       dir:    (s, p) => +1,                     // for "latch" only
//       gains:  (s, p) => ({ dead, effort, uCap }),
//     },
//   }
//
//  When `modeKey` is set and present in params, it picks the active flavour
//  ("pid" or "bangbang"). When modeKey is absent (or its value is unknown),
//  whichever flavour is supplied is used.
//
//  Output shape — state[output] is always populated with { e, u, uP, uI, uD }.
//  Bang-bang produces uP=uI=uD=0 (the breakdown only makes sense for PID).
//
//  Disabled behaviour — when enable() returns false:
//   - state[output] = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 }
//   - state[slot].I is reset to 0 (default; suppress with resetIWhenDisabled:false)
//   - state[slot].bbDir is left untouched so a re-enable doesn't re-initialise the FSM
//
//  Depends on LIB.PID, LIB.BangBang.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.PID || !LIB.BangBang) {
    throw new Error("LIB.ControlBlock requires lib/pid.js");
  }

  function ensureLoop(state, slot) {
    let l = state[slot];
    if (!l) { l = state[slot] = { I: 0, ePrev: 0, bbDir: 0 }; }
    if (l.I     == null) l.I     = 0;
    if (l.ePrev == null) l.ePrev = 0;
    if (l.bbDir == null) l.bbDir = 0;
    return l;
  }

  function ensureOut(state, key) {
    let o = state[key];
    if (!o) o = state[key] = { e: 0, u: 0, uP: 0, uI: 0, uD: 0 };
    return o;
  }

  function pickFlavour(blockSpec, params) {
    const modeKey = blockSpec.modeKey;
    if (modeKey && params && params[modeKey] != null) {
      const m = String(params[modeKey]);
      if (m === "bangbang" && blockSpec.bangbang) return "bangbang";
      if (m === "pid"      && blockSpec.pid)      return "pid";
    }
    if (blockSpec.pid)      return "pid";
    if (blockSpec.bangbang) return "bangbang";
    return null;
  }

  function advance(state, params, dt, blockSpec) {
    if (!blockSpec || !blockSpec.slot || !blockSpec.output) {
      throw new Error("LIB.ControlBlock.advance: blockSpec.slot and .output required");
    }
    const loop = ensureLoop(state, blockSpec.slot);
    const out  = ensureOut(state, blockSpec.output);

    const enabled = (typeof blockSpec.enable === "function")
      ? !!blockSpec.enable(state, params) : true;

    if (!enabled) {
      out.e = 0; out.u = 0; out.uP = 0; out.uI = 0; out.uD = 0;
      const resetI = (blockSpec.resetIWhenDisabled !== false);
      if (resetI) loop.I = 0;
      return out;
    }

    const flavour = pickFlavour(blockSpec, params);

    if (flavour === "pid") {
      const cfg   = blockSpec.pid;
      const err   = +cfg.err  (state, params) || 0;
      const dm    = +cfg.dmeas(state, params) || 0;
      const gains = cfg.gains(state, params) || {};
      LIB.PID.advance(loop, err, dt,
        { ki: +gains.ki || 0, iClamp: gains.iClamp });
      const eff = LIB.PID.effort(loop, err, dm,
        { kp: +gains.kp || 0, kd: +gains.kd || 0, uCap: gains.uCap });
      out.e  = err;
      out.uP = eff.uP; out.uI = eff.uI; out.uD = eff.uD; out.u = eff.u;
      return out;
    }

    if (flavour === "bangbang") {
      const cfg    = blockSpec.bangbang;
      const flavor = cfg.flavor || "flip";
      const err    = +cfg.err(state, params) || 0;
      const gains  = cfg.gains(state, params) || {};
      if (flavor === "latch") {
        const dir = +cfg.dir(state, params) || 0;
        LIB.BangBang.latch.advance(loop, err, dir, { dead: +gains.dead || 0 });
        const eff = LIB.BangBang.latch.effort(loop, dir,
          { effort: +gains.effort || 0, uCap: gains.uCap });
        out.e = err; out.uP = 0; out.uI = 0; out.uD = 0; out.u = eff.u;
      } else {
        LIB.BangBang.flip.advance(loop, err, { dead: +gains.dead || 0 });
        const eff = LIB.BangBang.flip.effort(loop,
          { effort: +gains.effort || 0, uCap: gains.uCap });
        out.e = err; out.uP = 0; out.uI = 0; out.uD = 0; out.u = eff.u;
      }
      return out;
    }

    // No flavour resolved — emit zeros so dxdt callers don't read NaN.
    out.e = 0; out.u = 0; out.uP = 0; out.uI = 0; out.uD = 0;
    return out;
  }

  LIB.ControlBlock = { advance };
})();
