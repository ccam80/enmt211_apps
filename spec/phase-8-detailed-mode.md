# Phase 8: Detailed mode (refined grid + Web Worker)

## Overview

The accurate, off-thread fidelity tier. The Live tier (Phases 1–5) runs the
coarse field solve on the main thread in real time. Detailed mode runs the
**same simulation** — the same `LIB.MotorRun` temporal loop, the same agnostic
config pipeline — through a **refined field-solve backend** that is too slow for
the main loop, so it executes in a **Web Worker**. The UI stays responsive; the
worker streams the (slower-than-real-time) refined result back for display.

Detailed is not a different *kind* of computation — it is the Phase-5 engine with
its `SolveBackend` swapped from coarse to refined. That swap is the whole reason
Phase 5 made the field-solve tier pluggable. Phase 8 therefore adds **no**
orchestration: it ships one refined backend, one worker harness that hosts the
standard `MotorRun`/`MotorStack` with that backend injected, and one header
control that drives the worker and renders its output.

It ships, in dependency order:

1. **`lib/airgap-refine.js`** — the refined `SolveBackend`: a uniformly-finer
   polar grid (k× the Live resolution, re-rasterized through the frozen Phase-2
   `motor-compile`), tooth-tip **corner reluctivity regularization** (graduating
   `ν` at iron convex corners to regularize the `r^(−1/3)` corner singularity
   that makes cogging hard to resolve), and a **geometric multigrid** linear
   solve (semi-coarsening in θ — the thin-annulus anisotropy direction) so the
   high-`N` solve has grid-independent iteration counts. Exposes
   `LIB.AirgapRefine.backend(opts)` returning a `{ prepare, solveSaturated,
   linearSolve }` object that drops into `LIB.MotorSlice.create`'s `opts.backend`
   (the Phase-5 seam).
2. **`lib/airgap-worker.js`** — the Web Worker harness. Its pure core
   (`LIB.AirgapWorker.compute` for a one-shot static sweep / field map, and
   `LIB.AirgapWorker.createSession` for the streamed time-domain run) is a thin
   composition over the standard `LIB.MotorStack` / `LIB.MotorRun` with the
   refined backend; a **worker-context-guarded bootstrap** wires the message
   pump. Imports only `lib/` modules — never the app-layer `config-schema.js`
   (the main thread expands the config before posting it), so `lib/` stays free
   of app dependencies.
3. **`lessons/unified_motor/detailed-toggle.js`** — the Live/Detailed header
   control plus a companion result panel, both attached through the Phase-5
   registration seams. The toggle spawns/terminates the worker (the explicit
   worker boundary — no per-frame switching); the panel renders the worker's
   streamed frames (refined gap-field heatmap + torque/ω/θ readouts) and an
   on-demand zero-current cogging sweep. The Live main-viewport keeps running, so
   Live and Detailed are a deliberate side-by-side compare; no mount edit is
   needed.

### Relationship to the frozen pipeline

- **Phase 5 is consumed, not modified.** The refined backend plugs into the
  Phase-5 `SolveBackend` seam (`LIB.MotorSlice.create(section, { backend })`,
  `opts` flowing `MotorRun → MotorStack → MotorSlice`). `motor-slice.js`,
  `motor-stack.js`, `motor-run.js`, `config-schema.js`, and `mount.js` are
  **byte-unchanged** by this phase.
- **No new orchestration.** The static sweep is `LIB.MotorStack.create(expanded,
  { backend }).solve(θ, currents)` looped over θ; the time-domain run is
  `LIB.MotorRun.create(expanded, { backend }).step(dt)`. Phase 8 does not
  re-implement the slice aggregation or the per-tick chain.
- **Phase 1/2 are consumed, not modified.** The refined backend builds its
  operators with the frozen `LIB.AirgapGrid.create` (at a finer grid) and
  rasterizes with the frozen `LIB.MotorCompile.compile`; the multigrid coarsest
  level is solved by the frozen `LIB.AirgapSolve.pcg`.

### Conventions fixed for this phase

- **App vs lib split.** `lib/airgap-refine.js` and `lib/airgap-worker.js` attach
  to `window.LIB` (`LIB.AirgapRefine`, `LIB.AirgapWorker`) as DOM-free IIFEs and
  import only other `lib/` modules. The app-layer
  `lessons/unified_motor/detailed-toggle.js` attaches to `window.UnifiedMotor`
  (`UnifiedMotor.DetailedToggle`) using the lazy idiom
  `const UM = window.UnifiedMotor || (window.UnifiedMotor = {});`, and is the only
  Phase-8 module that may reference `UnifiedMotor.ConfigSchema`.
- **Grid-array conventions are inherited unchanged** from Phases 1–2: row-major
  `Float64Array`, `idx = i*Ntheta + j`, `μ₀ = 4π×1e-7`, air `ν = 1/μ₀`.
- **Refinement factor.** `factor` is a positive integer (default `3`); the
  refined grid is `Nr·factor × Ntheta·factor` over the **same** physical extents
  (`rInner`, `rOuter`, `ell` unchanged). The physical feature geometry
  (`rRange`/`thetaRange`) is resolution-independent, so `motor-compile`
  re-rasterizes it at the finer grid with no feature edits.
- **Worker shim line.** A Worker has no `window`; the `lib/` IIFEs resolve
  `window.LIB`. The worker bootstrap therefore sets `self.window = self;`
  **before** `self.importScripts(...)`, the worker analogue of the Node test
  shim's `globalThis.window = globalThis;`.
- **Worker availability.** Classic Workers are typically blocked over `file://`.
  Detailed mode requires serving over `http(s)://` (the repo's recommended
  `python -m http.server`). `detailed-toggle` feature-detects `Worker` and, if a
  worker cannot be constructed, shows the control disabled with an explanatory
  `title`; **Live is fully functional regardless**. This is feature-detection,
  not a fallback shim.
- **Worker message protocol** (resolves the plan's deferred "worker message
  schema" item). Plain structured-clone-safe data only (numbers, strings, plain
  arrays, `Float64Array`); no functions. The **main thread** expands and seeds:
  - main → worker:
    - `{ kind:"start", expanded, stateSeed, backendOpts, dt, stepsPerMessage }` —
      `expanded = ConfigSchema.expand(config)` (plain feature/section data),
      `stateSeed = { theta, omega, t, stepIndex, i:number[] }` (the current Live
      state), `backendOpts = { factor, fillet?, mg?, tier? }` (`tier ∈
      {"refined","nonlinear"}`, default `"refined"`; `"nonlinear"` selects the
      Phase-9 `LIB.AirgapNonlinear` backend).
    - `{ kind:"updateDrive", circuits, mechanical }` — slider changes.
    - `{ kind:"sweep", expanded, currents:number[], thetas:number[] }` — one-shot
      static torque-vs-angle table.
    - `{ kind:"stop" }`, `{ kind:"reset", stateSeed }`.
  - worker → main:
    - `{ kind:"frame", state:{theta,omega,t,stepIndex,i:number[]}, torque,
      field?:{ Br:number[], Bt:number[], grid } }` — streamed during a run
      (`field` only every `stepsPerMessage` frames to bound message size).
    - `{ kind:"sweepResult", thetas:number[], torques:number[] }`.
- **Test runner**: `node:test` + `node:assert/strict`; `npm test` → `node
  --test`. Phase 8 ships its own loader `tests/detailed/_fixtures.js` that
  `require`s `tests/pipeline/_fixtures.js` **read-only** (for `window`, the engine
  + pipeline libs, `UnifiedMotor.ConfigSchema`, `assertClose`, the sample
  configs, and `MACHINE_NAMES`), then `require`s `lib/airgap-refine.js`,
  `lib/airgap-worker.js`, and `lessons/unified_motor/detailed-toggle.js`
  **directly**. **`tests/_shim.js` and `tests/pipeline/_fixtures.js` are NOT
  modified by this phase.**

### Machine-agnosticism boundary (load-bearing for this phase)

- The refined backend, the worker core, and the toggle read **no** element
  letter, machine name, or machine-type field. They consume the agnostic
  compiled/expanded shapes (`section`, `expanded`, per-circuit `{terminal,
  commutation, R}`) exactly as the Live tier does. The headless tests grep each
  module's source for the `MACHINE_NAMES` token list and require zero matches.
- Absent physics is zero, not skipped (invariant #2): a current-free cogging
  sweep is the ordinary `stack.solve(θ, zeros)` — no special detent path. A
  magnet-free config yields zero magnetization through the same compile.
- `N=1` runs the identical refined `MotorStack` loop as `N>1` (invariant #5): the
  worker builds the stack via the Phase-5 aggregator, which has no single-slice
  bypass.

## Files Owned

- `lib/airgap-refine.js` — created
- `lib/airgap-worker.js` — created
- `lessons/unified_motor/detailed-toggle.js` — created
- `lessons/unified_motor/index.html` — modified (append **one** `<script>` tag
  inside the marked module-extension region only; no other line changes)
- `tests/detailed/_fixtures.js` — created
- `tests/detailed/airgap-refine.test.js` — created
- `tests/detailed/airgap-worker.test.js` — created
- `tests/detailed/detailed-toggle.test.js` — created
- `tests/detailed/cogging.test.js` — created
- `tests/detailed/wiring.test.js` — created

> **`lessons/unified_motor/index.html`** is created by Phase 5 with the
> comment-marked module-extension region (the sanctioned shared append-point).
> Phase 8 appends inside that region only and is the **sole Phase-8 task** that
> touches the file (Task 8.3.1). Phases 6 and 7 also append into the same region;
> `implement-hybrid` runs phases as ordered sequential batches, so the appends do
> not race.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 8.1: Refined solver tier

### Task 8.1.1: airgap-refine.js — refined SolveBackend (finer grid + corner regularization + multigrid)

- **Description**: The refined field-solve tier as a Phase-5 `SolveBackend`. A
  uniformly-finer polar grid re-rasterized through the frozen `motor-compile`,
  tooth-tip corner reluctivity regularization, and a geometric-multigrid linear
  solve with semi-coarsening in θ. Reads only compiled arrays + the Phase-1
  `GridOperator` contract — no winding/element/machine knowledge, no hard-wired
  config vocabulary.
- **Files to create**:
  - `lib/airgap-refine.js` — IIFE attaching `LIB.AirgapRefine`. `MU0 = 4π×1e-7`
    declared at module top. API:
    - `LIB.AirgapRefine.refineSection(section, { factor = 3 }) → section'` —
      pure. `factor` a positive integer. Returns a new `section` with
      `grid = { Nr: section.grid.Nr·factor, Ntheta: section.grid.Ntheta·factor,
      rInner, rOuter, ell }` (extents copied), `gapBand = { iInner:
      section.gapBand.iInner·factor, iOuter: section.gapBand.iOuter·factor }`, and
      `features` copied **unchanged** (deep-cloned; physical `rRange`/`thetaRange`
      are resolution-independent). Throws a descriptive `Error` if `factor` is not
      an integer `≥ 1`.
    - `LIB.AirgapRefine.filletCorners(nu, grid, { strength = 1 } = {}) →
      Float64Array` — pure. Returns a **new** `Float64Array(grid.Nr·grid.Ntheta)`
      regularizing reluctivity at iron convex corners. `airNu = 1/MU0`. A cell
      `idx = i*Ntheta + j` is **iron** when `nu[idx] < 0.999·airNu`. Examine its
      four face neighbours (radial `N = i+1`, `S = i−1` clamped at the rims;
      angular `E = j+1`, `W = j−1` periodic). A **convex corner** iron cell has
      **exactly one** radial neighbour and **exactly one** angular neighbour that
      are air (`nu ≥ 0.999·airNu`) — i.e. exactly two air face-neighbours, one
      from each axis. For each convex-corner cell, set `nu'[idx] =
      nu[idx]·(airNu/nu[idx])^(0.5·strength)` (the geometric mean of iron and air
      `ν` at `strength = 1`; identity at `strength = 0`). All other cells copy
      `nu` verbatim. Deterministic and order-independent (reads original `nu`,
      writes the copy). `strength` is clamped to `[0,1]`.
    - `LIB.AirgapRefine.buildHierarchy(op, grid, { minNtheta = 16, maxLevels = 6 })
      → hierarchy` — builds the semi-coarsened-in-θ multigrid stack from the fine
      **operator** `op` (its `matvec` seeds the Galerkin recursion below). Level 0
      is the fine operator. Each successive level halves `Ntheta` (keeping `Nr`
      fixed — thin-annulus θ-anisotropy → semi-coarsening). Transfer operators are
      pure θ-index operations, defined internally: prolongation `P` is linear
      interpolation in θ (coarse→fine) and restriction is its variational transpose
      `R = Pᵀ`. The coarse operator at each level is the **Galerkin (variational)
      operator** `A_l = R · A_{l−1} · P`, assembled at build time by applying the
      finer level's operator to the columns of `P` (≈`Ntheta_l` `matvec`s per
      level) and restricting. **Coarse levels are NOT rediscretized from an
      angularly-averaged `ν`** — under θ-only semi-coarsening a rediscretized
      coarse operator is inconsistent with the fine operator wherever `ν` is
      angularly discontinuous (slotted stators such as `coggingConfig`), which
      makes the coarse-grid correction diverge; the Galerkin operator is consistent
      by construction (this is the resolution of the 2026-05-25 T8.1.1
      clarification — see `spec/progress.md`). Each level stores its coarse
      operator in a form that supports `matvec`, the operator diagonal, and
      per-angular-column radial-tridiagonal extraction (consumed by the radial-line
      smoother in `vcycleSolve`). Stops when `Ntheta_l ≤ minNtheta` or `maxLevels`
      reached; requires `Ntheta` divisible by 2 down to the coarsest level (throws
      a descriptive `Error` otherwise). The coarsest level carries no children.
    - `LIB.AirgapRefine.vcycleSolve(op, b, { x0 = null, tol = 1e-6, maxCycles =
      30, hierarchy, nu1 = 2, nu2 = 2, omega = 2/3 }) → { x, iters, residual }` —
      geometric-multigrid V-cycle linear solve with the **same call shape** as
      `LIB.AirgapSolve.pcg`. The **fine level uses `op`** (so the current rotor
      angle, set via `op.setRotorAngle`, is honoured through `op.matvec`/
      `op.diagonal`); coarse-grid corrections use `hierarchy` (levels ≥ 1). The
      smoother is a **radial-line (block) smoother, NOT point Jacobi**: because the
      hierarchy coarsens only in θ, the radial direction is never coarsened and a
      point smoother cannot damp radial error modes — which is exactly what
      destroys grid-independence and makes the `< 15` criterion unreachable (the
      2026-05-25 T8.1.1 clarification; see `spec/progress.md`). One smoothing sweep
      computes the residual `r = b − A·x` (via `matvec`) and then, for each angular
      column `j` (fixed θ), solves that column's radial tridiagonal system
      `T_j · δ_j = r_j` by the Thomas algorithm — where `T_j` carries the operator
      diagonal on its main diagonal and the radial (north/south) face couplings on
      its sub/super-diagonals, with the angular (east/west) couplings carried
      explicitly in `r` — then updates `x ← x + omega·δ` (`omega` is the
      line-smoother under-relaxation factor). One V-cycle: `nu1` line-pre-smooths,
      restrict the residual via `R`, recurse, prolong via `P` + correct, `nu2`
      line-post-smooths; the coarsest level is solved by
      `LIB.AirgapSolve.pcg(coarsestOp, rc, { tol: 1e-8 })`. Iterate V-cycles until
      `‖b − op.matvec(x)‖₂ / ‖b‖₂ ≤ tol` or `maxCycles`. `iters` = V-cycle count.
      Holds the pinned gauge node fixed (per the Phase-1 operator contract).
      `hierarchy` is required.
    - `LIB.AirgapRefine.solveSaturated(op, b, { x0 = null, tol = 1e-6, maxCycles =
      30, hierarchy, ceiling }) → { x, iters, residual, satScale }` — the
      Live-style global flux-dependent ceiling wrapped around the V-cycle, with
      the **same contract** as `LIB.AirgapSolve.solveSaturated` (`ceiling =
      { enabled = true, Bknee = 1.6, p = 2, ironMask }`): one `vcycleSolve`;
      compute `Bpeak = max|B|` over `ironMask`; `s = max(1, (Bpeak/Bknee)^p)`; if
      `s > 1`, `op.setIronScale(s, ironMask)`, one warm-started corrective
      `vcycleSolve`, then `op.setIronScale(1, ironMask)`; return final `x`, total
      `iters`, `residual`, `satScale = s`.
    - `LIB.AirgapRefine.backend({ factor = 3, fillet = { strength: 1 }, mg = {} }
      = {}) → backend` — returns a Phase-5 `SolveBackend`:
      - `prepare(section)`: `refined = refineSection(section, { factor })`;
        `op = LIB.AirgapGrid.create(refined.grid)`;
        `compiled = LIB.MotorCompile.compile(refined)`;
        `nuFillet = filletCorners(compiled.nu, refined.grid, fillet)`;
        `op.setMaterials({ nu: nuFillet })`;
        `op.setRotorRegion({ rotorMask: compiled.rotorMask })`;
        `op.setGapBand(refined.gapBand)`;
        `op._refineHierarchy = buildHierarchy(op, refined.grid, mg)` (stashed
        — note `op` already has `setMaterials(nuFillet)` applied above, so the
        Galerkin recursion coarsens the filleted fine operator)
        on the op so the backend's solves reach it); returns `{ op, compiled }`.
      - `solveSaturated(op, b, o)`: `LIB.AirgapRefine.solveSaturated(op, b, {
        ...o, hierarchy: op._refineHierarchy })`.
      - `linearSolve(op, b, o)`: `LIB.AirgapRefine.vcycleSolve(op, b, {
        ...o, hierarchy: op._refineHierarchy })`.
- **Files to modify**: `lib/airgap-grid.js` — ONLY if the radial-line smoother
  needs a minimal, additive, read-only accessor for the per-cell radial
  (north/south) face conductances, so `T_j` can be assembled without re-deriving
  the FV stencil. Such an accessor must not change any existing behaviour or
  output (it is purely additive; the operator's `matvec`/`diagonal`/`field`/etc.
  results must be byte-identical). If the existing operator surface already
  exposes enough to assemble the radial tridiagonal, keep this as none.
- **Tests** (authored in Task 8.3.1): `tests/detailed/airgap-refine.test.js`.
- **Acceptance criteria**:
  - `refineSection(section, { factor:3 })` returns a section whose `grid.Nr`,
    `grid.Ntheta` are `3×` the input, whose `rInner`/`rOuter`/`ell` are unchanged,
    whose `gapBand.iInner`/`iOuter` are `3×` the input, and whose `features` are a
    deep clone equal in value to the input features.
  - `filletCorners` leaves interior iron cells and flat iron edges unchanged and
    sets a hand-constructed convex-corner iron cell to the geometric mean
    `sqrt(ironNu·airNu)` (within `1e-9` relative) at `strength:1`; `strength:0`
    returns a copy equal to the input.
  - `vcycleSolve(op, b, { hierarchy })` reaches relative residual `≤ 1e-6` on a
    refined salient/slotted operator and its solution matches
    `LIB.AirgapSolve.pcg(op, b, { tol:1e-8 }).x` entrywise within `1e-5` relative.
  - **Grid-independent iteration count**: `vcycleSolve` V-cycle counts to reach
    `tol = 1e-6` at `Ntheta` and `2·Ntheta` (same physical problem) differ by
    `≤ 2`, and both are `< 15` (the multigrid property — unlike PCG, whose count
    grows with `N`).
  - `solveSaturated` returns `satScale === 1` and a single V-cycle group below the
    knee; with a source past the knee, `satScale > 1` and the ceilinged `Bpeak`
    is strictly below the un-ceilinged `Bpeak`.
  - `LIB.AirgapRefine.backend().prepare(section)` returns `{ op, compiled }` whose
    `compiled.grid.Ntheta === section.grid.Ntheta·3` and exposes a `linearSolve`
    and `solveSaturated` honouring the `SolveBackend` contract (driven through a
    `MotorSlice` in `airgap-worker.test.js`).
  - Module loads under `require` with no DOM access; its source contains no
    `MACHINE_NAMES` token (asserted in `airgap-refine.test.js`).
  - All tests pass.

---

## Wave 8.2: Worker harness + Detailed toggle

### Task 8.2.1: airgap-worker.js — worker core + guarded message pump

- **Description**: The Web Worker harness. A DOM-free pure core that runs the
  refined static sweep / field map and hosts the refined time-domain session over
  the standard `LIB.MotorStack` / `LIB.MotorRun`, plus a worker-context-guarded
  bootstrap that loads the `lib/` dependencies and wires the message pump. Imports
  only `lib/` modules; never the app-layer `config-schema.js`.
- **Files to create**:
  - `lib/airgap-worker.js` — IIFE attaching `LIB.AirgapWorker`. At the top:
    `const inWorker = (typeof self !== "undefined" && typeof self.importScripts
    === "function");` and, when `inWorker`, `self.window = self;` then
    `self.importScripts("util.js", "integrate.js", "airgap-grid.js",
    "airgap-solve.js", "airgap-torque.js", "motor-compile.js", "excitation.js",
    "motor-circuit.js", "motor-slice.js", "motor-stack.js", "motor-run.js",
    "airgap-refine.js");` (`winding-model.js` is intentionally omitted: the worker receives the already-`expand()`ed config (the main thread resolved all winding routing via `LIB.WindingModel` before posting), and `motor-compile` rasterizes the pre-resolved feature list — it never calls `LIB.WindingModel` at load or runtime.) (URLs relative to the worker script's own `lib/`
    location), followed by a **guarded** Phase-9 tier load
    `try { self.importScripts("airgap-nonlinear.js"); } catch (e) { /* nonlinear
    tier unavailable until Phase 9 is built */ }` (so Phase 8 verifies in the
    browser before `airgap-nonlinear.js` exists, and the tier becomes available
    once Phase 9 ships it). Resolve `const LIB = (window.LIB || (self.LIB));`. API
    (defined unconditionally — testable headless):
    - `LIB.AirgapWorker.selectBackend(backendOpts = {}) → backend` — the **tier
      selector**: `if (backendOpts.tier === "nonlinear") { if (!LIB.AirgapNonlinear)
      throw new Error("nonlinear backend not loaded"); return
      LIB.AirgapNonlinear.backend(backendOpts); } return
      LIB.AirgapRefine.backend(backendOpts);`. Default (`undefined` /
      `"refined"`) → the refined backend. The nonlinear branch is the Phase-5
      `SolveBackend` seam exactly as the refined branch is — the worker adds no
      tier-specific logic beyond this factory choice.
    - `LIB.AirgapWorker.compute(request) → response` — pure dispatch on
      `request.kind`:
      - `"sweep"`: `stack = LIB.MotorStack.create(request.expanded, { backend:
        LIB.AirgapWorker.selectBackend(request.backendOpts ?? {}) })`;
        `cur = Float64Array.from(request.currents)`; for each `θ` in
        `request.thetas`, push `stack.solve(θ, cur).torque`; return
        `{ kind:"sweepResult", thetas: Array.from(request.thetas),
        torques: <number[]> }`.
      - `"fieldMap"`: build the same `stack`; `r = stack.solve(request.theta,
        Float64Array.from(request.currents))`;
        `f = r.perSliceField[request.sliceIndex ?? 0]`;
        `g = stack.sliceGrid(request.sliceIndex ?? 0)` (added to MotorStack in Phase 5 §Task 5.2.1); return
        `{ kind:"fieldMap", theta: request.theta, Br: Array.from(f.Br),
        Bt: Array.from(f.Bt), grid: { Nr:g.Nr, Ntheta:g.Ntheta, r:Array.from(g.r),
        rInner:g.rInner, rOuter:g.rOuter } }`.
    - `LIB.AirgapWorker.createSession(request) → session` — the refined
      time-domain core: `runtime = LIB.MotorRun.create(request.expanded,
      { backend: LIB.AirgapWorker.selectBackend(request.backendOpts ?? {}),
      binCount: request.binCount })`; if `request.stateSeed`, seed
      `runtime.state.theta/omega/t/stepIndex` and `runtime.state.i =
      Float64Array.from(stateSeed.i)`. Returns:
      - `session.runtime` — the `LIB.MotorRun` instance.
      - `session.step(dt) → frame` — `runtime.step(dt)`; returns
        `{ kind:"frame", state: session.snapshot(), torque:
        runtime.lastSolve.torque }` (the message pump attaches `field` on the
        cadence below; `step` itself returns the lightweight frame).
      - `session.snapshot() → { theta, omega, t, stepIndex, i:number[] }` — a
        plain copy of `runtime.state`.
      - `session.updateDrive({ circuits, mechanical })` — copy the supplied
        `terminal`/`commutation`/`R` into `runtime.circuits[*]` and the supplied
        scalars into `runtime.mechanical`, in place (no rebuild).
      - `session.fieldFrame(sliceIndex = 0) → { Br:number[], Bt:number[], grid }`
        — from `runtime.lastSolve.perSliceField[sliceIndex]` + `runtime.stack.sliceGrid(sliceIndex)` (added to MotorStack in Phase 5 §Task 5.2.1).
        (`stack.solve(...)` returns `perSliceField`, and `runtime.lastSolve` is set after each `runtime.step` — both specified in Phase 5 §Task 5.2.1 and §Task 5.3.1.)
      - `session.reset(stateSeed = null)` — `runtime.reset()`, then re-seed if
        `stateSeed`.
    - **Worker bootstrap** (only when `inWorker`): a module-scoped session +
      `running` flag. `self.onmessage = (e) => { … }` dispatches:
      `"start"` → `session = createSession(msg)`, `running = true`, reset module-scoped `let postCount = 0`, kick a
      self-scheduling `tick()` that calls `session.step(dt)` `stepsPerMessage`
      times, posts a `"frame"` (incrementing `postCount` on each post; `field` is attached via `session.fieldFrame()` when `postCount % stepsPerMessage === 0`, so the first post always includes a field), then `setTimeout(tick, 0)` while `running`;
      `"updateDrive"` → `session.updateDrive(msg)`; `"sweep"` →
      `self.postMessage(compute(msg))`; `"stop"` → `running = false`; `"reset"` →
      `session.reset(msg.stateSeed)`, reset `postCount = 0`. The bootstrap is **not** exercised headless
      (no `compute`/`createSession` logic lives in it — it only wires them); it is
      browser-verified in Task 8.3.1.
- **Files to modify**: none.
- **Tests** (authored in Task 8.3.1): `tests/detailed/airgap-worker.test.js`.
- **Acceptance criteria**:
  - `compute({ kind:"sweep", expanded, currents, thetas })` returns
    `{ kind:"sweepResult", thetas, torques }` with `torques.length ===
    thetas.length`, every entry finite, and each entry equal (within `1e-9`
    relative) to `LIB.MotorStack.create(expanded, { backend:
    LIB.AirgapRefine.backend() }).solve(θ, currents).torque` (the worker adds no
    physics of its own).
  - `compute({ kind:"fieldMap", expanded, theta, currents })` returns finite
    `Br`/`Bt` arrays of length `grid.Nr·grid.Ntheta` and a `grid` whose `Ntheta`
    equals the refined (`factor×`) value.
  - The `response` of both `compute` kinds contains only plain numbers/arrays (no
    functions, no class instances) — structured-clone-safe (asserted by a
    `JSON`-serialisability check on a numeric projection).
  - `createSession({ expanded, backendOpts })` over a driven config (e.g.
    `woundConfig()`): seed at rest, `session.step(1/240)` for `300` steps; assert
    `Number.isFinite(session.runtime.state.theta)` and
    `Math.abs(session.runtime.state.theta) > 1e-3` (the refined time-domain run
    turns the rotor — the same agnostic-pipeline assertion as Phase 5, on the
    refined backend).
  - `createSession({ ..., stateSeed:{ theta:0.5, omega:2, t:0.1, stepIndex:1,
    i:[…] } })` seeds `session.runtime.state` to those values.
  - The module `require`s under Node (the headless loader’s `require` succeeds:
    `inWorker` is false, so no `importScripts` is attempted) with no DOM access.
  - `selectBackend(undefined)` and `selectBackend({ tier:"refined" })` both return
    a refined backend (so the default `compute`/`createSession` behaviour is
    byte-equivalent to the pre-amendment refined path); `selectBackend({
    tier:"nonlinear" })` throws when `LIB.AirgapNonlinear` is absent and returns
    `LIB.AirgapNonlinear.backend(opts)` when present (the nonlinear routing is
    exercised in Phase 9's `tests/saturation/airgap-nonlinear.test.js`).
  - The guarded `importScripts("airgap-nonlinear.js")` does not break worker
    construction when the file is absent (Phase-8-time browser verification uses
    the refined tier only).
  - The module source references **no** `config-schema` path and contains no
    `MACHINE_NAMES` token (asserted in `airgap-worker.test.js`).
  - All tests pass.

### Task 8.2.2: detailed-toggle.js — Live/Detailed header control + result panel

- **Description**: The app-layer control. A header toggle that spawns/terminates
  the worker (the explicit Live↔Detailed boundary) and a companion panel that
  renders the worker's streamed frames and an on-demand cogging sweep, both
  registered through the Phase-5 seams. The pure helpers (message builders, the
  θ-sweep generator, frame application, worker feature-detect) are headless; the
  canvas/worker-lifecycle layer is browser-verified.
- **Files to create**:
  - `lessons/unified_motor/detailed-toggle.js` — IIFE attaching
    `window.UnifiedMotor.DetailedToggle`. DOM-free at load (only defines
    functions; touches no `document`/`canvas`/`Worker` at module-load). API:
    - `DetailedToggle.workerAvailable() → boolean` — `typeof Worker ===
      "function"` (cheap feature-detect; `false` under the Node shim). The actual
      `new Worker(...)` construction in `build` is additionally wrapped in
      `try/catch` for the `file://` block case.
    - `DetailedToggle.thetaSweep(n, period = 2*Math.PI) → Float64Array` — pure;
      `θ_k = (k + 0.5)·period/n` for `k = 0..n−1`.
    - `DetailedToggle.buildStartMessage(config, runtimeState, opts = {}) →
      message` — pure; `{ kind:"start", expanded:
      UnifiedMotor.ConfigSchema.expand(config), stateSeed: { theta:
      runtimeState.theta, omega: runtimeState.omega, t: runtimeState.t,
      stepIndex: runtimeState.stepIndex, i: Array.from(runtimeState.i) },
      backendOpts: opts.backendOpts ?? { factor: 3 }, dt: opts.dt ?? 1/240,
      stepsPerMessage: opts.stepsPerMessage ?? 4 }`.
    - `DetailedToggle.buildSweepMessage(config, currents, n = 180) → message` —
      pure; `{ kind:"sweep", expanded:
      UnifiedMotor.ConfigSchema.expand(config), currents: Array.from(currents),
      thetas: Array.from(thetaSweep(n)) }`.
    - `DetailedToggle.applyFrame(target, frame) → void` — pure; copies
      `frame.state` (theta/omega/t/stepIndex/i) and `frame.torque` (and
      `frame.field` if present) into the plain `target` object the panel reads at
      draw time. Mutates `target` in place.
    - `DetailedToggle.register(UM) → void` — guarded: when `UM.registerHeaderControl`
      exists, registers `{ id:"detailed-toggle", build(host, ctx) → unmountFn }`
      (the Live/Detailed toggle); when `UM.registerPanel` exists, registers
      `{ id:"detailed-view", title:"Detailed (worker)", zone:"side",
      build(host, ctx) → unmountFn }` (the result panel). Invoked at module load
      only when the seams exist (under the headless shim the seams are absent, so
      load only defines the namespace functions).
    - `build(host, ctx)` of the header control (browser): (`ctx = { runtime, config, view, requestRebuild() }`, with `ctx.runtime` the live `LIB.MotorRun` instance (state read live each call) — Phase 5 §Task 5.4.1.) A button toggling
      Live/Detailed. On enable: if `!workerAvailable()`, disable the button and
      set an explanatory `title` ("Detailed mode needs http(s):// — serve the
      app"); else `try { worker = new Worker("../../lib/airgap-worker.js") }
      catch { disable with title }`. On a constructed worker, `worker.postMessage(
      buildStartMessage(ctx.config, ctx.runtime.state, { backendOpts: { factor: 3,
      tier: UM._detailedTier ?? "refined" } }))` (the tier comes from the panel's
      Saturation checkbox), and
      `worker.onmessage = (e) => applyFrame(UM._detailedView, e.data)` (the shared
      render-state the panel draws). On disable / `unmountFn`: `worker.postMessage(
      { kind:"stop" }); worker.terminate()`. The **Live main viewport keeps
      running** — Detailed renders in its own panel, a deliberate side-by-side
      compare. Geometry edits while Detailed is active re-post a `"start"` seeded
      from the current state (the worker boundary; not per-frame).
    - `build(host, ctx)` of the result panel (browser): owns its own canvas(es)
      drawing, from the shared `UM._detailedView`, the refined gap-field heatmap
      via `LIB.FieldRender.drawGapField` (fed `field.Br/Bt` + `field.grid`) and a
      torque/ω/θ readout column; a "Cogging sweep" button posts
      `buildSweepMessage(ctx.config, new Float64Array(ctx.runtime.state.i.length),
      180)` and plots the returned `torques` vs `thetas` via `LIB.Plot`. It also
      hosts a **"Saturation (nonlinear)"** checkbox that writes
      `UM._detailedTier = checked ? "nonlinear" : "refined"`; toggling it re-posts
      a `"start"` (via the header control's start path) so the running worker
      session switches tiers from the current state (the worker boundary — not a
      per-frame switch). The nonlinear tier is browser-verified in **Phase 9**
      (its `airgap-nonlinear.js` is absent at Phase-8 time; leave the box unticked
      during Phase-8 verification). `unmountFn` removes listeners and clears
      `host`.
- **Files to modify**: none.
- **Tests** (authored in Task 8.3.1): `tests/detailed/detailed-toggle.test.js`.
- **Acceptance criteria**:
  - `thetaSweep(180)` returns a `Float64Array` of length `180` with `θ_0 ===
    0.5·2π/180` and strictly increasing entries in `[0, 2π)`.
  - `buildStartMessage(woundConfig(), stubState, {})` returns `kind:"start"`, an
    `expanded` equal to `UnifiedMotor.ConfigSchema.expand(woundConfig())` in
    `nCircuits`/`slices.length`, a `stateSeed.i` that is a plain `number[]`, and
    `backendOpts.factor === 3`, `dt === 1/240`, `stepsPerMessage === 4`.
  - `buildSweepMessage(woundConfig(), zeros, 60)` returns `kind:"sweep"`,
    `currents` a plain `number[]` of length `expanded.nCircuits`, `thetas.length
    === 60`.
  - `applyFrame(target, { state:{theta:1,omega:2,t:3,stepIndex:4,i:[1,2]},
    torque:0.5 })` writes those values into `target` (in place).
  - `workerAvailable()` returns `false` under the Node shim (no `Worker` global);
    `register(UM)` with no seams present is a no-op that still defines
    `UnifiedMotor.DetailedToggle`.
  - `buildStartMessage(config, state, { backendOpts: { factor:3, tier:"nonlinear" }
    })` forwards `message.backendOpts.tier === "nonlinear"` (the pure helper passes
    `opts.backendOpts` through unchanged — the Saturation checkbox supplies it at
    runtime; asserted in `detailed-toggle.test.js`).
  - The module loads under `require` with no DOM access; its source contains no
    `MACHINE_NAMES` token (asserted in `detailed-toggle.test.js`).
  - All tests pass.

---

## Wave 8.3: Tests + page wiring (browser-verified)

### Task 8.3.1: detailed-mode test suite + index.html wiring

- **Description**: The Phase-8 validation suite — the refined backend, the worker
  core, the toggle helpers, and the cogging/detent accuracy gate — plus the
  `index.html` wiring that loads `detailed-toggle.js`. Because Detailed mode's
  off-thread behaviour and the live worker round-trip can only be observed in a
  browser, this task carries a browser-verification step that no headless agent
  can perform — it is flagged **user-required** in the manifest.
- **Files to create**:
  - `tests/detailed/_fixtures.js` — not a test file (no `.test.js`). On require:
    `const P = require("../pipeline/_fixtures.js");` (installs `window` + all
    engine/pipeline libs incl. `UnifiedMotor.ConfigSchema`, and provides
    `P.LIB`, `P.UnifiedMotor`, `P.assertClose`, `P.woundConfig`, `P.pmConfig`,
    `P.salientConfig`, `P.MACHINE_NAMES`), then **direct** `require` of
    `../../lib/airgap-refine.js`, `../../lib/airgap-worker.js`, and
    `../../lessons/unified_motor/detailed-toggle.js`. Exports:
    - `LIB` (`= P.LIB`), `UnifiedMotor` (`= P.UnifiedMotor`),
      `assertClose` (`= P.assertClose`), `MACHINE_NAMES` (`= P.MACHINE_NAMES`),
      `woundConfig`, `pmConfig`, `salientConfig` (re-exported).
    - `coggingConfig()` — a slotted-PM config that cogs at zero current, on a
      **small** grid so the multi-grid convergence test stays fast:
      `grid:{ Nr:8, Ntheta:64, rInner:0.030, rOuter:0.055, ell:0.10 }`,
      `gapBand:{ iInner:4, iOuter:5 }` (The 1-cell gap band is intentional and correct for this geometry: with `Nr:8` over `rInner:0.030..rOuter:0.055` (`dr≈0.003125`), only cell 4 (centre ≈0.0441 m) lies in the physical gap 0.043–0.047 m — widening the band would pull a rotor- or stator-surface cell into the Arkkio average and corrupt the torque. The cogging test checks Richardson convergence ratios, not absolute accuracy, so a 1-cell band is sufficient.), `poles:4`, `mechanical:{ J:1e-4,
      damping:1e-5, loadTorque:0 }`; rings: rotor `M` `{ magnets:4, Mr:8e5,
      backIron:true, backIronRRange:[0.030,0.038], muR:1000, rRange:[0.038,0.043] }`,
      stator `C` `{ winding:{ standard:{ m:3, p:4, Q:12, coilPitch:1, turns:40 } },
      rRange:[0.047,0.051], slotRRange:[0.047,0.051], slotFraction:0.5,
      ironRRange:[0.051,0.055], muR:1000, spanFraction:0.5 }`; `circuits` (3
      stator, idle for cogging) `{ terminal:{type:"DC",amp:0},
      commutation:{mode:"none"}, R:0.5 }`; `stack:{ slices:1, sliceOffsets:[0],
      fluxSources:[] }`.
    - `refinedStack(config, factor) → stack` — `LIB.MotorStack.create(
      UnifiedMotor.ConfigSchema.expand(config), { backend:
      LIB.AirgapRefine.backend({ factor }) })`.
    - `coarseStack(config) → stack` — `LIB.MotorStack.create(
      UnifiedMotor.ConfigSchema.expand(config))` (default coarse backend — the
      Live tier).
    - `sweepTorque(stack, currents, thetas) → number[]` — `stack.solve(θ,
      currents).torque` for each θ.
    - `ripple(values) → number` (`max − min`), `mean(values) → number`,
      `signChanges(values) → int` (adjacent sign flips), `amp(values) → number`
      (`ripple/2`) — computed inline; no external dependency.
    - `spyBackend(inner) → backend` — wraps a `SolveBackend`, counting
      `prepare`/`solveSaturated`/`linearSolve` calls and delegating.
  - `tests/detailed/airgap-refine.test.js` — `require("./_fixtures.js")`:
    - › `"refineSection scales grid and gapBand, clones features"` — on a
      hand section (`Nr:6,Ntheta:24`), `refineSection(s,{factor:3})` has
      `grid.Nr === 18`, `grid.Ntheta === 72`, unchanged `rInner/rOuter/ell`,
      `gapBand` `3×`, and `features` deep-equal but not the same references.
    - › `"refineSection rejects non-integer factor"` — `factor:2.5` and
      `factor:0` each throw.
    - › `"filletCorners graduates convex iron corners only"` — build a `4×4`
      `nu` with an L-shaped iron block; assert the single convex-corner cell
      becomes `sqrt(ironNu·airNu)` (±`1e-9` rel.), interior iron and flat-edge
      iron cells are unchanged, and `strength:0` returns the input verbatim.
    - › `"vcycleSolve matches PCG on the same operator"` — build a refined
      `coggingConfig` slice operator at `factor:2`; `b = op.assembleRHS({ Jz })`;
      `xMg = vcycleSolve(op, b, { hierarchy }).x`;
      `xPcg = LIB.AirgapSolve.pcg(op, b, { tol:1e-8 }).x`; assert relative-L2
      error `< 1e-5` and `vcycleSolve(...).residual ≤ 1e-6`.
    - › `"multigrid iteration count is grid-independent"` — V-cycle counts to
      reach `tol:1e-6` at `Ntheta` and `2·Ntheta` (refined `coggingConfig`
      operator, same physical RHS) differ by `≤ 2` and both `< 15`.
    - › `"solveSaturated ceiling matches the airgap-solve contract"` — below the
      knee `satScale === 1`; with a source past the knee `satScale > 1` and the
      ceilinged `Bpeak` `<` the un-ceilinged `Bpeak`.
    - › `"backend honours the SolveBackend contract through MotorSlice"` —
      `slice = LIB.MotorSlice.create(<a coggingConfig slice section>, { backend:
      LIB.AirgapRefine.backend({ factor:2 }) })`; `r = slice.solve(0.1,
      Float64Array([0,0,0]))`; assert `Number.isFinite(r.torque)`,
      `r.field.Br.length === 16*128` (the refined length), and
      `slice.extractCoeffs(0.1)` returns finite `L`/`lambdaPm`.
    - › `"no machine-name string in source"` — read `lib/airgap-refine.js`;
      assert no `MACHINE_NAMES` token (case-insensitive).
  - `tests/detailed/airgap-worker.test.js` — `require("./_fixtures.js")`:
    - › `"sweep round-trips a torque-vs-angle table"` — `cfg = woundConfig()`;
      `expanded = UnifiedMotor.ConfigSchema.expand(cfg)`;
      `currents = new Float64Array(expanded.nCircuits)` with `currents[0] = 5`;
      `thetas` = 24 uniform samples over `[0, π)`;
      `res = LIB.AirgapWorker.compute({ kind:"sweep", expanded,
      currents: Array.from(currents), thetas: Array.from(thetas) })`; assert
      `res.kind === "sweepResult"`, `res.torques.length === res.thetas.length`,
      every entry finite, and each equals `refinedStack(cfg, 3).solve(θ,
      currents).torque` within `1e-9` relative (the worker adds no physics).
    - › `"fieldMap returns refined-length field arrays"` — `expanded =
      UnifiedMotor.ConfigSchema.expand(woundConfig())`;
      `currents = new Array(expanded.nCircuits).fill(0)` with `currents[0] = 5`;
      `res = LIB.AirgapWorker.compute({ kind:"fieldMap", expanded, theta:0.2,
      currents })`; assert `res.Br.length === res.grid.Nr*res.grid.Ntheta` and
      `res.grid.Ntheta === woundConfig().grid.Ntheta*3`.
    - › `"response is structured-clone-safe"` — for the sweep `res`, assert every
      value is a number or array-of-numbers/strings (no function, no `undefined`
      leaf); `JSON.stringify(res)` does not throw and round-trips the `torques`.
    - › `"createSession runs the refined time-domain sim and turns the rotor"` —
      `s = createSession({ expanded: expand(woundConfig()), backendOpts:{factor:2}});`
      run `s.step(1/240)` `300×`; assert `Number.isFinite(s.runtime.state.theta)`
      and `Math.abs(s.runtime.state.theta) > 1e-3`.
    - › `"createSession seeds from stateSeed"` — `expanded =
      UnifiedMotor.ConfigSchema.expand(woundConfig())`;
      `seed = { theta:0.5, omega:2, t:0.1, stepIndex:1,
      i: new Array(expanded.nCircuits).fill(0) }`;
      `s = createSession({ expanded, stateSeed: seed })`; assert
      `s.runtime.state.theta === 0.5`, `omega === 2`, `t === 0.1`,
      `stepIndex === 1`.
    - › `"selectBackend defaults to refined and guards the nonlinear tier"` —
      `LIB.AirgapWorker.selectBackend()` and
      `LIB.AirgapWorker.selectBackend({ tier:"refined" })` each return an object
      exposing `prepare`/`solveSaturated`/`linearSolve`; with `LIB.AirgapNonlinear`
      absent (it is not loaded in the Phase-8 suite),
      `assert.throws(() => LIB.AirgapWorker.selectBackend({ tier:"nonlinear" }))`.
    - › `"worker imports no app-layer config-schema and no machine name"` — read
      `lib/airgap-worker.js`; assert the source contains neither the substring
      `config-schema` nor any `MACHINE_NAMES` token.
  - `tests/detailed/detailed-toggle.test.js` — `require("./_fixtures.js")`:
    - › `"thetaSweep spans [0,2π) with cell-centre offset"` —
      `DetailedToggle.thetaSweep(180)`: length `180`, `t[0] === 0.5·2π/180`,
      strictly increasing, `t[179] < 2π`.
    - › `"buildStartMessage expands config and serialises state"` —
      `n = UnifiedMotor.ConfigSchema.expand(woundConfig()).nCircuits`;
      `msg = buildStartMessage(woundConfig(), { theta:0.2, omega:1, t:0.05,
      stepIndex:2, i: new Float64Array(n) }, {})`: assert `msg.kind === "start"`,
      `msg.expanded.nCircuits === n`, `Array.isArray(msg.stateSeed.i)`,
      `msg.backendOpts.factor === 3`, `msg.dt === 1/240`,
      `msg.stepsPerMessage === 4`.
    - › `"buildSweepMessage builds a zero-current table request"` —
      `n = UnifiedMotor.ConfigSchema.expand(woundConfig()).nCircuits`;
      `msg = buildSweepMessage(woundConfig(), new Float64Array(n), 60)`: assert
      `msg.kind === "sweep"`, `Array.isArray(msg.currents)` of length `n`,
      `msg.thetas.length === 60`.
    - › `"applyFrame copies state into the render target"` — a fresh `target`,
      `applyFrame(target, { state:{theta:1,omega:2,t:3,stepIndex:4,i:[1,2]},
      torque:0.5 })`; assert `target.theta===1`, `target.torque===0.5`,
      `target.i` is `[1,2]`.
    - › `"workerAvailable is false under the shim; register is a guarded no-op"` —
      `workerAvailable() === false`; calling `register(window.UnifiedMotor)` with
      no seams present does not throw and `UnifiedMotor.DetailedToggle` is defined.
    - › `"buildStartMessage forwards a supplied backendOpts.tier"` —
      `msg = buildStartMessage(woundConfig(), { theta:0, omega:0, t:0, stepIndex:0,
      i: new Float64Array(UnifiedMotor.ConfigSchema.expand(woundConfig()).nCircuits)
      }, { backendOpts: { factor:3, tier:"nonlinear" } })`; assert
      `msg.backendOpts.tier === "nonlinear"` and `msg.backendOpts.factor === 3`.
    - › `"no machine-name string in source"` — read
      `lessons/unified_motor/detailed-toggle.js`; assert no `MACHINE_NAMES` token.
  - `tests/detailed/cogging.test.js` — `require("./_fixtures.js")`. The
    cogging/detent accuracy gate (the plan's "~1–5%" target, operationalised as
    grid self-convergence of the refined tier):
    - › `"refined cogging amplitude is grid-converged within 5%"` — `cfg =
      coggingConfig()`; `zeros = new Float64Array(3)`; `thetas` = 72 uniform
      samples over `[0, 2π)`;
      `a2 = amp(sweepTorque(refinedStack(cfg,2), zeros, thetas))`,
      `a4 = amp(sweepTorque(refinedStack(cfg,4), zeros, thetas))`; assert
      `Math.abs(a2 − a4) ≤ 0.05·Math.max(a4, 1e-9)` (the refined tier has
      converged to the ~5% target) and `a4 > 1e-7` (cogging is present).
    - › `"the Live coarse tier is not grid-converged for cogging"` —
      `aCoarse = amp(sweepTorque(coarseStack(cfg), zeros, thetas))`; assert
      `Math.abs(aCoarse − a4) > 0.05·a4` (Live smears cogging — provably outside
      the Detailed target band, which is why Detailed exists). [If
      `aCoarse` happens within 5% the refinement is not changing the answer — a
      real failure to surface, not a tolerance to relax.]
    - › `"zero-current detent is oscillatory with zero net average"` — the
      refined (`factor:4`) waveform `w`: assert `ripple(w) > 1e-7`,
      `signChanges(w) ≥ 4` (it oscillates over a revolution), and
      `Math.abs(mean(w)) ≤ 0.05·amp(w)` (net detent over a full revolution is
      ~zero).
  - `tests/detailed/wiring.test.js` — `require("./_fixtures.js")` + `node:fs`:
    - › `"index.html loads detailed-toggle.js inside the marked region"` — read
      `lessons/unified_motor/index.html`; locate the substring between
      `<!-- unified-motor modules:` and `<!-- /unified-motor modules -->`; assert
      that region contains a `<script src>` for `./detailed-toggle.js` and that
      both marker comments are present exactly once.
- **Files to modify**:
  - `lessons/unified_motor/index.html` — inside the existing module-extension
    region (between the `<!-- unified-motor modules: later phases append … -->`
    and `<!-- /unified-motor modules -->` markers, created by Phase 5), append:
    ```html
    <script src="./detailed-toggle.js"></script>
    ```
    No other line of `index.html` changes. (`airgap-refine.js` and
    `airgap-worker.js` are **not** page scripts — they load inside the worker via
    `importScripts`, so only `detailed-toggle.js` is added to the page.)
- **Acceptance criteria**:
  - `npm test` runs all `tests/detailed/*.test.js` (alongside the existing
    suites) and exits 0.
  - `tests/detailed/_fixtures.js` is not collected as a test (no `.test.js`
    suffix) and is `require`-able by every detailed test file.
  - `tests/_shim.js` and `tests/pipeline/_fixtures.js` are byte-unchanged.
  - The refined cogging amplitude is grid-converged to `≤ 5%` (factor 2 vs 4) and
    the Live coarse estimate is provably outside that band.
  - The single `<script src="./detailed-toggle.js">` tag appears inside the
    `index.html` marked region; no other line of `index.html` changed.
  - **(User-required)** Served from the repo root over `http://`,
    `http://localhost:<port>/lessons/unified_motor/index.html` loads with no
    console errors; the user completes the browser checklist and records the
    result in `spec/progress.md`:
    1. The Live/Detailed header control and the Detailed panel appear via the
       registration seams.
    2. Toggling **Detailed** spawns the worker; the **UI stays responsive** (the
       Live main viewport keeps animating smoothly) while the Detailed panel
       updates from the worker's streamed frames at a slower cadence — the rotor
       turns in the Detailed view.
    3. The "Cogging sweep" button plots a refined zero-current `torque(θ)` curve
       in the Detailed panel.
    4. Toggling back to **Live** terminates the worker (the Detailed panel stops
       updating); re-enabling re-seeds from the current state.
    5. Over `file://` (no server) the Detailed control is shown disabled with the
       explanatory tooltip and Live is unaffected.
- **User action required**: the browser checklist above; acked via
  `bash "${CLAUDE_PLUGIN_ROOT}/scripts/ack-user-gate.sh" T8.3.1 "<evidence>"`.
