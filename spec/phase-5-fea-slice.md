# Phase 5: FEA slice — the new `MotorSlice`

## Overview

Recreate `lib/motor-slice.js` **FEA-native** (the grid version was deleted in
Phase 0) and reconnect the preserved upper layers (`motor-stack.js`,
`motor-run.js`, `mount.js`, the four editors, the 15 machine fixtures). The
slice assembles the SPD field operator on the Phase-2 conforming mesh, couples
rotor and stator interiors through the Phase-4 harmonic gap (the **embed**
bordered system), solves local non-linear B–H by Newton through the Phase-1
sparse Cholesky solver, and exposes the unchanged `MotorSlice` contract
(`solve` / `extractCoeffs` / `coggingTorque` / `clearWarmStart` /
`nCircuits`).

This phase also lands the one consequence of §10 that the plan's "preserved
unchanged" framing glossed over: `motor-stack.js` exposes a grid-shaped
`sliceGrid(k)` that the FEA slice cannot honor (the slice has no grid). §10
explicitly supersedes it with mesh access; Phase 5 replaces `sliceGrid(k)` with
`sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }`. The only consumer of the
old `sliceGrid` (`mount.js`'s gap-field overlay block) was already deleted in
Phase 0, so this rename has no remaining call sites outside the re-greened
pipeline test.

The phase's three waves are sequential edits of the same `lib/motor-slice.js`
file: **5.1** lays down assembly + Brauer Newton against a static rotor;
**5.2** wires the public `solve` (torque + flux linkages + mesh-native `field`);
**5.3** adds the staggered `extractCoeffs`, the stack/run reconnection (incl.
`sliceMesh`), the re-greened `tests/pipeline/*`, and the §11.4 embed-vs-Schur
diagnostic.

### Locked decisions for this phase (settled with the author 2026-05-27)

- **D1 — Embed only; Schur is escalation-gated.** Phase 5 ships the §3.6
  **embed** baseline: ONE combined bordered SPD system per slice
  (rotor interior + stator interior + `2·(2K+1)` harmonic DOFs from
  `LIB.AirgapHarmonic.stamp(φ)`), one `LIB.FeaSolver` instance for the
  saturated path (analyze once at prepare; factorize per Newton iter; solve per
  iter) and one for the linear-material extract path (same pattern, independent
  factorization). The §9-G5 interior Schur condensation is **not** built. A
  Phase-5 perf test measures embed per-θ-step at the largest realistic-DOF
  fixture and **logs** it; if that measurement exceeds **16 ms**, the
  implementer takes a **Clarification Exit** per §11.4 (escalates with the
  measurement; building G5 is a scope addition the user green-lights — never a
  silent decision).

- **D2 — `sliceGrid → sliceMesh` on `motor-stack.js`.** §10 retires the
  grid-shaped accessor. Phase 5 owns `lib/motor-stack.js` for this one rename
  (preserving every other field/method signature byte-identical) and updates
  `spec/plan.md`'s "preserved unchanged" note accordingly. `motor-stack.js`'s
  body is otherwise untouched — `solve` / `extractCoeffs`
  / `coenergyTorque` / `clearWarmStart` / `nCircuits` / `nSlices` /
  `.expanded` keep their contracts, and additionally `motor-stack.create`'s
  return object exposes the per-slice array as `.slices: MotorSlice[]` (the
  N slices the stack constructed, indexable as `stack.slices[k]`). The
  per-slice array was already present internally; Phase 5 elevates it to
  public-contract status so Phase 7's `tests/fea-engine/saturated-cogging.test.js`
  can address a single slice (`stack.slices[0]`) without re-deriving
  section + opts from the expanded config.
  `coenergyTorque(thetaR, currents) → { total, reluctance, mutual, pm, cogging }`
  returns the four additive parts of the co-energy decomposition plus
  their sum, computed from `extractCoeffs(thetaR)` (one linear-material
  factorization at `thetaR`). Formulas:
  `reluctance = Σ_k (−½·currents[k]²·dL[k·m+k]/dθ)`,
  `mutual = Σ_{i≠j} (−currents[i]·currents[j]·dL[i·m+j]/dθ)`,
  `pm = Σ_k (currents[k]·dLambdaPmdth[k])`,
  `cogging = slice(0).coggingTorque(thetaR)` for `N=1` stacks;
  for N≥2 stacks `cogging = Σ_k slice(k).coggingTorque(thetaR + sliceOffsets[k])`.
  `total = reluctance + mutual + pm + cogging`. Asserted by Phase 7's
  `tests/fea-engine/cross-method.test.js` and the pipeline `motor-stack.test.js`
  "coenergyTorque returns finite parts" test.

- **D3 — `field` is mesh-native (§10 R-set).**
  `solve(...).field = { rotor:{mesh, Anode, Belem}, stator:{mesh, Anode,
  Belem}, gap:{harmonics, phi} }`. `mesh` is the body's full `BodyMesh`
  (Phase-2 contract). `Anode` is `Float64Array(Nn)`. `Belem = { mag:
  Float64Array(Ne), Bx: Float64Array(Ne), By: Float64Array(Ne) }`. `gap =
  { harmonics:{ rotor:{a:Float64Array(K+1), b:Float64Array(K+1)},
  stator:{a:…, b:…} }, phi: number }` — Phase 6 R5 evaluates the analytic
  in-gap `A(r,θ)` from these. No grid sampling or grid-adapter shim is built.

- **D4 — Linear-mode toggle `opts.saturation`.** The grid `opts.ceiling`
  vocabulary is dropped. `opts.saturation = { enabled=true, BkneeDefault=1.6 }`.
  `enabled:false` runs a single linear-material factorize-and-solve per
  `solve()` call (the comparison handle the agnostic-pipeline Maxwell-vs-co-
  energy cross-check uses). `BkneeDefault` is the fall-back `Bknee` (Tesla)
  applied to any iron material whose Phase-2 mesh entry has
  `Bknee == null`/undefined; per-material override is honored from
  `material.Bknee` (Phase 2 / Phase 3 amendment).

- **D5 — Brauer per iron material (§11.3).** Locked: `ν(B²) = k1 + k2·exp(k3·B²)`
  per iron material, analytic `dν/dB²` for the Newton tangent.
  `k1 = 1/(μ0·material.muR)`. `k2`,`k3` are fit so the knee sits at
  `material.Bknee ?? opts.saturation.BkneeDefault` (T) with the
  cross-over criterion `ν(Bknee²) = 2·k1` and `k2·k3·Bknee²·exp(k3·Bknee²) =
  α·k1` for fixed shape constant `α = 1` (a smooth knee whose tangent doubles
  the linear ν at `B = Bknee`). Materials may set `material.k1`/`k2`/`k3`
  explicitly (per-material override per §11.3); when present, those values are
  used verbatim and `Bknee` is ignored for that material. Magnets stay linear
  (`ν = 1/(μ0·material.muR)`); air/conductor `ν = 1/μ0`.

- **D6 — Boundary conditions.** Dirichlet `A = 0` on the **outer-stator
  boundary** (the nodes at `r == section.grid.rOuter` within `1e-9`) — applied
  by row/column elimination during pattern build (the eliminated DOFs are
  removed from the system, so the factored operator has only free DOFs).
  Rotor inner boundary natural (no pin) — the harmonic gap's `k=0` admittance
  couples rotor to stator and constrains the constant null space; the
  combined system's SPD-ness is asserted by `factorize` success + residual <
  1e-9 in the assembly test.

- **D7 — `nCircuits` from the mesh.** `nCircuits = max(srcId) + 1` over both
  body meshes' `srcId` arrays (with `-1` excluded), matching the
  `config-schema.expand`-emitted `nCircuits`. Asserted by motor-stack's
  existing global-vs-slice equality check.

- **D8 — `K` and (slots,poles) — caller passes `opts.poles`.** `K =
  opts.K ?? LIB.AirgapHarmonic.defaultK(slots, opts.poles)`. The slice derives
  `slots` from the section as `max(angular count of stator features by ring)`
  (the largest periodic angular division across stator iron/conductor features;
  it is `Q` for `W`/`C`/`K`, `teeth` for `I`, equal to `nSlots` of the routing
  for the realistic fixtures). `poles` is **passed by `motor-stack.js`** as
  `opts.poles = expanded.poles` (the only piece of metadata the stack adds —
  both `slots` derivation and `poles` passthrough are pure integer vocabulary,
  not machine identity). When `opts.poles` is absent the slice falls back to
  `2`. `K` is therefore one number per slice, machine-agnostic.

- **D9 — Test layout.** Phase 5 owns `tests/slice/*.test.js` (the slice's own
  contract + assembly + Newton + extract + perf + convergence checks). Phase 7
  owns `tests/fea-engine/*.test.js` (the physics validation suite). Phase 5
  re-greens `tests/pipeline/{motor-stack,agnostic-pipeline}.test.js` against
  the FEA slice driven via `CS.expand(woundConfig|pmConfig|salientConfig|
  skewN2Config)` (real feature lists the mesher accepts); the grid-only
  `tinySection`/`makeExpanded` scaffold is removed.

## The `MotorSlice` contract (FEA-native, preserved signatures)

`LIB.MotorSlice.create(section, opts) → slice`

**Inputs.** `section = { grid, gapBand, features }` — the `config-schema.expand`
slice-0 payload. `gapBand` (grid-index-shaped) is **ignored** by the FEA slice;
the gap geometry is derived by the mesher (`r_mr`, `r_ms` from feature radii
per §11.4). `opts`:

- `mesh` — forwarded to `LIB.MotorMesh.buildCached(section, opts.mesh)`;
  defaults `{}`.
- `saturation = { enabled=true, BkneeDefault=1.6 }` — D4.
- `poles` — number, passed through by `motor-stack` (D8); fallback `2`.
- `K` — integer harmonic truncation; default `LIB.AirgapHarmonic.defaultK(slots,
  poles)` (D8).
- `newton = { maxIter=8, tol=1e-6, residualTol=1e-9 }` — Newton stopping
  criteria (§11.3 guards).
  - `tol=1e-6` is the relative change in nodal vector potential `A` between
    successive Newton iterations. For the silicon-steel fixtures in the
    suite, `‖ΔA‖∞/(‖A‖∞ + ε) < 1e-6` corresponds to a worst-case torque
    error of roughly 0.01% (derived from the sensitivity `dT/dA ~ B·L·I`
    near saturation, where a 1e-6 change in A produces a 1e-6 change in
    co-energy and thus a comparable fractional change in torque). The
    1% torque-convergence acceptance criterion in Wave 5.2 has 10000×
    headroom over this Newton residual.
  - `residualTol=1e-9` is the absolute equation residual
    `‖K·A − f‖∞/(‖f‖∞ + ε)`. The chosen value is one decimal place above
    the solver's own residual floor (`< 1e-9` per Phase 1 acceptance),
    so the residual-tol check is solver-floor-limited and not a meaningful
    additional constraint — it is included as a defensive guard against
    Newton iterating past the solver's accuracy.
  - `maxIter=8` is empirical: for B-H Brauer curves in the suite at the
    operating points of the AC-excited fixtures, Newton converges in
    3-6 iterations from the warm-start initial guess. The 8-iteration
    cap traps non-convergence (e.g. an under-damped step that oscillates)
    and forces an explicit error rather than silent timeout. If a future
    fixture's nonlinearity exceeds this, the slice throws; the right
    response is a line-search modification in the solver, not raising
    the iteration cap.

**Returned slice object** (every field a stable contract):

- `nCircuits: number` — D7.
- `solve(thetaR: number, currents: Float64Array(m)) → { torque, fluxLinkages, field }`
- `extractCoeffs(thetaR: number, opts2?: { derivStep?: number }) → { L, dLdth, lambdaPm, dLambdaPmdth }`
- `coggingTorque(thetaR: number) → number` — linear magnet-only solve (matches
  the linear co-energy decomposition; the saturated detent headline of Phase 7
  uses `solve(θ, zero-currents)` instead).
- `clearWarmStart() → void`

## Combined global system layout

The slice assembles ONE bordered sparse SPD system per slice:

```
Global DOF layout (n = Nn_rotor_free + Nn_stator_free + 2·(2K+1)):
   [   rotor interior nodes (free)   ]   indices [0, Nn_rotor_free)
   [   stator interior nodes (free)  ]   indices [Nn_rotor_free, Nn_rotor_free + Nn_stator_free)
   [ 2·(2K+1) harmonic DOFs (a/b)    ]   indices [Nn_rotor_free + Nn_stator_free, n)
```

"Free" = "not eliminated by the D6 outer-stator Dirichlet pin." Pinned nodes are
removed from the system before `setPattern`; their `A = 0` value is restored
when assembling the `Anode` Float64Arrays returned in `field`.

Two index maps are built at prepare time and never change:

- `gapLocalToGlobal_rotor[i] = rotor body's `gapLoop[i]` mapped through the
  body's pin-removal renumbering` (length `Ngr`).
- `gapLocalToGlobal_stator[i] = …` (length `Ngs`).
- The harmonic DOFs map identically (local index `Ngr + Ngs + j` → global
  `Nn_rotor_free + Nn_stator_free + j`).

`LIB.AirgapHarmonic.stamp(phi)` returns full-symmetric triplets in its **local**
DOF space (rotor-gap | stator-gap | harmonic per Phase-4 `dofMap`); the slice
remaps every `(I[k], J[k])` to global indices via the two maps above and
concatenates with the body-interior triplets. By Phase-4 D4 the harmonic stamp's
`(I,J)` set is φ-invariant, so the combined pattern is φ-invariant — `analyze`
runs **once**.

## Field ↔ circuit bridge (preserved formula-for-formula, mesh-native)

The grid's `coilMasks[k][cell] = signed turns per unit area` becomes
**per-element turns-density**: for any element with `srcId == k`,
`turnsDensity_k(elem) = turns(elem) / area(elem)` (where `turns(elem)` is the
Phase-2 per-element signed ampere-conductor count and `area(elem)` is the
element area). For elements with `srcId != k`, `turnsDensity_k = 0`.

- **Current source.** `Jz(elem) = currents[srcId(elem)] · turnsDensity_{srcId(elem)}(elem)`
  for conductor elements, `0` elsewhere. Per element this contributes a load
  `∫_elem Jz · N_i dA` to each of its nodes' RHS.
- **Magnet remanence.** For magnet elements, the remanence vector
  `M(elem) = material.mrMag · magDir(elem)` contributes the standard
  remanence load `∫_elem (1/μ0) (∇ × M) · N_i dA` (numerically the per-element
  contribution `(M_x · ∂N_i/∂y − M_y · ∂N_i/∂x) · (1/μ0) · area`).
- **Flux linkage.** `λ_k = ell · Σ_{elem: srcId(elem) == k} A_elem · turns(elem)`,
  where `A_elem` is the area-weighted average of the element's nodal `A` values
  (the Q4 4-node mean / the linear-tri 3-node mean; equivalent to
  `(1/area) · ∫ A dA` for these shape functions). `ell = section.grid.ell`.
- **`L[i*m + j] = λ_i(unit current j)`** — the staggered probe of §3.4/§10:
  one linear solve per circuit `j` with `Jz = turnsDensity_j` (unit current),
  then read out `λ_i` for every `i`. `λ_pm,k` is the linear magnet-only solve's
  flux linkage in circuit `k`.

This is the grid bridge with `coilMasks[k] · dA` replaced by `turns(elem)` for
the element `srcId == k` (and 0 otherwise). For the realistic fixtures both
give identical integrated turns per circuit by construction (Phase-2's
feature-coverage diff).

## Files Owned

- `lib/motor-slice.js` — created (all three waves write to this file; sequential
  waves, no lock contention)
- `lib/motor-stack.js` — modified (Wave 5.3; D2 rename `sliceGrid` → `sliceMesh`
  and pass `opts.poles = expanded.poles` through to each `MotorSlice.create`
  call; every other line byte-identical)
- `tests/slice/_fixtures.js` — created (Wave 5.1; loader + helpers for every
  Phase-5 test file)
- `tests/slice/assembly.test.js` — created (Wave 5.1)
- `tests/slice/newton.test.js` — created (Wave 5.1)
- `tests/slice/contract.test.js` — created (Wave 5.2)
- `tests/slice/convergence.test.js` — created (Wave 5.2; the static-rotor
  refinement convergence guard of the Phase-5 verification bullet — the Phase-7
  validation suite goes deeper)
- `tests/slice/extract.test.js` — created (Wave 5.3)
- `tests/slice/perf.test.js` — created (Wave 5.3; embed per-θ-step diagnostic,
  D1 escalation gate)
- `tests/pipeline/_fixtures.js` — modified (Wave 5.3; restore the `motor-slice`
  require that Phase 0 stripped, add the new dependency requires —
  `motor-mesh`/`motor-mesh-view`/`airgap-harmonic`/`fea-solver` — and drop the
  grid-only `tinySection`)
- `tests/pipeline/motor-stack.test.js` — modified (Wave 5.3; rewrite to drive
  the FEA slice via `CS.expand(woundConfig)` etc.; replace the `sliceGrid` test
  with a `sliceMesh` test)
- `tests/pipeline/agnostic-pipeline.test.js` — modified (Wave 5.3; replace
  `{ceiling:{enabled:false}}` with `{saturation:{enabled:false}}`; loosen step
  counts and tolerances for FEA wall-clock; keep the unchanged-files
  machine-name scan)

> **Task groups are not declared here.** They live in `spec/manifest.json`.

### Cross-phase amendments (applied alongside this spec)

Two small ripples land in this same plan-spec session, since they unblock the
slice's per-iron-material Brauer fit:

- **Phase 2 (`spec/phase-2-parametric-ring-stack-mesher.md`)** — `BodyMesh`
  `materials[]` entries carry `Bknee: number | null`. Dedup key extends to
  `(kind, muR, mrMag, Bknee)`. The Phase-2 mesh test `mesh-core.test.js`
  gains an assertion that two iron features with equal `muR` but different
  `Bknee` produce **two** distinct material entries.
- **Phase 3 (`spec/phase-3-current-source-terminal.md`)** —
  `config-schema.js` accepts an optional `ring.Bknee` and emits `feature.Bknee
  = ring.Bknee` on every iron feature it builds. `validate` checks (when
  present) that `Bknee` is a finite positive number. The Phase-3 test surface
  gains a small case asserting an optional `ring.Bknee` validates and reaches
  the iron feature.

Phase 5 reads `material.Bknee` directly (Phase 2 carries it through from the
mesh material entry). Both amendments are byte-localized changes within their
respective phases' already-defined Files Owned (no new file ownership added).

---

## Wave 5.1: FEM assembly + local B–H Newton (static rotor)

### Task T5.1.1: Mesh → bordered SPD operator + Brauer-Newton solver loop

- **Description**: Create `lib/motor-slice.js` with the `LIB.MotorSlice.create`
  factory's prepare phase and a **static-rotor** Newton solve. Build both body
  meshes via `LIB.MotorMesh.buildCached`, build the harmonic gap via
  `LIB.AirgapHarmonic.build`, apply the D6 outer-stator Dirichlet pin, assemble
  the combined-system triplet pattern (interior Q4/linear-tri stiffness
  pattern + remapped harmonic-stamp pattern), set it on a saturated
  `LIB.FeaSolver` instance, run `analyze()` once. Implement the Newton loop on
  the Brauer ν(B²) per-iron-material reluctivity (D5), with `factorize`/`solve`
  per iteration and `setValues` updating only values on the fixed pattern.
  Cache the Newton solution as the warm start. No `solve(thetaR, currents)`
  public method yet — Wave 5.1 exposes only the prepare/assembly internals via
  a documented internal API the assembly + newton tests can drive (the wave's
  acceptance is the internal contract, not the public one).

- **Files to create**:
  - `lib/motor-slice.js` — IIFE attaching `window.LIB.MotorSlice = { create }`.
    Internals exposed to tests via a module-level `__test_internals` hatch
    (gated by a `slice.__internals` accessor on the returned object — visible to
    Phase-5 tests, not to production callers; agnosticism unaffected). Wave
    5.1 lays down:
    - Helpers: `derivedSlots(section)`, `derivedPoles(opts)`,
      `eliminateOuterStatorPin(rotorMesh, statorMesh, rOuter)` returning the
      free-DOF renumbering + pinned-node list.
    - `prepare(section, opts)`: build meshes, build harmonic gap, compute
      `slots`/`poles`/`K`, build the renumbering, assemble interior triplets,
      remap and concatenate harmonic stamp(0) triplets, call
      `LIB.FeaSolver.init().then(...)` (note: `prepare` is **synchronous**;
      the slice's `create` contract is sync end-to-end. `create` queries
      `LIB.FeaSolver.isInitialized()` (a synchronous read of the
      `init`-resolved cached promise's status) and **throws**
      `Error("LIB.MotorSlice.create: LIB.FeaSolver.init() has not resolved; await it before constructing a slice")`
      if `init` has not completed. Every Phase-5/Phase-6/Phase-7 caller
      awaits `LIB.FeaSolver.init()` at module/boot time before its first
      `MotorSlice.create` call; the `index.html` boot await of Phase 6
      D8 satisfies the live app. No lazy-init path is built — the sync
      contract for `solve` holds unconditionally.
      (Cross-phase: `LIB.FeaSolver.isInitialized()` is a sync read of the
      `init`-cached promise — added to Phase 1's T1.1.1 public API
      alongside `init`/`create`.)
    - `assembleInteriorPatternAndValues(body, ν_per_elem)` returning triplets
      `{I, J, V}` for that body, in the free-DOF numbering. Q4 elements use the
      bilinear shape functions with 2×2 Gauss quadrature; linear tris use
      1-point quadrature.
    - `assembleInteriorMagnetLoadAndJz(body, currents, ν_per_elem)` returning
      the body's RHS contribution (magnetization curl + Jz).
    - `brauerNu(B2, material, BkneeDefault)`: returns `{ ν, dν_dB2 }` per D5.
    - `newtonSolve({solver, A0, assembleResidualAndTangent, maxIter, tol,
      residualTol})`: returns `{A, iters, residual, converged}`. Uses
      `setValues` to update the tangent on the fixed pattern; calls
      `factorize` then `solve` each iter; ΔA stopping criterion
      `‖ΔA‖∞/(‖A‖∞ + ε) < tol`; absolute residual `‖K·A − f‖∞/(‖f‖∞ + ε) <
      residualTol` at convergence.
    - `_internals` — a test-only hatch exposed on the returned slice object as
      `slice.__internals`. The complete contract (every key the
      Phase-5 and Phase-7 tests reference; the implementer must expose all
      of them):
        - `prepare(section, opts) → preparedState` — the build step (mesh,
          harmonic gap, renumbering, pattern assembly, analyze).
        - `assembleInteriorPatternAndValues(body, νPerElem) → { I, J, V }` —
          body-interior triplets in free-DOF numbering.
        - `assembleInteriorMagnetLoadAndJz(body, currents, νPerElem) → Float64Array(n_free)`
          — body RHS contribution.
        - `assembleCombinedTriplets(section, opts, phi) → { I, J, V }` — the
          combined interior + remapped harmonic-stamp triplets at angle `phi`
          (used by `assembly.test.js` to inspect pattern symmetry and
          φ-invariance).
        - `brauerNu(B2, material, BkneeDefault) → { ν, dν_dB2 }` — the
          per-material Brauer reluctivity and its tangent.
        - `newtonSolve({ solver, A0, assembleResidualAndTangent, maxIter, tol,
          residualTol }) → { A, iters, deltaNorm, residual, converged }` — the
          Newton driver. The returned object is also cached on
          `slice.__internals.lastNewton` for Phase-7 saturated-cogging
          assertions.
        - `solveStaticRotor(thetaR, currents) → { A, iters, deltaNorm, residual }`
          — the public-`solve` engine without the post-processing (used by
          `newton.test.js`).
        - `eliminateOuterStatorPin(rotorMesh, statorMesh, rOuter) → { renumbering, pinned }`
          — D6 pin removal.
        - `remapGapTriplets(localTriplets, gapLocalToGlobalRotor, gapLocalToGlobalStator)
          → triplets` — local-DOF→global-DOF remap of the harmonic stamp output.
        - `globalLayout → { Nn_rotor_free, Nn_stator_free, nHarmonicDofs, n }`
          — the combined-system DOF layout.
        - `K: number` — the harmonic truncation actually used by this slice.
        - `derivedSlots: number`, `derivedPoles: number` — the per-slice
          `slots` and `poles` values used to compute `K` via `defaultK`.
        - `bodies: { rotor: BodyMesh, stator: BodyMesh }` — the two Phase-2
          meshes the slice built (test access for the `field.<body>.mesh ===
          bodies.<body>` identity assertion).
        - `solverSat: LIB.FeaSolver instance` — the saturated-path solver
          (analyze once at prepare, factorize per Newton iter).
        - `solverLin: LIB.FeaSolver instance` — the linear-material
          solver used by `coggingTorque` and `extractCoeffs` probes (independent
          factorization; same pattern as `solverSat`).
        - `lastNewton: { iters, deltaNorm, residual } | null` — last
          Newton-solve summary from the most recent `solve` /
          `solveStaticRotor` call (Phase 7 reads this for the
          saturated-cogging numeric guards).
        - `gapStampLog: number[]` — appended on every `gap.stamp(angle)` call
          inside `extractCoeffs`; cleared at the start of each `extractCoeffs`
          invocation. Test-only diagnostic; never used in production code paths.

  - `tests/slice/_fixtures.js` — loader + helpers used by every Phase-5 test
    file. `"use strict";` `if (!globalThis.window) globalThis.window =
    globalThis;` then in order:
    1. `require("../_shim.js")`
    2. `require("../../lib/winding-model.js")`
    3. `require("../../lib/excitation.js")`
    4. `require("../../lib/motor-circuit.js")`
    5. `require("../../lib/motor-mesh.js")`
    6. `require("../../lib/motor-mesh-view.js")`
    7. `require("../../lib/airgap-harmonic.js")`
    8. `require("../../lib/fea-solver.js")`
    9. `require("../../lib/motor-slice.js")`
    10. `require("../../lib/motor-stack.js")`
    11. `require("../../lessons/unified_motor/config-schema.js")`
    Exports:
    - `LIB`, `UnifiedMotor`, `CS = UnifiedMotor.ConfigSchema`.
    - `initSolver()` — returns `LIB.FeaSolver.init()` (a memoized promise the
      tests `await` before `MotorSlice.create`).
    - `sectionFromConfig(config) → section` — `CS.expand(config).slices[0].section`.
    - `polesFromConfig(config) → number` — `CS.expand(config).poles`.
    - `loadMachine(id) → config` — `require("../../lessons/unified_motor/machines/" + id + ".js");`
      then `UnifiedMotor.MACHINES.find(m => m.id === id).config`.
    - `feaOpts(extra) → opts` — base `{ saturation:{ enabled:false }, mesh:{ refine:0.5 } }`,
      merged with `extra`. The default-linear, coarse-mesh handle keeps test
      wall-clock manageable; tests that need a saturated solve override.
    - `assertClose(actual, expected, tol, msg)` — re-exported from
      `../_assert.js`.
    - `relErrInf(x, ref) → number`.
    - `solveCombinedDense(n, I, J, V, b)` — a tiny dense SPD solver (Cholesky or
      LDLT) used only by unit tests that need to drive an assembled system
      without going through `LIB.FeaSolver`; small `n ≤ 200`.

  - `tests/slice/assembly.test.js` — `node:test` + `node:assert/strict`.
  - `tests/slice/newton.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**: none.

- **Tests**:
  - `tests/slice/assembly.test.js`:
    - `"prepare returns the documented global layout"` — load
      `woundConfig`-style config; `await initSolver()`; `slice =
      MotorSlice.create(section, feaOpts({ poles: polesFromConfig(cfg) }))`;
      assert `slice.__internals.globalLayout` carries
      `{ Nn_rotor_free, Nn_stator_free, nHarmonicDofs, n }` with
      `n === Nn_rotor_free + Nn_stator_free + nHarmonicDofs` and
      `nHarmonicDofs === 2 * (2*slice.__internals.K + 1)`.
    - `"slice.nCircuits matches expand"` — assert
      `slice.nCircuits === CS.expand(cfg).nCircuits` for `woundConfig`,
      `pmConfig`, `salientConfig`.
    - `"combined pattern is symmetric"` — capture the triplet `(I,J,V)` set
      from `_internals.assembleCombinedTriplets(section, opts, 0)`
      (φ=0 form); for every triplet `(i,j,v)` assert a `(j,i)` triplet with
      equal cumulative value within `1e-12` (sum duplicates per coord first).
    - `"combined pattern is φ-invariant"` — capture pattern-key `Set` from
      `assembleCombinedTriplets(...,φ=0)` and `assembleCombinedTriplets(...,φ=1.07)`;
      assert pairwise `Set` equality of `"i,j"` keys (binding §11.1#3).
    - `"outer-stator Dirichlet pin removes the expected DOFs"` — count the
      stator nodes at `radius == section.grid.rOuter` within `1e-9` from the
      mesh directly, and assert
      `_internals.eliminateOuterStatorPin(...).pinned.length` equals that count.
    - `"linear-material assembly factorizes SPD"` — build the combined operator
      at `opts.saturation.enabled = false`, set on a `LIB.FeaSolver` instance,
      `analyze()` + `factorize()` succeeds (no throw), and a Jz-zero
      magnet-only solve produces a residual `‖Ax−b‖∞/‖b‖∞ < 1e-9` on
      `pmConfig` (the standard SPD sanity check).
    - `"Brauer per-material k1/k2/k3 fit"` — for a synthetic material
      `{ kind:"iron", muR:1000, mrMag:0, Bknee:1.6 }` and `BkneeDefault:1.6`,
      assert `brauerNu(0, mat, 1.6).ν === 1/(μ0·1000)` (the linear ν at B=0
      equals 1/(μ0·muR)) within `1e-15`, and that `brauerNu(Bknee², mat,
      1.6).ν === 2/(μ0·1000)` within `1e-9` (ν doubles at the knee per D5).
    - `"explicit k1/k2/k3 override wins over Bknee"` — material
      `{ kind:"iron", muR:1000, Bknee:1.6, k1:1e5, k2:1e3, k3:0.5 }`; assert
      `brauerNu(0.5, mat, …).ν === 1e5 + 1e3·exp(0.5·0.5)` within `1e-9` (raw
      formula); `Bknee` is not consulted.
    - `"BkneeDefault applies when material.Bknee is null"` — material
      `{ kind:"iron", muR:1000, Bknee:null }`, `BkneeDefault:1.4`; assert
      `brauerNu(1.4·1.4, mat, 1.4).ν` doubles `1/(μ0·1000)` within `1e-9`.
    - `"two iron materials with different Bknee stay distinct"` — feed two
      iron features `(muR:1000, Bknee:1.4)` and `(muR:1000, Bknee:1.8)` (via a
      minimally hand-built section, since `config-schema` would not need to
      coexist them in one ring); after Phase-2 mesh build, assert
      `mesh.materials.filter(m => m.kind === "iron").length === 2`, and that
      `brauerNu` produces a smaller ν at `B² = 1.6²` for the `Bknee=1.4`
      material than for `Bknee=1.8` (the lower-knee iron saturates earlier).

  - `tests/slice/newton.test.js`:
    - `"Newton converges within the §11.3 guards on a loaded operating point"` —
      `salientConfig` with `currents = [10]` (a moderately saturated point
      given the 20-turn coil; or scaled to reach `|B| ≳ Bknee` in the
      teeth); `opts = { saturation:{enabled:true} }`; run the public
      `_internals.solveStaticRotor(thetaR=0, currents)`; assert
      `iters ≤ 8`, `ΔA-norm tol satisfied`, `‖K·A − f‖∞/(‖f‖∞ + ε) < 1e-9`
      (the residual guard) at convergence.
    - `"Newton tangent matches finite-difference dν/dB²"` — for a synthetic
      material `{ muR:500, Bknee:1.5 }` at `B² ∈ {0.5², 1.5², 2.0²}`, compare
      `brauerNu(B², ...).dν_dB2` to `(brauerNu(B²+δ,...).ν − brauerNu(B²−δ,...).ν)/(2δ)`
      with `δ = 1e-5`; assert relative agreement `< 1e-5`.
    - `"linear-mode bypass does exactly one factorize"` — instrument the
      saturated `FeaSolver` instance with a counter (wrap `factorize` via the
      slice's `_internals`); run `_internals.solveStaticRotor(thetaR=0, currents)`
      with `opts.saturation.enabled = false`; assert `factorize` called
      exactly once and the resulting field's residual `< 1e-9`.
    - `"linear and saturated agree at low excitation"` — same `pmConfig`,
      `currents = [0]` (pure cogging probe so |B| stays below the knee in
      yokes/teeth); run static-rotor at `opts.saturation.enabled = true` and
      `false`; assert max `|A_sat[i] − A_lin[i]| / (‖A_lin‖∞ + ε) < 5e-3`
      (low-B saturation is a near-no-op).
    - `"warm-start cache is honored across consecutive static solves at same θ"` —
      run `_internals.solveStaticRotor(0, currents)` twice; assert the second
      call's Newton iter count `≤` the first's iter count (warm start should
      converge in fewer or equal iterations).
    - `"clearWarmStart resets the cache"` — after `slice.clearWarmStart()`,
      assert the next solve does NOT bypass Newton (iter count `≥ 1`; not
      degenerate to zero iterations).

- **Acceptance criteria**:
  - `slice = LIB.MotorSlice.create(section, opts)` returns successfully for
    `woundConfig`, `pmConfig`, `salientConfig`, and (with `await
    LIB.FeaSolver.init()` first) and exposes the documented contract surface
    plus `slice.__internals`.
  - The combined-system triplet pattern is symmetric and φ-invariant (binding
    §11.1#3).
  - The combined SPD operator factorizes successfully under D6 boundary
    conditions; magnet-only residual `< 1e-9`.
  - Brauer per-iron-material fit honors `(muR, Bknee)` from `material.Bknee`
    with the `BkneeDefault` fallback; per-material `{k1,k2,k3}` override
    short-circuits the fit.
  - Newton meets the §11.3 numeric guards (`ΔA tol < 1e-6`, `iters ≤ 8`,
    `residual < 1e-9`) at a loaded operating point on `salientConfig`.
  - All listed tests pass.
  - `lib/motor-slice.js` contains no machine name, machine-type enum, or
    machine-identity branch; dispatch is on element kind / material kind /
    terminal vocabulary only (binding §11.1#1).
  - No DOM/canvas access at module load.

---

## Wave 5.2: Slice contract — `solve` / torque / flux-linkage / mesh field + convergence

### Task T5.2.1: `solve(θ, currents)`, mesh-native `field`, harmonic torque, flux linkages, `coggingTorque`, refinement convergence

- **Description**: Extend `lib/motor-slice.js` with the public
  `solve(thetaR, currents) → { torque, fluxLinkages, field }`,
  `coggingTorque(thetaR) → number`, and `clearWarmStart()`. `solve`'s steps:
  set the harmonic phase `φ = thetaR` via `gap.stamp(thetaR)` (revalue only —
  the pattern is unchanged), assemble the Jz + magnetization RHS over both
  bodies, run the Wave-5.1 Newton solver (saturated by default; one linear
  factorize if `opts.saturation.enabled === false`), and post-process:
  - extract gap-circle nodal `A` for both bodies (via the
    `gapLocalToGlobal_*` maps) and call
    `gap.torque(rotorGapNodal, statorGapNodal, thetaR)` → `torque`;
  - assemble `fluxLinkages: Float64Array(m)` via the bridge formula above;
  - construct the mesh-native `field` (D3) — `Anode` per body restored to full
    size by inserting the D6-pinned `A=0` nodes; `Belem` computed per element
    from the shape-function gradients (Q4 and linear tri); `gap.harmonics` =
    `{ rotor: gap.project(rotor.gapTheta, rotorGapNodal),
       stator: gap.project(stator.gapTheta, statorGapNodal) }`, `gap.phi =
    thetaR`.
  `coggingTorque(thetaR)`: short-circuit to `0` when neither body has any
  `material.kind === "magnet"` (zero-not-skip, §11.1#2); otherwise a
  **linear-material** magnet-only solve (the slice's linear `FeaSolver`
  instance — same pattern, independent factorization), then
  `gap.torque(rotorGapNodal, statorGapNodal, thetaR)`. The linear solve uses a
  fresh zero start (no warm-start carry from `solve`), matching the old slice's
  semantics that the coenergy decomposition's cogging term is a linear
  magnet-only Maxwell-stress.

- **Files to create**:
  - `tests/slice/contract.test.js` — `node:test` + `node:assert/strict`.
  - `tests/slice/convergence.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**:
  - `lib/motor-slice.js` — implement the three public methods; no change to
    the `create(section, opts)` signature or the Wave-5.1 internals.

- **Tests**:
  - `tests/slice/contract.test.js`:
    - `"solve returns finite torque + fluxLinkages of length nCircuits"` — load
      `salientConfig`; `currents = new Float64Array([5])`; `r =
      slice.solve(0.0, currents)`; assert `Number.isFinite(r.torque)`,
      `r.fluxLinkages instanceof Float64Array`, `r.fluxLinkages.length ===
      slice.nCircuits`, every entry finite.
    - `"field carries mesh-native rotor/stator/gap shape (D3)"` — same setup;
      assert `r.field.rotor.mesh === slice.__internals.bodies.rotor`,
      `r.field.rotor.Anode.length === r.field.rotor.mesh.nodes.length/2`,
      `r.field.rotor.Belem.mag.length === r.field.rotor.mesh.elems.length/4`,
      `r.field.rotor.Belem.Bx.length === r.field.rotor.Belem.By.length ===
      r.field.rotor.Belem.mag.length`; same for stator; `r.field.gap.phi ===
      0.0`; `r.field.gap.harmonics.rotor.a.length ===
      r.field.gap.harmonics.rotor.b.length === slice.__internals.K + 1`; same
      for stator.
    - `"D6 pinned nodes report A = 0 in Anode"` — extract the pinned-node
      indices from `slice.__internals.eliminateOuterStatorPin(...).pinned`;
      assert every pinned index `i` has `r.field.stator.Anode[i] === 0`
      (strict).
    - `"Belem magnitude equals hypot(Bx, By)"` — assert
      `|Belem.mag[e] - Math.hypot(Belem.Bx[e], Belem.By[e])| < 1e-12` for
      every element of both bodies.
    - `"field changes with rotor angle"` — solve at θ=0 and θ=0.3; assert at
      least one `Anode_rotor` entry differs by `> 1e-9` (the rotor body is
      analytically rotated through the harmonic phase even though its mesh
      nodes do not move).
    - `"torque is finite and changes with currents"` — `pmConfig`; assert
      `slice.solve(0.0, [0]).torque !== slice.solve(0.0, [5]).torque` by at
      least `1e-9` (Jz changes the field).
    - `"magnet-free section ⇒ coggingTorque is exactly 0"` —
      `salientConfig` (no `M` ring); assert
      `slice.coggingTorque(0.2) === 0` strictly.
    - `"PM section ⇒ coggingTorque is finite and θ-dependent"` — `pmConfig`;
      assert `Number.isFinite(slice.coggingTorque(0.1))` and that
      `coggingTorque(0.0) !== coggingTorque(0.1)` by at least `1e-12`.
    - `"clearWarmStart does not throw, subsequent solve still produces a
      finite torque"`.
    - `"linear-mode solve matches saturated solve at very low excitation"` —
      `salientConfig`, `currents = [0.5]` (well below knee); compare
      `slice.solve(0.0, currents).torque` at
      `opts.saturation.enabled = true` and `false`; assert relative
      difference `< 5e-3`.
    - `"harmonic torque sign convention matches motor convention"` —
      `salientConfig`'s pole count is `cfg.poles = 4` (verified by reading
      `CS.expand(cfg).poles`), so the electrical angle is
      `θ_e = (poles/2)·thetaR = 2·thetaR`. Pick `thetaR = π/16` so
      `θ_e = π/8` lands mechanically between aligned (`θ_e = 0`) and
      unaligned (`θ_e = π/2`); `currents = [5]`. Assert
      `r = slice.solve(thetaR, currents)`'s `r.torque` is non-zero and its
      sign matches the sign of `-Math.sin(2·θ_e)` (reluctance machines
      pull toward alignment; positive aligned-side, negative
      unaligned-side). This is a low-precision sign check, not a magnitude
      assertion.
    - `"single FeaSolver instance per slice for the saturated path"` — assert
      `slice.__internals.solverSat !== slice.__internals.solverLin`; both are
      `LIB.FeaSolver`-created handles; calling
      `slice.__internals.solverSat.factorNnz()` returns a positive number.
    - `"no DOM access on module load"` — re-confirm `assert.ok(LIB.MotorSlice)`
      after `require` with `globalThis.window = globalThis` and no document.

  - `tests/slice/convergence.test.js`:
    - `"static-rotor torque convergent under mesh refinement"` — `pmConfig`,
      build the slice at `opts.mesh.refine ∈ {1.0, √2, 2.0}` (three coarser-
      to-finer levels), solve at θ=0 with `currents=[0]` and currents=[5],
      capture `torque(refine)`; assert
      `|torque(√2) − torque(1)| / max(|…|) < 1%` and
      `|torque(2) − torque(√2)| / max(|…|) < 1%` (the §11.3 avg-torque
      convergence bar, between successive refinements).
    - `"cogging amplitude convergent under refinement"` — `pmConfig`, sweep
      `θ ∈ {0, π/(8·poles), 2π/(8·poles), …, π/poles}` (8 angles over a
      cogging period), capture `peak−valley` of `coggingTorque(θ)` at each
      refinement; assert `|amp(√2) − amp(1)| / amp(√2) < 2%` and
      `|amp(2) − amp(√2)| / amp(√2) < 2%`.
    - `"refinement increases mesh DOF count"` — assert
      `slice(refine:2.0).__internals.globalLayout.n >
      slice(refine:1.0).__internals.globalLayout.n` (monotone, simple
      sanity).

- **Acceptance criteria**:
  - `slice.solve(thetaR, currents)` returns the documented `{torque,
    fluxLinkages, field}` shape with the mesh-native D3 `field`.
  - `coggingTorque(thetaR)` is exactly `0` for magnet-free sections and
    finite/θ-dependent for PM sections.
  - Torque and cogging amplitude converge between successive `refine ∈
    {1, √2, 2}` levels within the §11.3 bars (1% torque, 2% cogging
    amplitude).
  - The slice carries exactly two `LIB.FeaSolver` instances (saturated +
    linear), both built once at `create`.
  - All listed tests pass.

---

## Wave 5.3: `extractCoeffs` (staggered) + stack reconnection + pipeline re-green + perf diagnostic

### Task T5.3.1: Staggered probes, `motor-stack.js` reconnection, FEA-native pipeline tests, embed-vs-Schur diagnostic

- **Description**: Implement `slice.extractCoeffs(thetaR, opts2)` natively
  against the FEA assembly + harmonic gap (the §10 "~50 lines duplicated"
  reimplementation of `LIB.MotorCircuit.extract` against the slice's linear
  `FeaSolver` instance). For each of `{thetaR − h, thetaR, thetaR + h}` (with
  `h = opts2.derivStep ?? Math.PI/180` ≈ 1°):
  - rebuild the harmonic-gap border values via `gap.stamp(angle)` (interior
    is φ-independent in the linear-material operator);
  - `solverLin.setValues(V_combined)`; `solverLin.factorize()`;
  - one magnetization-only solve → `λ_pm,k(angle)` for each circuit;
  - `m` unit-current solves (each with `Jz = turnsDensity_j`, magnetization
    zero) → column `j` of `L(angle)`.
  Central-difference `dL/dθ` and `dλ_pm/dθ`; return `{L: L_center, dLdth,
  lambdaPm: lambdaPm_center, dLambdaPmdth}`. All probes are linear-material
  (per §10 "magnetization-only **linear** probe solves"). The Wave-5.1 warm
  start is not consulted by extract.

  Reconnect `motor-stack.js`: replace `sliceGrid(k) → {…grid fields…}` with
  `sliceMesh(k) → { rotor: BodyMesh, stator: BodyMesh }` (D2); add `opts.poles
  = expanded.poles` to the `MotorSlice.create(s.section, opts)` call (D8 — the
  only additive opts injection from the stack). Every other line of
  `motor-stack.js` byte-identical to baseline.

  Re-green the pipeline tests on the FEA slice: drive `LIB.MotorRun` /
  `LIB.MotorStack` exclusively via `CS.expand(woundConfig|pmConfig|salientConfig|skewN2Config)`;
  drop the grid-only `tinySection`/`makeExpanded`+`MotorCompile.compile`
  scaffold; replace `{ceiling:{enabled:false}}` with
  `{saturation:{enabled:false}}`; loosen step counts and tolerances to match
  FEA wall-clock; add a `sliceMesh` test.

  Add `tests/slice/perf.test.js` — the **D1 embed-vs-Schur escalation
  diagnostic**: load a representative full-annulus zero-symmetry fixture
  (`hybrid-stepper`), build the slice at the realistic-DOF setting
  (`opts.mesh = {}` — no `refine:0.5` reduction), warm up with one
  `solve(...)` (so analyze + first factorize don't taint the average), then
  time `N = 5` consecutive `solve(θ_k, currents)` calls (small θ steps + a
  fixed loaded current vector) and `console.log` the per-step mean and max in
  ms. The test **passes** as long as the timing was captured (`Number.isFinite`
  + positive). It does **not assert** `< 16 ms` — the 16 ms threshold is the
  escalation gate per the acceptance criteria below, where the implementer
  reads the log and (if it trips) takes a Clarification Exit reporting the
  measurement rather than silently building or skipping G5.

- **Files to create**:
  - `tests/slice/extract.test.js` — `node:test` + `node:assert/strict`.
  - `tests/slice/perf.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**:
  - `lib/motor-slice.js` — implement `extractCoeffs(thetaR, opts2)` consuming
    the slice's linear `FeaSolver` instance; expose
    `slice.__internals.derivedSlots`/`derivedPoles` for the tests; no other
    change to the public API.

  - `lib/motor-stack.js` — exactly these two surgical edits, no others:
    1. In `create(expanded, opts)`'s slice-construction loop, change
       `LIB.MotorSlice.create(s.section, opts)` to
       `LIB.MotorSlice.create(s.section, Object.assign({}, opts, { poles: expanded.poles }))`.
    2. Remove the function `sliceGrid(k)` and its `sliceGrid: sliceGrid,`
       entry in the returned object; add:
       ```js
       function sliceMesh(k) {
         var b = slices[k].slice.__internals.bodies;
         return { rotor: b.rotor, stator: b.stator };
       }
       ```
       and `sliceMesh: sliceMesh,` in the returned object (in the same
       position the old `sliceGrid:` entry occupied — keep the rest of the
       returned object's key order byte-identical).
    Every other line of `lib/motor-stack.js` is untouched.

  - `tests/pipeline/_fixtures.js` — restore the now-needed library requires
    that Phase 0 stripped, and adjust:
    1. After `require("../../lib/motor-circuit.js")`, insert (in order):
       `require("../../lib/motor-mesh.js");`,
       `require("../../lib/motor-mesh-view.js");`,
       `require("../../lib/airgap-harmonic.js");`,
       `require("../../lib/fea-solver.js");`,
       `require("../../lib/motor-slice.js");`.
    1a. Add `module.exports.CS = UnifiedMotor.ConfigSchema;` alongside the
       existing `LIB`/`UnifiedMotor`/`MACHINE_NAMES` exports. The Phase-7
       loader pattern (`const P = require("../pipeline/_fixtures.js")`,
       then `const CS = P.CS;`) relies on this; without the export
       `P.CS` is `undefined` and every Phase-7 `CS.expand(cfg)` call
       throws. (The `UnifiedMotor` reference is already in scope from the
       existing requires.)
    2. Add `async function initSolver() { return LIB.FeaSolver.init(); }` and
       export it.
    3. Add `function feaOpts(extra) { return Object.assign({ saturation:{enabled:false}, mesh:{refine:0.5} }, extra || {}); }` and export it.
    4. Remove the `function tinySection(...)` definition and its entry in
       `module.exports` (grid-only; the FEA tests use `CS.expand(woundConfig|…)`
       sections directly).
    5. Update the `MACHINE_NAMES` list — **no change** (the agnosticism scan
       tokens are unchanged; new FEA `lib/*` files do not introduce any
       machine name).
    Keep `woundConfig`, `pmConfig`, `salientConfig`, `skewN2Config`, `LIB`,
    `UnifiedMotor`, `MACHINE_NAMES`, `assertClose`. Keep the `_assert.js`
    `assertClose` import path.

  - `tests/pipeline/motor-stack.test.js` — full rewrite:
    1. Drop the `tinySection`, `makeExpanded`, and `LIB.MotorCompile.compile`
       references. Replace with `CS.expand(...)` configs.
    2. Replace every `LIB.MotorStack.create(makeExpanded(section, N, …))`
       with `LIB.MotorStack.create(CS.expand(cfg), feaOpts())` where `cfg` is
       the appropriate four-config helper.
    3. `await initSolver()` in each `it(...)` body before the first slice
       construction (or in a top-level `before(...)` hook).
    4. The eight current `it(...)` blocks become:
       - `"N=1 stack equals its single slice"` — use `woundConfig()` with
         `stack:{slices:1}`; compare `stack.solve(0.2, [5]).torque` to a fresh
         `LIB.MotorSlice.create(CS.expand(cfg).slices[0].section,
         feaOpts({poles:CS.expand(cfg).poles})).solve(0.2, [5]).torque`
         within `1e-9` relative.
       - `"N=2 zero-offset sums torque and flux"` — inside this `it(...)` body,
         build `cfg = woundConfig()`, then construct **two separate stacks**:
         `stack_n1 = LIB.MotorStack.create(CS.expand(woundConfig({ stack:{ slices:1 } })),
           feaOpts())` and
         `stack_n2 = LIB.MotorStack.create(CS.expand(woundConfig({ stack:{ slices:2, sliceOffsets:[0,0] } })),
           feaOpts())`.
         `r1 = stack_n1.solve(0.2, new Float64Array([5]))`,
         `r2 = stack_n2.solve(0.2, new Float64Array([5]))`. Assert
         `Math.abs(r2.torque - 2·r1.torque) / Math.max(Math.abs(r2.torque), Math.abs(2·r1.torque)) < 1e-9`
         (relative tolerance) and
         `Math.abs(r2.fluxLinkages[0] - 2·r1.fluxLinkages[0]) / Math.max(Math.abs(r2.fluxLinkages[0]), Math.abs(2·r1.fluxLinkages[0])) < 1e-9`.
       - `"non-zero slice offset produces a different torque"` — `woundConfig`
         with `[0,0]` vs `[0,0.4]`; assert `|Δtorque| > 1e-9`.
       - `"perSliceField length equals nSlices"` — for N ∈ {1,2,3} via
         `woundConfig` with the appropriate `stack.slices`/`sliceOffsets`.
       - `"coenergyTorque returns finite parts"` — `woundConfig`, `[5]`;
         assert each part finite, `total === reluctance + mutual + pm +
         cogging` within `1e-12`.
       - `"extractCoeffs returns correct-length arrays all finite"` —
         `woundConfig`; assert lengths and finiteness.
       - `"module loads under require with no DOM access"` — assert the
         `LIB.MotorStack` surface (now incl. `sliceMesh` not `sliceGrid`).
       - `"nCircuits mismatch throws descriptive error"` — build an `expanded`
         object that claims `nCircuits: 2` but each slice's `section.features`
         produce `nCircuits: 1` (use the `woundConfig` section directly; force
         the global field to `2`); assert `LIB.MotorStack.create` throws
         matching `/nCircuits/`.
       - `"clearWarmStart resets all slices without error"` — unchanged
         semantics on `woundConfig` N=2.
    5. **Replace** `"sliceGrid returns correct grid fields for each slice"`
       with `"sliceMesh returns rotor and stator BodyMeshes for each slice"`:
       for `woundConfig` with `stack:{slices:2, sliceOffsets:[0,0.1]}`,
       assert for each `k ∈ {0,1}` that `stack.sliceMesh(k)` returns
       `{rotor, stator}` and both bodies carry the BodyMesh contract fields
       (`nodes`/`elems`/`matId`/`srcId`/`turns`/`magDir`/`materials`/`gapLoop`/
       `gapTheta`/`gapR`/`sig` per Phase 2's contract).

  - `tests/pipeline/agnostic-pipeline.test.js` — surgical edits:
    1. Replace the `linearOpts = { ceiling:{enabled:false} }` line with
       `linearOpts = feaOpts({ saturation:{enabled:false} })` (the
       `feaOpts({...})` helper handle).
    2. In the `"all configs run … the rotor turns"` test, reduce the step
       count from `600` to `200` (FEA wall-clock); pass `feaOpts()` to
       `LIB.MotorRun.create(CS.expand(cfg), feaOpts())`; lower the
       theta-displacement bar from `1e-3` to `1e-4` (still well above
       float noise; FEA-on-coarse-mesh-at-linear-opts still spins the
       rotor over 200 steps for each config).
    3. The `"Maxwell agrees with co-energy within 10%"` test passes `linearOpts`
       to `LIB.MotorStack.create(expanded, linearOpts)` — same flow with the
       new opts vocabulary.
    4. The `"unified-motor lib + mount.js are free of machine names"` test:
       no new lib file introduced by Phases 1–5 contains a machine name —
       the new files (`lib/fea-solver.js`, `lib/solver.mjs`,
       `lib/motor-mesh.js`, `lib/motor-mesh-view.js`,
       `lib/airgap-harmonic.js`, `lib/motor-slice.js`) are by construction
       agnostic. **Do not modify `CARVE_OUTS`**; it stays exactly:
       `{ "app.js", "registry.js", "header-buttons.js", "stepper-drive.js", "three-phase.js" }`.
       The test runs unchanged against the expanded `lib/` listing.

- **Tests** (new):
  - `tests/slice/extract.test.js`:
    - `"extractCoeffs shape"` — `woundConfig`; assert `coeffs.L.length === m·m`,
      `coeffs.dLdth.length === m·m`, `coeffs.lambdaPm.length === m`,
      `coeffs.dLambdaPmdth.length === m`; every entry finite.
    - `"L is symmetric (reciprocity, linear material)"` — use a 3-phase wound
      config (build a config with `m:3` so `m=3`); assert
      `|L[i*m+j] - L[j*m+i]| / max(|L[i*m+j]|, |L[j*m+i]|) < 1e-6` for every
      `(i,j)`.
    - `"L_self > 0 for every circuit"` — for the same 3-phase config, assert
      `L[k*m+k] > 0` for every `k`.
    - `"magnet-free section → lambdaPm = 0 and dLambdaPmdth = 0"` —
      `salientConfig`; assert every entry of `lambdaPm` and `dLambdaPmdth` is
      strictly `0` (zero-not-skip).
    - `"PM section → lambdaPm changes with θ"` — `pmConfig`; assert
      `|lambdaPm_center(θ=0) - lambdaPm_center(θ=0.5)| > 1e-9` (the slice
      computes lambdaPm at the **center** angle of each extract call;
      compare two extract calls at different θ).
    - `"dLdth from extract matches central-difference of L"` — `salientConfig`;
      pick `h=Math.PI/180`; call extractCoeffs at θ=0.3 with default derivStep;
      independently call extract at θ=0.3+h and θ=0.3−h and compute
      `(L_plus − L_minus)/(2h)` from the centers; assert these match
      `coeffs.dLdth` from the θ=0.3 call within `1e-6` relative (the central-
      difference IS what extract returns, this just verifies the construction
      against the independent recomputation).
    - `"linear FeaSolver instance handles all three probe angles"` — capture
      `slice.__internals.solverLin.factorNnz()` after `extractCoeffs`; assert
      the same instance was used (no second `LIB.FeaSolver.create` was needed
      during extract); assert `factorize` was called exactly 3 times during
      the extract call (one per angle) and `solve` was called `3·(m+1)` times
      (m unit-current probes + 1 magnetization probe per angle).
    - `"derivStep override is honored at the unit level"` —
      instrument `slice.__internals.solverLin.factorize` by wrapping it in a
      counter, and stub-track the angle each `gap.stamp(angle)` call inside
      `extractCoeffs` is invoked with (via a per-slice
      `slice.__internals.gapStampLog: number[]` that the
      `extractCoeffs` body pushes into on every `gap.stamp(angle)` call).
      Call `extractCoeffs(0.3, { derivStep: Math.PI/360 })`; assert
      `gapStampLog` is exactly `[0.3 - Math.PI/360, 0.3, 0.3 + Math.PI/360]`
      within `1e-12` (the override step is the actually-used step), and
      that `solverLin.factorize` was called **three** times during the
      extract call. Then call `extractCoeffs(0.3)` (no override); assert
      `gapStampLog` is `[0.3 - Math.PI/180, 0.3, 0.3 + Math.PI/180]` (the
      default step of `Math.PI/180 ≈ 1°`). The `gapStampLog` is a
      `__internals`-only diagnostic, cleared at the start of each
      `extractCoeffs` call.

  - `tests/slice/perf.test.js`:
    - `"embed per-θ-step measurement logged at the realistic-DOF stepper"` —
      load `hybrid-stepper` (full-annulus zero-symmetry, the §11.4 stress
      case); `await initSolver()`; build the slice at default
      (`opts={poles:cfgPoles}` — no `mesh:{refine:0.5}` to honor the realistic
      DOF); warm-up `solve(0, currents=zeros)` once; then time five
      `solve(θ_i, currents)` calls at small θ increments
      (`θ_i = i · π/180` for `i=1..5`); compute `meanMs`, `maxMs`. `console.log`
      a single line containing both numbers and the §11.4 16 ms gate, e.g.
      `"[perf] embed per-θ-step (hybrid-stepper, full annulus, full Newton): mean=__ms max=__ms (§11.4 escalation gate: 16ms)"`.
      Assertions: `meanMs > 0`, `maxMs >= meanMs`, both `< 500` (catastrophic-
      regression sanity guard; this is **not** the 16 ms escalation gate).
      The test does **not** fail on the 16 ms threshold — the acceptance
      criteria below codify the manual escalation step.

- **Acceptance criteria**:
  - `extractCoeffs(thetaR)` returns the documented contract; `L` is symmetric
    (reciprocity), `L_self > 0`, `lambdaPm = 0` on magnet-free sections,
    and the central-difference relation between three angles' values and the
    returned `dLdth` / `dLambdaPmdth` holds within `1e-6`.
  - `motor-stack.js` has exactly two edits relative to baseline: the
    `opts.poles` injection on `MotorSlice.create` and the `sliceGrid →
    sliceMesh` rename; every other line is byte-identical (verifiable by
    `git diff lib/motor-stack.js`).
  - The re-greened `tests/pipeline/motor-stack.test.js` and
    `tests/pipeline/agnostic-pipeline.test.js` both run green under
    `node --test`, driving the FEA slice via `CS.expand(woundConfig | pmConfig
    | salientConfig | skewN2Config)`.
  - The Maxwell-vs-co-energy `≤ 10%` cross-check passes for every config at
    `{saturation:{enabled:false}}` (the FEA equivalent of the old
    ceiling-disabled comparison).
  - The agnosticism scan in `agnostic-pipeline.test.js` finds zero machine
    names in `lib/*.js` or `mount.js` (all new FEA files clean).
  - `tests/slice/perf.test.js` logs a finite embed per-θ-step measurement at
    the `hybrid-stepper` fixture.
  - **§11.4 escalation (manual, mandatory):** if `perf.test.js`'s logged
    `meanMs` or `maxMs` **exceeds 16 ms**, the implementer takes a
    **Clarification Exit** and escalates to the user — quoting the measured
    value, the fixture, and the §11.4 criterion — rather than silently
    building the §9-G5 Schur path or silently ignoring the threshold. The
    G5 build is a scope addition the user authorizes; it is **not** part of
    Phase 5 acceptance. (Phase 5 acceptance closes once the diagnostic is
    logged and the rest of the suite is green.)
  - All listed tests pass.
  - `lib/motor-slice.js` contains no machine name, machine-type enum, or
    machine-identity branch end-to-end across all three waves.
  - No DOM/canvas access at module load in `lib/motor-slice.js`.

## Eddy-current regime — validity statement (added 2026-05-27)

Phase 5 solves the **2-D magnetostatic** problem `∇×ν∇A = J`. This is the
quasi-static approximation: induced eddy currents in iron and conductors are
neglected on the assumption that the AC field penetrates fully into the
relevant region. The static approximation is valid when the **iron-region
skin depth at the operating frequency is large compared to the iron region's
characteristic transverse dimension** (tooth width, back-iron radial depth).

**Quantitative bound.** Skin depth in iron at frequency `f` is
`δ = √(2/(2π·f·μ₀·μ_r·σ))`. For silicon steel (`μ_r ≈ 1000`, `σ ≈ 2e6 S/m`):
- `f = 50 Hz`  → `δ ≈ 1.6 mm`
- `f = 60 Hz`  → `δ ≈ 1.5 mm`
- `f = 400 Hz` → `δ ≈ 0.56 mm`
- `f = 1 kHz`  → `δ ≈ 0.36 mm`

For copper conductors (`μ_r=1, σ=5.96e7 S/m`):
- `f = 50 Hz`  → `δ ≈ 9.2 mm`
- `f = 1 kHz`  → `δ ≈ 2.06 mm`
- `f = 10 kHz` → `δ ≈ 0.65 mm`

**Per-fixture validity (with the current 15-fixture industrial-scale suite):**
- All AC and PWM fixtures driven at `f ≤ 60 Hz` with iron tooth widths
  `≥ 4 mm` (roughly all fixtures): static approximation valid to within ~5%
  of fundamental-frequency torque/EMF.
- Hybrid-stepper, VR-stepper, SR motor: their dominant excitation is step/DC
  with PWM chopping. The DC component dominates; PWM ripple is not modeled
  but does not contribute to mean torque.
- Brushed-DC fixtures: DC excitation, no eddy-current regime concern.
- Induction-1ph and induction-3ph: cage-bar eddy currents are **the whole
  physics** of the machine. The static slice CANNOT model induction motor
  steady-state behaviour. The slice can still produce a valid mesh, field,
  and circuit-coupled solve at zero slip (synchronous rotation, no induced
  cage current), but real induction-motor torque-speed curves require
  Phase 5+ extension OR a complex-A AC-magnetic solve at slip frequency,
  which is NOT in this phase.

**Acceptance implication.** The torque/back-EMF acceptance tests in Wave 5.2
and Phase 7 must skip the two induction fixtures OR explicitly test only
zero-slip operation. Any future fixture with operating frequency above 1 kHz
or iron tooth width below 1 mm must be flagged with a documented
`eddyConcern: true` field, and Phase 5 must either reject it or treat it
as zero-slip-only. The slice does NOT silently compute a wrong answer for
out-of-regime configurations: `motor-slice.js` MUST throw on construction
if the per-circuit frequency × iron region's smallest dimension violates
`δ_iron > 2 × dim_min` (i.e. skin depth must exceed twice the smallest
iron dimension for static to apply to within ~5%).

**Direct test.** Add `tests/slice/eddy-regime.test.js`:
- A fixture with iron tooth width 0.5 mm and AC frequency 1 kHz throws
  with a message naming the offending region.
- A standard 50 Hz PMSM passes the construction check.

## `extractCoeffs` `derivStep` — derivation (added 2026-05-27)

The default `derivStep` for the central-difference derivative
`dL/dθ ≈ [L(θ+h) − L(θ−h)] / (2h)` is now derived rather than picked.

For double-precision floating point, the optimal step minimizes the sum of
truncation error (`~ h²·max|d³L/dθ³|/6`) and round-off error
(`~ ε·|L|/h`, where `ε ≈ 2.2e-16`). Setting `d/dh` of that sum to zero:
`h_opt = (3·ε·|L| / max|d³L/dθ³|)^(1/3)`.

For motor inductance L(θ) varying smoothly over a pole period (≈2π/poles),
`max|d³L/dθ³|` is roughly `|L| · (poles/π)³`. Substituting:
`h_opt ≈ (3·ε·(π/poles)³)^(1/3) ≈ 1.8e-5 · (π/poles)` rad.

For a 4-pole machine: `h_opt ≈ 1.4e-5 rad`.
For an 8-pole machine: `h_opt ≈ 7e-6 rad`.

**Spec change.** The default `derivStep` is now `Math.PI / (poles · 1e5)`
(machine-aware, derived). The old `Math.PI/180` default is removed.
Callers that override `derivStep` keep that ability, but the override
itself is now validated to lie within `[1e-7, π/(10·poles)]`, throwing
on values outside that range (too-small steps amplify round-off;
too-large steps lose smoothness assumption). The override-validation
test in `tests/slice/extract.test.js` is updated to cover both bounds.

**Acceptance:** `dL/dθ` computed at `derivStep = π/(poles·1e5)` agrees
with the analytic round-rotor `dL/dθ = 0` (identically zero for a round
rotor) to within `1e-12` (machine-epsilon * |L|), demonstrating that
the chosen step does not lose precision to round-off.

## Constraint-matrix handling for per-feature mesh (added 2026-05-28)

Phase 2.7 (per-feature tangential columns + uniform gap band) exports a
`body.constraints` field on each `BodyMesh` when band transitions create
hanging nodes:

```
constraints: {
  slaves: Int32Array      // slave node global indices (within the body)
  masters: Float64Array   // [idx_left, w_left, idx_right, w_right] per slave
} | null
```

The slice's assembly layer applies the constraint transformation
`K̂ = CᵀKC, f̂ = Cᵀf` to the rotor and stator body blocks before
invoking the solver, and recovers full nodal vectors via `A = C·Â`
after the solve. Phase 1's sparse solver wrapper is unchanged — the
constrained system is just another SPD sparse problem.

**Critical layout fact**: the constraints touch body-INTERIOR nodes
only. The gap-loop nodes (used by `B_r`, `B_s` in the bordered system)
are in the uniform gap-adjacent band, where C is identity for those
indices. Therefore the harmonic-coupling blocks `B_r`, `B_s` and the
harmonic-self block `M` stay BYTE-IDENTICAL under the constraint
transformation. Only `K_rotor`, `K_stator`, `f_rotor`, `f_stator`
transform.

The constrained bordered system:

```
[Cᵀ_r·K_r·C_r       0                       B_r ] [Â_rotor ]   [Cᵀ_r·f_r ]
[0                   Cᵀ_s·K_s·C_s           B_s ] [Â_stator] = [Cᵀ_s·f_s ]
[B_rᵀ                B_sᵀ                    M   ] [a_b      ]   [0         ]
```

SPD preserved: if the unconstrained system was SPD, so is the
constrained system (CᵀKC is SPD for any full-rank C; the bordering by
B_r, B_s, M preserves the property).

**Implementation contract** for the new internal helpers in
`lib/motor-slice.js`:

- `buildConstraintOps(constraints, N) → { applyKLeft, applyKRight,
  applyFLeft, recoverFull }`
  - `applyKLeft(triplets) → triplets`: pre-multiplies CᵀK by walking
    each (I, J, V) triplet; if I is a slave, distributes V to
    (masters of I, J) entries with the slave's weights. Output is
    triplets indexed only by master nodes (slave row index never
    appears in output I).
  - `applyKRight(triplets) → triplets`: post-multiplies K·C; mirror
    of `applyKLeft` applied to J indices.
  - `applyFLeft(f: Float64Array) → f_hat: Float64Array`: dense version
    for the RHS vector. For each slave i, distributes f[i] to its
    masters; sets f_hat[slave] = 0 (or removes the entry — the slave
    index is eliminated from f_hat).
  - `recoverFull(A_hat: Float64Array) → A: Float64Array`: writes
    A[master] = A_hat[master] for each master, then computes
    A[slave] = (1-w)·A[m_left] + w·A[m_right] for each slave.

- The pattern `K̂ = applyKLeft(applyKRight(K_triplets))` is computed
  once per geometry change and cached (the slice already caches
  symbolic factorization across Newton iters; the constraint
  application piggybacks on that cache).

- At Newton iteration: `K(A)` is rebuilt with current ν per element
  (Brauer update), then `K̂ = applyKRight(applyKLeft(K_triplets))` is
  re-applied because the triplet values change. Symbolic factorization
  is preserved.

**Test additions** in Wave 5.1:

- `tests/slice/constraints-spd.test.js`:
  - For a small representative mesh with non-trivial constraints
    (a 4×4 quad fixture with hanging-node band transition):
    - Verify the constraint application produces an SPD matrix
      (Cholesky factorization succeeds via the existing solver).
    - Solve a known problem with constraints applied; verify
      `‖K·(C·Â) − f‖∞ < 1e-9` (the full unconstrained system is
      satisfied to solver tolerance).
    - Recover full vector `A = C·Â`; verify all slave nodes satisfy
      `A[slave] = (1-w)·A[m_left] + w·A[m_right]` exactly.
  - For each of the 15 fixtures' rotor body with non-null
    constraints: build the slice, perform one solve at zero current,
    verify SPD-ness via the solver's residual check passes.

**Acceptance addendum** for Phase 5:

- All slice tests pass on fixtures with `body.constraints != null` AND
  on fixtures where it's null (no-op path must work — the assembly
  code's constraint handling is bypassed when `constraints === null`).
- The full system residual `‖K·A − f‖∞/‖f‖∞ < 1e-9` is verified after
  reconstruction of full A, not just on the reduced system — proves
  the constraint application is consistent with the full unconstrained
  problem.
- No Phase 1 solver API change. The wrapper sees a standard SPD
  sparse problem.

## Phase 5 acceptance now includes ONE non-self-referential physical test (added 2026-05-27)

To close the "solver converges on itself" loophole, Wave 5.2 adds:

`tests/slice/analytic-reference.test.js`:
- Build a slotless ring-magnet fixture (PMSM stripped of stator slots — a
  smooth-bore stator with surface magnets only). The analytic in-gap
  radial field is `|B_r(r,θ)| = Br · g_m / (g_m + g) · cos(p·θ)` per
  Hague's formula for a surface-magnet machine.
- Solve at θ=0 with zero stator current.
- Sample the mesh-native `field` at 24 points around the gap circle
  `r = gapR`.
- Assert `‖B_FEA(θ_k) − B_analytic(θ_k)‖∞ / max|B_analytic| < 3%`.

This test is independent of any refinement sweep and pins the slice to
a physical reference at refine=1. If Phase 5's default mesh isn't fine
enough to hit 3% on this test, the right response is to increase the
auto-derived cells-per-pole (Phase 2.6 tangential follow-up), not to
loosen the tolerance.

## Out of Scope (Phase 5)

- The Phase 6 mesh-native cross-section render, 3-D rig, machine picker, and
  geometry sliders. The slice publishes the mesh-native `field` (D3) and the
  preserved upper layers' UI seam is unchanged.
- The Phase 7 physics validation: every analytic acceptance criterion
  (no-load back-EMF, slotless/Carter gap, `L(θ)` fit, cross-method torque
  consistency, the saturated-cogging headline) runs against `tests/fea-engine/*`
  (Phase 7) and `tests/machines/*` (Phase 7's re-point). Phase 5 ships only
  the static-rotor refinement convergence check (§11.3 between-refinement
  bar) — the deeper validation is Phase 7's.
- The §9-G5 Schur condensation — D1 escalation-gated; built only on §11.4
  measurement trip (Clarification Exit), as a separate scope addition.
- Off-thread worker — §11.4 measurement-gated, deferred to Phase 6 if
  triggered.
- The wound-field-synchronous **self-start** un-skip — Phase 7 owns the
  test file; Phase 3 already owns the fixture's CURRENT terminal flip.
  Phase 5 simply lets the dynamic test become runnable for the first time
  (the FEA slice exists end-to-end), but the assertion itself is Phase 7.
