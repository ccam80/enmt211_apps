"use strict";

// =============================================================================
//  LIB.WheelChain — N-wheel transmission chain: layout math, kinematics, and
//  the declarative-physics surface (state factory + dof list + chain dxdt /
//  jacobian) that lets the rotational lessons run on the same implicit-Euler
//  integrator as the linear ones.
//
//  Wheel data
//  ----------
//  A wheel carries five plain fields and two DOF accessors:
//
//    { r, r1, r2, J, lastTau,                       // plain values
//      theta (getter/setter onto state.theta_i),
//      omega (getter/setter onto state.omega_i)  }
//
//  Single-radius wheels (drive pulley, simple-mode gears, the only flavour
//  in the simple/backlash/whole-system rotational lessons) read `r` for both
//  contact surfaces. Compound wheels (gearboxes, stepped pulleys) carry r1
//  (mates with the wheel on its left) and r2 (mates with the wheel on its
//  right). Wheel 0 only ever has a single contact (no left mate), so its r1
//  is effectively unused.
//
//  Couplings depend on a `mode` string:
//    "simple"   — single-radius gears, tangent contact, sign reverses each step
//    "compound" — wheels 1+ are compound (r1, r2), gear contact, sign reverses
//    "belt"     — wheels 1+ are compound (r1, r2), belt contact, sign preserved
//    "backlash" — single-radius gears with finite tooth lash; rigid otherwise
//
//  Layout / kinematics surface (operates on a wheels-array)
//  --------------------------------------------------------
//
//    isCompound(mode, i)         leftR(w, mode, i)
//    rightR(w, mode, i)          outerR(w, mode, i)
//    pairRatio(wheels, i, mode)  → ω_{i+1}/ω_i, signed
//    cumRatios(wheels, mode)     → R[0..N−1] with R[0]=1
//    reflectedJ(wheels, mode)    → reflected to wheel 0
//    reflectedDrag(wheels, mode, c) → c·ΣR² reflected to wheel 0
//    layoutCenters(wheels, mode, beltGap?) → world-space wheel centres
//    computeDrawOrder(wheels, mode)        → z-order
//    meshSign(mode)              → +1 for gear contact, -1 for belt
//
//  Declarative-physics surface (operates on a state-object)
//  --------------------------------------------------------
//
//    makeState(N, opts?) → state
//        Returns a chain state with `state.N`, flat DOF keys (`theta_i`,
//        `omega_i`), per-wheel proxies on `state.wheels[]`, per-mesh arrays
//        `meshEngaged[]` / `meshPsiOffset[]`, plus `drag/lastT/t`.
//        opts: { defaults? : (i) => { r, r1, r2, J } }
//
//    addWheel(state, mode, init?)        modify chain in place; update offsets
//    removeLast(state, mode)             so a freshly-attached or freshly-
//                                        detached mesh is born at ψ=0.
//
//    dof(state) → ["theta_0","omega_0","theta_1","omega_1", …]
//        Pass to spec.physics.dof = (state) => LIB.WheelChain.dof(state).
//
//    meshPsi(state, mode, i)             ψ_i = rA·θA + ms·rB·θB − offset
//    meshPsiDot(state, mode, i)          ψ̇_i = rA·ωA + ms·rB·ωB
//    recomputePsiOffsets(state, mode)    Latch offsets so every meshPsi → 0
//                                        right now (call after structural
//                                        change AND after a freshly-built
//                                        defaultState).
//
//    contactDxdt(state, params, t, opts)  → { theta_i, omega_i, … }
//    contactJacobian(state, params, t, opts) → Float64Array of (2N × 2N)
//        Builds the chain's contact-spring + viscous + (optional) drive
//        contributions. The lesson's dxdt/jacobian usually just call these
//        and add lesson-specific terms (saturating drive Jacobian, pointer-
//        drag penalty springs, end-stops, etc.) on top.
//
//        opts: {
//          mode,                                 // required
//          c     = 0,                            // viscous damping per wheel
//          meshK = K_RIGID, meshC = C_RIGID,     // contact stiffness/damping
//          meshH = 0,                            // lash half-width per mesh
//          drive?: (state, params) => τ_on_0,    // optional drive on wheel 0
//          extraTorque?: (state, params, i) => τ_extra_on_i,  // optional
//        }
//
//        meshH = 0 collapses to plain rigid bilateral coupling at ψ=0 (gear
//        / belt / whole-system). meshH > 0 invokes LIB.Lash.contactForce in
//        unilateral mode (F = 0 inside |ψ|<H, one-sided spring + damper at
//        the boundary). state.meshEngaged[i] is now a derived label written
//        for readouts, not an input.
//
//        contactDxdt also writes per-wheel net torque into
//        state.wheels[i].lastTau as a side effect, so postStep / readouts
//        can show it without recomputing.
//
//  Constants
//  ---------
//    LIB.WheelChain.K_RIGID = 2.0e5
//    LIB.WheelChain.C_RIGID = 1.0e3
//
//  Dependencies: lib/lash.js (contact-spring force).
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});
  if (!LIB.Lash) throw new Error("LIB.WheelChain requires lib/lash.js");

  const K_RIGID = 2.0e5;
  const C_RIGID = 1.0e3;
  // Default mass picked so the legacy default J=0.05 falls out of
  // J = ½·m·r² at r=0.5 m. Mass is the first-class field; J is derived.
  const WHEEL_DEFAULTS = { r: 0.5, r1: 0.5, r2: 0.5, m: 0.4, J: 0.05 };

  // Solid-disc inertia. The whole repo treats wheels (gears, pulleys, motor
  // rotors) as solid discs — couples r and m so a slider on either updates J,
  // which the rest of the chain math reads. For compound wheels (r1, r2) we
  // use max(r, r1, r2) as the effective inertial radius — conservative upper
  // bound that matches the visual mass of a stepped pulley.
  function massToJ(r, m) { return 0.5 * (+m || 0) * (+r || 0) * (+r || 0); }
  function recomputeJ(w) {
    if (!w) return;
    const r = Math.max(+w.r || 0, +w.r1 || 0, +w.r2 || 0);
    w.J = 0.5 * (+w.m || 0) * r * r;
  }

  // ---------------------------------------------------------------------------
  //  Layout / kinematics (operate on a wheels-array — unchanged from before)
  // ---------------------------------------------------------------------------

  function isCompound(mode, i) {
    return (mode === "compound" || mode === "belt") && i > 0;
  }
  function leftR(w, mode, i)  { return isCompound(mode, i) ? w.r1 : w.r; }
  function rightR(w, mode, i) { return isCompound(mode, i) ? w.r2 : w.r; }
  function outerR(w, mode, i) {
    return isCompound(mode, i) ? Math.max(w.r1, w.r2) : w.r;
  }
  function meshSign(mode) { return (mode === "belt") ? -1 : +1; }

  function pairRatio(wheels, i, mode) {
    if (i >= wheels.length - 1) return 0;
    const a = rightR(wheels[i],     mode, i);
    const b = leftR (wheels[i + 1], mode, i + 1);
    const sign = (mode === "belt") ? +1 : -1;
    return sign * a / Math.max(1e-6, b);
  }

  function cumRatios(wheels, mode) {
    const R = new Array(wheels.length);
    R[0] = 1;
    for (let i = 0; i < wheels.length - 1; i++) {
      R[i + 1] = R[i] * pairRatio(wheels, i, mode);
    }
    return R;
  }

  function reflectedJ(wheels, mode) {
    const R = cumRatios(wheels, mode);
    let J = 0;
    for (let i = 0; i < wheels.length; i++) J += wheels[i].J * R[i] * R[i];
    return J;
  }

  function reflectedDrag(wheels, mode, c) {
    const R = cumRatios(wheels, mode);
    let cT = 0;
    for (let i = 0; i < wheels.length; i++) cT += c * R[i] * R[i];
    return cT;
  }

  function layoutCenters(wheels, mode, beltGap) {
    const out = [];
    const gap = +beltGap || 0;
    for (let i = 0; i < wheels.length; i++) {
      let x;
      if (i === 0) {
        x = (mode === "belt") ? outerR(wheels[0], mode, 0)
                              : leftR (wheels[0], mode, 0);
      } else if (mode === "belt") {
        x = out[i - 1].cx + outerR(wheels[i - 1], mode, i - 1)
                          + gap
                          + outerR(wheels[i],     mode, i);
      } else {
        x = out[i - 1].cx + rightR(wheels[i - 1], mode, i - 1)
                          + leftR (wheels[i],     mode, i);
      }
      out.push({ cx: x, cy: 0 });
    }
    return out;
  }

  function computeDrawOrder(wheels, mode) {
    const N = wheels.length;
    const depth = new Array(N).fill(0);
    for (let iter = 0; iter < N; iter++) {
      let changed = false;
      for (let m = 0; m < N - 1; m++) {
        const aRight = rightR(wheels[m],     mode, m);
        const aOuter = outerR(wheels[m],     mode, m);
        const bLeft  = leftR (wheels[m + 1], mode, m + 1);
        const bOuter = outerR(wheels[m + 1], mode, m + 1);
        if (bOuter > bLeft + 1e-9 && depth[m] <= depth[m + 1]) {
          depth[m] = depth[m + 1] + 1;
          changed = true;
        }
        if (aOuter > aRight + 1e-9 && depth[m + 1] <= depth[m]) {
          depth[m + 1] = depth[m] + 1;
          changed = true;
        }
      }
      if (!changed) break;
    }
    const order = wheels.map((_, i) => i);
    order.sort((i, j) => depth[i] - depth[j]);
    return order;
  }

  // ---------------------------------------------------------------------------
  //  State factory + add/remove
  //
  //  state.wheels[i] are proxies that read/write the flat DOF keys on `state`
  //  (state.theta_0, state.omega_0, …). Renderers and sliders use the proxy
  //  fields; the integrator and physics callbacks read the flat keys directly
  //  (so rk4's Object.assign-clone scratch state would still work — though in
  //  practice we use implicitEuler exclusively here).
  // ---------------------------------------------------------------------------

  function makeWheelView(state, i, init) {
    const w = {
      r:  init && init.r  != null ? +init.r  : WHEEL_DEFAULTS.r,
      r1: init && init.r1 != null ? +init.r1 : WHEEL_DEFAULTS.r1,
      r2: init && init.r2 != null ? +init.r2 : WHEEL_DEFAULTS.r2,
      m:  0,
      J:  0,
      lastTau: 0,
    };
    // Mass is the primary field and J is derived. Back-compat: callers that
    // still pass `J` get their mass back-derived (so a slider on r alone keeps
    // m fixed and recomputes J).
    if (init && init.m != null) {
      w.m = +init.m;
      w.J = massToJ(w.r, w.m);
    } else if (init && init.J != null) {
      w.J = +init.J;
      w.m = 2 * w.J / Math.max(1e-9, w.r * w.r);
    } else {
      w.m = WHEEL_DEFAULTS.m;
      w.J = massToJ(w.r, w.m);
    }
    Object.defineProperty(w, "theta", {
      get() { return state[`theta_${i}`]; },
      set(v) { state[`theta_${i}`] = v; },
      enumerable: true, configurable: true,
    });
    Object.defineProperty(w, "omega", {
      get() { return state[`omega_${i}`]; },
      set(v) { state[`omega_${i}`] = v; },
      enumerable: true, configurable: true,
    });
    return w;
  }

  function makeState(N, opts) {
    opts = opts || {};
    const defaults = opts.defaults || (() => ({}));
    const state = {
      N: 0,
      wheels: [],
      meshEngaged: [],
      meshPsiOffset: [],
      drag: null,
      lastT: 0,
      t: 0,
    };
    for (let i = 0; i < N; i++) {
      addWheel(state, opts.mode || "simple", defaults(i));
    }
    return state;
  }

  function addWheel(state, mode, init) {
    const i = state.N;
    state[`theta_${i}`] = (init && init.theta != null) ? +init.theta : 0;
    state[`omega_${i}`] = (init && init.omega != null) ? +init.omega : 0;
    state.wheels.push(makeWheelView(state, i, init));
    state.N++;
    if (i > 0) {
      // Latch ψ_offset for the new mesh so it's born at ψ=0.
      state.meshEngaged.push(0);
      state.meshPsiOffset.push(0);
      state.meshPsiOffset[i - 1] = currentMeshPsiRaw(state, mode, i - 1);
    }
  }

  function removeLast(state, _mode) {
    if (state.N <= 0) return;
    const i = state.N - 1;
    delete state[`theta_${i}`];
    delete state[`omega_${i}`];
    state.wheels.pop();
    if (i > 0) {
      state.meshEngaged.pop();
      state.meshPsiOffset.pop();
    }
    state.N--;
  }

  function dof(state) {
    const out = [];
    for (let i = 0; i < state.N; i++) {
      out.push(`theta_${i}`, `omega_${i}`);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  //  Mesh ψ / ψ̇ + offset latching
  // ---------------------------------------------------------------------------

  function currentMeshPsiRaw(state, mode, i) {
    // ψ before subtracting offset — used by recomputePsiOffsets / addWheel.
    const wA = state.wheels[i];
    const wB = state.wheels[i + 1];
    if (!wA || !wB) return 0;
    const rA = rightR(wA, mode, i);
    const rB = leftR (wB, mode, i + 1);
    const ms = meshSign(mode);
    return rA * state[`theta_${i}`] + ms * rB * state[`theta_${i + 1}`];
  }

  function meshPsi(state, mode, i) {
    const offset = (state.meshPsiOffset && state.meshPsiOffset[i]) || 0;
    return currentMeshPsiRaw(state, mode, i) - offset;
  }
  function meshPsiDot(state, mode, i) {
    const wA = state.wheels[i];
    const wB = state.wheels[i + 1];
    if (!wA || !wB) return 0;
    const rA = rightR(wA, mode, i);
    const rB = leftR (wB, mode, i + 1);
    const ms = meshSign(mode);
    return rA * state[`omega_${i}`] + ms * rB * state[`omega_${i + 1}`];
  }
  function recomputePsiOffsets(state, mode) {
    const N = state.N;
    state.meshPsiOffset.length = Math.max(0, N - 1);
    for (let i = 0; i < N - 1; i++) {
      state.meshPsiOffset[i] = currentMeshPsiRaw(state, mode, i);
    }
  }

  // ---------------------------------------------------------------------------
  //  contactDxdt — viscous + contact + (optional) drive contributions.
  //
  //  Reads flat DOF keys (state.theta_i / state.omega_i), so this is safe to
  //  call from inside an integrator that builds a scratch-state clone.
  //  Writes per-wheel net torque to state.wheels[i].lastTau as a side effect
  //  so readouts can pick it up without recomputing.
  // ---------------------------------------------------------------------------

  function contactDxdt(state, params, t, opts) {
    const N    = state.N;
    const mode = opts.mode || "simple";
    const c    = +opts.c    || 0;
    const K    = (opts.meshK != null) ? +opts.meshK : K_RIGID;
    const C    = (opts.meshC != null) ? +opts.meshC : C_RIGID;
    const H    = +opts.meshH || 0;
    const drive = (typeof opts.drive === "function") ? +opts.drive(state, params) || 0 : 0;
    const extra = (typeof opts.extraTorque === "function") ? opts.extraTorque : null;
    const out = {};

    // Position derivatives.
    for (let i = 0; i < N; i++) out[`theta_${i}`] = state[`omega_${i}`];

    // Per-wheel net torque, accumulated.
    const tau = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      tau[i] -= c * state[`omega_${i}`];
      if (extra) tau[i] += +extra(state, params, i) || 0;
    }
    if (N > 0) tau[0] += drive;

    // Mesh contacts (unilateral when H > 0, bilateral rigid mesh when H = 0).
    for (let i = 0; i < N - 1; i++) {
      const psi    = meshPsi(state, mode, i);
      const psiDot = meshPsiDot(state, mode, i);
      const F = LIB.Lash.contactForce(psi, psiDot, H, K, C);
      if (state.meshEngaged) {
        state.meshEngaged[i] = LIB.Lash.engagementOf(psi, H);
      }
      const wA = state.wheels[i];
      const wB = state.wheels[i + 1];
      const rA = rightR(wA, mode, i);
      const rB = leftR (wB, mode, i + 1);
      const ms = meshSign(mode);
      tau[i]     +=      rA * F;
      tau[i + 1] += ms * rB * F;
    }

    // Velocity derivatives + side-effect lastTau.
    for (let i = 0; i < N; i++) {
      const Ji = Math.max(1e-9, state.wheels[i].J);
      state.wheels[i].lastTau = tau[i];
      out[`omega_${i}`] = tau[i] / Ji;
    }
    return out;
  }

  function contactJacobian(state, params, t, opts) {
    const N = state.N;
    const n = 2 * N;
    const M = new Float64Array(n * n);
    const mode = opts.mode || "simple";
    const c    = +opts.c    || 0;
    const K    = (opts.meshK != null) ? +opts.meshK : K_RIGID;
    const C    = (opts.meshC != null) ? +opts.meshC : C_RIGID;
    const H    = +opts.meshH || 0;

    // Index helpers — DOF order = [θ_0, ω_0, θ_1, ω_1, …].
    const ti = (i) => 2 * i;
    const wi = (i) => 2 * i + 1;

    // d(θ_i)/d(ω_i) = 1.
    for (let i = 0; i < N; i++) M[ti(i) * n + wi(i)] = 1;

    // Viscous on ω_i.
    for (let i = 0; i < N; i++) {
      const Ji = Math.max(1e-9, state.wheels[i].J);
      M[wi(i) * n + wi(i)] += -c / Ji;
    }

    // Contact contributions per mesh in compression (|ψ| > H, or always when H=0).
    for (let i = 0; i < N - 1; i++) {
      if (H > 1e-9) {
        const psi = meshPsi(state, mode, i);
        if (psi <= H && psi >= -H) continue;
      }
      const wA = state.wheels[i];
      const wB = state.wheels[i + 1];
      const rA = rightR(wA, mode, i);
      const rB = leftR (wB, mode, i + 1);
      const ms = meshSign(mode);
      const Ja = Math.max(1e-9, wA.J);
      const Jb = Math.max(1e-9, wB.J);
      // F = -K(rA·θA + ms·rB·θB - target) - C(rA·ωA + ms·rB·ωB).
      // τ_A = rA · F  →  ∂τ_A/∂θ_A = -K·rA²,  ∂τ_A/∂θ_B = -K·rA·ms·rB, etc.
      // τ_B = ms·rB · F → ∂τ_B/∂θ_A = -K·ms·rB·rA, ∂τ_B/∂θ_B = -K·rB² (ms²=1).
      M[wi(i)     * n + ti(i)    ] += -K * rA * rA       / Ja;
      M[wi(i)     * n + ti(i + 1)] += -K * rA * ms * rB  / Ja;
      M[wi(i)     * n + wi(i)    ] += -C * rA * rA       / Ja;
      M[wi(i)     * n + wi(i + 1)] += -C * rA * ms * rB  / Ja;
      M[wi(i + 1) * n + ti(i)    ] += -K * ms * rB * rA  / Jb;
      M[wi(i + 1) * n + ti(i + 1)] += -K * rB * rB       / Jb;
      M[wi(i + 1) * n + wi(i)    ] += -C * ms * rB * rA  / Jb;
      M[wi(i + 1) * n + wi(i + 1)] += -C * rB * rB       / Jb;
    }

    return M;
  }

  // ---------------------------------------------------------------------------
  //  Public surface
  // ---------------------------------------------------------------------------

  LIB.WheelChain = {
    K_RIGID, C_RIGID, WHEEL_DEFAULTS,
    massToJ, recomputeJ,
    isCompound, leftR, rightR, outerR, meshSign,
    pairRatio, cumRatios, reflectedJ, reflectedDrag,
    layoutCenters, computeDrawOrder,
    makeState, addWheel, removeLast, dof,
    meshPsi, meshPsiDot, recomputePsiOffsets,
    contactDxdt, contactJacobian,
  };
})();
