# Unified electric-motor app — FEA engine rebuild + integration

Spec sources: `spec/fea-engine-rebuild.md` (the agreed solver-decomposition
investigation + target FEA architecture — **read §11 first; it is binding**) and
`lessons/unified_motor/DESIGN.md` (the original product brief).

## Why this plan exists

The original build (old plan, Phases 0–10) reached a working **agnostic
pipeline + 15 machine fixtures + editors + a refined/Detailed tier** on a
**structured polar-grid field engine**. That engine is now known to rest on a
broken premise (`fea-engine-rebuild.md` §0–§1):

1. **Saturation is intrinsically local.** The global single-scalar ν ceiling is
   not grid-convergent for PM back-iron, so saturated cogging/detent is wrong —
   exactly the wall the old Phase-8 cogging work hit ("Phase-9 TODO: local
   saturation").
2. **The polar grid rasterizes geometry.** Cells straddle material boundaries;
   tooth-tip / slot-opening / magnet-edge accuracy stair-steps. No uniform
   refinement fixes it.
3. **Jacobi-CG does not scale** to FEA-quality meshes and is conditioning-bound.

The rebuild replaces the field engine with a genuine 2-D motor FEA core —
**conforming graded mesh + sliding air-gap harmonic interface + local non-linear
B–H + an exact AMD-ordered sparse-direct solver (Eigen `SimplicialLDLT`, WASM,
analyze-once / factorize-per-step)**. The solver decision is **settled with
measured evidence** (§2): a 50,176-DOF operator factors in ~20 ms (one-time
ordering) + ~66 ms (numeric refactor) + ~3 ms (solve), residual ~1e-10.

**Everything completed in the old plan is treated as done and irrelevant; its
task tables are removed.** What that work produced splits cleanly into two sets
(`fea-engine-rebuild.md` §11.2):

- **Preserved unchanged (the seam is `MotorSlice`):**
  `excitation.js`, `motor-circuit.js`, `motor-run.js`, the four editors
  (`cross-section-render.js`, `winding-editor.js`, `schematic-panel.js`,
  `matrix-panel.js`), and the Phase-0 frozen EM set. These consume only the
  slice API and do **not** change. (The four editors are extended for live
  geometry control in Phase 6, but their physics-facing contracts are stable.)
  **Three files were unfrozen in Phase 2.5** (`spec/phase-2.5-winding-model-cleanup.md`)
  after the industrial-scale fixture rewrite in batch-6 surfaced architectural
  defects hidden by trivial geometries: `lib/winding-model.js` (over-strict
  `Q % (m·p)` validator, no cage routing), `lessons/unified_motor/config-schema.js`
  (`K` element wrongly bucketed with `W`), and the 15 `lessons/unified_motor/machines/*.js`
  fixtures (mixed `p` semantics, cage forced through standardWinding). Phase 8's
  `git diff motor-baseline` invariant now allows these three sets to differ.
  **Two near-preserved files** carry small, byte-localized edits and are noted
  in their owning phases: `lessons/unified_motor/config-schema.js` (Phase 3 —
  adds the `"CURRENT"` terminal type to `validTerminalTypes` and the optional
  per-iron `ring.Bknee` passthrough that Phase 5's Brauer fit consumes) and
  `lib/motor-stack.js`
  (Phase 5 — `sliceGrid(k) → sliceMesh(k)` per §10, plus the `opts.poles =
  expanded.poles` passthrough to each slice; every other line byte-identical
  to baseline).
- **Deleted (the grid engine below `MotorSlice`):** see Phase 0.

> **Divergence from `fea-engine-rebuild.md` §10 (author-approved, 2026-05-26).**
> §10 proposed keeping the grid alive behind a dev `opts.engine` flag and
> deleting it only at cutover, to keep the app live during the build. The author
> overrode this: the app has no users, so the grid is **deleted up front in
> Phase 0** and there is **no dual-engine scaffold, no `opts.engine` flag, and no
> cutover phase**. This simplifies the build and strengthens §11.1 constraint #2
> (no second persistent engine abstraction). Every other decision in
> `fea-engine-rebuild.md` §0–§11 stands as written and is binding.

## Goals

- A genuine 2-D motor **FEA field engine** living below the `MotorSlice` seam:
  - a **custom parametric in-browser ring-stack mesher** (`lib/motor-mesh.js`)
    emitting a conforming, graded, quad-dominant mesh per body (rotor, stator)
    plus a uniform-Δθ mid-gap circle (`gapLoop`) — `fea-engine-rebuild.md` §3.1,
    §3.2, §8;
  - an **analytic air-gap harmonic coupling** (`lib/airgap-harmonic.js`) — the
    sliding interface where rotation is a phase parameter, never a remesh; the
    sparsity pattern is φ-invariant — §3.3, §9;
  - **FEM assembly + local non-linear B–H (Brauer ν(B²), Newton)** and an
    **exact AMD-ordered sparse Cholesky** (`lib/fea-solver.js`, Eigen
    `SimplicialLDLT` WASM, analyze-once / factorize-per-step) — §2, §3.4–§3.6;
  - a new `lib/motor-slice.js` that implements the **unchanged `MotorSlice`
    contract** on the FEA core (`solve`, `extractCoeffs`, `coggingTorque`,
    `clearWarmStart`, `nCircuits`), reconnecting the preserved
    `MotorStack`/`MotorRun` — §10.
- A **mesh-native render** that replaces the grid heatmap: rich 2-D
  cross-section (conforming salient teeth, discrete-winding glyphs, flux
  iso-contours, per-element |B|), a polished 3-D rig, and analytic in-gap field
  evaluation — §10 R1–R5. Plus the **live UI** the old build never wired: a
  **machine picker** (load any of the 15 fixtures) and **geometry sliders**
  (radii, gap, poles, teeth/slot counts) that drive a topology rebuild.
- **Resolution of the one orthogonal outstanding item**: a `current`-source
  terminal kind in `excitation.js` so the wound-field-synchronous machine is
  current-regulated (un-skips its self-start test) — §11.2.
- **Validation against physics, not the grid** (§10-Validation, §11.3): every
  existing analytic/physics acceptance criterion re-computed on the FEA engine,
  plus the headline the grid could never meet — **saturated cogging
  grid-convergent to < 5 %**.

## Non-Goals

- **No grid field engine preserved.** It is not a co-engine, fallback, or
  correctness oracle. It is deleted in Phase 0 and never referenced again.
- **The old non-goal "No CPU unstructured-mesh FEA" is REVERSED** — the FEA core
  is the whole point now. Likewise the Live/Detailed two-tier **collapses**: FEA
  is one accurate engine. An off-thread worker is **optional**, built only if a
  measured budget demands it (§11.4), never as a second computation.
- **No machine-specific code paths** in `lib/` or the runtime UI. The mesher,
  harmonic gap, and FEA slice dispatch **only** on the universal vocabulary
  (element kind `{W,C,M,I,K}`, terminal/commutation, source scope). Machine
  identity never reaches a code path. (Carried from the original plan;
  Phase 8 audits the new FEA files too.)
- **No coupled field+circuit MNA and no Schur-condensed circuit block.** The
  field block stays SPD; circuit coupling stays **staggered** (extract
  `L,dL/dθ,λpm,dλpm/dθ` → step `MotorCircuit` ODE → field solve) — §3.4, §11.1#4.
  ("Schur" appears only as the *optional* §9-G5 interior condensation, a
  rotation-cost lever, unrelated to the circuit.)
- **No moving-band / mortar gap.** Rotation is the analytic harmonic phase
  parameter; any per-step remesh or re-`analyze` is the rejected moving band —
  §3.3, §11.1#3.
- **No iterative or Markowitz-LU solver, no CHOLMOD-WASM.** Eigen
  `SimplicialLDLT`/AMD is the shipping choice; CHOLMOD is a deferred native-only
  option (§2.5, §11.4). Pare-back levers are applied to measured need, not built
  speculatively.
- **No GPU/WebGL compute tier** (carried from the original plan).
- **No changes to `lib/em-physics.js`, `lessons/ac_motor/`, or other lessons.**
  The frozen EM set stays byte-identical (Phase 8 asserts it).

## Machine-Agnosticism Invariants

The contract that keeps the system unified — carried verbatim from the original
plan and now binding on the new FEA files. Every phase's verification checks the
invariants relevant to its files; Phase 8 audits them repo-wide.

1. **Legitimate dispatch axes only.** Code may switch on the universal physical
   vocabulary — element type `{W,C,M,I,K}`, terminal state
   `{AC,DC,PULSE,STEP,OPEN,SHORT}` (now also `CURRENT`, Phase 3), commutation
   mode, and source scope `{slice, stack}`. Code may **never** switch on machine
   identity, a machine name, or a machine-type enum. The mesher consumes the
   `config-schema` feature list (kind-dispatched) and stays agnostic.
2. **Zero-not-skip.** Absent physics contributes zero; it is never branched
   around. No magnet → `λpm = 0` computes to zero. Round rotor → `dL/dθ ≈ 0`.
3. **The engine sees only the compiled feature list + mesh.** `config-schema`
   emits `section = {grid, gapBand, features}`; `features`
   (kind/member/rRange/thetaRange/circuit/turns/muR/Mr/Mθ) is the mesher input.
   The FEA core has zero knowledge of windings, machines, or the UI.
4. **W vs C is routing, not a branch.** Concentrated vs distributed windings are
   different conductor routings; the winding function is computed identically
   from the per-slot ampere-conductor map. Element-*type* dispatch is legitimate;
   "is this a concentrated machine" is not.
5. **`N=1` is not special.** `MotorStack` always loops over slices and sums; no
   single-slice fast path.
6. **Config-declared presentation.** Readouts, plots, panels, controls, and the
   machine picker are declared by config / the fixtures registry and rendered
   generically. No behavioral code reads a human-readable label.

## Verification

- **Phase 0 (dead-code removal):** the grid engine files are gone; **all
  runtime code** (`lib/*.js`, `index.html`, `mount.js`, `cross-section-render.js`)
  and every surviving (loadable) test file have **zero references** to them
  (imports, `LIB.Airgap*`, `LIB.MotorCompile`, `drawGapField`); `field-render.js`
  is restored **byte-identical** to `motor-baseline` (only the `drawGapField`
  addition removed — verified as the sole divergent hunk). The surviving
  preserved-module suites (`WindingModel`, `MotorCircuit`, `config-schema`) load
  and pass; the only retained grid references are in the deliberately-red
  deferred trees — `tests/pipeline/{motor-stack,agnostic-pipeline}.test.js`
  (re-greened Phase 5) and `tests/machines/*` (re-pointed Phase 7) — which run
  red/erroring as expected. The frozen EM set (minus `field-render.js`, which is
  restored to baseline) is byte-untouched.
- **Phase 1 (solver):** `lib/fea-solver.js` reproduces the `fea-engine-rebuild.md`
  §2.3 numbers on the 5-point proxy operator within constant-factor tolerance
  (residual ~1e-10; analyze/factorize/solve split exposed); a **Moodle/static-host
  compatibility check** confirms non-streaming `WebAssembly.instantiate(buffer)`
  loads same-origin without an `application/wasm` MIME dependency and with no
  Web-Worker requirement.
- **Phase 2 (mesher):** each milestone M0–M7 has a headless check (canvas
  rendering verified via a recording-mock 2-D context + a user-required browser
  pass) — no inverted/degenerate elements, area = annulus, conforming ring
  interfaces, graded anisotropic gap layers, **feature-coverage diff** vs
  `config-schema` (every feature exactly tiled, no straddling), uniform-Δθ
  `gapLoop` emitted, near-90° quad angles, per-body signature LRU cache, and
  **mesh-metric refinement convergence** (area-error → 0, bounded min-angle, zero
  coverage error across a refinement sequence). The `materials[]` entry carries
  `Bknee` and the dedup key includes it, so two iron features with equal `muR`
  but different `Bknee` produce two distinct materials (Phase 5's per-material
  Brauer fit relies on this). The gmsh diff is a **dev-time oracle only** (no
  browser/CI build — §3.2): a `scripts/` regen script produces static `.msh`
  references when run by a gmsh-equipped developer, and the committed suite
  uses analytic/intrinsic oracles, not gmsh. **Field/torque convergence is
  Phase 7**, not here — Phase 2 has no solver or assembly, so it converge-tests
  mesh metrics only.
- **Phase 3 (current terminal + per-iron `Bknee` passthrough):** `excitation.js`
  exposes a `CURRENT` terminal whose closed form matches; `MotorCircuit`
  enforces the imposed current (pins that circuit's `i`); `config-schema`
  validates `CURRENT`; `motor-run` routes the new condition kind; the
  wound-field-synchronous fixture uses a regulated field current. `config-schema`
  also accepts an optional **`ring.Bknee`** and emits it onto every iron feature
  (the back-iron + salient-tooth iron + per-tooth iron); `validate` rejects
  non-finite / non-positive `Bknee`. All verified at Phase 3 by
  **engine-independent** tests, because the machine pipeline has no field
  engine between Phase 0 and Phase 5. The *dynamic* self-start assertion (no
  self-start under a regulated field) requires a field solve, so it **un-skips
  and passes in Phase 7** — the first phase after the FEA slice is rebuilt —
  which is also the first end-to-end exercise of the Phase-3 `CURRENT` path
  through the live pipeline.
- **Phase 4 (harmonic gap):** FFT round-trip on the gap circle < 1e-8; the
  static-rotor (φ=0) bordered coupling matches a once-meshed gap-annulus
  reference (G2); the **sparsity pattern is φ-invariant** (G3) and the field
  rotates correctly vs a remeshed-at-φ reference; harmonic torque (G4)
  cross-checks Arkkio on a meshed-gap reference.
- **Phase 5 (FEA slice):** the new `MotorSlice` honors the unchanged contract
  (`solve` / `extractCoeffs` / `coggingTorque` / `clearWarmStart` /
  `nCircuits`); `MotorStack`/`MotorRun` drive it after `motor-stack.js`'s
  `sliceGrid → sliceMesh` rename and the `opts.poles` passthrough; a
  static-rotor solve converges under mesh refinement (average torque < 1 %,
  cogging amplitude < 2 % between successive refinements, §11.3); Newton meets
  the residual/iteration guards (§11.3) on the per-iron-material Brauer fit
  reading `material.Bknee`; staggered circuit coupling reproduces the
  field↔circuit bridge formula-for-formula (§10); the field return is
  mesh-native `{rotor:{mesh,Anode,Belem}, stator:{mesh,Anode,Belem},
  gap:{harmonics,phi}}`; the embed-vs-Schur diagnostic logs the per-θ-step
  measurement at the largest realistic-DOF fixture (the §11.4 16 ms threshold
  is an escalation gate, not a Phase-5 build target).
- **Phase 6 (render + UI):** the mesh-native cross-section draws conforming
  salient teeth + discrete-winding glyphs + flux iso-contours + per-element |B|;
  the 3-D rig extrudes the cross-section with end-windings and per-slice
  in-gap field; the **machine picker loads each of the 15 fixtures live** and the
  **geometry sliders trigger a topology rebuild** (re-mesh + re-`analyze`); no
  grid render path remains. **User-required**: browser verification per the
  CLAUDE.md checklist.
- **Phase 7 (validation):** every preserved analytic/physics criterion passes on
  the FEA engine (reluctance `L(θ)` fit r² ≥ 0.99 and `T = −i²L₂sin2θₑ`;
  cross-method torque harmonic-vs-Arkkio-vs-co-energy ≤ 2 %; no-load back-EMF
  < 1 %; slotless/Carter gap and linear inductance < 3 %; cogging period =
  LCM(slots,poles); `|λpm| < 1e-9` non-PM); the 15 machine tests re-point onto
  the slice and pass — including the **wound-field-synchronous self-start test,
  now un-skipped and passing** on Phase 3's regulated-`CURRENT` field (no
  line-start); **headline — saturated cogging grid-convergent to < 5 %**.
- **Phase 8 (final audit):** repo-wide sweep finds **zero stale grid references**
  in any form; the agnosticism audit (extended allow-list incl. the new FEA
  files) exits 0 — no machine-name / machine-type-field reads in the engine +
  runtime-UI files, no single-slice fast path; `git diff motor-baseline` over the
  frozen set (now re-including `field-render.js`) is empty.

## Dependency Graph

```
Phase 0 (Dead Code Removal — delete the grid engine + grid tests)  ── runs first, alone
   │
   ├──→ Phase 1 (FEA sparse solver: fea-solver.js + WASM)          ─── parallel after 0 ──┐
   ├──→ Phase 2 (parametric mesher: motor-mesh.js, M0–M7) [LARGE]  ─── parallel after 0    │
   └──→ Phase 3 (CURRENT terminal: excitation.js — orthogonal)     ─── parallel after 0    │
                         │                                                                  │
                         ▼ (Phase 4 needs Phase 2's gapLoop)                                │
        Phase 4 (harmonic-gap interface: airgap-harmonic.js, G0–G5)                         │
                         │                                                                  │
                         ▼ (Phase 5 needs solver + mesher + harmonic gap)                   │
        Phase 5 (FEA slice = new MotorSlice: assembly + B–H Newton + gap + solver)          │
                         │                                                                  │
            ┌────────────┴────────────┐                                                     │
            ▼                          ▼                                                     │
   Phase 6 (mesh render + 3D     Phase 7 (validation: analytic     ─── parallel after 5     │
   + machine picker + geometry           criteria on FEA + new                              │
   sliders) — needs Phase 2 too          saturated-cogging < 5 %)                           │
            └────────────┬────────────┘                                                     │
                         ▼                                                                   │
        Phase 8 (Legacy Reference Review + agnosticism guard) ── runs last ─────────────────┘
```

Phases are numbered in execution order; consecutive numbers after a shared
dependency are parallelisable. Phases 1, 2, 3 depend only on Phase 0. Phase 3
(the `CURRENT` terminal) is orthogonal to the field engine (§11.2) and rides
this tier only because Phase 0 is its sole prerequisite. Each `lib/` and UI file
is owned by exactly one phase.

---

## Phase 0: Dead Code Removal
**Depends on**: (none — runs first)

Delete the entire grid field engine and its tier-specific tests. This breaks the
app and the test suite wherever they reference the removed engine — that is
expected and correct; Phases 5 and 7 build the replacement. The author has
confirmed the app has no users, so nothing needs to stay live (this plan does
**not** keep the grid behind a flag — see the divergence note above).

Removed wholesale (with every import / `LIB.*` reference / dependent test):
`lib/airgap-grid.js`, `lib/airgap-solve.js`, `lib/airgap-torque.js`,
`lib/airgap-refine.js`, `lib/airgap-worker.js`, `lib/motor-compile.js`
(grid rasterizer — superseded by mesh assembly), `lib/motor-slice.js` (grid
backend — recreated FEA-native in Phase 5; deleting it removes the
`LIB.MotorSlice` global), and `lessons/unified_motor/detailed-toggle.js` (the
Live/Detailed worker tier — built entirely on the deleted worker + `drawGapField`;
the two-tier collapses, §11.2). The grid `drawGapField` addition is removed from
`lib/field-render.js`, restoring it **byte-identical to `motor-baseline`** (the
sole divergent hunk; the rest of `field-render.js` is frozen EM and stays).
Grid-tier / grid-coupled tests removed: all of `tests/engine/*` and
`tests/detailed/*`, plus `tests/winding/motor-compile.test.js`,
`tests/circuit/extract.test.js`, and `tests/pipeline/motor-slice.test.js`.

Two preserved runtime files carry a single lingering grid reference each, both
stripped here (they are not in the deleted set, but their dead grid call must
go to satisfy "zero references"; Phase 6 owns their broader render rewrite):
the lone `drawGapField` call in `mount.js`, and the lone `MotorCompile` user
(`compileForOverlay`) in `cross-section-render.js`.

Test-suite re-seam (so preserved-module suites still load and pass): the generic
helpers `assertClose`/`fitCos2`/`fitCos2Cos4` move from the deleted
`tests/engine/_fixtures.js` into a new grid-free `tests/_assert.js`; the
surviving fixtures (`tests/_shim.js`, `tests/winding/_fixtures.js`,
`tests/circuit/_fixtures.js`, `tests/pipeline/_fixtures.js`) drop their
deleted-module requires and re-point to `tests/_assert.js`;
`tests/pipeline/config-schema.test.js` drops its two `MotorCompile.compile`
assertions (keeping the pure config-schema ones).

**Preserved, deliberately broken until Phase 5:** `lib/motor-stack.js`,
`lib/motor-run.js`, `lessons/unified_motor/mount.js`, the four editors, the 15
`machines/*.js` fixtures, `config-schema.js`, `winding-model.js`,
`excitation.js`, `motor-circuit.js` — they consume the `MotorSlice` contract,
which has no implementation between Phase 0 and Phase 5.
`tests/pipeline/{motor-stack,agnostic-pipeline}.test.js` stay red until Phase 5
re-greens them; `tests/machines/*` (which also import the fit helpers from the
deleted `tests/engine/_fixtures.js`) are deferred wholesale to Phase 7's
re-point — they load-crash in the interim, which Node's per-file test isolation
keeps from blocking the survivors.

### Wave 0.1: Remove the grid engine + grid tests
One implementer (group `0.1.a` in `spec/manifest.json`) owns all three tasks;
the read-and-edited footprint is 10 files (within the per-group cap), while the
~22 wholesale deletions are scripted `rm`s and do not count toward it.

| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 0.1.1 | Delete the seven grid `lib/` modules; remove the `drawGapField` addition from `field-render.js` so it byte-matches `motor-baseline`. | M | `lib/airgap-grid.js`, `lib/airgap-solve.js`, `lib/airgap-torque.js`, `lib/airgap-refine.js`, `lib/airgap-worker.js`, `lib/motor-compile.js`, `lib/motor-slice.js`, `lib/field-render.js` |
| 0.1.2 | Delete `detailed-toggle.js`; remove the deleted-lib + `detailed-toggle` `<script>` tags from `index.html`; strip the lone `drawGapField` call from `mount.js` and the lone `MotorCompile` user (`compileForOverlay`) from `cross-section-render.js`. | M | `lessons/unified_motor/detailed-toggle.js`, `lessons/unified_motor/index.html`, `lessons/unified_motor/mount.js`, `lessons/unified_motor/cross-section-render.js` |
| 0.1.3 | Relocate `assertClose`/`fitCos2`/`fitCos2Cos4` to a new `tests/_assert.js`; delete the grid-tier/grid-coupled tests (`tests/engine/*`, `tests/detailed/*`, `winding/motor-compile.test.js`, `circuit/extract.test.js`, `pipeline/motor-slice.test.js`); rewire the surviving fixtures off the grid; strip the `MotorCompile` assertions from `config-schema.test.js`. Leave `motor-stack`/`agnostic-pipeline` tests and `tests/machines/*` untouched (deferred). | L | `tests/_assert.js`, `tests/_shim.js`, `tests/winding/_fixtures.js`, `tests/circuit/_fixtures.js`, `tests/pipeline/_fixtures.js`, `tests/pipeline/config-schema.test.js`, `tests/engine/*`, `tests/detailed/*`, `tests/winding/motor-compile.test.js`, `tests/circuit/extract.test.js`, `tests/pipeline/motor-slice.test.js` |

---

## Phase 1: FEA sparse solver
**Depends on**: Phase 0
**Parallel with**: Phase 2, Phase 3

Productionise the validated Eigen `SimplicialLDLT` (AMD) WASM prototype from the
scratch `../_solver_bench/` into a shipping `lib/` module with the
analyze-once / factorize-per-step split (`fea-engine-rebuild.md` §2, §3.6, §6).
Self-contained and validated on the 5-point proxy operator; the FEA slice
(Phase 5) re-runs the benchmark on the real unstructured matrix (§7 step 4).

### Wave 1.1: Production WASM solver wrapper
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.1.1 | `lib/fea-solver.js` (+ the built `solver.wasm`/`solver.mjs` artifacts copied into `lib/`, + the C++ source/build brought in-repo under `lib/solver-src/`): wrap Eigen `SimplicialLDLT<SparseMatrix<double>, Lower>` via a **handle-based** C ABI (`create`/`destroy`/`setPattern`/`setValues`/`analyze`/`factorize`/`solve`/`factorNnz`) so multiple solver instances (rotor + stator + the §3.2 per-body LRU) hold live factorizations in one shared WASM heap. Pattern set once from full-symmetric triplets (one-time sort + internal triplet→CSC scatter map, duplicates summed); `setValues` updates values per Newton iter in triplet order with no re-sort. Strip the prototype's debug `printf`s; keep the raised WASM stack (`-sSTACK_SIZE` ≥ 64 MB — the default 64 KB overflows AMD ordering, §6). Explicit per-instance heap memory discipline. **Load via non-streaming `WebAssembly.instantiate(arrayBuffer)`** (classic `LIB.FeaSolver` script dynamically `import()`s `solver.mjs` and passes `Module.wasmBinary`) — MIME-independent so it works under Moodle's `pluginfile.php` and any plain static host; no Web-Worker requirement. DOM-free; no machine identity. | L | `lib/fea-solver.js`, `lib/solver.wasm`, `lib/solver.mjs`, `lib/solver-src/wrapper.cpp`, `lib/solver-src/build.sh`, `lib/solver-src/README.md` |

### Wave 1.2: Solver validation + host-compat check
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 1.2.1 | Headless solver tests: reproduce `fea-engine-rebuild.md` §2.3 on the 5-point air↔iron ×1000 SPD proxy operator (residual `‖Ax−b‖∞/‖b‖∞ < 1e-9` at N=12100 and N=50176; numeric-refactor reuses the symbolic ordering — one `analyze`, many `factorize`/`solve`); two concurrent instances solve independently; `setValues` (incl. duplicate-triplet summation) reproduces hand-computed exact solutions; timings logged with a generous regression guard (not an absolute-ms gate). Document/automate the **Moodle/static-host load path** (non-streaming ArrayBuffer instantiate; `fetch`/`instantiateStreaming` stubbed to throw; no Worker) as an explicit verification item. | M | `tests/solver/solver.test.js`, `tests/solver/host-compat.test.js`, `tests/solver/_fixtures.js` |

---

## Phase 2: Parametric ring-stack mesher
**Depends on**: Phase 0
**Parallel with**: Phase 1, Phase 3

The big one (`fea-engine-rebuild.md` §3.1–§3.2, §8). A custom in-browser
quad-dominant ring-stack mesher that **replaces the polar rasterizer**: same
`config-schema` feature input, but emits a conforming, graded mesh whose element
edges lie on feature boundaries, plus a uniform-Δθ mid-gap circle (`gapLoop`) per
body for the harmonic interface. Generation is O(N) (one angular sector tiled by
period). Rotor and stator mesh independently. Plain JS, no modules. All milestones
render to canvas and are independently checkable. Element-kind dispatch only —
no machine identity. One file pair → one phase; milestones are waves.

### Wave 2.1: Mesh struct, visualizer, single annulus, ring stack
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.1.1 | **M0+M1+M2.** `lib/motor-mesh.js` `BodyMesh` struct (nodes/elems/matId/srcId/magDir/gapLoop/gapTheta/sig per §8 contract) + `lib/motor-mesh-view.js` canvas visualizer (elements by `matId`, gapLoop overlay). Single graded iron annulus → Cartesian (no inverted/degenerate elems, area = annulus, min-angle report). Ring stack + gap: radial layering, conforming ring interfaces, graded anisotropic gap layers, rotor + stator bodies. | L | `lib/motor-mesh.js`, `lib/motor-mesh-view.js` |

### Wave 2.2: Angular feature templates (the 5 element kinds)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.2.1 | **M3.** Angular sector templates per ring type, dispatched on element kind only: `I` uniform/salient iron teeth; `M` magnet segments + inter-magnet air + alternating `magDir`; `W` yoke + teeth/slots + conductor cells; `C` salient tooth per coil; `K` slots + bar conductors. Validated by **feature-coverage diff** vs `config-schema` (every feature exactly tiled, no straddling). | L | `lib/motor-mesh.js` |

### Wave 2.3: Air collar + gap circle, grading knobs, cache, validation harness
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 2.3.1 | **M4+M5.** Extend each body through a thin **structured air collar** from its conforming gap surface to a **uniform-Δθ circle** (rotor→`r_mr`, stator→`r_ms`); emit `gapLoop` (uniform nodes + θ + `gapR`) — the §3.3/§9-G0 handoff. Grading/quality knobs (gap-layer count, yoke-coarsening, DOF budget; min-angle/aspect report). Collar radii placed per §11.4 (`r_mr = r_rotor_surface + 0.25·g`, `r_ms = r_stator_bore − 0.25·g`). | L | `lib/motor-mesh.js` |
| 2.3.2 | **M6+M7.** Per-body topology **signature + LRU cache** (mesh now; the ~20 ms symbolic `analyze` keyed alongside once the solver lands — additive per-body, never per-machine, §3.2). Validation harness: **mesh-metric convergence under refinement** (area-error → 0, bounded min-angle, zero coverage error) + a 15-fixture regression sweep, on **analytic/intrinsic oracles**. The **gmsh diff** uses committed `.msh` reference fixtures (no gmsh binary at test time — §3.2): `scripts/gen-mesh-refs.mjs` generates them once via the on-PATH gmsh (4.15.2), and the diff test runs against the committed data (skip-guarded only for a sparse checkout). Field/torque convergence is **Phase 7**. The 15 existing `machines/*.js` fixtures are the warm-cache + regression set. **User-required**: browser visual pass via a dev harness page. | M | `lib/motor-mesh.js`, `tests/mesh/*.test.js`, `tests/mesh/_fixtures.js`, `tests/mesh/fixtures/*.msh`, `scripts/gen-mesh-refs.mjs`, `lessons/unified_motor/mesh-dev.html` |

---

## Phase 3: CURRENT-source terminal (orthogonal)
**Depends on**: Phase 0
**Parallel with**: Phase 1, Phase 2

The one outstanding non-field-engine item (`fea-engine-rebuild.md` §11.2): the
wound-field-synchronous self-start test is skipped because `excitation.js` has no
current-source terminal, so a real synchronous field can only be modelled as a DC
voltage source that acts as an induction damper (line-start). Add a `CURRENT`
terminal kind so the field is current-regulated. Independent of the FEA work.

The `CURRENT` path spans four files — the terminal value (`excitation.js`), the
circuit constraint (`motor-circuit.js`), the condition→terminal-state routing
(`motor-run.js`), and the validator vocabulary (`config-schema.js`) — plus the
fixture flip. All four are plain vocabulary extensions (a current source is the
dual of `DC`/`OPEN`), never machine identity. **Dependency reality:** Phase 0
deletes the grid `motor-slice.js`/`motor-compile.js`, so from Phase 0 until
Phase 5 the machine pipeline (`MotorStack`→`MotorSlice`) cannot do a field solve;
`tests/machines/*` and `tests/pipeline/*` fail to even load. Phase 3 therefore
proves the mechanism with **engine-independent** tests (excitation closed-form,
a self-contained `MotorCircuit` pinning + induction-damper test, a self-contained
`config-schema` validation), and the **dynamic self-start un-skip+pass moves to
Phase 7's machine-test re-point** (the WFS *test file* is Phase 7-owned; Phase 3
owns only the *fixture config*).

### Wave 3.1: CURRENT terminal + circuit/run/schema wiring
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 3.1.1 | Add a `CURRENT` terminal to `excitation.js` (imposed-current source, the dual of `DC`: `evalTerminal` returns `{kind:"current", I}`, composes with commutation exactly as `DC` does — vocabulary dispatch, zero machine identity); enforce it in `motor-circuit.js` (new `Iimp` arg pins the `CURRENT` circuit's `i` and moves its flux contribution to the RHS of the voltage-driven circuits, analogous to `OPEN`); route the new `{kind:"current"}` condition in `motor-run.js` (→ terminal-state `"CURRENT"` + imposed value); add `"CURRENT"` to `config-schema.js` `validTerminalTypes`. Verify with engine-independent tests: excitation closed-form, a self-contained `MotorCircuit` pinning + induction-damper-mechanism test, a self-contained `config-schema` validation test. | M | `lib/excitation.js`, `lib/motor-circuit.js`, `lib/motor-run.js`, `lessons/unified_motor/config-schema.js`, `tests/excitation/sources.test.js`, `tests/excitation/current-schema.test.js`, `tests/circuit/current-terminal.test.js` |
| 3.1.2 | Flip the wound-field-synchronous fixture's field circuit from a `DC` voltage source to a `CURRENT` regulated source (`type:"CURRENT", amp:12`), so a true synchronous field is current-regulated. (The dynamic self-start un-skip+pass on this fixture is Phase 7, which owns the test file and runs after the FEA slice exists.) | S | `lessons/unified_motor/machines/wound-field-synchronous.js` |
| 3.1.3 | Per-iron `Bknee` passthrough in `config-schema`: accept an optional finite-positive `ring.Bknee` in `validate`; emit `feature.Bknee = ring.Bknee ?? null` on every iron feature built by `buildIronFeatures`, `buildMagnetFeatures` (back-iron), and `buildWoundFeatures` (back-iron + `C` salient teeth). Pure vocabulary extension — no engine dependency, no machine identity. Verified self-contained (`util.js` + `winding-model.js` + `config-schema.js` only). | S | `lessons/unified_motor/config-schema.js`, `tests/pipeline/bknee-schema.test.js` |

---

## Phase 4: Harmonic-gap sliding interface
**Depends on**: Phase 2 (consumes M4's `gapLoop`)

The analytic air-gap harmonic coupling (`fea-engine-rebuild.md` §3.3, §9). No
sliding mesh — rotation is a phase parameter and the sparsity pattern is
φ-invariant. Built entirely from the two `gapLoop` circles + radii + harmonic
truncation `K`. Plain JS, `lib/airgap-harmonic.js`. The interior Schur-condense
lever (G5) is built **only if** the §11.4 measurement says so.

### Wave 4.1: FFT projection + per-harmonic admittance + static coupling
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.1.1 | **G0+G1+G2.** Consume M4's uniform circle; fix `gapR`, `N_gap`, choose `K` (start `K = 3·max(slots,poles)`, §11.4). FFT projection per circle (nodal `A` ↔ harmonics `Â_k`; verify inverse round-trip < 1e-8). Per-harmonic 2×2 admittance `M_k(r_mr,r_ms,k)` from the annulus `r^{±k}` Laplace solution; assemble the **static-rotor (φ=0) bordered system** (`2(2K+1)` harmonic DOFs). **Oracle:** mesh the gap annulus once explicitly, solve, diff fields. | L | `lib/airgap-harmonic.js` |

### Wave 4.2: Rotation phase, torque, truncation tuning
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 4.2.1 | **G3+G4.** Add the `e^{±ikφ}` phase on the rotor↔stator cross terms; **assert the sparsity pattern is φ-invariant** (same nonzero set for all φ); confirm the field rotates correctly vs a remeshed-at-φ reference. Torque from gap harmonics (`∝ Σ_k k·Im(Â_rotor,k Â*_stator,k)`); cross-check Arkkio on a meshed-gap reference. Tune `K` per §11.4 (raise +50 % until torque < 0.5 % / cogging < 1 %; require `N_gap ≥ 4K`). | L | `lib/airgap-harmonic.js`, `tests/harmonic/*.test.js`, `tests/harmonic/_fixtures.js` |

---

## Phase 5: FEA slice — the new `MotorSlice`
**Depends on**: Phase 1 (solver), Phase 2 (mesher), Phase 4 (harmonic gap)

Assemble the SPD field operator on the mesh, solve local non-linear B–H by
Newton through the sparse solver, couple rotation through the harmonic gap, and
implement the **unchanged `MotorSlice` contract** so the preserved
`MotorStack`/`MotorRun`/`mount` reconnect (`fea-engine-rebuild.md` §3.4–§3.6,
§10). This file (`lib/motor-slice.js`, recreated FEA-native) is the single owner;
assembly / B–H / wiring are waves within it. Circuit coupling stays **staggered**
(no coupled-MNA). Element-kind dispatch only.

Phase 5 ships **embed only** (one combined bordered SPD system per slice). The
§9-G5 interior Schur lever is **measurement-gated** per §11.4 and **not** built
here: a Phase-5 perf test logs embed per-θ-step at the largest realistic-DOF
fixture; if it exceeds **16 ms**, the implementer takes a Clarification Exit
escalating to the user — building G5 is a scope addition the user authorizes,
not a silent branch.

Phase 5 also lands the one consequence of §10 the "preserved unchanged" framing
glossed: `motor-stack.js`'s grid-shaped `sliceGrid(k)` is replaced by
`sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }`; every other line of
`motor-stack.js` is byte-identical to baseline.

### Wave 5.1: FEM assembly + local B–H Newton (static rotor)
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.1.1 | FEM assembly: per-element `k_e = ∫ ν∇Nᵢ·∇Nⱼ` (Q4 bilinear / linear tri, §11.3) + load (circuit `Jz` + magnetization/remanence) → triplets → CSC for `fea-solver`. Local non-linear B–H via **Brauer** `ν(B²)=k1+k2·exp(k3·B²)` **per iron material** with analytic `dν/d(B²)` tangent (`k1=1/(μ0·material.muR)`, `k2,k3` fit so `ν` doubles at `material.Bknee` — read from the Phase-2 mesh material entry, fall back to `opts.saturation.BkneeDefault=1.6 T` when null; per-material `{k1,k2,k3}` override per §11.3); magnets linear (recoil μr + remanence); air/conductor `ν=1/μ0`. **Newton** re-stamps tangent + residual on a fixed pattern (`analyze` once; `factorize`/`solve` per iter). Outer-stator Dirichlet `A=0`. Static-rotor convergence under mesh refinement + Newton residual/iteration guards (§11.3). | L | `lib/motor-slice.js`, `tests/slice/_fixtures.js`, `tests/slice/assembly.test.js`, `tests/slice/newton.test.js` |

### Wave 5.2: Slice contract — solve / torque / flux-linkage / mesh field
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.2.1 | Implement `solve(θ,currents) → {torque, fluxLinkages, field}`: set harmonic-gap phase `φ=θ` via `gap.stamp(θ)` (values only — pattern unchanged), assemble `Jz` from currents, Newton solve, harmonic torque (Arkkio cross-check), per-circuit flux linkage `λ_k = ℓ·Σ_elem A_elem·turnsDensity_k·area`, and the **mesh-native `field` return** `{rotor:{mesh,Anode,Belem}, stator:{mesh,Anode,Belem}, gap:{harmonics,phi}}`. `coggingTorque(θ)` = **linear** magnet-only solve (matches the linear co-energy decomposition; the saturated zero-current detent of Phase 7 uses `solve(θ, zero-currents)` instead). `clearWarmStart`, `nCircuits`. Field↔circuit bridge preserved formula-for-formula (grid `coilMasks` → per-element turns-density; §10). | L | `lib/motor-slice.js`, `tests/slice/contract.test.js`, `tests/slice/convergence.test.js` |

### Wave 5.3: extractCoeffs (staggered) + stack/run reconnection + pipeline re-green + perf diagnostic
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 5.3.1 | `extractCoeffs(θ) → {L, dLdth, lambdaPm, dLambdaPmdth}` via unit-current + magnetization-only **linear-material** probe solves; one linear factorization per angle, reused across `m+1` probes; three angles for central differences (each its own factorization in the embed baseline — the "3 angles share the interior factorization" of §3.4 is the Schur lever G5, not built here). Rename `motor-stack.js`'s `sliceGrid(k) → sliceMesh(k)` and add the `opts.poles = expanded.poles` passthrough (every other line byte-identical). Re-green `tests/pipeline/{motor-stack,agnostic-pipeline}.test.js` against the FEA slice driven via `CS.expand(woundConfig|pmConfig|salientConfig|skewN2Config)`; drop the grid-only `tinySection`/`makeExpanded` scaffold; replace `{ceiling:{enabled:false}}` with `{saturation:{enabled:false}}`. Add `tests/slice/perf.test.js` logging the **§11.4 embed-vs-Schur diagnostic** at the largest realistic-DOF fixture (`hybrid-stepper`) — the implementer escalates via Clarification Exit if measured embed per-θ-step exceeds 16 ms. Per-slice/skew offset enters as the harmonic phase (zero FEA-specific skew code, §10). | L | `lib/motor-slice.js`, `lib/motor-stack.js`, `tests/slice/extract.test.js`, `tests/slice/perf.test.js`, `tests/pipeline/_fixtures.js`, `tests/pipeline/motor-stack.test.js`, `tests/pipeline/agnostic-pipeline.test.js` |

---

## Phase 6: Mesh-native render + live UI
**Depends on**: Phase 2 (mesh), Phase 5 (mesh-native `field` return)
**Parallel with**: Phase 7

Replace the grid heatmap with a first-class mesh-native render (`fea-engine-rebuild.md`
§10 R1–R5) and wire the live controls the old build never had — a machine
**preset picker** (loads any of the 15 `UnifiedMotor.MACHINES` fixtures into a fully
editable config — preset-loader semantics, no machine identity downstream),
**geometry sliders** (radii, counts, derived gap length), and a per-ring
**material card** (`muR`, `Mr`, `Bknee`) so "try different materials and
magnetisations and see what happens" is the live experience. The old Phase-9 3-D
rig polish folds in here, rewired to the mesh field.

Phase 6 also adds the one new render seam the plan's original framing
glossed: `mount.js`'s 2-D canvases are wired through a new
`UM.registerCrossSection2D` seam (mirrors the existing `registerRender3D`); the
four existing seams (`registerPanel`/`registerTool`/`registerHeaderControl`/
`registerRender3D`) stay byte-identical. `mount.js`'s dead built-in grid-rig
fallback branch and its orphan `drawFeatureSectors*`/`fillSector*`/`drawRing3D`/
`ringPoints` helpers are deleted in this phase (Phase 0 stripped only the lone
`drawGapField` call; the broader rewrite is here). `index.html` gains the FEA
library `<script>` tags + a `LIB.FeaSolver.init()` boot await.

### Wave 6.1: Mesh-native 2-D cross-section + diagnostics + 2-D seam
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.1.1 | **R1+R2+R3 + 2-D seam.** Promote `motor-mesh-view.js` to the production 2-D render (`drawMaterial`/`drawFluxLines`/`drawModulusB`/`drawSaturation`/`drawMagnetization`/`drawCurrentDensity`); rewrite `cross-section-render.js` mesh-native, consuming only `runtime.stack.sliceMesh(k)` + `runtime.lastSolve.perSliceField[k]` (Phase 5 D2/D3) and the shared `UM.fieldViz` toggle state; **add the 2-D seam** `UM.registerCrossSection2D({paint(mountCtx, canvases, rctx)})` to `mount.js` (mirrors `registerRender3D`), rewire the 2-D canvases through it, **delete the dead built-in grid rig** `else` branch + its orphan helpers (`drawFeatureSectors2D/3D`, `fillSector2D/3D`, `drawSlotConductors3D`, `drawRing3D`, `ringPoints`, `featureColor`, `KIND_COLORS`, `smoothedMagScale`) in `mount.js`. Saturation viz uses `|B|/Bknee` (no ν duplication; Phase 5 returns no `nuElem`). Field-view toggles are five **independent** checkboxes (no always-on), defaulting to flux-lines on only. | L | `lessons/unified_motor/cross-section-render.js`, `lib/motor-mesh-view.js`, `lessons/unified_motor/mount.js` |

### Wave 6.2: 3-D rig + rotation + analytic in-gap field + boot-time scripts
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.2.1 | **R4+R5 + index.html.** `render3d.js`: axial extrusion of the cross-section, end-winding arcs (go→return over stack ends), per-slice in-gap field paint, registered through `UM.registerRender3D`. Rotor mesh drawn **rigidly rotated by `field.gap.phi`** (body-frame, no remesh); stator fixed. The analytic in-gap `A(r,θ)` (R5 — Phase 4 explicitly delegated this) is a pure helper `lib/gap-eval.js` (`LIB.GapEval.evalA`/`evalAOnGrid`): solves the per-harmonic 2×2 `r^{±k}` Laplace system from `field.gap.harmonics.{rotor,stator}` + `field.<body>.mesh.gapR` and evaluates `A(r,θ)` across the unmeshed annulus → exact smooth cross-gap flux lines. The 2-D view (6.1) reuses the same helper. `index.html` gains the boot await `LIB.FeaSolver.init().then(() => LIB.App.runTabs({…}))` and the post-Phase-0 `<script>` tags for the FEA libs + the four new panel files (Phase 6 is the sole owner of `index.html` script additions). | L | `lessons/unified_motor/render3d.js`, `lib/gap-eval.js`, `lessons/unified_motor/index.html` |

### Wave 6.3: Machine picker + geometry sliders + material card
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 6.3.1 | Wire the live UI the app never had: a **machine picker** header control (own file `machine-picker.js`) that loads any of the 15 `UnifiedMotor.MACHINES` fixtures into the live editable `ctx.config` via deep-copy of `{rings,circuits,stack,grid,mechanical,poles,label}` then `ctx.requestRebuild()` — preset-loader semantics; no machine identity stored anywhere. `matrix-panel.js` extends per ring with two collapsed expander cards: **Geometry** (`rRange[0]/rRange[1]`, integer `teeth`/`magnets`/`Q` per element kind) and **Material** (`muR`, `Mr` on `M` rings, `Bknee` on iron-bearing rings). A global **gap-length slider `g`** uses a pure `applyGapLength(config, g)` helper to shift rotor surface + stator bore symmetrically around the current mid-gap (derived, not independent), preserving every other ring radius. All edits mutate `ctx.config` in place and fire `requestRebuild()` → re-mesh + re-`analyze` (cached by body-signature). Both files register through existing mount seams (`registerPanel`/`registerHeaderControl`); `mount.js` is **not** touched in this wave (it was edited in Wave 6.1). **User-required**: the single Phase-6 browser pass — picker loads each of the 15 fixtures; geometry/material/gap sliders rebuild geometry; rotor turns; field paints under each viz toggle; R5 analytic in-gap flux lines visibly bridge rotor↔stator surfaces; Reset works. | L | `lessons/unified_motor/matrix-panel.js`, `lessons/unified_motor/machine-picker.js` |

---

## Phase 7: Validation (physics, not the grid)
**Depends on**: Phase 5
**Parallel with**: Phase 6

Re-establish every analytic/physics acceptance criterion on the FEA engine and
add the headline the grid could never meet (`fea-engine-rebuild.md` §10-Validation,
§11.3). Grid is **not** an oracle. Arkkio + co-energy torque math is reimplemented
on the mesh as cross-checks.

### Wave 7.1: Engine-tier FEA validation + machine-test re-point
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.1.1 | New engine-tier FEA tests: **convergence under mesh refinement** (avg torque < 1 %, cogging < 2 % between refinements); **analytic refs** (no-load back-EMF vs `dλpm/dθ·ω` < 1 %; slotless/Carter gap + round-rotor linear inductance < 3 %); **cross-method torque** harmonic-vs-Arkkio-vs-co-energy ≤ 2 %; **known-machine** (reluctance `L(θ)=L0+L2cos2θₑ` r² ≥ 0.99 and `T=−i²L2sin2θₑ`; reluctance torque ∝ i² ratio 4.0±0.2 below knee; cogging period = LCM(slots,poles); `\|λpm\| < 1e-9` non-PM). | L | `tests/fea-engine/*.test.js`, `tests/fea-engine/_fixtures.js` |
| 7.1.2 | Re-point the 15 machine-fixture validation tests onto the FEA slice (the preserved physics assertions, now computed on FEA); confirm the `tests/machines/*` suite passes on the new engine, including the wound-rotor torque, cross-method cross-checks, and skew/pole-mismatch demos. **Un-skip the wound-field-synchronous self-start test** — now passing because Phase 3's regulated-`CURRENT` field (routed `excitation`→`motor-run`→`motor-circuit`) develops no induction-damper current, so the machine does not line-start; this is the first end-to-end exercise of the Phase-3 `CURRENT` path through the rebuilt pipeline. | M | `tests/machines/*.test.js`, `tests/machines/_fixtures.js` |

### Wave 7.2: Headline — saturated cogging grid-convergence
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 7.2.1 | The proof of the rebuild: **saturated cogging/detent grid-convergent to < 5 %** under Richardson refinement (the exact failure of the old global-ceiling engine, which wandered ~0.7→1.6 ≈ 100 %), with local per-element Brauer B–H active. Newton numeric guards asserted at the most-saturated point (`‖ΔA‖/‖A‖ < 1e-6` in ≤ 8 iters; field residual < 1e-9). | M | `tests/fea-engine/saturated-cogging.test.js` |

---

## Phase 8: Legacy Reference Review + agnosticism guard
**Depends on**: all previous phases

> Like every phase, this gets its detailed `spec/phase-8-*.md` (via `plan-spec`)
> when it is its turn to implement.

### Wave 8.1: Full legacy audit + agnosticism guard
| Task | Description | Complexity | Key Files |
|------|-------------|------------|-----------|
| 8.1.1 | Repo-wide sweep for **any** stale grid reference (imports, `LIB.Airgap*`/`MotorCompile`/`drawGapField`, type/string/comment/test-fixture/doc/`index.html` script tags) — none acceptable. Extend the agnosticism audit script (`scripts/agnosticism-audit.js`) allow-list to the new engine + runtime-UI files (`lib/fea-solver.js`, `lib/motor-mesh.js`, `lib/motor-mesh-view.js`, `lib/airgap-harmonic.js`, `lib/motor-slice.js`, `lessons/unified_motor/render3d.js`) and re-run its four checks (zero machine-name refs; no machine-type field read; no single-slice fast path in `motor-stack`/`motor-run`; `git diff motor-baseline` over the frozen set — now **re-including `field-render.js`** since `drawGapField` was removed — is empty). Exit 0. | M | `scripts/agnosticism-audit.js` (repo-wide) |

---

## Open items deferred to plan-spec

Surfaced now so each per-phase `plan-spec` resolves them with the author rather
than silently. All are mechanical measure-and-threshold calls fixed in
`fea-engine-rebuild.md` §11.4 — not re-escalations:

- **embed-vs-Schur rotation (Phase 4 / §9-G5):** build the interior Schur
  condensation **iff** embed per-θ-step > 16 ms at the realtime DOF and
  saturation is materially static across the reuse window; else embed.
- **Harmonic truncation `K` (Phase 4 / §9):** start `K=3·max(slots,poles)`,
  raise +50 % until torque < 0.5 % and cogging < 1 %; require `N_gap ≥ 4K` and
  FFT round-trip < 1e-8.
- **Collar radii + layers (Phase 2/4 / §9):** `r_mr=r_rotor_surface+0.25·g`,
  `r_ms=r_stator_bore−0.25·g`; accept iff ±0.1·g moves torque < 0.5 %; collar
  layers start 2–3, add until gap-circle field changes < 0.5 %.
- **Off-thread worker (Phase 5/6 / §10, §11.4):** build it **iff** sustained
  main-thread step > 33 ms or any Newton sequence > 100 ms on a throttled
  profile; else keep FEA on the main thread (the default).
- **Element order Q4 → Q8/Q9 (Phase 5 / §11.3):** upgrade the saturating bands
  to quadratic **iff** meeting the convergence bar needs a mesh whose refactor
  exceeds ~30 ms at the realtime DOF; decided by the convergence sweep.
- **CHOLMOD-WASM (Phase 1 / §2.5, §11.4):** only after all §2.5 pare-back levers;
  undertake the research-grade build **iff** the per-revolution budget still
  misses interactive (≥ 20 fps symmetric / ≥ 3 fps full zero-symmetry stepper) by
  < 2× and the supernode analysis predicts CHOLMOD's ~2× WASM gain closes it.
