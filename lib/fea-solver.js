// lib/fea-solver.js — classic <script src> attaching LIB.FeaSolver.
//
// Load path: non-streaming ArrayBuffer instantiation.
// Emscripten's factory receives the .wasm bytes via Module.wasmBinary so it
// calls WebAssembly.instantiate(arrayBuffer, ...) — never
// WebAssembly.instantiateStreaming. This makes the module:
//   - MIME-independent (Moodle pluginfile.php serves .wasm as
//     application/octet-stream, which streaming instantiation rejects).
//   - Same-origin, no Worker, no fetch dependency (when opts.wasmBinary
//     is supplied directly or Node reads the file via fs).
//
// Usage (browser):
//   <script src="../../lib/fea-solver.js"></script>
//   <script>
//     LIB.FeaSolver.init().then(() => {
//       const solver = LIB.FeaSolver.create();
//       solver.setPattern(n, I, J);
//       solver.setValues(V);
//       solver.analyze();
//       solver.factorize();
//       const x = solver.solve(b);
//       solver.destroy();
//     });
//   </script>
//
// Usage (Node test harness via tests/solver/_shim.js):
//   process.env.FEA_SOLVER_MJS_PATH = require("path").resolve(__dirname,
//     "../../lib/solver.mjs");
//   require("../../lib/fea-solver.js");
//   // window.LIB.FeaSolver is now available.

(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  // This script's own URL, captured at load time. While fea-solver.js runs as
  // a classic <script src>, document.currentScript refers to it, so .src is the
  // resolved engine URL. init() runs later from an inline boot <script> whose
  // currentScript has no src — reading it there would yield the bare specifier
  // "solver.mjs" and import() would reject it. Snapshot the base here instead.
  const _selfSrc = (typeof document !== "undefined" && document.currentScript)
    ? document.currentScript.src
    : "";

  // Module-level cached init promise — idempotent across multiple init() calls.
  let _initPromise = null;

  // The Emscripten Module object, set after init() resolves.
  let _M = null;

  // Resolve the path to solver.mjs. In a Node test harness the caller sets
  // process.env.FEA_SOLVER_MJS_PATH to the absolute path; in the browser
  // we use a path relative to this script's location.
  //
  // On Windows, Node's ESM dynamic import() requires file:// URLs for
  // absolute paths (drive-letter paths like "C:/..." are rejected with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME). We convert any absolute path that
  // starts with a drive letter to a proper file:// URL.
  function _toImportable(p) {
    // Already a URL scheme (file://, http://, ./relative, etc.) — use as-is.
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(p)) return p;
    // Windows absolute path: C:/... or C:\...
    if (/^[A-Za-z]:[\\/]/.test(p)) {
      return "file:///" + p.replace(/\\/g, "/");
    }
    return p;
  }

  function _mjsPath() {
    if (typeof process !== "undefined" && process.env && process.env.FEA_SOLVER_MJS_PATH) {
      return process.env.FEA_SOLVER_MJS_PATH;
    }
    // Browser: resolve relative to fea-solver.js's own URL, captured at load
    // time in _selfSrc (see its declaration above for why currentScript cannot
    // be read here — init() runs from an inline boot script with no src).
    if (_selfSrc) {
      const base = _selfSrc.replace(/\/[^/]+$/, "/");
      return base + "solver.mjs";
    }
    return "./solver.mjs";
  }

  // Obtain the .wasm bytes as an ArrayBuffer. Never uses streaming.
  // In the browser: fetch + arrayBuffer(). Under Node: fs.readFileSync.
  async function _readWasmBytes(mjsPath) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      // Node environment — read from disk.
      const fs   = require("fs");
      const path = require("path");
      // The wasm file lives next to solver.mjs.
      const wasmPath = mjsPath.replace(/\.mjs$/, ".wasm").replace(/^file:\/\//, "");
      return fs.readFileSync(wasmPath).buffer;
    }
    // Browser — fetch relative to solver.mjs location.
    const wasmUrl = mjsPath.replace(/\.mjs$/, ".wasm");
    const resp    = await fetch(wasmUrl, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("fea-solver: failed to fetch " + wasmUrl + " (" + resp.status + ")");
    return resp.arrayBuffer();
  }

  // Load the Emscripten ES-module glue and return its module namespace.
  // Node imports the file URL directly. The browser cannot: import() enforces a
  // JavaScript MIME type on the module response, but static hosts (the dev
  // server, Moodle's pluginfile.php) serve .mjs as text/plain or octet-stream.
  // So fetch the source and import it through a Blob URL tagged text/javascript
  // — MIME-independent, the same rationale as the wasmBinary path. solver.mjs
  // only reads import.meta.url to locate solver.wasm, which wasmBinary overrides,
  // so the blob: base is harmless.
  async function _importSolver(mjsPath) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      return import(_toImportable(mjsPath));
    }
    const resp = await fetch(mjsPath, { credentials: "same-origin" });
    if (!resp.ok) throw new Error("fea-solver: failed to fetch " + mjsPath + " (" + resp.status + ")");
    const src = await resp.text();
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    try {
      return await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  LIB.FeaSolver = {
    // init(opts?) → Promise<void>
    //
    // Loads and instantiates the WASM module once. Subsequent calls return the
    // same cached promise (idempotent). opts.wasmBinary (ArrayBuffer) bypasses
    // all fetch/fs logic and is passed directly to the Emscripten factory.
    init: function (opts) {
      if (_initPromise) return _initPromise;

      _initPromise = (async function () {
        const mjsPath = _mjsPath();

        // Load the Emscripten ES-module glue (MIME-independent in the browser,
        // direct file:// import under Node — see _importSolver).
        const mod = await _importSolver(mjsPath);
        const createSolver = mod.default || mod;

        // Obtain the wasm bytes as an ArrayBuffer (non-streaming path).
        const wasmBinary = (opts && opts.wasmBinary)
          ? opts.wasmBinary
          : await _readWasmBytes(mjsPath);

        // Pass wasmBinary to the factory so it instantiates from bytes (no
        // streaming). In the browser solver.mjs is imported from a Blob URL,
        // so its import.meta.url is a blob: URL that Emscripten's default
        // `new URL("solver.wasm", import.meta.url)` cannot resolve. Supplying
        // locateFile makes findWasmBinary return our sibling .wasm URL and never
        // touch import.meta.url; the bytes still come from wasmBinary regardless.
        const moduleArg = { wasmBinary: wasmBinary };
        if (!(typeof process !== "undefined" && process.versions && process.versions.node)) {
          moduleArg.locateFile = function (p) { return mjsPath.replace(/[^/]+$/, p); };
        }
        _M = await createSolver(moduleArg);
      })();

      return _initPromise;
    },

    // isInitialized() → boolean
    //
    // Synchronous read of the cached init-promise's resolved state. Returns
    // true iff init() has been called AND its promise has resolved (the WASM
    // module is loaded and create() is safe to call). Used by sync constructors
    // (e.g. LIB.MotorSlice.create) to enforce that the caller has awaited
    // init() before any solver-dependent construction.
    isInitialized: function () {
      return _M != null;
    },

    // create() → Solver
    //
    // Allocates a new solver instance. Throws if init() has not completed.
    create: function () {
      if (!_M) throw new Error("LIB.FeaSolver.create(): init() has not completed — await init() first.");

      const h = _M._create();

      // Per-instance reusable heap buffers. Grown on demand; freed in destroy().
      let _pI = 0, _capI = 0;  // Int32 pointer for row indices
      let _pJ = 0, _capJ = 0;  // Int32 pointer for col indices
      let _pV = 0, _capV = 0;  // Float64 pointer for values
      let _pB = 0, _capB = 0;  // Float64 pointer for rhs
      let _pX = 0, _capX = 0;  // Float64 pointer for solution

      let _n   = 0;  // matrix dimension from setPattern
      let _nnz = 0;  // triplet count from setPattern

      // Ensure an Int32 buffer of at least `count` elements.
      function _ensureI32(ptr, cap, count) {
        if (count <= cap) return { ptr, cap };
        if (ptr) _M._free(ptr);
        const p = _M._malloc(count * 4);
        if (!p) throw new Error("fea-solver: _malloc failed (Int32, " + count + " elements)");
        return { ptr: p, cap: count };
      }

      // Ensure a Float64 buffer of at least `count` elements.
      function _ensureF64(ptr, cap, count) {
        if (count <= cap) return { ptr, cap };
        if (ptr) _M._free(ptr);
        const p = _M._malloc(count * 8);
        if (!p) throw new Error("fea-solver: _malloc failed (Float64, " + count + " elements)");
        return { ptr: p, cap: count };
      }

      const solver = {
        // setPattern(n, I, J)
        // I, J: Int32Array of full-symmetric triplet coordinates.
        setPattern: function (n, I, J) {
          if (!(I instanceof Int32Array) || !(J instanceof Int32Array))
            throw new TypeError("fea-solver: setPattern expects Int32Array for I and J");
          const nnz = I.length;
          if (J.length !== nnz)
            throw new Error("fea-solver: setPattern: I and J must have the same length");

          _n   = n;
          _nnz = nnz;

          let r;
          r = _ensureI32(_pI, _capI, nnz); _pI = r.ptr; _capI = r.cap;
          r = _ensureI32(_pJ, _capJ, nnz); _pJ = r.ptr; _capJ = r.cap;

          _M.HEAP32.set(I, _pI >> 2);
          _M.HEAP32.set(J, _pJ >> 2);

          _M._setPattern(h, n, nnz, _pI, _pJ);
        },

        // setValues(V)
        // V: Float64Array, length = nnz from setPattern, in triplet order.
        setValues: function (V) {
          if (!(V instanceof Float64Array))
            throw new TypeError("fea-solver: setValues expects Float64Array");
          if (V.length !== _nnz)
            throw new Error("fea-solver: setValues: V.length (" + V.length + ") != nnz (" + _nnz + ")");

          let r = _ensureF64(_pV, _capV, _nnz); _pV = r.ptr; _capV = r.cap;
          _M.HEAPF64.set(V, _pV >> 3);
          _M._setValues(h, _nnz, _pV);
        },

        // analyze() — AMD ordering + symbolic factorization (call once per pattern).
        analyze: function () {
          const info = _M._analyze(h);
          if (info !== 0) throw new Error("fea-solver: analyze() failed (Eigen info=" + info + ")");
        },

        // factorize() — numeric Cholesky (call once per value update).
        factorize: function () {
          const info = _M._factorize(h);
          if (info !== 0) throw new Error("fea-solver: factorize() failed (Eigen info=" + info + " — matrix may not be SPD)");
        },

        // solve(b) → Float64Array(n)
        // b: Float64Array(n) right-hand side.
        solve: function (b) {
          if (!(b instanceof Float64Array))
            throw new TypeError("fea-solver: solve expects Float64Array");
          if (b.length !== _n)
            throw new Error("fea-solver: solve: b.length (" + b.length + ") != n (" + _n + ")");

          let r;
          r = _ensureF64(_pB, _capB, _n); _pB = r.ptr; _capB = r.cap;
          r = _ensureF64(_pX, _capX, _n); _pX = r.ptr; _capX = r.cap;

          _M.HEAPF64.set(b, _pB >> 3);
          _M._solve(h, _pB, _pX, _n);

          // Return a fresh copy (so the caller owns the data independently).
          return new Float64Array(_M.HEAPF64.buffer, _pX, _n).slice();
        },

        // solveInto(b, out) — same as solve() but writes the result into the
        // caller-provided out Float64Array(n). No allocation. Returns out.
        solveInto: function (b, out) {
          if (!(b instanceof Float64Array))
            throw new TypeError("fea-solver: solveInto expects Float64Array for b");
          if (!(out instanceof Float64Array))
            throw new TypeError("fea-solver: solveInto expects Float64Array for out");
          if (b.length !== _n)
            throw new Error("fea-solver: solveInto: b.length (" + b.length + ") != n (" + _n + ")");
          if (out.length !== _n)
            throw new Error("fea-solver: solveInto: out.length (" + out.length + ") != n (" + _n + ")");

          let r;
          r = _ensureF64(_pB, _capB, _n); _pB = r.ptr; _capB = r.cap;
          r = _ensureF64(_pX, _capX, _n); _pX = r.ptr; _capX = r.cap;

          _M.HEAPF64.set(b, _pB >> 3);
          _M._solve(h, _pB, _pX, _n);

          // Copy from the wasm heap into the caller's buffer.
          const heapStart = _pX >> 3;
          const heap = _M.HEAPF64;
          for (let i = 0; i < _n; i++) out[i] = heap[heapStart + i];
          return out;
        },

        // solveMultiInto(B, ncols, out) — multi-RHS solve. B and out are
        // column-major Float64Array of length ≥ n*ncols: column j occupies
        // [j*n, (j+1)*n). One Eigen solve(matrix) call — the L factor is streamed
        // once for all ncols columns (vs ncols separate solveInto calls). Bit-
        // identical to looping solveInto per column. No allocation. Returns out.
        solveMultiInto: function (B, ncols, out) {
          if (!(B instanceof Float64Array) || !(out instanceof Float64Array))
            throw new TypeError("fea-solver: solveMultiInto expects Float64Array for B and out");
          const need = _n * ncols;
          if (B.length < need)   throw new Error("fea-solver: solveMultiInto: B.length (" + B.length + ") < n*ncols (" + need + ")");
          if (out.length < need) throw new Error("fea-solver: solveMultiInto: out.length (" + out.length + ") < n*ncols (" + need + ")");

          let r;
          r = _ensureF64(_pB, _capB, need); _pB = r.ptr; _capB = r.cap;
          r = _ensureF64(_pX, _capX, need); _pX = r.ptr; _capX = r.cap;

          _M.HEAPF64.set(B.subarray(0, need), _pB >> 3);
          _M._solveMulti(h, _pB, _pX, _n, ncols);

          const heapStart = _pX >> 3, heap = _M.HEAPF64;
          for (let i = 0; i < need; i++) out[i] = heap[heapStart + i];
          return out;
        },

        // factorNnz() → number — nnz of the L factor.
        factorNnz: function () {
          return _M._factorNnz(h);
        },

        // destroy() — releases this instance and its heap buffers.
        destroy: function () {
          _M._destroy(h);
          if (_pI) { _M._free(_pI); _pI = 0; _capI = 0; }
          if (_pJ) { _M._free(_pJ); _pJ = 0; _capJ = 0; }
          if (_pV) { _M._free(_pV); _pV = 0; _capV = 0; }
          if (_pB) { _M._free(_pB); _pB = 0; _capB = 0; }
          if (_pX) { _M._free(_pX); _pX = 0; _capX = 0; }
        },
      };

      return solver;
    },
  };

})();
