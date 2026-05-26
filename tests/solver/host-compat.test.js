"use strict";

// First install globalThis.window and load lib/fea-solver.js via the shim.
const LIB = require("./_shim.js");

const { test }   = require("node:test");
const assert     = require("node:assert/strict");
const { buildSmallSPD, assertClose, readWasmBinary } = require("./_fixtures.js");

// ---- tests -----------------------------------------------------------------

test("loads from an in-memory ArrayBuffer with no fetch/streaming/worker", async () => {
  // Re-set the cached init promise so this test controls the init path.
  // We reach into the module's closure by resetting through a fresh require
  // of fea-solver.js is not possible (it's cached). Instead we call init()
  // with opts.wasmBinary — fea-solver.js uses wasmBinary verbatim and skips
  // all fetch/fs logic. The module-level promise is already set from _shim.js
  // loading, but init() is idempotent and returns the same promise, so we
  // need a fresh LIB.FeaSolver. We achieve this by testing the ArrayBuffer
  // path through the solver we already have: the key assertion is that fetch
  // and instantiateStreaming were never called during any part of the load.
  //
  // Strategy: stub fetch + instantiateStreaming to throw BEFORE the first
  // init() call. We do this by deleting the module cache for fea-solver.js
  // and reloading in a sub-scope — but that is fragile. Instead we verify
  // the contract that the existing loaded solver (via _shim.js) never used
  // fetch or streaming, and separately verify that init({wasmBinary}) works
  // without fetch/streaming by building a second isolated FeaSolver object
  // from scratch with stubs active.
  //
  // Per spec: "temporarily replace globalThis.fetch and
  // WebAssembly.instantiateStreaming with stubs that throw, and assert
  // globalThis.Worker is not invoked; call
  // LIB.FeaSolver.init({ wasmBinary: readWasmBinary() });
  // then run a buildSmallSPD() solve."
  //
  // The init() in fea-solver.js is idempotent (returns cached promise after
  // the first call). To exercise a fresh load path under stubs we use the
  // module registry approach: delete the require cache entry and re-require
  // so the IIFE runs again with a fresh _initPromise = null.

  // Delete cached modules so we get a fresh LIB.FeaSolver instance.
  const feaSolverPath = require("path").resolve(__dirname, "../../lib/fea-solver.js");
  delete require.cache[feaSolverPath];

  // Also reset the shim's window.LIB for this sub-test.
  const savedLIB = globalThis.window.LIB;
  globalThis.window.LIB = {};

  // Install stubs that throw if called.
  const savedFetch = globalThis.fetch;
  const savedStreaming = WebAssembly.instantiateStreaming;
  let workerInvoked = false;
  const savedWorker = globalThis.Worker;

  globalThis.fetch = function stubFetch() {
    throw new Error("host-compat: fetch must not be called on the non-streaming path");
  };
  WebAssembly.instantiateStreaming = function stubStreaming() {
    throw new Error("host-compat: instantiateStreaming must not be called on the ArrayBuffer path");
  };
  globalThis.Worker = function StubWorker() {
    workerInvoked = true;
    throw new Error("host-compat: Worker must not be constructed");
  };

  try {
    // Re-load fea-solver.js with stubs active so any code path that calls
    // fetch or instantiateStreaming during init() would fail.
    require(feaSolverPath);
    const FS = globalThis.window.LIB.FeaSolver;

    // init() with explicit wasmBinary — bypasses all fetch/fs logic.
    await FS.init({ wasmBinary: readWasmBinary() });

    // Run a solve to confirm the solver works on this load path.
    const fix = buildSmallSPD();
    const n   = fix.b.length;
    const s   = FS.create();
    s.setPattern(n, fix.I, fix.J);
    s.setValues(fix.V);
    s.analyze();
    s.factorize();
    const x = s.solve(fix.b);
    s.destroy();

    for (let i = 0; i < n; i++) {
      assertClose(x[i], fix.xExact[i], 1e-10,
        `ArrayBuffer-path solve x[${i}]`);
    }

    assert.ok(!workerInvoked, "Worker must not have been constructed");
  } finally {
    // Restore everything.
    if (savedFetch !== undefined) {
      globalThis.fetch = savedFetch;
    } else {
      delete globalThis.fetch;
    }
    WebAssembly.instantiateStreaming = savedStreaming;
    if (savedWorker !== undefined) {
      globalThis.Worker = savedWorker;
    } else {
      delete globalThis.Worker;
    }
    // Restore the original fea-solver.js in require cache and window.LIB.
    globalThis.window.LIB = savedLIB;
    delete require.cache[feaSolverPath];
    require(feaSolverPath);
  }
});

test("init is idempotent", async () => {
  // The main LIB.FeaSolver (from _shim.js) should already be initialised.
  // Calling init() again must return the same module promise and not
  // re-instantiate the WASM.
  const FS = LIB.FeaSolver;

  const p1 = FS.init();
  const p2 = FS.init();
  assert.strictEqual(p1, p2, "init() must return the same Promise on repeated calls");

  await p1;
  await p2;

  // create() must still work after redundant init() calls.
  const fix = buildSmallSPD();
  const n   = fix.b.length;
  const s   = FS.create();
  s.setPattern(n, fix.I, fix.J);
  s.setValues(fix.V);
  s.analyze();
  s.factorize();
  const x = s.solve(fix.b);
  s.destroy();

  for (let i = 0; i < n; i++) {
    assertClose(x[i], fix.xExact[i], 1e-10,
      `idempotent-init solve x[${i}]`);
  }
});
