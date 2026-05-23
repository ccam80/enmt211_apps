"use strict";

// =============================================================================
//  LIB.Drag — pointer-drag helpers for lesson canvases.
//
//  Four dragger flavours, all sharing a common shape:
//
//    LIB.Drag.hbar(opts)      — drag along world-x (load on a horizontal rail)
//    LIB.Drag.vbar(opts)      — drag along world-y or any 1D axis (shaft, ladder)
//    LIB.Drag.point2d(opts)   — free 2D drag (rover target, free body)
//    LIB.Drag.angular(opts)   — rotate around a pivot (wheel rim, motor shaft)
//
//  Plus a coordinator:
//
//    LIB.Drag.mux([d1, d2, …])  — first dragger whose hitTest passes captures.
//
//  ────────────────────────────────────────────────────────────────────────────
//   STATE CONVENTION
//  ────────────────────────────────────────────────────────────────────────────
//
//   The active gesture writes a payload to `state.drag`. Only one gesture runs
//   at a time — when one dragger captures, the others see `state.drag` is
//   already set and refuse to start. When the gesture ends, `state.drag` is
//   set to null. Lessons treat `state.drag` as read-only; they read it from
//   their dxdt / postStep to apply springs against whatever DOF the dragger
//   is targeting.
//
//   Per-flavour payloads (in addition to `kind`):
//
//     hbar / vbar:  { kind, value, prev, velocity, smoother }
//     point2d:      { kind, x, y, prevX, prevY, vx, vy, smootherX, smootherY }
//     angular:      { kind, theta, prev, omega, theta0, ang0, smoother }
//
//  ────────────────────────────────────────────────────────────────────────────
//   LIFECYCLE
//  ────────────────────────────────────────────────────────────────────────────
//
//   spec.onPointer = (type, mx, my, layout, state, params) =>
//     dragger.handle(type, mx, my, layout, state, params);
//
//   spec.physics.preStep = (state, params, dt) => {
//     dragger.preStep(state, dt);   // pushes a smoother sample, refreshes velocity
//     // …other discrete updates
//   };
//
//   spec.physics.dxdt = (state, params) => {
//     // 1D example
//     const F = dragger.spring1D(state, state.x, state.v, K_DRAG, C_DRAG);
//     // angular
//     const tau = dragger.springTheta(state, state.theta, state.omega, K, C);
//     return { x: state.v, v: (F + …) / m, … };
//   };
//
//   For implicit-Euler integration the lesson must also include the spring's
//   sensitivities in its jacobian (∂F/∂DOF = ±K, ∂F/∂DOFdot = ±C, gated on
//   `state.drag && state.drag.kind === thisKind`). The dragger doesn't write
//   the jacobian — too much knowledge of the lesson's DOF layout.
//
//  Dependencies: LIB.DragSmoother (lib/drag-smoother.js).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.DragSmoother) {
    throw new Error("LIB.Drag requires lib/drag-smoother.js");
  }

  // ---------------------------------------------------------------------------
  //  shared helpers
  // ---------------------------------------------------------------------------

  function clampN(v, lo, hi) {
    if (lo != null && v < lo) return lo;
    if (hi != null && v > hi) return hi;
    return v;
  }
  function applyBounds(v, b) {
    return b ? clampN(v, b.min, b.max) : v;
  }

  // Unwrap angular delta into (-π, +π]. Used by the angular dragger so a
  // pointer wrapping past +π → -π doesn't yank theta by -2π.
  function unwrapAngle(d) {
    while (d >  Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function isMine(state, kind) {
    return !!(state.drag && state.drag.kind === kind);
  }
  function isFree(state) {
    return !state.drag;
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.hbar
  //  Drag a 1D value along world-x, sourced from pointer mx via opts.worldX.
  // ---------------------------------------------------------------------------

  function hbar(opts) {
    const kind      = opts.kind || "load";
    const windowSec = (opts.windowSec != null) ? +opts.windowSec : 0.02;

    function start(state, mx, my, layout, params) {
      const v0 = (typeof opts.onSeedV === "function") ? +opts.onSeedV(state) : 0;
      const v0safe = Number.isFinite(v0) ? v0 : 0;
      const sm = new LIB.DragSmoother(windowSec);
      // Seed the smoother with one window's worth of synthetic motion at v0.
      // Without this the first preStep sees a zero pointer delta and the spring
      // would yank against the lesson's own velocity (e.g. snap a moving load
      // to rest the moment the user clicks it).
      sm.push(windowSec, v0safe * windowSec);
      const v = applyBounds(opts.worldX(mx, layout, state, params),
                            opts.bounds && opts.bounds(state, params));
      state.drag = { kind, value: v, prev: v, velocity: v0safe, smoother: sm };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        if (typeof opts.hitTest === "function" &&
            !opts.hitTest(state, params, layout, mx, my)) return false;
        start(state, mx, my, layout, params);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const v = applyBounds(opts.worldX(mx, layout, state, params),
                              opts.bounds && opts.bounds(state, params));
        state.drag.value = v;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) {
      if (!isMine(state, kind)) return;
      const d = state.drag.value - state.drag.prev;
      state.drag.prev = state.drag.value;
      state.drag.smoother.push(dt, d);
      state.drag.velocity = state.drag.smoother.velocity();
    }

    function spring1D(state, currentValue, currentVel, K, C) {
      if (!isMine(state, kind)) return 0;
      return -K * (currentValue - state.drag.value)
             -C * (currentVel   - state.drag.velocity);
    }

    return {
      kind, handle, preStep, spring1D,
      isActive(state) { return isMine(state, kind); },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.vbar
  //  Same as hbar but sourced from pointer my via opts.worldY (or opts.axis).
  //  The "value" is whatever 1D unit the lesson chose — meters for vertical
  //  position, radians if the lesson maps pixel y to angle, etc.
  // ---------------------------------------------------------------------------

  // vbar supports two mapping styles. For an *absolute* mapping (pointer y →
  // value), supply only `worldY(my, layout, state, params, mx, anchor)`; the
  // dragger calls it on every move with anchor=null. For a *relative* mapping
  // (e.g. "pointer Δy from grab point → Δθ"), supply `onStart(state, mx, my,
  // layout, params) → { value, anchor }` to stash the grab-point context.
  // worldY then receives that anchor on every move and computes a delta.
  function vbar(opts) {
    const kind      = opts.kind || "shaft";
    const windowSec = (opts.windowSec != null) ? +opts.windowSec : 0.02;

    if (typeof opts.worldY !== "function") {
      throw new Error("LIB.Drag.vbar: opts.worldY required");
    }

    function start(state, mx, my, layout, params) {
      const v0 = (typeof opts.onSeedV === "function") ? +opts.onSeedV(state) : 0;
      const v0safe = Number.isFinite(v0) ? v0 : 0;
      const sm = new LIB.DragSmoother(windowSec);
      sm.push(windowSec, v0safe * windowSec);
      let value, anchor = null;
      if (typeof opts.onStart === "function") {
        const init = opts.onStart(state, mx, my, layout, params) || {};
        anchor = init.anchor || null;
        value  = (init.value != null) ? +init.value : 0;
      } else {
        value = applyBounds(opts.worldY(my, layout, state, params, mx, null),
                            opts.bounds && opts.bounds(state, params));
      }
      state.drag = { kind, value, prev: value, velocity: v0safe, smoother: sm, anchor };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        if (typeof opts.hitTest === "function" &&
            !opts.hitTest(state, params, layout, mx, my)) return false;
        start(state, mx, my, layout, params);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const v = applyBounds(opts.worldY(my, layout, state, params, mx, state.drag.anchor),
                              opts.bounds && opts.bounds(state, params));
        state.drag.value = v;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) {
      if (!isMine(state, kind)) return;
      const d = state.drag.value - state.drag.prev;
      state.drag.prev = state.drag.value;
      state.drag.smoother.push(dt, d);
      state.drag.velocity = state.drag.smoother.velocity();
    }

    function spring1D(state, currentValue, currentVel, K, C) {
      if (!isMine(state, kind)) return 0;
      return -K * (currentValue - state.drag.value)
             -C * (currentVel   - state.drag.velocity);
    }

    return {
      kind, handle, preStep, spring1D,
      isActive(state) { return isMine(state, kind); },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.point2d
  //  Drag a 2D point in world coords. opts.worldXY(mx, my, layout, …) → {x, y}.
  // ---------------------------------------------------------------------------

  function point2d(opts) {
    const kind      = opts.kind || "target";
    const windowSec = (opts.windowSec != null) ? +opts.windowSec : 0.02;

    if (typeof opts.worldXY !== "function") {
      throw new Error("LIB.Drag.point2d: opts.worldXY required");
    }

    function applyBoundsXY(p, b) {
      if (!b) return p;
      return {
        x: clampN(p.x, b.xMin, b.xMax),
        y: clampN(p.y, b.yMin, b.yMax),
      };
    }

    function start(state, mx, my, layout, params) {
      const seed = (typeof opts.onSeedV === "function") ? opts.onSeedV(state) : { vx: 0, vy: 0 };
      const vx0 = Number.isFinite(seed && seed.vx) ? seed.vx : 0;
      const vy0 = Number.isFinite(seed && seed.vy) ? seed.vy : 0;
      const smX = new LIB.DragSmoother(windowSec);
      const smY = new LIB.DragSmoother(windowSec);
      smX.push(windowSec, vx0 * windowSec);
      smY.push(windowSec, vy0 * windowSec);
      const p = applyBoundsXY(opts.worldXY(mx, my, layout, state, params),
                              opts.bounds && opts.bounds(state, params));
      state.drag = { kind, x: p.x, y: p.y, prevX: p.x, prevY: p.y,
                     vx: vx0, vy: vy0, smootherX: smX, smootherY: smY };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        if (typeof opts.hitTest === "function" &&
            !opts.hitTest(state, params, layout, mx, my)) return false;
        start(state, mx, my, layout, params);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const p = applyBoundsXY(opts.worldXY(mx, my, layout, state, params),
                                opts.bounds && opts.bounds(state, params));
        state.drag.x = p.x;
        state.drag.y = p.y;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) {
      if (!isMine(state, kind)) return;
      const dX = state.drag.x - state.drag.prevX;
      const dY = state.drag.y - state.drag.prevY;
      state.drag.prevX = state.drag.x;
      state.drag.prevY = state.drag.y;
      state.drag.smootherX.push(dt, dX);
      state.drag.smootherY.push(dt, dY);
      state.drag.vx = state.drag.smootherX.velocity();
      state.drag.vy = state.drag.smootherY.velocity();
    }

    function spring2D(state, curX, curY, curVx, curVy, K, C) {
      if (!isMine(state, kind)) return { Fx: 0, Fy: 0 };
      return {
        Fx: -K * (curX - state.drag.x) - C * (curVx - state.drag.vx),
        Fy: -K * (curY - state.drag.y) - C * (curVy - state.drag.vy),
      };
    }

    return {
      kind, handle, preStep, spring2D,
      isActive(state) { return isMine(state, kind); },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.angular
  //  Rotate around a pivot. opts.centerPx(state, params, layout) → {x, y}.
  //  opts.thetaOf(state) → current theta DOF value (used as the anchor at
  //  gesture start, so the user "grabs" the wheel at its current angle).
  // ---------------------------------------------------------------------------

  function angular(opts) {
    const kind      = opts.kind || "wheel";
    const windowSec = (opts.windowSec != null) ? +opts.windowSec : 0.02;

    if (typeof opts.centerPx !== "function") {
      throw new Error("LIB.Drag.angular: opts.centerPx required");
    }
    if (typeof opts.thetaOf !== "function") {
      throw new Error("LIB.Drag.angular: opts.thetaOf required");
    }

    function pointerAng(mx, my, c) {
      // y axis is canvas-down; flip so theta increases CCW with world convention.
      return Math.atan2(-(my - c.y), (mx - c.x));
    }

    function start(state, mx, my, layout, params) {
      const c = opts.centerPx(state, params, layout);
      const ang0 = pointerAng(mx, my, c);
      const theta0 = +opts.thetaOf(state);
      const w0 = (typeof opts.onSeedW === "function") ? +opts.onSeedW(state) : 0;
      const w0safe = Number.isFinite(w0) ? w0 : 0;
      const sm = new LIB.DragSmoother(windowSec);
      sm.push(windowSec, w0safe * windowSec);
      state.drag = {
        kind,
        theta: theta0, prev: theta0,
        omega: w0safe,
        theta0, ang0,
        smoother: sm,
      };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        if (typeof opts.hitTest === "function" &&
            !opts.hitTest(state, params, layout, mx, my)) return false;
        start(state, mx, my, layout, params);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const c = opts.centerPx(state, params, layout);
        const ang = pointerAng(mx, my, c);
        const d = unwrapAngle(ang - state.drag.ang0);
        // Slide the anchor so consecutive deltas always remain in (-π, π].
        // Without this, sweeping past the branch cut would jump theta by 2π.
        state.drag.ang0   = ang;
        state.drag.theta0 = state.drag.theta0 + d;
        state.drag.theta  = state.drag.theta0;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) {
      if (!isMine(state, kind)) return;
      const d = state.drag.theta - state.drag.prev;
      state.drag.prev = state.drag.theta;
      state.drag.smoother.push(dt, d);
      state.drag.omega = state.drag.smoother.velocity();
    }

    function springTheta(state, curTheta, curOmega, K, C) {
      if (!isMine(state, kind)) return 0;
      return -K * (curTheta - state.drag.theta)
             -C * (curOmega - state.drag.omega);
    }

    return {
      kind, handle, preStep, springTheta,
      isActive(state) { return isMine(state, kind); },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.chainWheel
  //  Rotate one wheel of an N-wheel chain. Like `angular` but the wheel index
  //  is selected at gesture start (not baked into the dragger), and the spring
  //  is parameterised over the wheel index so callers can iterate and ask
  //  "what's the drag torque on wheel i?".
  //
  //  opts:
  //    hitTest(state, params, layout, mx, my)  → wheelIdx | -1
  //    centerPxFor(state, params, layout, i)   → {x, y}
  //    thetaOf?(state, i)                       → defaults to state[`theta_${i}`]
  //    omegaOf?(state, i)                       → defaults to state[`omega_${i}`]
  //
  //  state.drag payload: { kind, i, theta, prev, omega, theta0, ang0, smoother }
  //
  //  springTheta(state, i, K, C) returns 0 unless this dragger is active AND
  //  state.drag.i === i. The lesson's jacobian must add −K to (ω_i, θ_i) and
  //  −C to (ω_i, ω_i) under the same gating so the implicit step sees the
  //  spring's sensitivity.
  // ---------------------------------------------------------------------------

  function chainWheel(opts) {
    const kind      = opts.kind || "wheel";
    const windowSec = (opts.windowSec != null) ? +opts.windowSec : 0.02;

    if (typeof opts.hitTest !== "function") {
      throw new Error("LIB.Drag.chainWheel: opts.hitTest required");
    }
    if (typeof opts.centerPxFor !== "function") {
      throw new Error("LIB.Drag.chainWheel: opts.centerPxFor required");
    }
    const thetaOf = (typeof opts.thetaOf === "function")
      ? opts.thetaOf
      : (state, i) => state[`theta_${i}`];
    const omegaOf = (typeof opts.omegaOf === "function")
      ? opts.omegaOf
      : (state, i) => state[`omega_${i}`];

    function pointerAng(mx, my, c) {
      return Math.atan2(-(my - c.y), (mx - c.x));
    }

    function start(state, mx, my, layout, params, i) {
      const c = opts.centerPxFor(state, params, layout, i);
      const ang0   = pointerAng(mx, my, c);
      const theta0 = +thetaOf(state, i);
      const w0     = +omegaOf(state, i);
      const w0safe = Number.isFinite(w0) ? w0 : 0;
      const sm = new LIB.DragSmoother(windowSec);
      sm.push(windowSec, w0safe * windowSec);
      state.drag = {
        kind, i,
        theta: theta0, prev: theta0,
        omega: w0safe,
        theta0, ang0,
        smoother: sm,
      };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        const i = opts.hitTest(state, params, layout, mx, my);
        if (i < 0) return false;
        start(state, mx, my, layout, params, i);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const c = opts.centerPxFor(state, params, layout, state.drag.i);
        const ang = pointerAng(mx, my, c);
        const d = unwrapAngle(ang - state.drag.ang0);
        state.drag.ang0   = ang;
        state.drag.theta0 = state.drag.theta0 + d;
        state.drag.theta  = state.drag.theta0;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) {
      if (!isMine(state, kind)) return;
      const d = state.drag.theta - state.drag.prev;
      state.drag.prev = state.drag.theta;
      state.drag.smoother.push(dt, d);
      state.drag.omega = state.drag.smoother.velocity();
    }

    function springTheta(state, i, K, C) {
      if (!isMine(state, kind) || state.drag.i !== i) return 0;
      return -K * (thetaOf(state, i) - state.drag.theta)
             -C * (omegaOf(state, i) - state.drag.omega);
    }

    return {
      kind, handle, preStep, springTheta,
      isActive(state) { return isMine(state, kind); },
      activeIndex(state) { return isMine(state, kind) ? state.drag.i : -1; },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.orbit
  //  Kinematic orbital-camera drag for LIB.Layout3D. Pointer Δx → camera Δyaw,
  //  pointer Δy → camera Δpitch on a state-owned camera object. Used as the
  //  catch-all in a mux (place LAST so element draggers get first crack).
  //
  //  Camera state lives at state[opts.cameraField] (default "cam") and is the
  //  object {yaw, pitch, dist}. The dragger only mutates yaw/pitch; dist is
  //  reserved for a future zoom helper. Pitch is clamped to (−π/2+ε, π/2−ε)
  //  so the basis stays well-defined.
  //
  //  No spring helper — this is a direct write of the camera angles, not a
  //  force on a DOF. Lessons that include orbit() in their mux do NOT need to
  //  add anything to dxdt or jacobian.
  //
  //  opts:
  //    kind?         "orbit"
  //    cameraField?  "cam"
  //    yawPerPx?     0.008          // radians per pixel of horizontal drag
  //    pitchPerPx?   0.008          // radians per pixel of vertical drag (inverted: drag up tilts up)
  //    hitTest?      (state, params, layout, mx, my) → bool
  //                                  // optional gate — defaults to "always"
  //    pitchLimit?   Math.PI/2 - 0.05
  //
  //  state.drag payload: { kind, mx0, my0, yaw0, pitch0 }
  // ---------------------------------------------------------------------------

  function orbit(opts) {
    opts = opts || {};
    const kind        = opts.kind        || "orbit";
    const cameraField = opts.cameraField || "cam";
    const yawPerPx    = (opts.yawPerPx   != null) ? +opts.yawPerPx   : 0.008;
    const pitchPerPx  = (opts.pitchPerPx != null) ? +opts.pitchPerPx : 0.008;
    const pitchLimit  = (opts.pitchLimit != null) ? +opts.pitchLimit : (Math.PI / 2 - 0.05);

    function ensureCam(state) {
      let cam = state[cameraField];
      if (!cam || typeof cam !== "object") {
        cam = { yaw: 0, pitch: 0.35, dist: 4 };
        state[cameraField] = cam;
      }
      if (!Number.isFinite(cam.yaw))   cam.yaw = 0;
      if (!Number.isFinite(cam.pitch)) cam.pitch = 0.35;
      return cam;
    }

    function start(state, mx, my, layout, params) {
      const cam = ensureCam(state);
      state.drag = { kind, mx0: mx, my0: my, yaw0: cam.yaw, pitch0: cam.pitch };
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        if (!isFree(state)) return false;
        if (typeof opts.hitTest === "function" &&
            !opts.hitTest(state, params, layout, mx, my)) return false;
        start(state, mx, my, layout, params);
        return true;
      }
      if (!isMine(state, kind)) return false;
      if (type === "move") {
        const cam = ensureCam(state);
        const dx = mx - state.drag.mx0;
        const dy = my - state.drag.my0;
        cam.yaw   = state.drag.yaw0   + dx * yawPerPx;
        // dy increases downward in canvas pixels; drag DOWN should tilt the
        // camera DOWN (look more from above), so pitch increases with dy.
        let p = state.drag.pitch0 + dy * pitchPerPx;
        if (p >  pitchLimit) p =  pitchLimit;
        if (p < -pitchLimit) p = -pitchLimit;
        cam.pitch = p;
        return true;
      }
      if (type === "up" || type === "leave" || type === "cancel") {
        state.drag = null;
        return true;
      }
      return false;
    }

    function preStep(state, dt) { /* kinematic — no smoother to advance */ }

    return {
      kind, handle, preStep,
      isActive(state) { return isMine(state, kind); },
      target(state) { return isMine(state, kind) ? state.drag : null; },
    };
  }

  // ---------------------------------------------------------------------------
  //  LIB.Drag.mux
  //  Combine N draggers. On pointerdown, each in turn is offered the gesture;
  //  the first whose handle() returns true captures. Subsequent move/up events
  //  are routed only to whichever dragger currently owns state.drag.
  // ---------------------------------------------------------------------------

  function mux(draggers) {
    const list = (draggers || []).slice();
    if (!list.length) {
      throw new Error("LIB.Drag.mux: at least one dragger required");
    }

    function ownerByKind(state) {
      if (!state.drag) return null;
      const k = state.drag.kind;
      for (const d of list) if (d.kind === k) return d;
      return null;
    }

    function handle(type, mx, my, layout, state, params) {
      if (type === "down") {
        for (const d of list) {
          if (d.handle("down", mx, my, layout, state, params)) return true;
        }
        return false;
      }
      const owner = ownerByKind(state);
      if (!owner) return false;
      return owner.handle(type, mx, my, layout, state, params);
    }

    function preStep(state, dt) {
      for (const d of list) d.preStep(state, dt);
    }

    return {
      handle, preStep,
      draggers: list,
      isActive(state) { return !!state.drag; },
    };
  }

  LIB.Drag = { hbar, vbar, point2d, angular, chainWheel, orbit, mux };
})();
