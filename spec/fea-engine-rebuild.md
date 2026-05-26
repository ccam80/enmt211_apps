# Unified-Motor FEA Engine Rebuild — Solver Investigation & Target Architecture

> Status: **agreed design — handoff to implementation** (2026-05-26). Captures the
> solver-decomposition investigation (with measured evidence) and the agreed
> conforming-mesh + sliding-interface + sparse-direct rebuild of the unified-motor field
> engine.
>
> **Implementers/orchestrator: read §11 FIRST** — binding constraints (§11.1), what this
> supersedes/preserves (§11.2), the resolved design decisions (§11.3), and the deferred
> items with their mechanical measure-and-threshold criteria (§11.4). Everything in this doc
> is settled; do not substitute alternatives or re-open §11.3 without the user.

---

## 0. TL;DR

The current live field engine (Jacobi-preconditioned CG on a coarse polar grid with a
single global saturation ceiling) is **inaccurate** (the global ceiling is not
grid-convergent for PM back-iron; cogging/detent is wrong) and **does not scale**. A
correct engine needs a real 2-D FEA core: a **conforming, graded mesh**, a **sliding
air-gap interface**, **local non-linear B–H saturation**, and an **exact sparse-direct
solver**.

The load-bearing question was the solver. It is now answered **with measured data**, not
extrapolation:

- The field operator `∇·(ν∇A)` is **SPD** ⇒ use **sparse Cholesky with a fill-reducing
  (AMD / nested-dissection) ordering**, computed **once** for a fixed sparsity pattern,
  then **numeric-refactor + solve per step**.
- A working WASM build of **Eigen `SimplicialLDLT` (AMD ordering)** factors a 50,176-DOF
  2-D operator in **20 ms (ordering+symbolic, one-time) + 66 ms (numeric refactor) +
  3.2 ms (solve)**, residual ~1e-10 (exact, conditioning-immune).
- For comparison, an ngspice-style **Markowitz** sparse-LU on the same matrix needs
  **~27 s** just to order and **~1 s** per refactor — i.e. ordering choice is a
  **~1,360×** factor. Markowitz (a circuit-matrix ordering) is the wrong tool; AMD/ND is
  the right one.

**Conclusion:** full-annulus, **zero-symmetry** machines (steppers — no pole symmetry to
exploit) are exact and **interactive** with an AMD-ordered sparse Cholesky, analyze-once /
factorize-per-step. A *realistic graded* stepper is ~10k DOF (§3.2) → ~6 ms refactor →
**~30 fps** doing full Newton every frame, and far faster in steady spin (factorization
reuse / the Schur lever make rotation nearly free). The 50k benchmark below is a stress
*ceiling*, not the operating point.

---

## 1. Why rebuild

The present engine (`lib/airgap-solve.js` live tier: Jacobi-PCG on an `Nr×Ntheta` polar
grid, default `Ntheta=256` ≈ 3072 DOF; `lib/airgap-refine.js` detailed tier: geometric
multigrid) has two coupled, fundamental problems:

1. **Accuracy.** Saturation is modelled by a *single global* scale `s = max(1,(Bpeak/Bknee)^p)`
   applied to all iron `ν`. This is not grid-convergent for the PM back-iron (magnets
   short-circuit through a thin μr=1000 yoke → ~100–260 T in a linear solve), so the
   saturated cogging/detent torque is wrong. Verified: linear cogging converges (~1.4 %),
   *saturated* cogging does not. The global ceiling cannot be patched into correctness —
   saturation is intrinsically **local**.
2. **Geometry fidelity.** The structured polar grid **rasterizes** geometry. At
   `Nr=12, Ntheta=256` the radial resolution is ~2 mm; cells straddle material boundaries
   (a magnet sliver tagged as air gap; the 4 mm air gap resolved by ~2 radial cells).
   Cogging/detent and gap-field accuracy are dominated by exactly the tooth-tip /
   slot-opening / magnet-edge geometry that stair-steps. No uniform refinement fixes this.
3. **Scaling & conditioning.** Jacobi-CG is a weak preconditioner for the air↔iron ×1000
   contrast (~300 iters even linear), and the global-saturation scaling (s up to ~2.7e4)
   makes the corrective solve brutally ill-conditioned (~700 iters, 27 ms/solve at only
   3072 DOF). It does not scale to FEA-quality meshes.

A correct engine needs **conforming geometry + local saturation + an exact, scalable
solver**. Steppers force the issue: VR/hybrid/PM steppers are *built* with mismatched
rotor/stator teeth and have **zero alignment symmetry**, so we cannot reduce DOF via
one-pole anti-periodicity — the full annulus (~10k–50k DOF) must solve fast.

---

## 2. The solver decision — measured evidence

All benchmarks below use a representative 2-D 5-point operator (air↔iron ×1000 contrast,
SPD, θ-periodic or square), built and timed in `_solver_bench/`. Node v26, WASM via
Emscripten 5.0.7.

### 2.1 The bottleneck is the *ordering*, not the factorization

An ngspice `spMatrix` port (Markowitz threshold-pivoted sparse **LU**, from
`digital_in_browser`) on the 5-point operator, measured:

```
 N        order+factor   refactor(reuse order)   solve
 2,500       107 ms              7 ms            4.70 ms
 12,100     1,583 ms           111 ms            3.35 ms
 24,964         —                —                 —
 32,400    10,267 ms           403 ms           14.72 ms
 50,176    28,392 ms           979 ms           34.37 ms
```

Factor scales **~N^1.9** (near-quadratic). The cost is the **Markowitz ordering**
(O(N²)-ish pivot search), tuned for small, low-fill circuit matrices — the θ-periodic
wrap and 2-D fill defeat it. (Note: an earlier "10-minute hang" was *my* bug — a missing
`_initStructure()` call sent `factor()` into an infinite loop; once driven correctly the
solver is fine, just badly-ordered.)

### 2.2 Symbolic fill / flop analysis (validated vs dense Cholesky)

Elimination-tree + column-count symbolic factorization (`_solver_bench/symbolic2.js`),
**validated to match a dense Cholesky fill exactly**, comparing natural (lexicographic)
vs geometric nested-dissection ordering:

```
                  nnz(L)                    factor flops
  N         natural      nested-diss     natural     nested-diss
  2,500       125,049         48,561      6.33e6        1.68e6
  12,100    1,331,109        325,409      1.47e8        2.12e7
  50,176   11,239,647      1,706,721      2.53e9        1.94e8
```

- Natural: `flops ~ N^2.0`, `nnz(L) ~ N^1.5`.
- Nested dissection: `flops ~ N^1.58`, `nnz(L) ~ N^1.19`.
- Natural's N^2.0 matches the measured ngspice N^1.9 → **Markowitz fill is essentially
  natural-grade** on this matrix.
- At 50k: ND has **13× fewer flops** and **6.6× less fill** than natural; the gap widens
  as ~N^0.4.

The advantage is structural and definite; **ordering is the entire lever**.

### 2.3 Measured Eigen `SimplicialLDLT` (AMD ordering) — the real numbers

A thin Emscripten build of Eigen's `SimplicialLDLT<SparseMatrix<double>, Lower>` (AMD
ordering by default), exposing the **symbolic / numeric split** —
`analyze()` (ordering+symbolic, once) / `factorize()` (numeric, per value-change) /
`solve()` — built in `_solver_bench/` (`wrapper.cpp` → `solver.mjs` + `solver.wasm`).
Measured (`bench_wasm.mjs`):

```
 N        analyze(AMD+symbolic)   factor1   refactor(numeric)   solve     L-nnz       residual
 2,500          1.8 ms            1.5 ms        0.81 ms        0.42 ms      38,483     7.8e-11
 12,100         3.1 ms            6.7 ms        6.34 ms        0.89 ms     261,044     8.2e-11
 24,964         6.4 ms           22.8 ms       23.2  ms        1.39 ms     632,598     9.9e-11
 40,000        10.7 ms           45.8 ms       48.3  ms        2.48 ms   1,099,835     1.5e-10
 50,176        20.2 ms           95.7 ms       66.5  ms        3.21 ms   1,416,982     1.4e-10
```

- `analyze` (AMD+symbolic): **20 ms at 50k**, ~one-time.
- `refactor` (numeric, reusing symbolic): **66 ms at 50k**, scales **~N^1.5** (the
  theoretical sparse-Cholesky rate; confirms §2.2's flop prediction — measured L-nnz
  1.42M ≈ predicted 1.71M, AMD marginally better than geometric ND).
- `solve`: **3.2 ms at 50k**, ~N^0.7 (trivial).
- residual ~1e-10 → **exact and conditioning-immune** (the ×1000 contrast that crippled
  Jacobi-CG is a non-issue for a direct factorization).

### 2.4 Apples-to-apples at 50,176 DOF (both columns measured)

| Phase | ngspice Markowitz | Eigen SimplicialLDLT / AMD | speedup |
|---|---|---|---|
| order + symbolic | 27,413 ms¹ | **20.2 ms** | **~1,360×** |
| numeric refactor | 979 ms | **66.5 ms** | **~15×** |
| solve | — | **3.2 ms** | — |

¹ ngspice cold (28,392) − its refactor (979).

### 2.5 Decision

**Sparse Cholesky with an AMD / nested-dissection ordering, using the analyze-once /
factorize-per-step split.** Eigen `SimplicialLDLT` (WASM) is the validated reference
implementation. The field block is solved SPD-exact; ordering is one-time; per-step cost
is a numeric refactor (only when values change — rotor motion via the harmonic gap does
*not* change the pattern; saturation Newton iterations do) plus a cheap solve.

Rejected: Jacobi/MG-CG iterative (conditioning-sensitive, inexact), Markowitz LU (ordering
O(N²)), recompute-per-change Cholesky (wastes nothing here since `analyze` is split out).

**Realtime budget (WASM), by mesh size — N^1.5 projection from the measured 50k:**

| Case | DOF | refactor | full Newton step (3–5×) | steady spin (reuse/Schur) |
|---|---|---|---|---|
| Symmetric, pole-reduced (PMSM/BLDC) | ~2–4k | ~1–2 ms | ~10 ms (~100 fps) | solve-only, ~sub-ms |
| **Realistic stepper, full annulus** | **~8–12k** | **~4–7 ms** | **~25–35 ms (~30 fps)** | ~1–7 ms (140–1000 fps) |
| Stress ceiling (over-fine grading) | 50k | 66 ms | 200–330 ms (3–5 fps) | 3 ms solve |

The realistic operating point is interactive (~30 fps full-nonlinear; far higher in steady
spin, since saturation is ~periodic and the factorization is reused — full Newton-every-frame
is the *transient* worst case). The ~30 fps already bakes in the two **structural** levers
(grading + warm-start) and the steady-spin column adds **θ-reuse**; the **unspent reserve**
(modified Newton, then CHOLMOD) is *not* in these numbers (see tiers below). **50k is a
stress ceiling reached only by over-grading** (capped by the §8-M5 DOF budget); if hit, it is
the trigger for that reserve, not the expected experience. These are projections from the
5-point grid proxy — re-measured on the real mesh at §7.

**WASM tax — measured (not estimated).** The same Eigen code compiled natively (MinGW
g++ 13.2 `-O3`) on the same 50,176-DOF operator: analyze 13.0 ms, refactor 50.4 ms, solve
2.36 ms — i.e. WASM is only **~1.3× slower on the dominant numeric refactor** (1.15–1.45×
across sizes), ~1.55× on analyze, ~1.36× on solve. Identical residual and L-nnz (same
factorization). So the browser tax is ~30 %, **not** the 2–4× originally guessed.

**Native — decided against for the product** (browser-only deployment; measured tax just
~1.3×). A native Node N-API addon is only relevant for a hypothetical server/Electron path
(moderate effort: `binding.gyp` + node-gyp + N-API glue + prebuilds).

**Supernodal CHOLMOD — a real win, but the browser build cost is the blocker.** A symbolic
supernode analysis (`symbolic3.js`) corrects an earlier wrong assumption ("2-D supernodes
are small"): on the ND-ordered operator, **~82 % of factorization flops at 50k sit in
supernodes ≥16 columns wide** (20 % @16-31, 32 % @32-63, 27 % @64-127; maxWidth 224), and
the share *grows* with N (64 % @12k → 82 % @50k). Fundamental supernodes here, so CHOLMOD's
relaxed ones are wider still — this understates the opportunity. So BLAS-3 has a large
target. Estimated (flop concentration exact; rates assumed — simplicial measured ~3.4
GFLOP/s, BLAS-3 native ~30–50, WASM-SIMD only ~6–10): **native CHOLMOD refactor ≈ 17 ms
(~3× vs Eigen's 50)**; **WASM ≈ 28 ms (~2.3×)** — throttled because WASM has no fast f64
BLAS. Native is a clean ~3× drop-in (Eigen `CholmodSupernodalLLT` wrapper + OpenBLAS) but
not browser-shippable; WASM requires compiling **CHOLMOD + BLAS + METIS to WASM**
(research-grade, no maintained port) for ~2×.

**Verdict / pare-back tiers.** Ship **Eigen `SimplicialLDLT`** (header-only, no BLAS, AMD,
symbolic/numeric split, within ~30 % of native). The levers cut the *number* of refactors,
not the cost of each — and they sit in three tiers **by commitment**, which matters for
reading the §2.5 budget honestly:
- **Already structural (the budget assumes them):** **mesh grading** — the §8 mesher is
  graded by construction, which is *why* the realistic mesh is ~10k not 50k; and
  **warm-start** — the FEA slice seeds Newton from the previous step (fewer iterations).
- **Standard operating mode (the "steady spin" column; ~free given the harmonic gap):**
  **factorization reuse across θ** — rotation = phase doesn't change the interior operator,
  so skip refactoring while saturation is static (light form trivial; the full Schur form is
  §9-G5, measurement-gated, §11.4).
- **Unspent reserve (the baseline §3.6 loop does NOT use these):** **modified Newton** (reuse
  one `factorize` across Newton iters → ~2–3× fewer refactors), then last-resort **CHOLMOD**
  (native clean ~3×; WASM research-grade ~2×, only if §11.4's criterion is met).

So the **~30 fps full-Newton figure already spends grading + warm-start but NOT
modified-Newton or θ-reuse** — those are genuine unspent headroom lifting it toward the
steady-spin column. Hold CHOLMOD for a native/server path (clean 3×), or a WASM build only
if the reserve levers fall short (§11.4).

---

## 3. Target architecture

A genuine 2-D motor FEA. The solver result above makes two design choices **mandatory**
rather than merely preferred (see §3.3, §3.6).

### 3.1 Mesh — conforming, graded, per body

Two independent body meshes (rotor, stator). Element type follows the mesher chosen in
§3.2 — **quad-dominant** (structured bands + gap ring) with triangles only where a quad
band can't close; assembly handles mixed quad/tri:

```
Body { nodes: {x,y}[],                 // body-local frame
       elems: { n:[...], matId, srcId }[],   // 4 nodes (quad) or 3 (tri)
       boundary: { gap: nodeIdx[], outer/inner: nodeIdx[] } }
Material { matId -> nu(B) }             // constant ν, or a B–H curve handle
Magnet   { elemId -> Mr:{x,y} }         // remanence vector (rotates with rotor)
Source   { elemId -> circuitId }        // conductor -> circuit
```

Conforming nodes land *on* slot openings, tooth tips, magnet edges, fillets — killing the
stair-stepping that caps cogging/gap accuracy. Grading packs elements into the gap and
tooth tips, coarsens the yokes (accuracy per DOF; no more `Ntheta=256` everywhere).

### 3.2 Mesher — constraint regime, evidence, decision

**Constraint regime (decides what's even allowed).** Meshing is *not* per-frame (rotation
runs on a fixed mesh via the harmonic gap) but it **is generative and open-ended**, so it
**must run in-browser** on a topology edit. The model (per the codebase) is NOT a fixed set
of machine types: each body (rotor/stator) is a **stack of concentric rings**, each ring
typed ∈ **{I iron, M magnet, W distributed-wound, C concentrated-wound, K cage/wound}**
(`config-schema.js:64-80,427`), with global **poles** (even ≥2) and per-ring
**teeth/magnets/slots(Q)** counts. Winding `m`/`turns`/`coilPitch` are routing (source
vector + material tags), **not** mesh. The 15 `machines/*.js` fixtures are *demo instances*
of this generator, not an enumerable type list.

Because the space is a **variable-length ring-stack × 5 types × integer counts**, it is
**open-ended — offline pre-baking the machine space is precluded** (you cannot enumerate a
variable-length product). The mesher must therefore be an **in-browser generator**, run on
a topology *edit* (`requestRebuild`; interactive, ~sub-second — not 60 fps). Consequences:
- **Offline meshes to keep ≈ 0 as a strategy.** Generation is O(N) band fills, ~1 ms for a
  few-thousand-element body — nothing to pre-bake. Keep ~15–20 demo configs only as a
  first-paint warm cache + regression fixtures (a test asset, not the runtime path).
- **Cache per body, not per machine.** The harmonic gap decouples rotor/stator, so meshing
  *and the ~20 ms symbolic `analyze`* are per-body → caching is **additive** (rotor + stator
  signatures), never **multiplicative** (rotor×stator). LRU ~8 per body ≈ 1–2 MB RAM; the
  valuable cached item is the symbolic ordering (20 ms), not the 1 ms mesh.
- **Topology edit ⇒ re-`analyze`** (~5–20 ms at 5–15k DOF, cached by body-signature);
  **rotation ⇒ refactor only** (fixed pattern). Keeps the ordering off the per-frame path.
- **gmsh demotes to a dev-time validation oracle** — no browser build means it can never be
  the runtime fallback, so the custom in-browser generator must cover the whole space
  (a ring-stack design does: each type is a band template, counts set angular divisions).

**The air gap disqualifies isotropic meshing (quantified).** The gap needs ≥4 radial
layers across it *and* ~0.5 mm tangential resolution (cogging). Structured/anisotropic
meets both independently; isotropic is forced to the finer spacing in *both* axes, so its
gap DOF scale as **1/gap** while structured is gap-independent (mid-gap R≈45 mm, Q=12):

```
 gap(mm)   isotropic gap nodes   structured gap nodes   penalty
   4.0          ~1,300                 ~2,800           none (teaching-exaggerated gap)
   1.0          ~5,200                 ~2,800           1.8x
   0.5         ~10,400                 ~2,800           3.7x
   0.25        ~20,900                 ~2,800           7.4x  ...grows as 1/g
```

Current fixtures use a teaching-exaggerated **4 mm** gap (so isotropic doesn't bite today —
and the current engine's gap *geometry* isn't its main sin; saturation + material-straddling
are). But the rebuild's purpose is **realistic 0.5–1 mm gaps for correct cogging** — exactly
where isotropic costs 2–7×+ and climbs without bound.

**Survey verdict (verified npm/source, 2026-05-26).** Pure-JS libs (poly2tri, cdt2d,
delaunator, earcut) have **no min-angle/quality guarantee** (no Steiner refinement →
slivers; linear-triangle B-field error blows up as max angle → 180°, Babuška–Aziz) → out
as final FEM meshers. **`triangle-wasm`** is the only in-browser tool with a real quality
bound (Shewchuk/Ruppert) but is **isotropic** (gap blowup) and yields **irregular gap-node
angles** (bad for the harmonic interface, which needs uniform-Δθ rings); also unmaintained
(2020) and non-commercial-licensed. **gmsh** is the only off-the-shelf tool meeting every
need (anisotropic boundary layers + conforming subdomains + quads + quadratic) but is
**GPLv2+** (OK if we ship only mesh JSON), has **no maintained browser/WASM build**, and
needs a `.geo`→`.msh`→JSON pipeline. The harmonic interface (§3.3) *independently* requires
a **structured uniform-Δθ gap ring** regardless of mesher.

**Decision: custom parametric in-browser motor mesher (required — there is no runtime
fallback).** Because the geometry space is open-ended (variable ring-stacks), the mesher
*must* generate at runtime, so an offline tool cannot be the product path. A motor
cross-section is intrinsically structured (concentric ring bands; periodic slots/teeth/
magnets), so a templated quad-dominant ring-stack mesher delivers — by construction, no
dependency, no GPL, no pipeline — the four things every off-the-shelf option misses
*together*: graded **anisotropic gap layers**, **structured uniform-Δθ gap rings**
(harmonic-ready), **material-conforming bands**, and **near-90° angles** (so no Ruppert-style
quality bound is needed). Each ring element type (I/M/W/C/K) is a band template; integer
counts (poles/teeth/slots/magnets) set angular divisions — which is exactly the generative
model the codebase already uses, so the mesher consumes the existing config directly.

**gmsh is a dev-time validation oracle only**, not a fallback: no browser build means it
can never serve the runtime generative path. Use it offline to produce a few reference
meshes and diff the custom mesher's output (quality, conformity, gap layering) against them.
The custom mesher must therefore cover the *whole* generative space itself; the line to
watch is exotic per-ring shapes (heavy skew, irregular slot profiles) — handle them by
extending the band templates, not by swapping mesher.

**No offline mesh store.** Generation is ~1 ms/body; cache per body-signature in RAM (LRU
~8 rotor + ~8 stator, ~1–2 MB), caching the ~20 ms symbolic `analyze` alongside the mesh.
Keep ~15–20 demo configs on disk only as first-paint warm cache + regression fixtures.

**DOF feedback to the solver.** A realistic *graded* cross-section ≈ gap ring (~2.8k nodes)
+ iron bands ≈ **5–15k DOF**, not 50k (the 50k was the zero-symmetry full-annulus stress
case). At 5–15k the measured Eigen refactor is **~5–15 ms** — comfortably realtime, pare-back
levers (§2.5) still in reserve. Grading + anisotropic gap keep DOF modest *by construction*,
the cheapest perf lever (refactor ~N^1.5).

### 3.3 Sliding interface (rotor motion)

| Method | Capability / accuracy | Per-θ cost | Verdict |
|---|---|---|---|
| **Air-gap harmonic coupling** (air-gap element / Fourier DtN) | Source-free gap → θ-Fourier series; rotor/stator boundary harmonics couple analytically. **Rotation = phase multiply e^{jkθ} — exact at any angle, no remesh, no interpolation error.** Spectrally accurate gap; torque from harmonics. Assumes annular gap (true for radial-flux). | Trivial (phase update). **Low-rank** harmonic border — `2(2K+1)` DOFs, *not* a dense N_gap×N_gap block (see §3.3 detail / §9). | **Required for us.** Zero rotation noise (cogging!), **and it keeps the sparsity pattern fixed under rotation** → `analyze` stays one-time (see §3.6). |
| **Mortar / Lagrange** | Couples non-matching meshes; small projection error. | Recompute 1-D overlap integrals (cheap); adds λ DOFs → **saddle-point (indefinite)** system. | Fallback; **breaks SPD Cholesky** (indefinite) — avoid for the main path. |
| **Moving band** | Remesh a thin gap strip each θ. | Cheap remesh, but **changes the sparsity pattern each θ** (re-`analyze` every step) **and** injects torque-ripple noise. | **Avoid** — defeats analyze-once and corrupts cogging. |

The measured solver data turns the harmonic-gap preference into a hard requirement: a
moving-band remesh would force a 20 ms+ re-`analyze` every rotor step (and worse on
unstructured AMD), and mortar's indefinite saddle-point kills the SPD Cholesky path.

**There is no sliding *mesh*.** The two body meshes never change connectivity and never
share nodes; rotation is a single phase parameter in an analytic coupling. Mechanics:

- **Clean circular boundaries.** Each body extends past its conforming iron/magnet/tooth
  surface through a thin **structured air collar** to a **uniform-Δθ circle** in the gap —
  rotor at `r_mr`, stator at `r_ms` (`r_mr < r_ms`). The annulus `[r_mr, r_ms]` is **not
  meshed**; it is the analytic air-gap element. Uniform Δθ ⇒ the projection is a plain
  **FFT** (orthogonal, well-conditioned), not a least-squares solve. The collar is pure air,
  so the feature-conforming→uniform angular transition inside it is harmless.
- **Exact, per-harmonic coupling.** In the source-free gap, `A_z` solves Laplace; the
  2π-periodic solution per harmonic `k` is `α_k r^{|k|} + β_k r^{-|k|}` (+ `α_0 + β_0 ln r`).
  Laplace **decouples per harmonic**, so the boundary-`A`→boundary-flux (Neumann/admittance)
  map is **diagonal in the Fourier basis**: each `k` gets a 2×2 `M_k(r_mr, r_ms, k)` relating
  `(Â_rotor,k, Â_stator,k)` to the surface fluxes. That 2×2-per-harmonic admittance *is* the
  air-gap element's stiffness — exact (analytic, not discretized) and cheap (block-diagonal).
- **Rotation = phase.** Rotor harmonics live in the rotor frame (`θ' = θ − φ`), so they
  enter the lab frame multiplied by `e^{±ikφ}`. Rotation multiplies only the rotor↔stator
  cross terms of each `M_k` by `e^{±ikφ}`: the **sparsity pattern is unchanged**, only values
  phase-rotate → `analyze` stays one-time. Cogging is ripple-free (spectral gap, no moving-
  band interpolation).
- **Low-rank assembly (no dense block).** Retain `k = −K…K`, `K ≪ N_gap` (K set by slot/pole
  harmonics + margin). Augment the system with `2(2K+1)` harmonic DOFs `{Â_rotor,k,
  Â_stator,k}`; couple each circle's nodal `A` ↔ its harmonics by FFT; couple
  `Â_rotor,k ↔ Â_stator,k` per-`k` via `M_k(φ)`. Result: a **bordered sparse system**
  (sparse interiors + small structured harmonic border), `φ` confined to the tiny harmonic
  core — *not* a dense N_gap×N_gap block.
- **Rotation-cost lever.** (a) Factor the bordered system; refactor per saturation step.
  (b) **Schur-condense the interiors** — they are rotation-independent (each in its own
  frame), depending only on `ν`, so condense each onto its gap circle once per saturation
  state and per angle solve only the tiny harmonic core ⇒ **rotation nearly free**. This is
  the exact, structural form of §2.5's "reuse factorization across θ" lever. Choose (b) when
  the rotor spins faster than saturation changes (common); (a) under heavy per-step
  nonlinearity. A measured call on a real mesh.
- **Torque, for free and ripple-free.** Maxwell stress on the mid-gap circle is a clean
  harmonic sum (`∝ Σ_k k·Im(Â_rotor,k Â*_stator,k)`) from the same coefficients — the
  cogging-accuracy payoff. Build it (§9 G4) and cross-check against an Arkkio volume torque
  on a meshed-gap reference.

### 3.4 Assembly + circuit coupling

- **FEM assembly = sparse stamping.** Per element, local stiffness `k_e = ∫ ν ∇Nᵢ·∇Nⱼ`
  and load (Jz from circuits + magnetization/remanence) scatter into the global sparse
  matrix (triplets → CSC). Trivial to feed the solver.
- **Non-linear B–H = Newton:** each iteration re-stamps the tangent reluctivity + residual;
  the **pattern is fixed**, so reuse the symbolic `analyze`; only `factorize` repeats.
- **Circuit coupling — staggered inductance extraction (NOT coupled-MNA).** The live
  pipeline already decouples field and circuit, and we keep that: each step (a) *probes* the
  field with unit-current + magnetization-only **linear** solves to extract `L(θ)`, `dL/dθ`,
  `λpm(θ)`, `dλpm/dθ` (`MotorCircuit.extract`); (b) integrates the small dense circuit ODE
  separately (`MotorCircuit.advance`); (c) does the saturated field solve for torque. No
  monolithic field+circuit matrix. The field block stays pure SPD (→ Cholesky). FEA makes
  the `m+1` probe solves cheap: all reuse one factorization, and rotation-as-phase lets the
  3 finite-difference angles share the interior factorization too. (Optional later: `dL/dθ`
  analytically from the `ik·e^{ikφ}` phase derivative — exact, no finite difference.) See
  §10 for the full integration.

### 3.5 Non-linear saturation (local B–H)

Replace the global single-`s` ceiling with **per-element ν(|B|)** from a B–H curve, solved
by **Newton**. Representation (locked, §11.3): the **Brauer model**
`ν(B²) = k1 + k2·exp(k3·B²)` per iron material, with analytic `dν/d(B²)` for the tangent;
`k1 = 1/(μ0·muR)` and `k2,k3` fit to the existing `Bknee` (override `{k1,k2,k3}` allowed).
Magnets linear (recoil `μr` + remanence); air/conductor `ν = 1/μ0`. This is the accuracy fix
for cogging/regional saturation. Note: the current
polar grid *does* already mesh all the iron (rotor yoke, magnets, stator yoke) — local
saturation needs no re-spec there — but the radial resolution is too coarse (back-iron =
4 cells); the conforming graded mesh (§3.1) is what makes local B–H actually resolve.

### 3.6 Solver integration

```
ONE-TIME (per geometry / topology edit):
  build mesh (§8)                 // ring-stack generator
  assemble pattern + harmonic gap // §9; pattern is FIXED by the gap
  analyze()                       // AMD ordering + symbolic, ONCE (~20 ms @ 50k)

PER ROTOR STEP θ — inside the EXISTING motor-run loop (§10), unchanged:
  set harmonic-gap phase φ=θ      // pattern unchanged, NO remesh
  Newton loop (if saturating):
     stamp tangent + residual (values only)
     factorize()                  // numeric, reuse symbolic (~66 ms @ 50k)
     solve()                      // (~3 ms @ 50k)
  torque = harmonic (§9-G4), Arkkio cross-check
```

The circuit is **not** in this field loop: `extractCoeffs` (probe solves) → `MotorCircuit`
ODE → field solve is the existing **staggered** path (§3.4, §10), not a coupled-MNA/Schur
system. The **fixed sparsity pattern** (from the harmonic gap) is what keeps `analyze`
one-time — the single most important structural decision, backed by the measured
20 ms-vs-27 s ordering gap.

---

## 4. Build sizing (honest)

| Piece | Effort | Notes |
|---|---|---|
| Parametric conforming mesher (config → graded mesh) | **Large** | The big one. Custom in-browser ring-stack mesher — decided (§3.2, §8). |
| FEM assembly + B–H Newton | Moderate | Standard; element stiffness, tangent reluctivity. |
| Sliding interface (harmonic gap) | Moderate–large | Elegant but needs the harmonic gap derivation; moving-band is easier but rejected. |
| Solver integration | **Done (prototype)** | Eigen `SimplicialLDLT` WASM exists & is validated; needs production wrapper + CSC marshaling. |
| Circuit coupling on the mesh | Moderate | Staggered inductance extraction (existing `MotorCircuit`); mesh-element `Jz`/`λ`/`L` probes. **No** coupled-MNA/Schur (§3.4). |

It is a real FEA core — multi-week — but every piece is standard, and the foundation makes
accuracy (conforming geometry + local B–H) and performance (exact AMD-ordered direct solve
+ analyze-once + harmonic rotation) fall out together instead of fighting on the grid.

---

## 5. Caveats / open questions

- Solver numbers are the **5-point grid test operator**; a real unstructured mesh differs
  in constant factors (AMD handles arbitrary connectivity natively — which is exactly why
  it suits a stepper's geometry).
- **WASM tax is ~1.3×** (measured, §2.5), not the 2–4× first assumed. Eigen `SimplicialLDLT`
  is the shipping choice. Supernodal CHOLMOD is a real ~3× native / ~2× WASM win (82 % of
  flops are in wide supernodes — §2.5) but the WASM build is research-grade; prefer the
  refactor-count pare-back levers (§2.5) in-browser, hold CHOLMOD for a native path.
- Numbers are **single-thread**; the refactor could thread.
- The Newton-per-step refactor count drives the realtime budget; the harmonic gap (air,
  never saturates) means the gap coupling itself is permanently reusable — only the
  saturating bodies' interior changes per Newton iteration.
- A pole-symmetry fast path is still worth keeping for symmetric machines (PMSM etc.) — it
  isn't *required* given the 50k numbers, but it's free margin where geometry allows.

---

## 6. Artifacts

In `C:\local_working_projects\_solver_bench\` (scratch, outside the repo):

- `wrapper.cpp` — Eigen `SimplicialLDLT` C ABI (`setMatrixTriplets` / `analyze` /
  `factorize` / `solve` / `factorNnz`). *(Carries debug `printf`s used for the SAFE_HEAP
  diagnosis; strip for the production artifact. Build needs `-sSTACK_SIZE` raised — the
  default 64 KB WASM stack overflows Eigen's AMD ordering; 64 MB used here.)*
- `solver.mjs` + `solver.wasm` — built module (Emscripten 5.0.7, `-O3`, 64 MB stack).
- `bench_wasm.mjs` — the §2.3 benchmark.
- `symbolic2.js` — the §2.2 validated symbolic fill/flop analysis.
- `eigen-3.4.0/`, `emsdk/` — Eigen headers and the Emscripten SDK.

Reproduce: `source emsdk/emsdk_env.sh && node bench_wasm.mjs`.

---

## 7. Next steps

1. **Integration scaffold (§10):** add `opts.engine` dispatch at `MotorSlice.create` + a stub
   `MotorSliceFEA` + dev toggle; confirm the grid path still runs unchanged. Keeps the app
   live while FEA lands.
2. Build the **custom parametric in-browser mesher** (§8) + its canvas visualizer (which
   becomes the production mesh render, §10 R1). Decided; not an open question.
3. Stand up **FEM assembly + local B–H** on a single static rotor — proves geometry/accuracy,
   yields the real DOF count + matrix structure.
4. Re-run the solver benchmark on *that* unstructured matrix (vs the grid proxy) to confirm
   constant factors.
5. Add the **harmonic-gap sliding interface** (§9) and wire `extractCoeffs`/torque/flux-linkage
   through the FEA slice (§10).
6. **Mesh-native render** R2–R5 (field overlay, diagnostics, rotor rotation, analytic gap).
7. **Validate** (§10): convergence + analytic refs + cross-method torque + meshed-gap ref +
   known-machine behavior — *not* against the grid.
8. **Cutover:** flip the default engine to FEA, delete the grid path (`airgap-grid/solve/
   refine`, grid branch of `motor-slice`, `FieldRender.drawGapField`) + the `opts.engine` flag.
9. Productionise the Eigen WASM wrapper (strip debug, CSC marshaling, memory discipline);
   evaluate a native/supernodal path only if the realtime budget demands it.

---

## 8. Mesher build plan (LOCKED)

**Core idea.** `config-schema.js` already compiles geometry → a per-ring **feature list**
(`{kind: iron|magnet|conductor, rRange, angular count/positions}`). The current engine
*rasterizes those features onto a fixed `Nr×Nθ` polar grid* — the source of boundary
straddling. The mesher **replaces only that rasterizer step**: same feature input, but emits
a **conforming, graded, quad-dominant mesh whose element edges lie on the feature
boundaries**. Nothing upstream changes; the new path is validated against the same feature
decomposition. Generation is O(N): a body is **periodic in θ** (stator = slot pitch 2π/Q,
rotor = pole/tooth pitch), so mesh **one angular sector as a structured (r,θ) block, tile
it, map to Cartesian**. Rotor and stator mesh independently (harmonic gap couples them; no
shared nodes) → steppers' mismatched counts are a non-issue.

**Mesh contract (what assembly + interface consume):**
```
BodyMesh {
  nodes:  Float64Array(2·Nn)   // x,y, body-local frame
  elems:  Int32Array(4·Ne)     // CCW node indices; tri = repeat last (or -1)
  matId:  Int32Array(Ne)       // iron | air | magnet | conductor-slot
  srcId:  Int32Array(Ne)       // circuit/conductor id, else -1
  magDir: Float64Array(2·Ne)   // remanence unit vector for magnet elems, else 0
  gapLoop:  Int32Array         // ordered nodes on the uniform-Δθ mid-gap CIRCLE (collar edge)
  gapTheta: Float64Array       // θ per gapLoop node (uniform); gapR = the circle radius
  sig:    string               // topology signature → cache key (mesh + symbolic analyze)
}
```
Two per machine (rotor, stator) + gap-circle radii (`r_mr`, `r_ms`). `gapLoop` is **a
uniform-Δθ circle in the air gap**, not the jagged iron surface: each body is extended past
its conforming surface through a thin **structured air collar** to that circle (rotor→`r_mr`,
stator→`r_ms`), so the harmonic interface (§3.3) gets clean circular boundaries with
FFT-able uniform sampling. The annulus between the two circles is **not meshed**. `gapLoop`
is the only thing §3.3 needs; everything else feeds assembly (§3.4).

**Generation (per body):** (1) radial node lines from ring/`ironRRange` sub-band edges,
geometric grading dense→gap; (2) angular sector template per ring type — `I` uniform iron,
`M` magnet segments + inter-magnet air + alternating `magDir`, `W` yoke + teeth/slots +
conductor cells, `C` salient tooth per coil, `K` slots + bar conductors; (3) tile sector ×
period to 2π; (4) map (r,θ)→Cartesian (near-90° quads by construction → no quality bound
needed); (5) extend each body through a **structured air collar** from its conforming gap
surface to a **uniform-Δθ circle** (rotor→`r_mr`, stator→`r_ms`) and emit that circle as
`gapLoop`. The collar (pure air) absorbs the feature-conforming→uniform angular transition;
its uniform outer circle is the harmonic interface's required boundary (§3.3, locked).

**Milestones (each renders to canvas, independently checkable):**
- **M0** — `BodyMesh` struct + canvas visualizer (elements by `matId`, gapLoop overlay).
- **M1** — single iron annulus: graded annular quads → Cartesian; no inverted/degenerate
  elems, area = annulus, min-angle report.
- **M2** — ring stack + gap: radial layering, conforming ring interfaces, graded gap layers,
  rotor+stator.
- **M3** — angular feature templates: (a) `M`+`magDir`, (b) `W` yoke/teeth/slots/conductors,
  (c) `C`, (d) `K`. Validated by **feature-coverage diff** vs `config-schema`.
- **M4** — air collar + uniform-Δθ mid-gap circle per body; emit `gapLoop` (uniform nodes +
  θ + `gapR`). This is the §3.3 / §9-G0 handoff.
- **M5** — quality + grading knobs (gap-layer count, yoke-coarsening, DOF budget; min-angle/
  aspect report).
- **M6** — per-body signature + LRU cache (mesh now; symbolic `analyze` once solver lands).
- **M7** — validation harness: gmsh reference diff (dev oracle) + field/torque convergence
  under refinement.

**Validation (three independent checks):** (1) canvas visual every config; (2) automatic
**feature-coverage diff** — every `config-schema` feature exactly tiled, no straddling;
(3) gmsh oracle + convergence.

**Location / scope.** Plain JS (no modules), `lib/motor-mesh.js` (+ `lib/motor-mesh-view.js`
for M0), consuming the existing compiled config. **Out of scope here:** FEM assembly (§3.4),
harmonic gap (§3.3), B–H Newton (§3.5). gmsh is a **dev-time validation oracle only** (no
browser build → never a runtime fallback); the custom mesher must cover the whole generative
space via band templates.

---

## 9. Sliding-interface build plan (LOCKED)

The analytic air-gap harmonic coupling of §3.3. No sliding mesh — rotation is a phase
parameter. Built entirely from the two `gapLoop`s (uniform-Δθ circles) + radii + harmonic
truncation `K`. Plain JS, `lib/airgap-harmonic.js`.

**Inputs / outputs.** In: rotor & stator `gapLoop`/`gapTheta`/`gapR`, `K`, angle `φ`. Out:
the bordered coupling (FFT projection per circle + per-`k` 2×2 `M_k(φ)` core) stamped into
the assembled system over the gap-circle DOFs + `2(2K+1)` harmonic DOFs; plus a torque
readout from the harmonic coefficients.

**Steps (slot alongside the mesher milestones):**
- **G0** — consume M4's air collar + uniform circle; fix `gapR`, `N_gap`, choose `K`
  (`K ≪ N_gap`, set by slot/pole harmonics + margin).
- **G1** — FFT projection per circle (nodal `A` ↔ harmonics `Â_k`) from uniform `gapTheta`;
  verify round-trip (inverse FFT) to machine precision.
- **G2** — per-harmonic 2×2 admittance `M_k(r_mr, r_ms, k)` from the annulus `r^{±k}`
  solution; assemble the **static-rotor (φ=0)** bordered system. **Correctness oracle:**
  mesh the gap annulus once explicitly, solve, and diff fields against the harmonic coupling.
- **G3** — add the `e^{±ikφ}` phase on the rotor↔stator cross terms. **Load-bearing
  assertion: the sparsity pattern is φ-invariant** (same nonzero set for all φ); confirm the
  field rotates correctly vs a remeshed-at-φ reference.
- **G4** — torque from gap harmonics (`∝ Σ_k k·Im(Â_rotor,k Â*_stator,k)`); cross-check
  against an Arkkio volume-integral torque on a meshed-gap reference.
- **G5** — (only if the rotation budget needs it) Schur-condense the interiors (rotation-
  independent) once per saturation state; per-`φ` solve only the harmonic core ⇒ near-free
  rotation. Decide by measurement on a real mesh.

**To measure (none blocks starting):** harmonic truncation `K` + projection conditioning;
embed-vs-Schur (G5); collar layer count and circle radii `r_mr`/`r_ms`. Each has a fixed
measure-and-threshold criterion in **§11.4** — mechanical, not a re-escalation.

---

## 10. Integration with the live pipeline (LOCKED)

**Seam: `MotorSlice` is the engine boundary.** Everything above it — `MotorStack`,
`MotorRun`, `MotorCircuit` (circuit ODE), `Excitation`, the mechanical integrator, mount —
consumes only the slice API and is **untouched**. The grid `SolveBackend`/`GridOperator`
(`op`) is grid-shaped (`setRotorAngle` by angular-index interpolation, `.Nr/.Ntheta/.dtheta/
.r/.dr`, `radialCoeffs`, `field()` on cells) and is **not** a usable abstraction for FEA; we
do not generalize it. The FEA engine implements the `MotorSlice` contract directly.

**The grid engine is replaced, not kept.** It is verified unsuitable (global-saturation
inaccuracy, material straddling). It is **not** a co-engine, fallback, or correctness oracle.
The grid path — `airgap-grid.js`, `airgap-solve.js`, `airgap-refine.js`, the grid branch of
`motor-slice.js`, and `FieldRender.drawGapField` — is **deleted at cutover**. During the
build it may stay behind a dev `opts.engine` flag purely so the app runs while FEA lands
incrementally; the flag and grid code are removed at cutover.

**Slice contract the FEA slice honors** (signatures unchanged): `solve(θ, currents) →
{torque, fluxLinkages, field}`, `extractCoeffs(θ) → {L, dLdth, lambdaPm, dLambdaPmdth}`,
`coggingTorque(θ)`, `nCircuits`, `clearWarmStart`. (`sliceGrid` is superseded by the mesh —
render reads the mesh directly.)

**Unchanged upstream.** `config-schema`/`expand` already emits `section = {grid, gapBand,
features}` — and `features` (kind/member/rRange/thetaRange/circuit/turns/muR/Mr/Mtheta) *is*
the §8 mesher input, `grid` gives radii, `gapBand` locates the gap. Also unchanged:
`winding-model`, `MotorCircuit`, `Excitation`, mechanical, and **all of multi-slice/skew** —
`stack.solve` passes `θ + offset` per slice and sums torque + flux-linkage; FEA takes that
offset as its harmonic phase, and `fluxSources`/`sliceSigns` are baked into each slice's
`features` upstream ⇒ **zero FEA-specific skew code**.

**Field↔circuit bridge preserved formula-for-formula** (mesh elements ↔ grid cells):
`Jz_elem = Σ_k i_k·turnsDensity_k(elem)`; `λ_k = ℓ·Σ_elem A_elem·turnsDensity_k(elem)·
area_elem`; `L[i,j] = fluxLinkage_i(unit current in j)`. The grid `coilMasks` (turns-density
per cell) become turns-density per element; same `ℓ`, same circuit indexing, same signs.
Coupling stays **staggered** (extract `L,dLdth,λpm,dλpm/dθ` → step circuit ODE → saturated
field solve for torque), not coupled-MNA (§3.4). FEA accelerates the `m+1` probe solves via
factorization reuse (and 3-angle reuse via rotation-as-phase); optional analytic `dLdth`.

**FEA slice internals (`lib/motor-slice-fea.js`):** `prepare(section)` → mesh (§8) +
harmonic interface (§9) + assemble SPD operator + `analyze()` once (cache by topology sig);
`solve(θ,i)` → phase `φ=θ`, `Jz` from currents, Newton (`factorize`/`solve`), torque,
flux-linkages, mesh field; `extractCoeffs` → factorization-reused probes; `coggingTorque` →
zero-current solve.

**Mesh-native render (first-class workstream; replaces the grid heatmap):**
- **R1** — draw the mesh, elements shaded by material (= M0 visualizer, promoted to prod).
- **R2** — field overlay: flux lines = iso-contours of `A_z` marched over elements; `|B|`
  per-element shading.
- **R3** — diagnostics: ν/saturation heatmap, magnetization arrows, current density.
- **R4** — rotation: rotor mesh drawn **rigidly rotated by φ** (body-frame mesh, no remesh);
  stator fixed.
- **R5** — gap: evaluate harmonic `A(r,θ)` **analytically** in the unmeshed gap annulus (from
  the §9 coefficients) ⇒ exact, smooth cross-gap flux lines.
- Integrates with `detailed-toggle` / `cross-section-panel`; retires the grid render path.
  The slice `field` return becomes mesh-native `{Anode: Float64Array(Nn), Belem (mag/vector
  per elem), meshRef}` — no grid sampling/adapter.

**Validation (grid is NOT the oracle):** (1) **convergence under mesh refinement** — the FEA
gold standard; (2) **analytic references** — no-load back-EMF `λpm(θ)·ω`, slotless/Carter
gap field, linear inductance; (3) **cross-method torque consistency** — harmonic (§9-G4) vs
Arkkio vs coenergy agree; (4) **meshed-gap reference** (§9-G2/G3); (5) **known-machine
behavior** — cogging period vs slot/pole LCM, PMSM torque-angle shape. Grid A/B is at most a
transitional ballpark sniff in the linear-unsaturated regime, never an acceptance gate.

**Routes (sequenced).** **A (start):** parallel `MotorSliceFEA.create` returning the same
slice API; `MotorSlice.create` dispatches on `opts.engine` (no edit to the grid path;
`extractCoeffs` logic duplicated ~50 lines). **B (cutover):** delete the grid path; the FEA
slice becomes *the* `MotorSlice`; the `opts.engine` flag is removed. (No permanent two-engine
abstraction — grid has no future.)

**First code step:** add the `opts.engine` dispatch + a stub `MotorSliceFEA` (throws
"not implemented") + dev toggle, confirm the grid path still runs unchanged, then fill the
stub as §8 / §9 / render land. Delete the grid path + flag at cutover.

---

## 11. Handoff — binding constraints & decisions

**Read before planning. §11.3 design decisions are now CLOSED (do not re-open without the
user); §11.4 deferred items each carry a fixed measure-and-threshold criterion (resolve by
benchmark, not escalation). Everything in §0–§10 is settled; do not substitute alternatives,
"simpler" approaches, or fill perceived gaps with your own design. The one remaining true
open item — a current-source terminal for WFS self-start (§11.2) — is explicitly NOT part
of the field-engine work.**

### 11.1 Binding constraints (non-negotiable — violating any is a defect)

1. **Machine-agnosticism invariant** (the project's central rule — see `spec/plan.md`
   "Machine-Agnosticism Invariants"). No FEA code in `lib/` may branch on machine identity,
   a machine name, or a machine-type enum. The mesher and FEA slice dispatch **only** on the
   universal vocabulary — element kind `{W,C,M,I,K}`, terminal/commutation, source scope.
   **Zero-not-skip:** absent physics computes to zero, never a skipped path. The mesher
   consumes the existing `config-schema` feature list (kind-dispatched) and stays agnostic;
   the Phase-10 machine-name audit extends to the new FEA files.
2. **`MotorSlice` is the only integration seam (§10).** Do **not** generalize the grid
   `GridOperator`/`SolveBackend`, and do **not** introduce a second persistent engine
   abstraction. Everything above `MotorSlice` is unchanged.
3. **Rotation is a phase parameter, never a remesh (§3.3, §9).** The sparsity pattern is
   φ-invariant; `analyze` is one-time. Any design that re-meshes or re-`analyze`s per rotor
   step is the rejected moving-band and is wrong.
4. **Field block stays SPD; circuit stays STAGGERED, not coupled-MNA (§3.4, §10).** Extract
   `L,dLdth,λpm,dλpm/dθ` → step the existing `MotorCircuit` ODE → field solve for torque. Do
   **not** assemble a coupled field+circuit matrix or Schur-condense a circuit block into the
   field system. (The phrase "Schur" appears in this doc only for the *optional* interior
   condensation of §9-G5 — a rotation-cost lever, unrelated to the circuit.)
5. **Solver = Eigen `SimplicialLDLT`/AMD, WASM, analyze-once/factorize-per-step (§2).** Not
   iterative; not CHOLMOD (CHOLMOD is a deferred *native-only* option, §2.5). Pare-back
   levers (§2.5) are applied to measured need, not all built speculatively.
6. **Mesher = the in-browser ring-stack generator (§8).** gmsh is a **dev-time validation
   oracle only** — never shipped, never a runtime fallback. No offline mesh store.
7. **Grid engine is deleted at cutover, not preserved (§10).** It is not an oracle; validate
   against physics/convergence (§11.3 / §10-Validation), not against grid output.

### 11.2 Relationship to the existing codebase / `spec/plan.md`

- **Supersedes (delete at cutover):** `lib/airgap-grid.js`, `lib/airgap-solve.js`,
  `lib/airgap-refine.js`; the planned `lib/airgap-nonlinear.js` (Phase-9 grid Picard —
  **cancelled**; the FEA B–H Newton replaces it); the grid-raster role of
  `lib/motor-compile.js` (→ mesh assembly); `FieldRender.drawGapField` (→ mesh render). The
  plan's non-goal **"No CPU unstructured-mesh FEA" is reversed**; the **Live/Detailed
  two-tier collapses** (FEA is one accurate engine; an off-thread worker is *optional*, for
  heavy zero-symmetry configs only — §11.4).
- **Preserves unchanged:** `config-schema.js`, `winding-model.js`, `excitation.js`,
  `motor-circuit.js`, `motor-stack.js`, `motor-run.js`, the four editors, the 15
  `machines/*.js` fixtures, the Phase-0 frozen set, and the Phase-10 audit (allow-list
  updated for the new FEA files). Arkkio + co-energy torque math is reimplemented on the mesh
  as cross-checks.
- **Orthogonal open item, NOT a field-engine task:** the WFS self-start skip needs a
  current-source terminal kind in `excitation.js`. Keep it separate; do not fold it into the
  FEA work.

### 11.3 Resolved decisions (were open — now closed; veto to revisit)

**Element order — Q4 bilinear (linear), start here.** 4-node quads / 3-node linear tris, as
the §8 contract encodes. Rationale: gap/torque accuracy is carried by the analytic harmonic
interface (§9), *not* element interpolation, which weakens the usual quadratic-element
argument here; local-saturation resolution is bought more cheaply by mesh grading (DOF
headroom: 5–15k → ~5–15 ms refactor) than by doubling nodes/element; and linear elements
keep assembly, the gap FFT, and render simple for the first correct build. **Measured trigger
to upgrade to Q8/Q9:** if meeting the convergence bar (below) needs a mesh whose refactor
exceeds ~30 ms at the realtime DOF (Q4 is DOF-starved within budget), switch the saturating
bands to quadratic — decided by the convergence sweep, not upfront.

**B–H representation — Brauer model** `ν(B²) = k1 + k2·exp(k3·B²)` per iron material, analytic
`dν/d(B²)` for the Newton tangent. No external data: `k1 = 1/(μ0·muR)` (matches the linear
`muR` at low B), `k2,k3` fit so the knee sits at the existing `Bknee`; explicit `{k1,k2,k3}`
override per material allowed. Magnets linear (recoil `μr` + remanence); air/conductor
`ν = 1/μ0`. Smooth/differentiable (clean Newton), the standard motor-FEA saturation model,
qualitatively-correct knee (the teaching goal), reuses fields already in the configs. A
tabulated/PCHIP B–H path is a future option only if datasheet fidelity is ever needed.

**Acceptance thresholds** (the "done" bar — anchored to existing Phase-1/6 tolerances + the
DESIGN ~1–5 % cogging target):
- **Convergence (gold standard):** average torque < 1 % and cogging amplitude < 2 % change
  between successive refinements (Richardson, element size h vs h/√2 or h/2).
- **Headline acceptance — saturated cogging grid-convergent to < 5 %** (the exact failure of
  the old global-ceiling engine, which wandered ~0.7→1.6 ≈ 100 %). This proves the rebuild.
- **Cross-method torque consistency:** harmonic (§9-G4) vs mesh-Arkkio vs co-energy agree
  ≤ 2 % at a loaded point (matches Phase-1 Arkkio-vs-coenergy < 2 %).
- **Analytic refs:** no-load back-EMF vs numerical `dλpm/dθ·ω` < 1 %; slotless/Carter gap
  peak `B` and round-rotor linear inductance < 3 % (gap-resolution-limited).
- **Known-machine:** reluctance `L(θ)` fit `L0+L2cos2θe` `r² ≥ 0.99`; reluctance torque ∝ i²
  ratio 4.0 ± 0.2 below knee; cogging period = LCM(slots,poles) cycles/rev exactly;
  `|λpm| < 1e-9` for non-PM.
- **Numeric guards:** field residual `‖Ax−b‖∞/‖b‖∞ < 1e-9`; Newton `‖ΔA‖/‖A‖ < 1e-6` in
  ≤ 8 iterations at the most-saturated point.

### 11.4 Measurement-deferred — with specific decision criteria

Each is resolved by a benchmark on the real mesh; the measurement and the threshold that
picks the option are fixed here, so the choice is mechanical, not a re-escalation.

- **embed-vs-Schur rotation (§3.3 / §9-G5).** Measure per-θ-step wall-clock: embed (refactor
  the bordered system on a saturation change + harmonic solve) vs Schur (amortized interior
  Schur build + per-θ harmonic-core solve), at the realtime DOF. **Pick Schur iff** embed
  per-step > 16 ms (sub-60 fps) AND saturation is materially static across ≥ `K_reuse`
  θ-steps where `K_reuse·(embed refactor) > (Schur build) + K_reuse·(core solve)`; else embed
  (simpler). If embed is already < 16 ms, do not build Schur.
- **Harmonic truncation `K` (§9).** Start `K = 3·max(slots,poles)`; raise by +50 % and **stop
  when torque changes < 0.5 % and cogging amplitude < 1 %**. Require `N_gap ≥ 4K` (Nyquist +
  margin) and FFT round-trip residual < 1e-8 on the gap circle.
- **Collar radii + layers (§9).** Place `r_mr = r_rotor_surface + 0.25·g`,
  `r_ms = r_stator_bore − 0.25·g` (`g` = gap length). **Accept iff** moving each by ±0.1·g
  changes torque < 0.5 %; else thicken the collar. Collar layers: start 2–3, add until the
  gap-circle field changes < 0.5 % with one more layer.
- **Off-thread worker (§10).** Measure sustained main-thread per-step at the largest
  zero-symmetry config on a throttled (low-end) profile. **Move to a worker iff** sustained
  step > 33 ms (sub-30 fps) OR any single Newton sequence > 100 ms (visible stall); else keep
  it on the main thread in the existing `motor-run` loop.
- **CHOLMOD-WASM (§2.5).** Only after all §2.5 pare-back levers are applied. **Undertake the
  build iff** the per-revolution wall-clock at the target config still misses the interactive
  budget by < 2× (levers got close but not there) AND the §2.5 supernode analysis predicts
  CHOLMOD's ~2× WASM gain closes it. Interactive budget: **≥ 20 fps** at the *realistic*
  DOF — both symmetric (pole-reduced ~2–4k) and the full-annulus stepper (~8–12k → ~30 fps
  projected, §2.5). The ~3 fps figure applies **only** to the 50k stress-ceiling mesh, which
  is avoidable via grading / the §8-M5 DOF budget and is itself the trigger to weigh CHOLMOD.
  If realistic-DOF spin already clears 20 fps, do not build CHOLMOD. Otherwise never
  (research-grade build unjustified).
