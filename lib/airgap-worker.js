"use strict";

// =============================================================================
//  LIB.AirgapWorker — Web Worker harness for the refined field-solve tier
//
//  Pure core (testable headless):
//    LIB.AirgapWorker.selectBackend(backendOpts) → SolveBackend
//    LIB.AirgapWorker.compute(request) → response
//    LIB.AirgapWorker.createSession(request) → session
//
//  Worker bootstrap (only when running inside a Worker context):
//    Loads lib/ dependencies via importScripts, then installs self.onmessage.
//
//  Imports only lib/ modules — never app-layer modules.
//  Reads no element letter, machine name, or machine-type field.
//  The main thread expands the config before posting — the worker receives
//  already-expanded plain data.
// =============================================================================

(function () {
  // ---------------------------------------------------------------------------
  //  Worker-context detection
  //  A Worker has no window; self.importScripts is the discriminator.
  // ---------------------------------------------------------------------------
  const inWorker = (typeof self !== "undefined" && typeof self.importScripts === "function");

  if (inWorker) {
    // Make lib/ IIFEs resolve window.LIB inside the worker.
    self.window = self;

    // Load all required lib/ modules relative to this file's location.
    self.importScripts(
      "util.js",
      "integrate.js",
      "airgap-grid.js",
      "airgap-solve.js",
      "airgap-torque.js",
      "motor-compile.js",
      "excitation.js",
      "motor-circuit.js",
      "motor-slice.js",
      "motor-stack.js",
      "motor-run.js",
      "airgap-refine.js"
    );

    // Phase-9 nonlinear tier — guarded: absent until Phase 9 ships.
    try {
      self.importScripts("airgap-nonlinear.js");
    } catch (e) {
      // nonlinear tier unavailable until Phase 9 is built
    }
  }

  // Resolve LIB — works both on the main thread (window.LIB) and in a worker
  // (self.LIB after self.window = self above).
  const LIB = (typeof window !== "undefined" && window.LIB) || (typeof self !== "undefined" && self.LIB);

  // ---------------------------------------------------------------------------
  //  selectBackend(backendOpts = {}) → SolveBackend
  //
  //  Tier selector. Default (undefined / "refined") → refined backend.
  //  "nonlinear" → LIB.AirgapNonlinear.backend (Phase 9; throws if absent).
  // ---------------------------------------------------------------------------
  function selectBackend(backendOpts) {
    backendOpts = backendOpts || {};
    if (backendOpts.tier === "nonlinear") {
      if (!LIB.AirgapNonlinear) {
        throw new Error("AirgapWorker: nonlinear backend not loaded (airgap-nonlinear.js absent)");
      }
      return LIB.AirgapNonlinear.backend(backendOpts);
    }
    return LIB.AirgapRefine.backend(backendOpts);
  }

  // ---------------------------------------------------------------------------
  //  compute(request) → response
  //
  //  Pure dispatch — no side effects on module state.
  //
  //  request.kind === "sweep":
  //    { kind, expanded, currents: number[], thetas: number[], backendOpts? }
  //    → { kind:"sweepResult", thetas: number[], torques: number[] }
  //
  //  request.kind === "fieldMap":
  //    { kind, expanded, theta: number, currents: number[], sliceIndex?,
  //      backendOpts? }
  //    → { kind:"fieldMap", theta, Br: number[], Bt: number[],
  //        grid: { Nr, Ntheta, r: number[], rInner, rOuter } }
  // ---------------------------------------------------------------------------
  function compute(request) {
    if (request.kind === "sweep") {
      const stack = LIB.MotorStack.create(
        request.expanded,
        { backend: selectBackend(request.backendOpts || {}) }
      );
      const cur = Float64Array.from(request.currents);
      const torques = [];
      for (let k = 0; k < request.thetas.length; k++) {
        // Clear warm-start between theta steps to avoid cross-angle pollution.
        // The refined multigrid solver can diverge when warm-started from a
        // solution at a very different rotor angle; cold-start each theta ensures
        // finite, deterministic results that match the reference comparison.
        stack.clearWarmStart();
        torques.push(stack.solve(request.thetas[k], cur).torque);
      }
      return {
        kind: "sweepResult",
        thetas: Array.from(request.thetas),
        torques: torques,
      };
    }

    if (request.kind === "fieldMap") {
      const sliceIndex = request.sliceIndex != null ? request.sliceIndex : 0;
      const stack = LIB.MotorStack.create(
        request.expanded,
        { backend: selectBackend(request.backendOpts || {}) }
      );
      const cur = Float64Array.from(request.currents);
      const r = stack.solve(request.theta, cur);
      const f = r.perSliceField[sliceIndex];
      const g = stack.sliceGrid(sliceIndex);
      return {
        kind: "fieldMap",
        theta: request.theta,
        Br: Array.from(f.Br),
        Bt: Array.from(f.Bt),
        grid: {
          Nr: g.Nr,
          Ntheta: g.Ntheta,
          r: Array.from(g.r),
          rInner: g.rInner,
          rOuter: g.rOuter,
        },
      };
    }

    throw new Error("AirgapWorker.compute: unknown request.kind=" + request.kind);
  }

  // ---------------------------------------------------------------------------
  //  createSession(request) → session
  //
  //  request = {
  //    expanded:    object   (pre-expanded config),
  //    backendOpts: object   (optional; forwarded to selectBackend),
  //    stateSeed:   object   (optional; { theta, omega, t, stepIndex, i:[] }),
  //    binCount:    number   (optional; forwarded to MotorRun.create),
  //  }
  //
  //  Returns:
  //    session.runtime         — the LIB.MotorRun instance
  //    session.step(dt)        → lightweight frame { kind:"frame", state, torque }
  //    session.snapshot()      → plain copy of runtime.state
  //    session.updateDrive({ circuits, mechanical }) → void
  //    session.fieldFrame(sliceIndex?) → { Br, Bt, grid }
  //    session.reset(stateSeed?) → void
  // ---------------------------------------------------------------------------
  function createSession(request) {
    const opts = { backend: selectBackend(request.backendOpts || {}) };
    if (request.binCount != null) opts.binCount = request.binCount;

    const runtime = LIB.MotorRun.create(request.expanded, opts);

    // Seed state from stateSeed if provided.
    if (request.stateSeed) {
      const seed = request.stateSeed;
      if (seed.theta != null)     runtime.state.theta     = seed.theta;
      if (seed.omega != null)     runtime.state.omega     = seed.omega;
      if (seed.t != null)         runtime.state.t         = seed.t;
      if (seed.stepIndex != null) runtime.state.stepIndex = seed.stepIndex;
      if (seed.i != null) {
        runtime.state.i = Float64Array.from(seed.i);
      }
    }

    // ---- session.snapshot() ----
    function snapshot() {
      return {
        theta:     runtime.state.theta,
        omega:     runtime.state.omega,
        t:         runtime.state.t,
        stepIndex: runtime.state.stepIndex,
        i:         Array.from(runtime.state.i),
      };
    }

    // ---- session.step(dt) → frame ----
    function step(dt) {
      runtime.step(dt);
      return {
        kind:   "frame",
        state:  snapshot(),
        torque: runtime.lastSolve ? runtime.lastSolve.torque : 0,
      };
    }

    // ---- session.updateDrive({ circuits, mechanical }) ----
    function updateDrive(msg) {
      if (msg.circuits) {
        const src = msg.circuits;
        for (let k = 0; k < src.length && k < runtime.circuits.length; k++) {
          const s = src[k];
          const d = runtime.circuits[k];
          if (s.terminal != null)    d.terminal    = s.terminal;
          if (s.commutation != null) d.commutation = s.commutation;
          if (s.R != null)           d.R           = s.R;
        }
      }
      if (msg.mechanical) {
        const s = msg.mechanical;
        const d = runtime.mechanical;
        if (s.J != null)           d.J           = s.J;
        if (s.damping != null)     d.damping     = s.damping;
        if (s.loadTorque != null)  d.loadTorque  = s.loadTorque;
      }
    }

    // ---- session.fieldFrame(sliceIndex = 0) ----
    function fieldFrame(sliceIndex) {
      sliceIndex = sliceIndex != null ? sliceIndex : 0;
      const ls = runtime.lastSolve;
      if (!ls) return null;
      const f = ls.perSliceField[sliceIndex];
      const g = runtime.stack.sliceGrid(sliceIndex);
      return {
        Br:   Array.from(f.Br),
        Bt:   Array.from(f.Bt),
        grid: {
          Nr:     g.Nr,
          Ntheta: g.Ntheta,
          r:      Array.from(g.r),
          rInner: g.rInner,
          rOuter: g.rOuter,
        },
      };
    }

    // ---- session.reset(stateSeed = null) ----
    function reset(stateSeed) {
      runtime.reset();
      if (stateSeed) {
        if (stateSeed.theta != null)     runtime.state.theta     = stateSeed.theta;
        if (stateSeed.omega != null)     runtime.state.omega     = stateSeed.omega;
        if (stateSeed.t != null)         runtime.state.t         = stateSeed.t;
        if (stateSeed.stepIndex != null) runtime.state.stepIndex = stateSeed.stepIndex;
        if (stateSeed.i != null) {
          runtime.state.i = Float64Array.from(stateSeed.i);
        }
      }
    }

    return {
      runtime:     runtime,
      step:        step,
      snapshot:    snapshot,
      updateDrive: updateDrive,
      fieldFrame:  fieldFrame,
      reset:       reset,
    };
  }

  // ---------------------------------------------------------------------------
  //  Worker bootstrap — only installed when running inside a Worker.
  //
  //  Module-scoped session + running flag + post counter.
  //  self.onmessage dispatches: start, updateDrive, sweep, stop, reset.
  // ---------------------------------------------------------------------------
  if (inWorker) {
    let session = null;
    let running = false;
    let postCount = 0;

    function tick(dt, stepsPerMessage) {
      if (!running) return;

      for (let n = 0; n < stepsPerMessage; n++) {
        session.step(dt);
      }

      const frame = {
        kind:  "frame",
        state: session.snapshot(),
        torque: session.runtime.lastSolve ? session.runtime.lastSolve.torque : 0,
      };

      // Attach field on every stepsPerMessage-th post (first post always included).
      if (postCount % stepsPerMessage === 0) {
        frame.field = session.fieldFrame(0);
      }
      postCount++;

      self.postMessage(frame);

      setTimeout(function () { tick(dt, stepsPerMessage); }, 0);
    }

    self.onmessage = function (e) {
      const msg = e.data;

      if (msg.kind === "start") {
        session = createSession(msg);
        running = true;
        postCount = 0;
        const dt = msg.dt != null ? msg.dt : 1 / 240;
        const stepsPerMessage = msg.stepsPerMessage != null ? msg.stepsPerMessage : 4;
        setTimeout(function () { tick(dt, stepsPerMessage); }, 0);

      } else if (msg.kind === "updateDrive") {
        if (session) session.updateDrive(msg);

      } else if (msg.kind === "sweep") {
        self.postMessage(compute(msg));

      } else if (msg.kind === "stop") {
        running = false;

      } else if (msg.kind === "reset") {
        if (session) {
          session.reset(msg.stateSeed != null ? msg.stateSeed : null);
          postCount = 0;
        }
      }
    };
  }

  // Attach to LIB — resolve again now that worker scripts have run.
  const LIB_OUT = (typeof window !== "undefined" && window.LIB) || (typeof self !== "undefined" && self.LIB) || LIB;

  LIB_OUT.AirgapWorker = {
    selectBackend:  selectBackend,
    compute:        compute,
    createSession:  createSession,
  };
})();
