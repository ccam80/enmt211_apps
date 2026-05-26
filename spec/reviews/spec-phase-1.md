# Spec Review: Phase 1 — FEA sparse solver

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 3 | 3 |
| minor    | 0 | 1 | 1 |
| info     | 1 | 1 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 1.1.1 — Production WASM solver wrapper (`lib/fea-solver.js` + artifacts + C++ source/build) | yes | All six files specified; handle-based ABI, non-streaming load, pattern/values split all covered. |
| 1.2.1 — Headless solver tests + host-compat check | yes | All three test files specified; every named test case from the plan is present with concrete assertions. |
| Plan verification: residual ~1e-10 on proxy at N=12100 and N=50176 | yes | Spec asserts `< 1e-9` at both sizes (measured ~1.4e-10 at N=50176 per plan §2.3). |
| Plan verification: analyze/factorize/solve split exposed | yes | "numeric refactor reuses symbolic ordering" test asserts one `analyze` + multiple `factorize`/`solve`. |
| Plan verification: Moodle/static-host non-streaming load path | yes | `host-compat.test.js` stubs `fetch`/`instantiateStreaming`, asserts no Worker, verifies solve works. |

---

## Findings

### Mechanical Fixes

None found.

---

### Decision-Required Items

#### D1 — `buildSmallSPD()` size is ambiguous ("4×4 (or 3×3)") (major)

- **Location**: Phase 1 §Wave 1.2 Task 1.2.1 "Files to create" → `tests/solver/_fixtures.js`
- **Problem**: The spec reads: "a fixed 4×4 (or 3×3) SPD system with full-symmetric triplets and a hand-computed exact solution `{ I, J, V, b, xExact }`". The parenthetical "or 3×3" leaves the implementer to choose the matrix size. `xExact` is by definition size-dependent. The `setValues` test then asserts `solution matches xExact/2 within 1e-10` and the host-compat test asserts `solution matches xExact within 1e-10`. The exact values of `xExact` and the hand-computed `V` entries will differ between the two choices. A reviewer cannot verify correctness without knowing which size was intended.
- **Why decision-required**: 3×3 is simpler to hand-compute; 4×4 gives slightly more coverage of the scatter-map (more off-diagonal entries possible); neither is obviously wrong. The plan does not specify a size.
- **Options**:
  - **Option A — Fix size to 3×3**: Replace "4×4 (or 3×3)" with "3×3". The fixture section would then specify the exact matrix entries and `xExact` (or leave them to the implementer, but with a fixed size).
    - Pros: Minimises hand-computation for the spec author; 3×3 is still sufficient to exercise all code paths.
    - Cons: Slightly fewer off-diagonal entries to exercise the scatter map's duplicate-summation path.
  - **Option B — Fix size to 4×4**: Replace "4×4 (or 3×3)" with "4×4".
    - Pros: More representative of a real sparse system; more off-diagonal slots to test duplicate summation.
    - Cons: Slightly more hand-computation.
  - **Option C — Specify the full matrix entries and `xExact` in the spec**: Pin the exact `I`, `J`, `V`, `b`, `xExact` arrays in the fixture description (e.g., a Hilbert-like 3×3 or a diagonal-dominant 4×4 with known inverse).
    - Pros: Leaves nothing for the implementer to decide; a verifier can reproduce by hand.
    - Cons: Adds significant length to the spec; any typo in the matrix is a silent bug.

---

#### D2 — Node test environment setup for classic-script `fea-solver.js` is unspecified (major)

- **Location**: Phase 1 §Wave 1.2 Task 1.2.1 "Files to create" → `tests/solver/solver.test.js` and `tests/solver/host-compat.test.js`; also §Wave 1.1 Task 1.1.1 "Files to create" → `lib/fea-solver.js`
- **Problem**: `lib/fea-solver.js` is specified as a "classic script" (no top-level `import`/`export`) that exposes `LIB.FeaSolver` on `window.LIB`. The test files use `node --test`. For the test files to call `LIB.FeaSolver.init(...)`, three things must be true: (a) `window` must exist or be shimmed, (b) `fea-solver.js` must be loaded into the Node process, (c) the dynamic `await import("./solver.mjs")` inside `fea-solver.js` must resolve `./solver.mjs` correctly from within Node. In a Node environment without `window`, the IIFE `(function(){ const LIB = window.LIB || ... })()` throws immediately. The spec provides `readWasmBinary()` in `_fixtures.js` but says nothing about how `window.LIB` is shimmed, how `fea-solver.js` is loaded (e.g., `require`, dynamic `import`, or `eval`), or how `./solver.mjs`'s relative path is resolved when `fea-solver.js` lacks `__dirname` or `import.meta.url` (being neither a CJS module nor an ES module). An implementer must invent this test harness without guidance and could reasonably produce several incompatible designs.
- **Why decision-required**: Multiple credible approaches exist. Each has tradeoffs for test isolation and future maintainability. None is "obviously correct" from the spec text.
- **Options**:
  - **Option A — Add a test shim file `tests/solver/_shim.js`**: The spec declares a `tests/solver/_shim.js` (modelled on `tests/_shim.js`) that sets `global.window = { LIB: {} }`, then `require`s `lib/fea-solver.js`, then patches the dynamic `import` path. Add a line in the test description: "load via `tests/solver/_shim.js`; the shim sets `global.window`, `require`s `../../lib/fea-solver.js`, and resolves `./solver.mjs` to the absolute `lib/solver.mjs` path using `path.resolve(__dirname, '../../lib/solver.mjs')`."
    - Pros: Consistent with the project's existing shim pattern (`tests/_shim.js`); isolated to one file.
    - Cons: The shim must intercept the dynamic `import()` call inside a required CJS file — non-trivial and potentially fragile.
  - **Option B — Make `fea-solver.js` loadable as ESM under Node**: Allow the file to use `globalThis.LIB` (which works in both browser and Node) and specify that `tests/solver/solver.test.js` uses `import "../../lib/fea-solver.js"` as a side-effecting ESM import, treating the file as an ESM module with a compatibility shim for the IIFE pattern.
    - Pros: Avoids CJS/ESM friction; `import.meta.url` resolves paths correctly under ESM.
    - Cons: Changes the "classic script" contract; downstream lessons that `<script src>` it would still work but the `window` reference must become `globalThis`.
  - **Option C — Specify a dedicated Node entry-point wrapper `lib/fea-solver-node.js`**: The spec adds a thin Node-only CJS wrapper that handles `global.window`, `__dirname`-based path resolution for `solver.wasm`/`solver.mjs`, and re-exports `LIB.FeaSolver`. Test files `require` this wrapper instead of the browser classic script.
    - Pros: Cleanly separates browser and Node load paths; the browser script stays purely classic.
    - Cons: Adds a file not in "Files Owned"; the two files could diverge and break the MIME-independence guarantee.

---

#### D3 — `_solver_bench/` location relative to repo root is never stated (major)

- **Location**: Phase 1 §Wave 1.1 Task 1.1.1 "Files to create" → `lib/solver-src/build.sh` and `lib/solver-src/README.md`; also §Wave 1.1 Task 1.1.1 description ("prototype `wrapper.cpp` … in `_solver_bench/`")
- **Problem**: The spec says the build is "run from `_solver_bench/` after `source emsdk/emsdk_env.sh`" and references "the `_solver_bench/` emsdk + Eigen". The project's `CLAUDE.md` repo layout lists no `_solver_bench/` directory, and the git status shows no such entry. An implementer must know where `_solver_bench/` is to: (a) copy the prototype `wrapper.cpp` as the starting point, (b) write a `build.sh` with the correct relative path to `emsdk` and `eigen-3.4.0`, (c) author the README with accurate instructions. If `_solver_bench/` is at the repo root (a sibling of `ENMT211Apps/`), the paths are `../../_solver_bench/`; if it is inside `ENMT211Apps/`, they differ. Neither is stated.
- **Why decision-required**: The answer depends on where the author placed the scratch directory. This is a factual question, not a design choice — but the spec author must state the answer, and it is not currently present.
- **Options**:
  - **Option A — State the path explicitly in the spec**: Add to the Task 1.1.1 description: "`_solver_bench/` is at `<absolute-or-relative-path-from-repo-root>`; `build.sh` assumes it is a sibling of the repo root." Update `build.sh` spec and README spec to reflect the actual path.
    - Pros: Complete; no guessing.
    - Cons: None — this is pure information that belongs in the spec.
  - **Option B — Make `build.sh` accept the emsdk and Eigen paths as arguments**: Spec `build.sh` as taking `EMSDK_ROOT` and `EIGEN_ROOT` as environment variables or arguments, removing the dependency on `_solver_bench/` being in a specific location.
    - Pros: The build script becomes location-independent; any developer with emsdk + Eigen can run it.
    - Cons: Makes the build script slightly more complex; the README must document the variables.
  - **Option C — Include a note in README.md spec that the prototype is available at `_solver_bench/` and an implementer who cannot locate it must reconstruct `wrapper.cpp` from the C ABI description**: This essentially says the ABI description in the spec is the authoritative source and `_solver_bench/` is optional context.
    - Pros: Makes the spec self-contained without depending on the scratch directory.
    - Cons: Forces the implementer to write `wrapper.cpp` from scratch, increasing risk of ABI divergence from the validated prototype.

---

#### D4 — Timing assertion `factorize < 2000 ms` conflicts with plan's "not an absolute-ms gate" framing (minor)

- **Location**: Phase 1 §Wave 1.2 Task 1.2.1 "Files to create" → `tests/solver/solver.test.js`, test `"analyze/factorize/solve timings logged; refactor within a generous bound"`
- **Problem**: The spec text reads: "assert `factorize` wall-clock `< 2000 ms` and `solve < factorize` (loose, machine-independent regression guard — absolute targets are reported, not asserted, per §2.3 being a measured reference not a CI gate)". The parenthetical says "absolute targets are **reported**, not **asserted**", yet the same sentence contains an explicit `assert factorize < 2000 ms`. These two statements contradict each other. The plan (Phase 1 verification) says "timings logged with a generous regression guard (not an absolute-ms gate)". Whether the 2000 ms is an assert (hard fail) or a logged warning (soft) is unresolved.
- **Why decision-required**: Whether to assert or log is a test design decision. A hard `assert` can cause flaky test failures on slow CI runners or constrained devices. A soft log never catches a regression that makes factorization genuinely pathological.
- **Options**:
  - **Option A — Keep the hard assert but reconcile the wording**: Remove the contradictory parenthetical. The spec reads: "assert `factorize` wall-clock `< 2000 ms` and `solve < factorize`." This is a generous but hard regression guard.
    - Pros: Clear; unambiguous; consistent with `node --test` passing.
    - Cons: Could produce flaky failures on very slow runners.
  - **Option B — Remove the assert and log only**: Replace "assert `factorize` wall-clock `< 2000 ms`" with "`console.log` the measured timings; no timing assert." This matches the plan's "not an absolute-ms gate" language exactly.
    - Pros: No flaky CI failures; matches plan intent.
    - Cons: A catastrophic performance regression (e.g., 60 s factorize) would not be caught by the test suite.
  - **Option C — Use a soft assertion with a warning**: Log timings and emit a `console.warn` if `factorize > 2000 ms`, but do not fail the test. Document this as a "soft regression guard."
    - Pros: Retains signal without hard failure.
    - Cons: `node --test` does not distinguish warn from pass; the "regression guard" is purely advisory.

---

### Info Items

#### I1 — `readWasmBinary()` working-directory assumption is implicit (info)

- **Location**: Phase 1 §Wave 1.2 Task 1.2.1 "Files to create" → `tests/solver/_fixtures.js`
- **Problem**: The spec says `readWasmBinary()` "reads `lib/solver.wasm` from disk via `fs`". The path `lib/solver.wasm` is relative. Under `node --test tests/solver/` invoked from the project root, the working directory is the project root and `lib/solver.wasm` resolves correctly. The spec does not state this assumption. An implementer who runs tests from a different working directory or uses `path.resolve(__dirname, ...)` may produce a subtly different path.
- **Observation**: In practice this is unlikely to cause problems given the project's `node --test` convention, but an explicit note (e.g., "path resolved relative to the project root, i.e., `path.resolve(__dirname, '../../lib/solver.wasm')`") would remove ambiguity.
- **No action required** unless the implementer encounters a path-resolution error.

#### I2 — `build.sh` is described as run from `_solver_bench/` but lives in `lib/solver-src/` (info)

- **Location**: Phase 1 §Wave 1.1 Task 1.1.1 "Files to create" → `lib/solver-src/build.sh`
- **Problem**: The spec says `build.sh` is "run from `_solver_bench/`" but the file itself lives in `lib/solver-src/`. This cross-directory invocation (run `lib/solver-src/build.sh` from `_solver_bench/`) is unusual. It may mean the developer is expected to `cd _solver_bench && bash ../ENMT211Apps/lib/solver-src/build.sh`, or to copy `build.sh` to `_solver_bench/`. The spec doesn't clarify. The README.md is supposed to document this, but the spec doesn't specify the exact invocation form in the README section either.
- **Observation**: This is logistical rather than a blocking issue — the README.md acceptance criterion says it must contain "how to rebuild ... the build command, Windows + bash variants." As long as the README is concrete, an implementer can follow it. Surface here for awareness.
- **No action required** unless D3 is resolved and the invocation form changes.
