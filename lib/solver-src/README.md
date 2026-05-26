# FEA Sparse Solver — Build Instructions and ABI Reference

This directory contains the C++ source (`wrapper.cpp`) and build script
(`build.sh`) for the Eigen `SimplicialLDLT` (AMD ordering) WASM solver
used by the FEA field engine.

The built artifacts (`lib/solver.wasm` and `lib/solver.mjs`) are committed
to `lib/` and are safe to use without rebuilding. Rebuild only when
`wrapper.cpp` changes.

---

## Prerequisites

- [emsdk](https://emscripten.org/docs/getting_started/downloads.html) —
  Emscripten SDK (5.0.7 or later). The existing checkout lives in
  `_solver_bench/emsdk/` relative to the project parent directory.
- [Eigen 3.4.0](https://eigen.tuxfamily.org/) — header-only linear algebra
  library. The existing checkout lives in
  `_solver_bench/eigen-3.4.0/` relative to the project parent directory.

---

## Rebuild Steps

### Linux / macOS / Git Bash on Windows

```bash
export EMSDK_ROOT=/path/to/_solver_bench/emsdk
export EIGEN_ROOT=/path/to/_solver_bench/eigen-3.4.0
bash lib/solver-src/build.sh
```

Using the existing `_solver_bench/` checkout (from the repository parent
directory `C:/local_working_projects/` or equivalent):

```bash
REPO_ROOT="$(pwd)"   # run from ENMT211Apps/
export EMSDK_ROOT="${REPO_ROOT}/../_solver_bench/emsdk"
export EIGEN_ROOT="${REPO_ROOT}/../_solver_bench/eigen-3.4.0"
bash lib/solver-src/build.sh
```

### Windows (cmd.exe / PowerShell) — via Git Bash

Open Git Bash and run the bash commands above. Emscripten does not support
native cmd.exe/PowerShell invocation; always use Git Bash or WSL.

### What the script does

1. Sources `$EMSDK_ROOT/emsdk_env.sh` to activate `emcc` on `PATH`.
2. Compiles `wrapper.cpp` to `lib/solver-src/solver.mjs` + `solver.wasm`
   with `-O3`, 64 MB WASM stack (AMD ordering needs it — the default 64 KB
   overflows), and memory growth enabled.
3. Copies both artifacts into `lib/`.

---

## ABI Reference

All functions are exported as `extern "C"` with `EMSCRIPTEN_KEEPALIVE`.
The JS wrapper (`lib/fea-solver.js`) calls them via the Emscripten
`ccall`/`cwrap` helpers after instantiation.

### Handle lifecycle

```
int  create()         → allocate a solver slot; return its integer handle h.
void destroy(int h)   → release slot h and free its memory.
```

Multiple handles may be live simultaneously (one per body in a multi-body
problem, or one per cached symbolic analysis). All handles share the same
WASM heap.

### Pattern registration (call once per sparsity pattern)

```
void setPattern(int h, int n, int nnz, const int* I, const int* J)
```

- `n`   — matrix dimension (n×n).
- `nnz` — number of triplets (including duplicates and both triangles of a
  symmetric entry).
- `I`, `J` — row/column index arrays, length `nnz`, **full-symmetric**
  (both `(i,j)` and `(j,i)` may appear; Eigen `SimplicialLDLT<Lower>`
  uses only the lower triangle of the assembled CSC, but supplying the full
  symmetric pattern is safe and is the validated prototype convention).
- Internally: builds the CSC structure with `setFromTriplets` (unit values;
  duplicates merged), calls `makeCompressed()`, then builds the scatter map
  `scatterMap[k]` = index into the compressed value array for triplet `k`.
  Duplicate triplets that map to the same `(row,col)` entry are allowed:
  `setValues()` will sum them into the same CSC slot.
- Zeros the value array after building the scatter map.

### Value update (call once per Newton iteration)

```
void setValues(int h, int nnz, const double* V)
```

- `nnz` — must equal the `nnz` passed to `setPattern`.
- `V`   — triplet values in the **same order** as `I`/`J` in `setPattern`.
- Operation: zeros the CSC value array, then `for k: values[scatterMap[k]] += V[k]`.
  This is O(nnz) with no sort or search — as fast as direct CSC writes
  while keeping the caller in triplet form.

### Symbolic analysis (call once per pattern)

```
int analyze(int h)   → Eigen info(): 0 = Success.
```

Runs `solver.analyzePattern(A)`: computes the AMD fill-reducing ordering
and the symbolic Cholesky factor. This is the expensive one-time step
(~20 ms for a 50k-DOF operator). Reuse it across all subsequent numeric
refactors that share the same sparsity pattern.

### Numeric factorization (call once per value update)

```
int factorize(int h)   → Eigen info(): 0 = Success, non-zero = failure.
```

Runs `solver.factorize(A)`: numeric Cholesky with the previously computed
ordering. Returns non-zero if the matrix is not positive definite.

### Solve (call after factorize)

```
void solve(int h, const double* b, double* x, int n)
```

- `b`, `x` — `Float64` arrays of length `n`.
- Solves `L D Lᵀ x = b` using the current factorization.

### Fill diagnostics

```
int factorNnz(int h)   → nnz of the L factor.
```

---

## Triplet / scatter-map semantics

The caller builds triplets once (at mesh-generation time) and holds them
for the life of the simulation. Per Newton step:

1. Update `V[]` (computed from current field values).
2. Call `setValues(h, nnz, V)` — O(nnz), no reallocation.
3. Call `factorize(h)` — numeric refactor reusing the AMD ordering.
4. Call `solve(h, b, x, n)` — two sparse triangular solves.

`analyze(h)` is called again only when the sparsity pattern changes (e.g.
after mesh refinement or a topology change).

---

## Lower-triangle / full-symmetric-input convention

`SimplicialLDLT<SparseMatrix<double>, Lower>` assembles from the **lower
triangle** of the CSC matrix. The caller should supply **full-symmetric**
triplets (both `(i,j)` and `(j,i)`) so the assembled lower triangle is
correct. The validated prototype (`_solver_bench/bench_wasm.mjs`) follows
this convention and achieves residuals of ~1e-10 on the 50k-DOF test case.
