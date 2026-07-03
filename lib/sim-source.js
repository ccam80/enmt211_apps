"use strict";

// =============================================================================
//  LIB.SimSource — the seam between the render/UI thread and the numeric sim.
//
//  The unified-motor runtime (LIB.MotorRun) is the heavy numeric core: one
//  time-step is an atomic 20-50 ms field-circuit-motion Newton solve. Running
//  it on the render thread hitches the animation, so it lives behind a SimSource
//  the UI drives with COMMANDS and reads back as a stream of SNAPSHOTS +
//  one-per-epoch static GEOMETRY (see WORKER-SPEC).
//
//  Two implementations share one contract:
//    createInline(deps) — runs MotorRun in-process. The path every node test
//                         drives (node has no Worker) and the file:// fallback.
//    createWorker(deps) — runs MotorRun in a Web Worker (added alongside
//                         sim-worker.js); same contract, off the render thread.
//
//  Contract:
//    src.post(cmd)            — command down (see COMMANDS below)
//    src.onSnapshot(cb)       — cb(snapshot) per solve (WORKER-SPEC §5 shape)
//    src.onGeometry(cb)       — cb(geometry) once per epoch (§4 shape)
//    src.dispose()            — tear down
//
//  COMMANDS (main → sim):
//    { type:"init",       config }          build runtime; ship geometry + seed
//    { type:"rebuild",    config }          bump epoch; rebuild; ship geometry + seed
//    { type:"reset" }                       runtime.reset(); ship seed at t=0
//    { type:"mechanical", loadTorque?, damping? }
//    { type:"drive",      amp?, freq? }     apply to every circuit terminal
//    { type:"pace",       simClock, leadCap, paused, budgetMs? }
//                                           free-run the solver up to
//                                           simClock+leadCap, one snapshot/solve
//
//  The `behind` / achieved-rate signal is derived main-side from the snapshot
//  stream (LIB.Snapshot.resolveShowTime), so the contract needs no status
//  channel.
// =============================================================================

(function () {
  const LIB = (typeof window !== "undefined" ? window : globalThis).LIB ||
    ((typeof window !== "undefined" ? window : globalThis).LIB = {});

  const nowMs = function () {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  };

  // Deep-copy a solve bundle's dynamic arrays into a self-owned snapshot. The
  // runtime overwrites state.i in place each step and the field bundle aliases
  // reused scratch buffers (motor-run.js / motor-slice.js), so a snapshot that
  // held references would be corrupted by the next solve — it must own copies.
  function makeSnapshot(epoch, state, bundle, nSlices, nCircuits) {
    const snap = {
      epoch: epoch,
      t: state.t,
      theta: state.theta,
      omega: state.omega,
      i: Float64Array.from(state.i),
      torque: bundle ? bundle.torque : 0,
      fluxLinkages: bundle ? Float64Array.from(bundle.fluxLinkages) : new Float64Array(nCircuits),
      slices: new Array(nSlices),
    };
    for (let k = 0; k < nSlices; k++) {
      const f = bundle && bundle.perSliceField ? bundle.perSliceField[k] : null;
      snap.slices[k] = {
        AnodeR: Float64Array.from(f.rotor.Anode),
        BmagR:  Float64Array.from(f.rotor.Belem.mag),
        BxR:    Float64Array.from(f.rotor.Belem.Bx),
        ByR:    Float64Array.from(f.rotor.Belem.By),
        AnodeS: Float64Array.from(f.stator.Anode),
        BmagS:  Float64Array.from(f.stator.Belem.mag),
        BxS:    Float64Array.from(f.stator.Belem.Bx),
        ByS:    Float64Array.from(f.stator.Belem.By),
        gapPhi: f.gap.phi,
      };
    }
    return snap;
  }

  // ---------------------------------------------------------------------------
  //  Core sim engine — the command handler + snapshot/geometry emitters, shared
  //  by the inline source and (via importScripts) the worker adapter. `emit` is
  //  { geometry(msg), snapshot(msg) }; `deps` is { MotorRun, expand }.
  // ---------------------------------------------------------------------------
  function createEngine(deps, emit) {
    const MotorRun = deps.MotorRun;
    const expand = deps.expand;

    let runtime = null;
    let epoch = -1;
    let nSlices = 0, nCircuits = 0;
    let paused = false;

    // A cap on solves per pace: a runaway backstop far above any real frame's
    // solve count, so a bad `target` can't spin forever.
    const MAX_SOLVES_PER_PACE = 1000;

    function shipGeometry() {
      const slices = new Array(nSlices);
      for (let k = 0; k < nSlices; k++) {
        const m = runtime.stack.sliceMesh(k);
        slices[k] = { rotor: m.rotor, stator: m.stator };
      }
      emit.geometry({ type: "geometry", epoch: epoch, nCircuits: nCircuits, nSlices: nSlices, slices: slices });
    }

    // Seed snapshot at the current (unadvanced) state: a static field solve at
    // (theta, i) so the paused/initial view has a real field before the first
    // step — matching the field the app shows on its first rendered frame.
    function shipSeed() {
      const bundle = runtime.stack.solve(runtime.state.theta, runtime.state.i);
      emit.snapshot(makeSnapshot(epoch, runtime.state, bundle, nSlices, nCircuits));
    }

    function build(config) {
      const expanded = expand(config);
      runtime = MotorRun.create(expanded);
      nSlices = expanded.slices.length;
      nCircuits = expanded.nCircuits;
      shipGeometry();
      shipSeed();
    }

    function pace(cmd) {
      paused = !!cmd.paused;
      if (paused || !runtime) return;
      const target = cmd.simClock + cmd.leadCap;
      const budget = cmd.budgetMs;
      const wallStart = budget != null ? nowMs() : 0;
      let guard = 0;
      while (runtime.state.t < target - 1e-15 && guard++ < MAX_SOLVES_PER_PACE) {
        runtime.step(target - runtime.state.t, budget);
        emit.snapshot(makeSnapshot(epoch, runtime.state, runtime.lastSolve, nSlices, nCircuits));
        if (budget != null && nowMs() - wallStart >= budget) break;
      }
    }

    function handle(cmd) {
      switch (cmd.type) {
        case "init":
          epoch = 0;
          build(cmd.config);
          break;
        case "rebuild":
          epoch += 1;
          build(cmd.config);
          break;
        case "reset":
          if (!runtime) break;
          runtime.reset();
          shipSeed();
          break;
        case "mechanical":
          if (!runtime) break;
          if (cmd.loadTorque != null) runtime.mechanical.loadTorque = cmd.loadTorque;
          if (cmd.damping != null) runtime.mechanical.damping = cmd.damping;
          break;
        case "drive":
          if (!runtime) break;
          for (const c of runtime.circuits) {
            if (cmd.amp != null) c.terminal.amp = cmd.amp;
            if (cmd.freq != null) c.terminal.freq = cmd.freq;
          }
          break;
        case "pace":
          pace(cmd);
          break;
        default:
          throw new Error("SimSource: unknown command " + (cmd && cmd.type));
      }
    }

    return { handle: handle };
  }

  // ---------------------------------------------------------------------------
  //  createInline(deps) — in-process SimSource. Commands run synchronously and
  //  fire callbacks inline, so by the time post() returns the buffer is current.
  // ---------------------------------------------------------------------------
  function createInline(deps) {
    const snapCbs = [];
    const geomCbs = [];
    const emit = {
      geometry: function (msg) { for (const cb of geomCbs) cb(msg); },
      snapshot: function (msg) { for (const cb of snapCbs) cb(msg); },
    };
    const engine = createEngine(deps, emit);
    let disposed = false;
    return {
      post: function (cmd) { if (!disposed) engine.handle(cmd); },
      onSnapshot: function (cb) { snapCbs.push(cb); },
      onGeometry: function (cb) { geomCbs.push(cb); },
      dispose: function () { disposed = true; snapCbs.length = 0; geomCbs.length = 0; },
    };
  }

  // ---------------------------------------------------------------------------
  //  createWorker(opts) — SimSource backed by a Web Worker (sim-worker.js).
  //
  //  opts: { url, fallbackDeps, makeWorker?, readyTimeoutMs? }
  //    url            — worker script URL (new Worker(url))
  //    fallbackDeps   — { MotorRun, expand } for the in-process fallback
  //    makeWorker     — () => workerLike, injectable for tests; defaults to
  //                     new Worker(url). A workerLike has postMessage(msg),
  //                     an assignable onmessage/onerror, and terminate().
  //    readyTimeoutMs — fall back to in-process if the worker hasn't signalled
  //                     "ready" within this budget (default 8000).
  //
  //  The worker imports the numeric libs + FEA WASM asynchronously, so commands
  //  are queued until it posts { type:"ready" }, then flushed. If the worker
  //  fails to construct, errors, or never becomes ready, the source transparently
  //  becomes an in-process engine and REPLAYS the queued commands — the app keeps
  //  running (degraded to the single-thread solve) with no caller-visible change.
  // ---------------------------------------------------------------------------
  function createWorker(opts) {
    const snapCbs = [];
    const geomCbs = [];
    const emit = {
      geometry: function (msg) { for (const cb of geomCbs) cb(msg); },
      snapshot: function (msg) { for (const cb of snapCbs) cb(msg); },
    };

    let ready = false;
    let disposed = false;
    let fellBack = false;
    let inline = null;
    const queued = [];          // commands posted before "ready" (small: pre-first-frame)

    function fallBack(reason) {
      if (fellBack || disposed) return;
      fellBack = true;
      try { if (worker && worker.terminate) worker.terminate(); } catch (e) { /* ignore */ }
      inline = createInline(opts.fallbackDeps);
      inline.onGeometry(emit.geometry);
      inline.onSnapshot(emit.snapshot);
      for (const cmd of queued) inline.post(cmd);
      queued.length = 0;
      if (typeof console !== "undefined" && console.warn) {
        console.warn("SimSource: worker unavailable (" + reason + "); running in-process.");
      }
    }

    let worker = null;
    try {
      worker = (opts.makeWorker || function () { return new Worker(opts.url); })();
    } catch (e) {
      fallBack("construct failed: " + (e && e.message));
    }

    if (worker) {
      worker.onmessage = function (ev) {
        const msg = ev && ev.data;
        if (!msg || disposed || fellBack) return;
        if (msg.type === "ready") {
          ready = true;
          for (const cmd of queued) worker.postMessage(cmd);
          queued.length = 0;
        } else if (msg.type === "geometry") {
          emit.geometry(msg);
        } else if (msg.type === "snapshot") {
          emit.snapshot(msg);
        } else if (msg.type === "error") {
          fallBack("worker error: " + msg.message);
        }
      };
      worker.onerror = function (e) { fallBack("onerror: " + (e && e.message)); };
      const budget = opts.readyTimeoutMs != null ? opts.readyTimeoutMs : 8000;
      if (typeof setTimeout !== "undefined") {
        setTimeout(function () { if (!ready && !disposed && !fellBack) fallBack("ready timeout"); }, budget);
      }
    }

    return {
      post: function (cmd) {
        if (disposed) return;
        if (fellBack) { inline.post(cmd); return; }
        if (ready) worker.postMessage(cmd);
        else queued.push(cmd);
      },
      onSnapshot: function (cb) { snapCbs.push(cb); },
      onGeometry: function (cb) { geomCbs.push(cb); },
      dispose: function () {
        disposed = true;
        if (inline) inline.dispose();
        try { if (worker && worker.terminate) worker.terminate(); } catch (e) { /* ignore */ }
        snapCbs.length = 0; geomCbs.length = 0;
      },
    };
  }

  LIB.SimSource = {
    createInline: createInline,
    createWorker: createWorker,
    _createEngine: createEngine,   // exposed for the worker adapter + tests
    _makeSnapshot: makeSnapshot,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = LIB.SimSource;
})();
