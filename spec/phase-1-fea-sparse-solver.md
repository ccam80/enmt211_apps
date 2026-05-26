# Phase 1: FEA sparse solver

## Overview

Productionise the validated Eigen `SimplicialLDLT` (AMD ordering) WASM prototype
from the scratch `_solver_bench/` into a shipping `lib/` module with the
**analyze-once / factorize-per-step** split (`fea-engine-rebuild.md` §2, §3.6,
§6). The solver is the SPD field-operator backend the FEA slice (Phase 5) builds
on. Phase 1 is self-contained and validated on the **5-point air↔iron ×1000 SPD
proxy operator**; Phase 5 re-runs the benchmark on the real unstructured matrix
(`fea-engine-rebuild.md` §7 step 4).

The shipping module is `lib/fea-solver.js` (a classic, DOM-free `<script src>`
attaching `LIB.FeaSolver`) backed by the Emscripten artifacts `lib/solver.wasm`
+ `lib/solver.mjs`. The C++ source and build are brought into the repo under
`lib/solver-src/` so the ABI is owned and the binary is reproducible.

This phase ships four locked design decisions (settled with the author
2026-05-26):

1. **Handle-based multi-instance ABI.** `wrapper.cpp` is refactored from static
   globals to a handle registry so multiple solver instances (rotor + stator,
   plus the §3.2 per-body LRU of cached symbolic analyses) hold live
   factorizations in **one** shared WASM heap.
2. **Source in-repo.** `wrapper.cpp` + `build.sh` + `README.md` live in
   `lib/solver-src/`; the built `solver.wasm`/`solver.mjs` are committed to
   `lib/`.
3. **Classic-script load glue.** `lib/fea-solver.js` is a classic script that
   dynamically `import()`s `./solver.mjs` and passes the `.wasm` bytes as
   `Module.wasmBinary`, forcing Emscripten's **non-streaming
   `WebAssembly.instantiate(arrayBuffer)`** path — MIME-independent (Moodle
   `pluginfile.php`-safe), same-origin, no Web-Worker requirement.
4. **Pattern/values split.** `setPattern(I,J)` is called once (triplet input;
   one-time sort + internal scatter-map build, duplicates summed); `setValues(V)`
   updates values per Newton iteration in the same triplet order via the scatter
   map (O(nnz), no re-sort) — as fast as CSC-direct while keeping the caller in
   triplet form.

## Files Owned

- `lib/fea-solver.js` — created (classic-script `LIB.FeaSolver` wrapper: module
  init, handle-based solver instances, heap marshaling, memory discipline)
- `lib/solver.wasm` — created (built artifact: debug-stripped, 64 MB stack,
  handle ABI)
- `lib/solver.mjs` — created (built Emscripten ES-module glue, debug-stripped)
- `lib/solver-src/wrapper.cpp` — created (handle-based C ABI over Eigen
  `SimplicialLDLT<SparseMatrix<double>, Lower>`)
- `lib/solver-src/build.sh` — created (the exact `emcc` invocation)
- `lib/solver-src/README.md` — created (build instructions + ABI reference)
- `tests/solver/_fixtures.js` — created (5-point proxy operator builder, residual
  + assertion helpers, small hand-checked SPD systems)
- `tests/solver/solver.test.js` — created (correctness, symbolic-reuse,
  multi-instance, setValues/duplicate-summation, timing regression guard)
- `tests/solver/host-compat.test.js` — created (non-streaming ArrayBuffer load
  path; no-fetch / no-streaming / no-worker assertions)

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 1.1: Production WASM solver wrapper

### Task 1.1.1: Handle-based Eigen `SimplicialLDLT` WASM solver + `LIB.FeaSolver` wrapper

- **Description**: Refactor the prototype `wrapper.cpp` (currently static
  globals + debug `printf`s, in `_solver_bench/`) into a **handle-based** C ABI
  over `Eigen::SimplicialLDLT<SparseMatrix<double>, Lower>`, strip all debug
  `printf`s, build it to `lib/solver.wasm` + `lib/solver.mjs` with the raised
  WASM stack, and wrap it with `lib/fea-solver.js` exposing `LIB.FeaSolver`. The
  matrix is supplied as **full-symmetric triplets** (the validated prototype
  convention; Eigen's `Lower` uses the lower triangle). The pattern is set once
  and reused across numeric refactors; values update in triplet order via an
  internal scatter map. DOM-free; no machine identity anywhere.

- **Files to create**:
  - `lib/solver-src/wrapper.cpp` — handle-based C ABI. A solver registry
    (`std::vector<std::unique_ptr<...>>` holding, per handle, the
    `SparseMatrix<double>`, the `SimplicialLDLT` solver, the last solution
    vector, and the triplet→CSC scatter map). Exported `extern "C"`
    `EMSCRIPTEN_KEEPALIVE` functions:
    - `int create()` — allocate a solver slot; return its handle (index).
    - `void destroy(int h)` — release slot `h`.
    - `void setPattern(int h, int n, int nnz, const int* I, const int* J)` —
      build the `n×n` CSC structure from the triplet coordinates (values 1.0 for
      structure), `makeCompressed()`, and build the scatter map `map[k]` = index
      into the compressed value array for triplet `k` (multiple triplets mapping
      to one slot is allowed and means summation). Zero the value array.
    - `void setValues(int h, int nnz, const double* V)` — zero the CSC value
      array, then `for k: values[map[k]] += V[k]`. `nnz` must equal the
      `setPattern` `nnz`.
    - `int analyze(int h)` — `solver.analyzePattern(A)`; return `solver.info()`.
    - `int factorize(int h)` — `solver.factorize(A)`; return `solver.info()`.
    - `void solve(int h, const double* b, double* x, int n)` — map `b`, solve,
      write `x`.
    - `int factorNnz(int h)` — nnz of the `L` factor.
    No `printf`/`iostream`/debug output remains.
  - `lib/solver-src/build.sh` — the `emcc` command, location-independent. Reads
    two required environment variables: `EMSDK_ROOT` (the emsdk installation,
    e.g. `_solver_bench/emsdk/`) and `EIGEN_ROOT` (the Eigen 3.4.0 source tree,
    e.g. `_solver_bench/eigen-3.4.0/`). The script `source`s
    `"$EMSDK_ROOT/emsdk_env.sh"` to activate emcc on PATH and invokes:
    `emcc -O3 -I "$EIGEN_ROOT" -sMODULARIZE=1 -sEXPORT_ES6=1
     -sEXPORT_NAME=createSolver -sSTACK_SIZE=67108864 -sALLOW_MEMORY_GROWTH=1
     -sEXPORTED_FUNCTIONS=_create,_destroy,_setPattern,_setValues,_analyze,_factorize,_solve,_factorNnz,_malloc,_free
     -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAP32,HEAPF64,HEAPU8
     -sENVIRONMENT=web,node wrapper.cpp -o solver.mjs` (default 64 KB stack
    overflows AMD ordering, §6 — keep the 64 MB raise). After build, copies
    `solver.mjs` + `solver.wasm` into `lib/`. The script `set -euo pipefail`s
    and fails clearly when either env var is missing.
  - `lib/solver-src/README.md` — rebuild instructions documenting the two
    environment variables (`EMSDK_ROOT`, `EIGEN_ROOT`), example values for
    the developer using the existing `_solver_bench/` checkout
    (`export EMSDK_ROOT=$REPO_ROOT/../_solver_bench/emsdk` and
     `export EIGEN_ROOT=$REPO_ROOT/../_solver_bench/eigen-3.4.0`,
    or whatever paths the developer has), Windows + bash command variants,
    and the ABI reference (every exported symbol, argument layout,
    triplet/scatter-map semantics, the `Lower`-triangle / full-symmetric-input
    convention).
  - `lib/solver.wasm` — the built binary (copied from the build output).
  - `lib/solver.mjs` — the built ES-module glue (copied from the build output).
  - `lib/fea-solver.js` — classic script: `(function(){ const LIB =
    window.LIB || (window.LIB = {}); ... })()`. Exposes `LIB.FeaSolver`:
    - `LIB.FeaSolver.init(opts?) → Promise<void>` — load + instantiate the WASM
      module **once** (module-level cached promise; idempotent). The load path
      is **always non-streaming**: obtain the `.wasm` bytes as an `ArrayBuffer`
      and pass them to the Emscripten factory as `Module.wasmBinary` (so
      Emscripten never calls `WebAssembly.instantiateStreaming` and never depends
      on an `application/wasm` MIME type). `opts.wasmBinary` (ArrayBuffer) is used
      verbatim if given;
      The `Module` glue is loaded via `await import(process.env.FEA_SOLVER_MJS_PATH || "./solver.mjs")` so a Node test harness can point at the absolute `lib/solver.mjs` path without changing browser load behavior.
      otherwise in the browser the wrapper
      `fetch(...).arrayBuffer()`s `solver.wasm` resolved relative to
      `fea-solver.js`, and under node it reads `lib/solver.wasm` via `fs`. No Web Worker
      is created.
    - `LIB.FeaSolver.create() → Solver` — returns a handle-wrapper object; throws
      a clear error if `init()` has not completed. The `Solver` object methods:
      - `setPattern(n, I, J)` — `I`,`J` `Int32Array` (full-symmetric triplet
        coordinates); marshals to the WASM heap and calls `setPattern`. Records
        `n` and `nnz`.
      - `setValues(V)` — `V` `Float64Array`, length = the `setPattern` `nnz`,
        triplet order; marshals + calls `setValues`. Throws on length mismatch.
      - `analyze()` — calls `analyze`; throws if Eigen `info() != 0` (Success).
      - `factorize()` — calls `factorize`; throws if `info() != 0` (e.g.
        non-SPD).
      - `solve(b) → Float64Array(n)` — `b` `Float64Array(n)`; returns the
        solution as a fresh `Float64Array`.
      - `factorNnz() → number`.
      - `destroy()` — calls `destroy(h)` and frees this instance's reusable heap
        buffers.
    Memory discipline: each `Solver` owns reusable heap buffers for `I`/`J`/`V`/
    `b`/`x`, grown on demand and freed in `destroy()`; no per-call leaks. A
    header comment documents the **Moodle/static-host load path** (non-streaming
    ArrayBuffer instantiate; same-origin; MIME-independent; no Worker).

- **Files to modify**: none.

- **Tests**: (the runnable assertions live in Wave 1.2; this task is verified by
  the Wave 1.2 suite plus the build/agnosticism acceptance criteria below.)

- **Acceptance criteria**:
  - `lib/solver-src/build.sh` rebuilds `solver.wasm` + `solver.mjs` from
    `lib/solver-src/wrapper.cpp` using the `_solver_bench/` emsdk + Eigen, and
    copies them into `lib/`; the committed `lib/solver.wasm`/`lib/solver.mjs`
    match that build output.
  - `lib/solver-src/wrapper.cpp` contains **zero** `printf`/`std::cout`/debug
    output and exposes exactly the eight `create`/`destroy`/`setPattern`/
    `setValues`/`analyze`/`factorize`/`solve`/`factorNnz` symbols.
  - `lib/fea-solver.js` is a classic script (no top-level `import`/`export`),
    attaches `LIB.FeaSolver`, performs no DOM/canvas access at load, and contains
    no machine name, machine-type enum, or machine-identity branch.
  - The Wave 1.2 suite passes (`node --test tests/solver/`).

---

## Wave 1.2: Solver validation + host-compat check

### Task 1.2.1: Headless solver tests + host-compat load-path check

- **Description**: Headless `node --test` validation that the production
  `LIB.FeaSolver` reproduces the `fea-engine-rebuild.md` §2.3 behaviour on the
  5-point air↔iron ×1000 SPD proxy operator — SPD-exact residual, symbolic-reuse
  across numeric refactors, multi-instance isolation, `setValues` correctness
  (including duplicate-triplet summation) — plus an automated check of the
  Moodle/static-host non-streaming load path.

- **Files to create**:
  - `tests/solver/_shim.js` — Node-side classic-script loader for
    `lib/fea-solver.js`. Modeled on the existing `tests/_shim.js` pattern.
    `"use strict";` `if (!globalThis.window) globalThis.window = { LIB: {} };`
    then `require("../../lib/fea-solver.js");` so the IIFE runs and attaches
    `LIB.FeaSolver` to `window.LIB`. Resolves the dynamic
    `import("./solver.mjs")` inside `fea-solver.js` by intercepting via the
    Node ESM resolver: the shim, before `require`, sets
    `process.env.FEA_SOLVER_MJS_PATH = require("path").resolve(__dirname,
    "../../lib/solver.mjs")`, and `fea-solver.js` (per its Task-1.1.1 spec)
    honors that env var when present in lieu of the relative
    `./solver.mjs`. Exports `module.exports = window.LIB;`.
  - `tests/solver/_fixtures.js` — exports:
    - `buildProxy(n)` — the `n×n` grid 5-point operator (lifted from
      `_solver_bench/bench_wasm.mjs`): full-symmetric triplets with the air↔iron
      ×1000 harmonic-mean conductivity (`condOf(i)` = `1e-3` for
      `i ≤ 0.3n` or `i ≥ 0.85n`, else `1.0`), diagonal `+1e-4` regularisation.
      Returns `{ N, nnz, I:Int32Array, J:Int32Array, V:Float64Array,
      b:Float64Array }` with `b[i] = sin(0.1·i) + 1`.
    - `residualInf(I, J, V, x, b)` — returns `‖Ax−b‖∞ / ‖b‖∞` computed directly
      from the triplets.
    - `assertClose(actual, expected, tol, msg)`.
    - `buildSmallSPD()` — a fixed 3×3 SPD system with full-symmetric triplets
      and a hand-computed exact solution. Pinned values (diagonal-dominant;
      full symmetric off-diagonals; the helper documents the
      element-wise verification of `A·xExact = b` inline):
      ```js
      // A = [[4, 1, 0],
      //      [1, 3, 1],
      //      [0, 1, 2]],   diagonal-dominant SPD.
      // Verify A·xExact = b element-wise (x = [1, 1, 2]):
      //   row 0: 4·1 + 1·1 + 0·2 = 5
      //   row 1: 1·1 + 3·1 + 1·2 = 6
      //   row 2: 0·1 + 1·1 + 2·2 = 5
      // → b = [5, 6, 5].
      return {
        I:      new Int32Array  ([0, 0, 1, 1, 1, 2, 2]),
        J:      new Int32Array  ([0, 1, 0, 1, 2, 1, 2]),
        V:      new Float64Array([4, 1, 1, 3, 1, 1, 2]),
        b:      new Float64Array([5, 6, 5]),
        xExact: new Float64Array([1, 1, 2]),
      };
      ```
    - `buildSmallSPDWithDuplicates()` — the same 3×3 matrix expressed with some
      `(i,j)` entries split across **two** triplets that sum to the correct
      value, plus `xExact` (the same solution) — for the scatter-map summation
      test.
    - `readWasmBinary()` — reads `lib/solver.wasm` from disk via `fs` and returns
      it as an `ArrayBuffer`.
  - `tests/solver/solver.test.js` — First require `./_shim.js` which installs `globalThis.window` and loads `lib/fea-solver.js`; then uses `node:test` + `node:assert/strict`:
    - `"SPD residual below 1e-9 on the proxy operator"` — `buildProxy(110)`
      (N=12100); `init`, `create`, `setPattern`, `setValues`, `analyze`,
      `factorize`, `solve`; assert `residualInf(...) < 1e-9`.
    - `"larger proxy stays SPD-exact"` — `buildProxy(224)` (N=50176); assert
      `residualInf(...) < 1e-9` (the §2.3 stress size; ~1.4e-10 measured).
    - `"numeric refactor reuses the symbolic ordering"` — `analyze()` exactly
      **once**, then `setValues`/`factorize`/`solve` **three** times (scaling the
      proxy `V` by 1.0, 2.0, 0.5 between refactors, with `b` matched so the exact
      solution is known); assert each solve's `residualInf < 1e-9` — i.e. the
      factorization is correct without any re-`analyze`.
    - `"two instances hold independent live factorizations"` — `create()` two
      handles `A` (proxy n=80) and `B` (proxy n=110); `setPattern`/`setValues`/
      `analyze`/`factorize` both; interleave solves; assert each handle's
      `residualInf < 1e-9` and that solving `B` does not change `A`'s result
      (re-solve `A` after `B`, compare element-wise within 1e-12).
    - `"setValues updates the system without re-analyze"` — `buildSmallSPD()`:
      `setPattern`/`setValues(V)`/`analyze`/`factorize`/`solve`, assert solution
      matches `xExact` within 1e-10; then `setValues(2·V)`/`factorize`/`solve`,
      assert solution matches `xExact/2` within 1e-10 (same pattern, no
      re-`analyze`).
    - `"scatter map sums duplicate triplets"` — solve `buildSmallSPD()` and
      `buildSmallSPDWithDuplicates()`; assert both solutions equal `xExact`
      within 1e-10 (proves duplicate `(i,j)` triplets are summed into one CSC
      slot).
    - `"factorNnz reports fill above N"` — for `buildProxy(110)`, assert
      `factorNnz() > N` and `< 50*N` (sane sparse fill; guards a catastrophic
      mis-ordering regression).
    - `"analyze/factorize/solve timings logged; relative order asserted"` —
      `console.log` the measured analyze/factorize/solve ms for
      `buildProxy(110)` so the §2.3 reference values are visible on every run.
      Assert only the **machine-independent relative order**: `solve <
      factorize` (a `solve` slower than its own `factorize` signals a broken
      ABI or marshaling regression). **Do not assert any absolute wall-clock
      bound** — the §2.3 numbers are a measured reference, not a CI gate
      (matches the plan's "timings logged with a generous regression guard,
      not an absolute-ms gate" framing).
    - `"non-SPD matrix surfaces an error"` — feed a deliberately indefinite
      small matrix (negate a diagonal); assert `factorize()` throws (Eigen
      `info() != 0`).
  - `tests/solver/host-compat.test.js` — First require `./_shim.js` which installs `globalThis.window` and loads `lib/fea-solver.js`; then uses `node:test`:
    - `"loads from an in-memory ArrayBuffer with no fetch/streaming/worker"` —
      temporarily replace `globalThis.fetch` and
      `WebAssembly.instantiateStreaming` with stubs that throw, and assert
      `globalThis.Worker` is **not** invoked; call
      `LIB.FeaSolver.init({ wasmBinary: readWasmBinary() })`; then run a
      `buildSmallSPD()` solve and assert it matches `xExact` within 1e-10 — i.e.
      the solver loads and works via the non-streaming ArrayBuffer path with no
      dependency on `fetch`, streaming instantiation, MIME type, or a Web Worker.
      Restore the stubs in a `finally`.
    - `"init is idempotent"` — call `init()` twice; assert the second resolves
      without re-instantiating (same module promise) and `create()` still works.

- **Files to modify**: none.

- **Acceptance criteria**:
  - `node --test tests/solver/` passes with every test above green.
  - The proxy-operator residual is `< 1e-9` at both N=12100 and N=50176.
  - Symbolic reuse is proven: a single `analyze()` followed by multiple
    `factorize()`/`solve()` cycles each yields `residualInf < 1e-9`.
  - Two concurrent solver instances each solve correctly and independently.
  - `setValues` (including duplicate-triplet summation) reproduces the
    hand-computed exact solutions within 1e-10.
  - The host-compat test proves the WASM loads and solves from an in-memory
    ArrayBuffer with `fetch`/`instantiateStreaming` stubbed to throw and no
    Worker created (the Moodle/static-host load-path verification item). The
    genuine in-Moodle browser confirmation rides Phase 6's browser checklist.
  - All tests pass.
