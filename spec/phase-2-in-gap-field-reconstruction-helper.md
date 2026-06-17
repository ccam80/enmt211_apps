# Phase 2: In-gap field reconstruction helper

## Overview

Expose the polar-Laplace air-gap field reconstruction — the same machinery
`lib/airgap-mortar.js`'s `torque()` performs internally to band-average Maxwell
stress — as a standalone, DOM-free, render-callable helper `LIB.GapEval`. Given
the two body gap-rings (rotor + stator boundary `A`, their radii/angles, and the
rotor offset `phi`), it solves the current-free annulus BVP and returns the
reconstructed vector potential `A(r,θ)` and field `B` on a render-supplied polar
grid. The 2-D (Phase 3) and 3-D (Phase 5) renders use it to draw smooth flux
lines and gap `|B|` that bridge rotor↔stator across the unmeshed gap.

This phase is a pure numerical helper plus its own headless unit test. It does
**not** wire the helper into any render and does **not** modify the engine.
`lib/airgap-mortar.js` is not touched.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

### Design decisions (current-state facts)

- **Home: a new standalone file `lib/gap-eval.js`.** The render holds no mortar
  engine handle (it sees only `field` + mesh), engine physics is a hard
  Non-Goal, and the render grid resolution (`Nr≈8`, `Ntheta≈96`) differs from
  the mortar's torque-tuned internal grid (`Nu = max(Ngr,Ngs)`, `L_SUB=8`), so
  the mortar's once-factored `recSolver` is not reusable. `gap-eval.js`
  re-derives the generic polar-Laplace BVP at the render grid; it duplicates no
  mortar coupling internals (no band/zipper/Arkkio code).
- **Input is an explicit descriptor**, decoupled from the engine's
  `perSliceField` layout. Phase 3/5 build the descriptor from a `perSliceField`
  entry (boundary `A` extracted via `mesh.gapLoop`).
- **Solve backend is `LIB.FeaSolver`** (`create`/`setPattern`/`setValues`/
  `analyze`/`factorize`/`solveInto`) — the same SPD path the mortar uses. The
  factored solver is memoized per gap grid so per-frame cost is resample + RHS +
  solve only.
- **Return carries both `A` and `B`** so Phase 3's gap-`|B|` overlay never has to
  reopen this Phase-2-owned file.

### Known transient regression (out of scope, owned by Phase 3)

Creating `lib/gap-eval.js` flips the guarded `require("../../lib/gap-eval.js")`
in `tests/render/_fixtures.js` to load successfully, so the **draft**
`lessons/unified_motor/cross-section-render.js` (Phase-3-owned) begins invoking
`LIB.GapEval.evalAOnGrid(field.gap, r_mr, r_ms, {…})` — passing four positional
arguments to the two-argument `(gapInput, opts)` API, so `gapInput` receives
`field.gap` and `opts` receives the scalar `r_mr` (wrong arity). That draft path
(exercised by `tests/render/cross-section-render.test.js`
"paint clears and draws the rotor + stator", flux-lines on) will throw and the
render suite will go red. This is accepted: Phase 3 rewrites the render to build
the proper descriptor and call `evalAOnGrid(descriptor, {Nr,Ntheta})`. Phase 2
does **not** add a defensive guard to mask it. Phase 2's acceptance is scoped to
its own test and to introducing no new failures in the airgap/engine suites.

## Files Owned

- `lib/gap-eval.js` — created
- `tests/airgap/gap-eval.test.js` — created

## Wave 2.1: gap-field evaluation helper + test

### Task 2.1.1: `LIB.GapEval.evalAOnGrid` — polar-Laplace gap reconstruction + headless test

- **Description**: Create `lib/gap-eval.js`, an IIFE registering
  `window.LIB.GapEval = { evalAOnGrid }`. `evalAOnGrid(gapInput, opts)`
  reconstructs the current-free air-gap field on a polar render grid by solving
  the discrete polar-Laplace BVP in the annulus between the rotor and stator
  gap-rings, with the two rings as Dirichlet boundaries. It returns the
  reconstructed `A(r,θ)` plus the derived `B = ∇×(A ẑ)` on the grid. DOM-free;
  no machine-name or machine-type dispatch; the only structural axes are grid
  resolution and ring geometry.

  **Input contract** —
  `gapInput = { rotor, stator, phi }` where each of `rotor`/`stator` is
  `{ gapR: number, gapTheta: Float64Array, A: Float64Array }`:
  - `gapR` — the ring radius. Requires `stator.gapR > rotor.gapR`.
  - `gapTheta[i]` — the ring node angles. The **rotor** ring angles are in the
    rotor body frame; the **stator** ring angles are in the lab frame. The rings
    are uniform-in-index (FEA gap rings always are); the helper sorts each ring
    ascending once and treats it as uniform step `2π/n`.
  - `A[i]` — the nodal vector potential at ring node `i`, in `gapTheta` order.
  - `phi` — the rotor body-frame angle (lab angle of rotor node `i` =
    `rotor.gapTheta[i] + phi`).

  **Options** — `opts = { Nr, Ntheta }`:
  - `Nr` — number of radial rings in the output grid, inclusive of both
    boundaries (`Nr ≥ 2`; interior unknown rings `nInt = Nr − 2`).
  - `Ntheta` — number of uniform angular samples in the output grid.

  **Return** — `{ rs, thetas, Az, Br, Bth, Bmag }`:
  - `rs` — `Float64Array(Nr)`, `rs[i] = rotor.gapR + i·(stator.gapR − rotor.gapR)/(Nr−1)`;
    `rs[0] = rotor.gapR`, `rs[Nr−1] = stator.gapR`.
  - `thetas` — `Float64Array(Ntheta)`, `thetas[j] = j·2π/Ntheta` (lab frame).
  - `Az` — `Float64Array(Nr·Ntheta)`, row-major `Az[i·Ntheta + j] = A(rs[i], thetas[j])`.
  - `Br`, `Bth` — `Float64Array(Nr·Ntheta)`, the radial and tangential flux
    density from `B = ∇×(A ẑ)`: `Br = (1/r)·∂A/∂θ`, `Bth = −∂A/∂r`.
  - `Bmag` — `Float64Array(Nr·Ntheta)`, `hypot(Br, Bth)`.

  **Method** (mirrors `airgap-mortar.js` `torque()` reconstruction, generalized
  to the render grid; the spec pins the numerics because they are
  architecturally significant):
  1. Sort each input ring ascending by angle (`sortedPerm`), giving each ring a
     base angle `th0` and uniform step `2π/n`.
  2. Resample both rings onto the uniform output angular grid via a periodic
     4-point Catmull-Rom cubic `cubicRing(vals, perm, n, th0, step, ang)`:
     - `vals` — the ring's nodal `A` values in original node order.
     - `perm` — the ascending-sort permutation from `sortedPerm(theta)`: an
       `Int32Array` of indices into `vals` / the ring, so `vals[perm[0]]` is
       the node at the smallest angle.
     - `n` — node count.
     - `th0` — base angle = smallest ring angle = `theta[perm[0]]`.
     - `step` — uniform angular step `2π/n`.
     - `ang` — query angle in the same frame as the ring's stored angles. The
       rotor ring is queried at `thetas[j] − phi` (mapping lab→rotor-body frame);
       the stator ring is queried at `thetas[j]` (lab frame).

     Fractional index `f = (ang − th0) / step`; integer base `i0 = floor(f)`;
     fraction `t = f − i0`. The 4-point Catmull-Rom stencil reads nodal values
     at `perm[(i0−1) mod n]`, `perm[i0 mod n]`, `perm[(i0+1) mod n]`,
     `perm[(i0+2) mod n]` (periodic wrapping modulo `n`).

     Call sites:
     - rotor (to lab frame): `aR_u[j] = cubicRing(rotor.A, permR, nR, th0R, stepR, thetas[j] − phi)`;
     - stator: `aS_u[j] = cubicRing(stator.A, permS, nS, th0S, stepS, thetas[j])`.
  3. If `nInt ≥ 1`: assemble the SPD cyclic-block-tridiagonal polar-Laplace
     system over `nInt × Ntheta` interior unknowns. For interior ring `i`
     (radius `rs[i]`): radial coefficient `ar = 1/hr²` with `hr = (Rs−Rr)/(Nr−1)`;
     angular coefficient `bang(i) = 1/(hθ²·rs[i]²)` with `hθ = 2π/Ntheta`;
     diagonal `2·ar + 2·bang(i)`; angular neighbours `−bang(i)` at `j±1`
     (periodic); radial neighbours `−ar` to rings `i±1`. The `Rr`/`Rs` Dirichlet
     boundaries fold into the RHS of the first/last interior rows
     (`+ar·aR_u[j]` for interior ring 1, `+ar·aS_u[j]` for interior ring
     `nInt`). Solve with `LIB.FeaSolver` (`setPattern`/`setValues`/`analyze`/
     `factorize`/`solveInto`).
  4. If `nInt = 0` (`Nr = 2`): no interior solve; the grid is the two boundary
     rings only.
  5. Assemble `Az` row-major: row `0 = aR_u`, rows `1..nInt =` solved interior,
     row `Nr−1 = aS_u`.
  6. Compute `Br` via a periodic central difference of `Az` in `θ` divided by
     `rs[i]`; `Bth` via a central difference of `Az` in `r` (one-sided at the
     `i=0` and `i=Nr−1` boundary rows); `Bmag = hypot(Br, Bth)`.

  **Memoization**: cache the factored `LIB.FeaSolver` instance and its pattern
  scratch keyed on `(Nr, Ntheta, rotor.gapR, stator.gapR)` at module scope, so
  back-to-back calls at a fixed gap geometry reuse the factor (only resample +
  RHS + `solveInto` per call). Rebuild on key change.

  **Validation**: throw a descriptive `Error` when `gapInput.rotor` or
  `gapInput.stator` is missing/malformed, when `stator.gapR ≤ rotor.gapR`, or
  when `Nr < 2`. (No silent empty-grid fallback — see "Known transient
  regression".)

- **Files to create**:
  - `lib/gap-eval.js` — IIFE registering `window.LIB.GapEval = { evalAOnGrid }`.
    Module-private helpers: `sortedPerm(theta)`, `cubicRing(vals, perm, n, th0, step, ang)`,
    a memoized BVP-solver factory keyed on `(Nr, Ntheta, Rr, Rs)`. Depends on
    `LIB.FeaSolver` (loaded before it). No `document`/`window` access beyond the
    `LIB` attach. No machine-name strings.

- **Tests**:
  - `tests/airgap/gap-eval.test.js::"reconstructs an analytic gap harmonic (round-trip)"`
    — for each `k ∈ {1,2,3,4}` and `phi ∈ {0, 0.4}`, build a descriptor on a
    3 mm / 50 mm gap (`Rr=0.050`, `Rs=0.053`, 256-node rings, rotor ring offset
    half a node) whose boundary `A` is the analytic current-free harmonic
    `A(r,θ) = (a·ρ^k + b·ρ^−k)·cos kθ + (c·ρ^k + d·ρ^−k)·sin kθ`, `ρ = r/r0`,
    `r0 = ½(Rr+Rs)`, sampled in the **lab** frame (rotor boundary at lab angle
    `gapTheta+phi`); call `evalAOnGrid(descriptor, {Nr:16, Ntheta:128})`; compute
    `maxInteriorA = max|Az[i·Ntheta+j]|` over interior rings `i ∈ [1, Nr−2]`;
    assert `maxInteriorA > 0` (so a mis-constructed fixture yields a clear
    diagnostic rather than a silent `NaN < 0.03`); then assert the max relative
    error of `Az` over every interior ring against the analytic `A(rs[i], thetas[j])`
    is `< 0.03` (normalized by `maxInteriorA`).
  - `tests/airgap/gap-eval.test.js::"honors the Dirichlet boundary rings"`
    — for `k=2`, `phi=0.37`, `{Nr:16, Ntheta:128}`, assert `Az` row `0`
    (`r=Rr`) matches the analytic `A(Rr, thetas[j])` and row `Nr−1` (`r=Rs`)
    matches `A(Rs, thetas[j])`, each to `< 0.01` relative.
  - `tests/airgap/gap-eval.test.js::"field is smooth, finite, and monotone for a radial BC"`
    — (a) for `phi ∈ {0, 0.37, π/3}` with a `k=2` harmonic descriptor, assert
    every entry of `Az`, `Br`, `Bth` is finite (no `NaN`/`Inf`); (b) build a
    constant-boundary descriptor (`rotor.A ≡ 0`, `stator.A ≡ 1`, `phi=0`) and
    assert `Az` is monotone non-decreasing in `i` at every `j` (the
    θ-independent radial solution).
  - `tests/airgap/gap-eval.test.js::"reconstructs gap B from the harmonic"`
    — for `k=2`, `phi=0`, `{Nr:24, Ntheta:192}`, compare `Br`/`Bth` over interior
    rings to the analytic `Br = (1/r)∂A/∂θ` and `Bth = −∂A/∂r` of the same
    harmonic; assert max relative error `< 0.08`.
  - `tests/airgap/gap-eval.test.js::"output shape and indexing"`
    — assert `rs.length === Nr`, `thetas.length === Ntheta`,
    `Az.length === Nr·Ntheta` (and likewise `Br`/`Bth`/`Bmag`);
    `rs[0] ≈ Rr`, `rs[Nr−1] ≈ Rs` (to `1e-12`); `thetas[j] === j·2π/Ntheta`.
  - `tests/airgap/gap-eval.test.js::"Nr=2 degenerate grid has no interior solve"`
    — `evalAOnGrid(descriptor, {Nr:2, Ntheta:64})` returns the two boundary rings
    only, does not throw, and every `Az` entry is finite.
  - `tests/airgap/gap-eval.test.js::"rejects malformed input"`
    — `evalAOnGrid({phi:0}, {Nr:8, Ntheta:64})` (no rings),
    `evalAOnGrid({rotor:R, stator:R, phi:0}, …)` with `stator.gapR ≤ rotor.gapR`,
    and `evalAOnGrid(descriptor, {Nr:1, Ntheta:64})` each throw an `Error`.
  - `tests/airgap/gap-eval.test.js::"is machine-agnostic and DOM-free"`
    — read `lib/gap-eval.js` as UTF-8 and assert it contains none of the machine
    names `bldc`, `pmsm`, `srm`, `squirrel`, `stepper`, `brushed`,
    `universal-motor`, `wound-field` (case-insensitive), and contains no
    `document.` reference.

  The test harness mirrors `tests/airgap/torque-formula-field.test.js`: set
  `globalThis.window = globalThis`; `require` `util.js` (guarded), then set
  `process.env.FEA_SOLVER_MJS_PATH` to the absolute `lib/solver.mjs` path and
  `require` `fea-solver.js` and `gap-eval.js`; register
  `before(async () => { await LIB.FeaSolver.init(); })`.

- **Acceptance criteria**:
  - `lib/gap-eval.js` exists and registers `window.LIB.GapEval` with an
    `evalAOnGrid` function; it does not modify or import `lib/airgap-mortar.js`.
  - `node --test tests/airgap/gap-eval.test.js` passes (all eight tests above).
  - The analytic-harmonic round-trip holds `Az` interior error `< 3%` for
    `k ≤ 4` at `Nr=16`, `Ntheta=128`, at multiple `phi`.
  - The reconstructed boundary rows reproduce the prescribed gap-ring fields to
    `< 1%`.
  - `node --test tests/airgap/` and `node --test tests/fea-engine/` (the engine
    suites) show no new failures attributable to `lib/gap-eval.js`. (The
    pre-existing `tests/render` flux-line draft path failing on the stale
    `field.gap` argument is the documented Phase-3-owned transient regression and
    is not a Phase-2 failure.)
