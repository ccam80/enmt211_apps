# Phase 5: Agnostic pipeline + universal stack container + mount

## Overview

The integration milestone. Phases 1–4 shipped the headless numerical pieces
(field solve, torque, winding/compile, excitation/commutation, circuit ODE) as
independent `window.LIB` modules. Phase 5 wires them into one **agnostic
pipeline** and proves the project's reason for existing: *multiple
structurally-different machines run through the identical code path, with
machine identity nowhere in the runtime.*

It ships, in dependency order:

1. **`lessons/unified_motor/config-schema.js`** — the agnostic machine
   descriptor and its `expand()` step. This is the **only** layer that knows the
   human-facing config vocabulary (rings / element letters `{W,C,M,I,K}` /
   excitation / commutation / slice stack). It dispatches on element *type*
   (legitimate — invariant #1) and emits the Phase-2 `section` feature shape +
   the Phase-3 per-circuit drive specs. **`lib/` never sees the config
   vocabulary** — it consumes only compiled sections and circuit specs. This is
   the architectural boundary that keeps every `lib/` module machine- *and*
   config-agnostic.
2. **`lib/motor-slice.js`** — wraps one compiled `section` into a single-section
   solver: `solve(θ, currents) → { torque, fluxLinkages, field }`, plus the
   `L(θ)` coefficient extraction the circuit step needs. Its field-solve tier is
   a pluggable **`SolveBackend`** (the coarse PCG path is the default; a refined
   or nonlinear tier swaps in through `opts.backend`), so the slice/stack/run
   orchestration carries no solver-tier knowledge.
3. **`lib/motor-stack.js`** — the universal **spatial** aggregator. Always loops
   over `N≥1` slices (no single-slice bypass — invariant #5), applies each
   slice's rotor-angle offset, sums each shared circuit's `λ` across the slices
   it threads, sums torque, and aggregates the `L(θ)` coefficients.
4. **`lib/motor-run.js`** — the headless **temporal** driver. Owns the per-tick
   chain (excitation → circuit current step → torque → mechanical integrate) and
   the runtime state tiers. This is the *single code path* both the mount and
   the milestone test drive, so "the runtime and the test exercise the same
   code" is literally true (DESIGN centralization invariant).
5. **`lib/field-render.js`** (extended) — a gap-field annulus visualization
   (`drawGapField`) painted on the cross-section plane, driven by the solver's
   field array. Greenfield additive function; the loop-centric renderers are
   byte-unchanged.
6. **`lessons/unified_motor/mount.js` + `index.html`** — the `{label, mount}`
   tab under `LIB.App.runTabs`, the 3-zone bespoke interior, its own rAF +
   accumulator loop driving `LIB.MotorRun` (Live, main-thread), and the
   **registration seams** (panel registry, pointer-tool registry,
   header-control slot, and a **render-layer slot**) that let Phases 6/7/8/9
   attach without editing `mount.js`. The render-layer slot
   (`registerRender3D`/`RENDER3D`) lets Phase 9's polished rig take over the 3D
   viewport draw; when none is registered the mount draws its built-in rig.

### Conventions fixed for this phase

- **App namespace.** All app-layer (non-`lib/`) modules attach to a single
  global `window.UnifiedMotor` (created lazily with the IIFE idiom
  `const UM = window.UnifiedMotor || (window.UnifiedMotor = {});`). `config-schema.js`
  attaches `UnifiedMotor.ConfigSchema`; `mount.js` attaches `UnifiedMotor.mount`
  plus the registration seams. This mirrors the existing per-topic namespace
  pattern (`window.AcMotorLessons`, `window.LinearLessons`).
- **`lib/` modules attach to `window.LIB`** as DOM-free IIFEs
  (`LIB.MotorSlice`, `LIB.MotorStack`, `LIB.MotorRun`), no
  `document`/`canvas`/`getComputedStyle` at module-load — so they load under the
  Node `require` shim exactly like Phases 1–4.
- **Grid-array conventions are inherited unchanged** from Phases 1–2: row-major
  `Float64Array`, `idx = i*Ntheta + j`, `μ₀ = 4π×1e-7`, air `ν = 1/μ₀`.
- **The `section` shape** consumed by `motor-slice` is exactly the Phase-2
  `motor-compile` input: `{ grid:{Nr,Ntheta,rInner,rOuter,ell}, gapBand:{iInner,iOuter},
  features:[…] }`. `config-schema.expand()` is the sole producer of this shape
  in the app.
- **Solve-tier backend (`SolveBackend`).** The field-solve tier is injected, so
  `motor-slice` / `motor-stack` / `motor-run` stay agnostic to which grid
  resolution and linear solver run underneath. A `SolveBackend` is a plain
  object with three methods:
  ```
  backend = {
    prepare(section) → { op, compiled },
       // op: a Phase-1 GridOperator with materials, rotor region, and gap band
       //     already set; compiled: the Phase-2 MotorCompile output. The coarse
       //     backend builds them at section.grid; a refined backend may build
       //     them at a finer grid.
    solveSaturated(op, b, { x0, tol, ceiling }) → { x, iters, residual, satScale },
    linearSolve(op, b, { x0, tol })            → { x, iters, residual },
  }
  ```
  `motor-slice.create(section, opts)` reads `opts.backend` (default: the coarse
  backend below) and routes every solve through it; the tier-invariant work
  (`setRotorAngle`, `assembleJz`, `assembleRHS`, `field`, `fluxLinkage`, Arkkio
  torque) stays in `motor-slice`. Because `opts` flows
  `MotorRun.create → MotorStack.create → MotorSlice.create` unchanged, a backend
  passed to `MotorRun.create` reaches every slice. The **coarse backend** — the
  default, defined inside `motor-slice.js` — is:
    - `prepare(section)`: `op = LIB.AirgapGrid.create(section.grid)`;
      `compiled = LIB.MotorCompile.compile(section)`;
      `op.setMaterials({ nu: compiled.nu })`;
      `op.setRotorRegion({ rotorMask: compiled.rotorMask })`;
      `op.setGapBand(section.gapBand)`; returns `{ op, compiled }`.
    - `solveSaturated`: delegates to `LIB.AirgapSolve.solveSaturated`.
    - `linearSolve`: delegates to `LIB.AirgapSolve.pcg`.
- **Mechanical angle is `θ` (radians).** Electrical angle is derived inside
  `excitation.commutationPhase` via its `poles` field; `motor-run` passes the
  *mechanical* `θ` as `ctx.theta` (matching the Phase-3 contract, where
  `commutationPhase` multiplies by `poles/2`).
- **Torque sign / readout.** The live torque readout and torque plot use the
  **Arkkio gap-band** value (`LIB.AirgapTorque.arkkio`) — primary, single solve.
  The co-energy decomposition is **not** a live readout (it is above the target
  students' level); it is computed only inside the milestone test to assert
  Maxwell-vs-co-energy agreement.
- **State tiers (DESIGN-mandated; sets Reset semantics).** *True state*
  (Reset-zeroed): rotor `theta`, `omega`; per-circuit currents `i`; commutation
  `stepIndex`; sim time `t`. *Derived each tick* (not stored): field, `λ`,
  torque. *Config* (persists across Reset; changed only by editing): geometry,
  winding routing, circuit topology, mechanical params. The field is a
  **warm-start cache** (recomputable; cleared on Reset and on geometry edits).
- **Test runner**: `node:test` + `node:assert/strict`; `npm test` → `node --test`.
  Phase 5 ships its own headless loader `tests/pipeline/_fixtures.js` that
  `require`s Phase-1's `tests/_shim.js` **read-only** (for `window` + the engine
  libs) and then `require`s every other needed module *directly* (Phases 2/4
  precedent). **`tests/_shim.js` is NOT modified by this phase.**

### Machine-agnosticism boundary (load-bearing for this phase)

- The config vocabulary (`ring.element ∈ {W,C,M,I,K}`, excitation, commutation,
  stack descriptor) lives **only** in `config-schema.js`. Dispatch there is on
  element *type* and the universal excitation/commutation vocabulary — never on
  a machine name or a "machine-type" field (invariant #1).
- `motor-slice`, `motor-stack`, `motor-run`, and `mount.js` read **no** element
  letter and **no** machine identity. They see compiled sections, per-circuit
  `{terminal, commutation, R}` specs, and plain numeric state.
- Absent physics is zero, not skipped (invariant #2): a magnet-free config
  yields zero magnetization arrays from compile and `λ_pm = 0` from extract — no
  branch is taken around it.
- `N=1` runs the identical stack loop as `N>1` (invariant #5): the aggregator
  has no single-slice fast path.

## Files Owned

- `lessons/unified_motor/config-schema.js` — created
- `lib/motor-slice.js` — created
- `lib/motor-stack.js` — created
- `lib/motor-run.js` — created
- `lib/field-render.js` — modified
- `lessons/unified_motor/mount.js` — created
- `lessons/unified_motor/index.html` — created
- `tests/pipeline/_fixtures.js` — created
- `tests/pipeline/config-schema.test.js` — created
- `tests/pipeline/motor-slice.test.js` — created
- `tests/pipeline/motor-stack.test.js` — created
- `tests/pipeline/agnostic-pipeline.test.js` — created

> **Shared append-point (sanctioned).** `lessons/unified_motor/index.html` is
> created here with an explicit, comment-marked **module extension region**.
> Phases 6/7/8 append their own `<script>` tags inside that region only (machine
> fixtures, editors, the Detailed toggle). Those later phases will list
> `index.html` in their Files Owned with an "append within the marked region
> only" note; this is an intentional shared inclusion manifest, approved at spec
> time, not a silent overlap. No later phase edits any other line of
> `index.html` and none edits `mount.js` (they use the registration seams).

> **`lib/field-render.js`** is modified additively here (one new exported
> function). Phase 9's render-polish task **consumes `drawGapField` unchanged**
> (per-slice paint calls it once per slice plane with a stack-wide shared
> `magScale`); Phase 9 does **not** modify `field-render.js`.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 5.1: Config schema, single slice, gap-field viz

These three tasks share no files and have no mutual dependency (the `section`
shape and the `drawGapField` data contract are both frozen in this spec), so
they run in parallel.

### Task 5.1.1: config-schema.js — agnostic descriptor + `expand()` (vocabulary-complete)

- **Description**: The agnostic machine descriptor and the one-way `expand()`
  that turns it into the compiled sections + circuit drive specs the `lib/`
  pipeline consumes. **Must be vocabulary-complete in this phase**: Phase 6 adds
  *only data* (`machines/*.js`), so every element type, terminal state,
  commutation mode, series/parallel circuit form, and the full axial slice-stack
  descriptor must already be expandable here. Element-type dispatch is the only
  dispatch; no machine name or machine-type field exists in the source.
- **Files to create**:
  - `lessons/unified_motor/config-schema.js` — IIFE attaching
    `window.UnifiedMotor.ConfigSchema`. DOM-free. API:
    - `UnifiedMotor.ConfigSchema.validate(config) → { ok:boolean, errors:string[] }`
      — never throws on malformed input. Checks (one human-readable string per
      violation): `grid` has finite `Nr,Ntheta≥1, rInner<rOuter, ell>0`;
      `gapBand.iInner`/`iOuter` integers in `[0,Nr)` with `iInner<iOuter`;
      `poles` a positive even integer; `mechanical.J>0`; every `ring.member ∈
      {"rotor","stator"}`; every `ring.element ∈ {"W","C","M","I","K"}`; every
      `ring.rRange=[r0,r1]` with `rInner ≤ r0 < r1 ≤ rOuter`; for wound rings
      (`W`/`C`/`K`) the resolved routing passes `LIB.WindingModel.validate`; the
      total resolved circuit count equals `config.circuits.length`; each circuit
      has a `terminal.type ∈ {AC,DC,PULSE,STEP,OPEN,SHORT}`, a `commutation.mode
      ∈ {none,mechanical,electronic-trap,electronic-sine,sequencer}`, and finite
      `R ≥ 0`; `stack.slices` an integer `≥1`; `stack.sliceOffsets.length ===
      stack.slices`; each `stack.fluxSources[*].ringRef` an in-range ring index
      whose element is `"M"` and whose `sliceSigns.length === stack.slices`.
    - `UnifiedMotor.ConfigSchema.expand(config) → expanded` where `expanded` is:
      ```
      {
        grid, gapBand, poles, mechanical: { J, damping, loadTorque }, label,
        nCircuits,                                  // global circuit count
        circuits: [ { terminal, commutation, R }, … ],   // length nCircuits
        slices:   [ { section, offset }, … ],            // length stack.slices (N≥1)
      }
      ```
      - `section` is the Phase-2 shape `{ grid, gapBand, features }`. `grid` and
        `gapBand` are `config.grid`/`config.gapBand` echoed onto every slice.
      - `offset` is `config.stack.sliceOffsets[k]` (radians; the per-slice
        rotor-angle offset the stack applies at runtime).
    - **Element→feature builders** (internal, not exported), dispatched only on
      `ring.element`, each emitting Phase-2 features for the ring's `rRange` and
      `member`:
      - `"I"` (salient iron): `count = ring.teeth`; for `t` in `0..count-1`,
        centre `θ_t = ring.theta0 + t·2π/count`, one `iron` feature
        `{ kind:"iron", member, rRange, thetaRange:[θ_t − h, θ_t + h], muR:ring.muR }`
        with `h = ring.spanFraction·(π/count)` (`spanFraction` default `0.5`).
      - `"M"` (PM): `count = ring.magnets`; for `g` in `0..count-1`, one `magnet`
        feature spanning the full sector `thetaRange:[g·2π/count, (g+1)·2π/count]`,
        `Mr = ring.Mr·(−1)^g` (alternating N/S), `Mtheta:0`. If `ring.backIron`
        is truthy, additionally one `iron` feature over `ring.backIronRRange`
        with `muR:ring.muR`.
      - `"W"`, `"C"`, `"K"` (wound): resolve `ring.winding` to a Phase-2
        `routing` (it is either an explicit routing object, or
        `{ standard:{ m,p,Q,coilPitch,turns } }` → `LIB.WindingModel.standardWinding`).
        Compute conductor features via
        `LIB.WindingModel.conductorFeatures(routing, slotGeom)` with
        `slotGeom = { rRange: ring.slotRRange ?? ring.rRange, member,
        width: ring.slotWidth ?? (ring.slotFraction ?? 0.5)·(2π/routing.nSlots) }`,
        then offset each feature's `circuit` by the ring's global circuit base.
        Also emit one back-iron `iron` feature over `ring.ironRRange ?? ring.rRange`
        with `muR:ring.muR`. For `"C"` additionally emit salient tooth `iron`
        features as in `"I"` (one per slot). `"K"` emits the same conductor +
        iron features as `"W"`; its shorted behaviour comes entirely from the
        circuit's `terminal.type === "SHORT"` (set in `config.circuits`), not
        from a geometry branch.
    - **Global circuit indexing**: walk rings in declared order; each wound ring
      contributes `LIB.WindingModel.ampereConductors(routing).nCircuits`
      circuits; assign a cumulative base offset and rewrite conductor
      `feature.circuit += base`. `nCircuits` is the running total. Every slice's
      section references this **same global circuit index space** (so each
      slice's compiled `coilMasks.length === nCircuits`; a circuit that does not
      thread a slice contributes an all-zero mask).
    - **Slice-stack expansion**: `N = config.stack.slices` (default `1`);
      `offsets = config.stack.sliceOffsets` (default `Array(N).fill(0)`). The
      base feature list is built once. For slice `k`, `section.features` is the
      base list with every `magnet` feature referenced by a
      `stack.fluxSources` entry multiplied (`Mr`,`Mtheta`) by that source's
      `sliceSigns[k]`; rings not referenced are copied unchanged. `N=1` produces
      a one-element `slices` array through the identical code (no special path).
- **Files to modify**: none.
- **Tests** (authored in Task 5.5.1): `tests/pipeline/config-schema.test.js`.
- **Acceptance criteria**:
  - `expand(cfg).slices[k].section` validates against the Phase-2 `section`
    shape: every feature has `kind ∈ {conductor,magnet,iron}`, a `member`, an
    `rRange`, a `thetaRange`, and its kind-specific fields; `compile()` of it
    runs without error.
  - All five element letters produce features; a ring with no magnets emits no
    `magnet` feature (→ zero magnetization after compile — zero-not-skip), and a
    config with no iron emits no `iron` feature.
  - `expand(cfg).nCircuits === cfg.circuits.length`; `circuits` is echoed
    verbatim (length `nCircuits`).
  - A `stack.slices = 1` config yields `slices.length === 1`; a
    `stack.slices = 2` config with `sliceOffsets:[0, δ]` yields
    `slices.length === 2` with `slices[1].offset === δ`.
  - A `stack.fluxSources` entry with `sliceSigns:[+1,−1]` produces slice-0 and
    slice-1 magnet features whose `Mr` are exact negatives.
  - The module source contains **no** string literal matching any of the 13
    machine names (asserted in `config-schema.test.js`) and reads no
    machine-type field; dispatch is on `ring.element` only.
  - Module loads under `require` with no DOM access.
  - All tests pass.

### Task 5.1.2: motor-slice.js — single-section solver

- **Description**: Wrap one compiled `section` into a single-section solve tying
  grid + compile + circuit-coefficient extraction through a pluggable
  `SolveBackend` (the coarse PCG tier by default; see Conventions). Holds a
  per-slice warm-start `A_z`. Reads only compiled arrays — no
  winding/element/machine knowledge and no hard-wired solver tier.
- **Files to create**:
  - `lib/motor-slice.js` — IIFE attaching `LIB.MotorSlice`. API:
    - `LIB.MotorSlice.create(section, opts = {}) → slice`. On create:
      `backend = opts.backend ?? <the coarse backend defined in Conventions>`;
      `{ op, compiled } = backend.prepare(section)`. Store `op`, `compiled`,
      `backend`, an initially-null warm-start `_Az`, and
      `ceiling = opts.ceiling ?? { enabled:true, Bknee:1.6, p:2 }`. Magnetization
      is registered with the rotor region so the sliding band carries it (per the
      Phase-1 `setRotorRegion` contract; the coarse backend's `prepare` performs
      that registration).
    - `slice.nCircuits` — `compiled.nCircuits`.
    - `slice.solve(thetaR, currents) → { torque, fluxLinkages, field }`:
      `op.setRotorAngle(thetaR)`; `Jz = compiled.assembleJz(currents)`;
      `b = op.assembleRHS({ Jz, magnetization: compiled.magnetization })`;
      `res = backend.solveSaturated(op, b, { x0: this._Az,
      tol: opts.tol ?? 1e-6, ceiling: { ...this.ceiling, ironMask:
      compiled.ironMask } })`; `this._Az = res.x`;
      `{ Br, Bt } = op.field(res.x)`;
      `fluxLinkages = op.fluxLinkage(res.x, compiled.coilMasks)`;
      `torque = LIB.AirgapTorque.arkkio(op, res.x)`. Return
      `{ torque, fluxLinkages, field: { Az: res.x, Br, Bt, satScale: res.satScale } }`.
    - `slice.extractCoeffs(thetaR, opts2 = {}) → { L, dLdth, lambdaPm,
      dLambdaPmdth }` — `LIB.MotorCircuit.extract(op, backend.linearSolve,
      { jzBasis: compiled.coilMasks, coilMasks: compiled.coilMasks,
      magnetization: compiled.magnetization }, thetaR, opts2)`.
    - `slice.clearWarmStart()` — sets `_Az = null`.
    - `slice.grid` — `compiled.grid` (echo of `section.grid` + derived
      `dr,dtheta,r,dA`), exposed so the stack/mount can index the field for the
      gap-field viz.
- **Files to modify**: none.
- **Tests** (authored in Task 5.5.1): `tests/pipeline/motor-slice.test.js`.
- **Acceptance criteria**:
  - `LIB.MotorSlice.create(section)` returns an object exposing `solve`,
    `extractCoeffs`, `clearWarmStart`, `nCircuits`, `grid`.
  - With no `opts.backend`, `create` uses the coarse backend (PCG + global
    ceiling): `prepare` builds the operator at `section.grid` and `solve`
    delegates to `LIB.AirgapSolve.solveSaturated`, `extractCoeffs` to
    `LIB.AirgapSolve.pcg`.
  - `create(section, { backend })` routes `prepare`, `solveSaturated`, and
    `linearSolve` through the supplied backend (asserted with a spy backend in
    `motor-slice.test.js`).
  - `solve(θ, currents)` returns a finite `torque`, a `fluxLinkages`
    `Float64Array` of length `nCircuits`, and a `field` with `Az`/`Br`/`Bt`
    `Float64Array`s of length `Nr·Ntheta`.
  - For a section with non-zero current and saliency, `solve(θ₁, i)` and
    `solve(θ₂, i)` with `θ₁ ≠ θ₂` return different `Br` arrays (the rotor moved
    the field).
  - After one `solve` followed by a second `solve` at a one-cell-shifted angle,
    the warm-started second solve is exercised without error (warm-start cache
    populated); `clearWarmStart()` resets it.
  - `extractCoeffs` returns `L`/`dLdth` of length `nCircuits²` and
    `lambdaPm`/`dLambdaPmdth` of length `nCircuits`, all finite; for a
    magnet-free section `lambdaPm` and `dLambdaPmdth` are exactly zero.
  - Module loads under `require` with no DOM access.
  - All tests pass.

### Task 5.1.3: field-render.js — gap-field annulus visualization

- **Description**: Add one exported renderer that paints the air-gap field as a
  heatmap (+ optional `B`-vectors) on a cross-section plane, projected through
  an `LIB.Layout3D` handle. Greenfield additive: the existing loop-centric
  functions and the module's dependency guard are byte-unchanged. The new
  function uses only `LIB.Layout3D`, `LIB.Draw`, and `LIB.Util` — it adds **no**
  dependency on `LIB.EM`.
- **Files to modify**:
  - `lib/field-render.js` — add `drawGapField(ctx, L3, fieldData, geom, opts)`
    to the `LIB.FieldRender` export object (appended to the existing
    `LIB.FieldRender = { … }` literal; existing entries unchanged). Contract:
    - `fieldData = { Br, Bt }` — two `Float64Array`s of length `Nr·Ntheta`
      (row-major `idx = i*Ntheta + j`), as returned in a slice's
      `solve(...).field`.
    - `geom = { Nr, Ntheta, r, rInner, rOuter, planeZ = 0, axis = "z" }` — `r`
      is the `Float64Array(Nr)` of cell-centre radii. The annulus lies in the
      machine's transverse plane (world x–y) at axial position `planeZ`; a cell
      `(i,j)` maps to world point `{ x: r[i]·cos(θ_j), y: r[i]·sin(θ_j),
      z: planeZ }` with `θ_j = (j+0.5)·2π/Ntheta`.
    - `opts = { alpha = 0.85, vectors = true, vectorStride = 8, magScale = null,
      colorLo = "#0d1013", colorHi = "#ffd54a" }`. When `magScale` is null, the
      heatmap auto-scales to `max|B|` over the array. Each cell is drawn as a
      projected quad filled by `LIB.Util.lerpColor(colorLo, colorHi,
      clamp01(|B|/magScale))`; cells whose projected corners are all `behind`
      are skipped. When `vectors`, a `B`-vector arrow (radial `Br` + tangential
      `Bt` decomposed into world x/y) is drawn every `vectorStride` cells via
      `LIB.FieldRender.drawVectorArrow`.
- **Files to create**: none.
- **Tests**: none headless (this is a canvas renderer; it has no DOM-free
  assertion). Its behaviour is verified manually as part of Task 5.4.1's browser
  checklist. The data it consumes (`fieldData`) is asserted at the array level
  in `tests/pipeline/motor-slice.test.js`.
- **Acceptance criteria**:
  - `LIB.FieldRender.drawGapField` is a function after the module loads.
  - The five pre-existing exports (`drawLoopFieldLines`, `drawMomentArrow`,
    `drawBarMagnet`, `drawVectorArrow`, `drawTorqueArrow`) remain present and
    their function bodies are unchanged (diff touches only the new function and
    the export list).
  - The `drawGapField` function body references no `LIB.EM` symbol, and the
    module-level `LIB.EM` guard is byte-unchanged. (No Phase-5 test loads
    `field-render.js` headlessly; any future headless test that `require`s it
    must shim `LIB.EM = {}` first.)

---

## Wave 5.2: Universal stack container

### Task 5.2.1: motor-stack.js — N≥1 spatial aggregator

- **Description**: The universal physics container. Builds one `LIB.MotorSlice`
  per expanded slice and **always** loops over them (`N≥1`) — no single-slice
  bypass. Applies each slice's rotor-angle offset, sums each shared circuit's
  `λ` across slices, sums torque, and aggregates the `L(θ)` coefficients. Also
  exposes the co-energy torque total (used only by the milestone test). Reads no
  element letter or machine identity.
- **Files to create**:
  - `lib/motor-stack.js` — IIFE attaching `LIB.MotorStack`. API:
    - `LIB.MotorStack.create(expanded, opts = {}) → stack`. Builds
      `slices = expanded.slices.map(s => ({ slice: LIB.MotorSlice.create(s.section,
      opts), offset: s.offset }))`. Stores `nCircuits = expanded.nCircuits`,
      `nSlices = slices.length`. Asserts every built slice has
      `slice.nCircuits === nCircuits` (throws a descriptive `Error` otherwise —
      the config-schema global-index guarantee).
    - `stack.nCircuits`, `stack.nSlices`.
    - `stack.solve(thetaR, currents) → { torque, fluxLinkages, perSliceField }`:
      `torque = 0`; `fluxLinkages = new Float64Array(nCircuits)`;
      `perSliceField = []`. For each `{ slice, offset }`:
      `r = slice.solve(thetaR + offset, currents)`; `torque += r.torque`;
      for `k` in `0..nCircuits-1`: `fluxLinkages[k] += r.fluxLinkages[k]`;
      `perSliceField.push(r.field)`. The loop body is unconditional — there is
      no `if (nSlices === 1)` fast path.
    - `stack.extractCoeffs(thetaR) → { L, dLdth, lambdaPm, dLambdaPmdth }`:
      zero-initialize `L`/`dLdth` (`Float64Array(nCircuits²)`) and
      `lambdaPm`/`dLambdaPmdth` (`Float64Array(nCircuits)`); for each
      `{ slice, offset }`: `c = slice.extractCoeffs(thetaR + offset)`; add each
      array entrywise (shared-circuit inductances sum across slices). Return the
      sums.
    - `stack.coenergyTorque(thetaR, currents, coeffs = null) → { reluctance, pm,
      mutual, total }`: if `coeffs` is null, `coeffs = stack.extractCoeffs(thetaR)`.
      With `m = nCircuits`: `reluctance = ½·Σ_k i_k²·dLdth[k*m+k]`;
      `mutual = ½·Σ_{k≠l} i_k·i_l·dLdth[k*m+l]`;
      `pm = Σ_k i_k·dLambdaPmdth[k]`; `total = reluctance + mutual + pm`.
    - `stack.sliceGrid(k) → { Nr, Ntheta, rInner, rOuter, r }` — returns slice
      `k`'s compiled grid (echo of that slice's `section.grid` + the derived `r`
      radii), so the mount's gap-field viz and the Phase-8 worker (`fieldMap`/
      `fieldFrame`) can index per-slice field arrays without reaching into slice
      internals.
    - `stack.clearWarmStart()` — calls `slice.clearWarmStart()` on every slice.
- **Files to modify**: none.
- **Tests** (authored in Task 5.5.1): `tests/pipeline/motor-stack.test.js`.
- **Acceptance criteria**:
  - A 1-slice stack's `solve(θ, i).torque` equals its single underlying slice's
    `solve(θ, i).torque` to `1e-9` relative (same path, no bypass).
  - A 2-slice stack with both `offset === 0` and identical sections returns
    `torque` equal to twice the single-slice torque and `fluxLinkages` equal to
    twice the single-slice flux linkage, each to `1e-9` relative.
  - A 2-slice stack with a non-zero second offset returns a `torque` that
    differs from the zero-offset case (the offset is applied).
  - `stack.solve` returns `perSliceField.length === nSlices`.
  - `stack.extractCoeffs` returns arrays of length `nCircuits²` (`L`,`dLdth`) and
    `nCircuits` (`lambdaPm`,`dLambdaPmdth`), all finite.
  - `stack.coenergyTorque(θ, i)` returns four finite numbers.
  - Module loads under `require` with no DOM access.
  - All tests pass.

---

## Wave 5.3: Headless temporal driver

### Task 5.3.1: motor-run.js — per-tick driver + state tiers

- **Description**: The headless runtime: one object owning the true-state tier
  and the per-tick chain *excitation → circuit current step → torque →
  mechanical integrate*. It is the single code path the mount and the milestone
  test both drive. Consumes `LIB.MotorStack` (Phase 5), `LIB.Excitation`
  (Phase 3), `LIB.MotorCircuit` (Phase 4). No DOM access.
- **Files to create**:
  - `lib/motor-run.js` — IIFE attaching `LIB.MotorRun`. API:
    - `LIB.MotorRun.create(expanded, opts = {}) → runtime`. Builds
      `stack = LIB.MotorStack.create(expanded, opts)`;
      `cache = LIB.MotorCircuit.makeCache({ period: 2π, binCount: opts.binCount ?? 360 })`.
      Stores **mutable** `circuits = expanded.circuits` (drive specs — the mount
      mutates `terminal.amp`/`freq`/etc. via sliders), **mutable**
      `mechanical = { ...expanded.mechanical }`, and `poles = expanded.poles`.
      Initializes `state = { theta:0, omega:0, i: new Float64Array(stack.nCircuits),
      t:0, stepIndex:0 }` and `lastSolve = null`. Exposes `runtime.stack`,
      `runtime.state`, `runtime.circuits`, `runtime.mechanical`.
    - `runtime.step(dt) → state`:
      1. `ctx = { t: state.t, theta: state.theta, stepIndex: state.stepIndex }`.
      2. `conditions = LIB.Excitation.evalDrive(circuits, ctx)`.
      3. Build the circuit-step inputs (length `m = stack.nCircuits`): for each
         `k`, `terminalStates[k] = conditions[k].kind === "open" ? "OPEN" :
         conditions[k].kind === "short" ? "SHORT" : "DC"`;
         `V[k] = conditions[k].kind === "voltage" ? conditions[k].V : 0`;
         `R[k] = circuits[k].R`. (`"DC"` is an accepted driven token in Phase 4
         `stepCurrents`, which branches only on `OPEN`/`SHORT` and uses `V[k]`
         for every other token (Phase 4 §4.1.1) — so mapping all voltage
         conditions to `"DC"` is correct.)
      4. `coeffs = cache.coeffs(state.theta, (thC) => stack.extractCoeffs(thC))`.
      5. `{ i } = LIB.MotorCircuit.advance(coeffs, { R, V, i: state.i,
         omega: state.omega, dt, terminalStates })`; set `state.i = i`.
      6. `solved = stack.solve(state.theta, state.i)`; `state` torque is
         `solved.torque` (Arkkio). Stash `runtime.lastSolve = solved`.
      7. Mechanics (semi-implicit): `omega += (solved.torque −
         mechanical.damping·state.omega − mechanical.loadTorque)·dt /
         mechanical.J`; `state.omega = omega`; `state.theta += omega·dt`.
      8. `state.t += dt`. Return `state`.
    - `runtime.commandStep(n = 1)` — `state.stepIndex += n` (open-loop sequencer
      advance; the mount calls this from a step button / a `stepHz` timer).
    - `runtime.reset()` — `state.theta = state.omega = state.t = 0`;
      `state.stepIndex = 0`; `state.i = new Float64Array(stack.nCircuits)`;
      `stack.clearWarmStart()`; `cache.clear()`; `runtime.lastSolve = null`.
    - `runtime.clearFieldCache()` — `stack.clearWarmStart()` + `cache.clear()`
      (geometry-edit invalidation without zeroing true state).
- **Files to modify**: none.
- **Tests** (authored in Task 5.5.1): exercised by
  `tests/pipeline/agnostic-pipeline.test.js`.
- **Acceptance criteria**:
  - `LIB.MotorRun.create(expanded)` returns an object exposing `step`,
    `commandStep`, `reset`, `clearFieldCache`, `stack`, `state`, `circuits`,
    `mechanical`.
  - `runtime.state.i` is a `Float64Array` of length `stack.nCircuits`.
  - Stepping a driven config repeatedly leaves `state.theta`, `state.omega`,
    `state.t` finite and advances `state.t` by exactly `N·dt` after `N` steps.
  - `runtime.reset()` returns `state.theta`, `state.omega`, `state.t`,
    `state.stepIndex` all to `0` and `state.i` to all-zero.
  - Module loads under `require` with no DOM access.
  - All tests pass.

---

## Wave 5.4: Mount + page

### Task 5.4.1: mount.js + index.html — bespoke interior, loop, registration seams

- **Description**: The browser app. A `{label, mount}` tab body built into the
  `runTabs` host `div`, with the 3-zone layout, its own rAF + accumulator loop
  driving `LIB.MotorRun` on the main thread (Live), the gap-field 3D
  visualization, and the registration seams Phases 6/7/8 use. No machine
  awareness: the mount reads config-declared presentation and drives the
  agnostic runtime. **This task requires a real-world browser verification step
  (the CLAUDE.md "Verifying a new lesson" checklist) that no headless agent can
  fully perform — it is flagged user-required in the manifest.**
- **Files to create**:
  - `lessons/unified_motor/mount.js` — IIFE attaching `window.UnifiedMotor`
    members. Surface:
    - **Registration seams** (created lazily on `window.UnifiedMotor`, populated
      by Phase 6/7/8 scripts *before* the `runTabs` call, consumed by `mount`
      at mount-time and torn down on unmount):
      - `UnifiedMotor.PANELS` (array) + `UnifiedMotor.registerPanel(entry)` where
        `entry = { id:string, title:string, zone:"shelf"|"side",
        build(host, ctx) → unmountFn }`.
      - `UnifiedMotor.TOOLS` (array) + `UnifiedMotor.registerTool(entry)` where
        `entry = { id:string, label:string, onPointer(type, mx, my, view, ctx)
        → boolean }` (returns true to consume the gesture; the mount muxes tools
        in registration order, built-ins first).
      - `UnifiedMotor.HEADER_CONTROLS` (array) +
        `UnifiedMotor.registerHeaderControl(entry)` where
        `entry = { id:string, build(host, ctx) → (HTMLElement | unmountFn) }`.
      - `UnifiedMotor.RENDER3D` (single slot, initially `null`) +
        `UnifiedMotor.registerRender3D(entry)` where
        `entry = { id:string, paint(ctx, L3, rctx) → void }` (last registration
        wins). When set, the mount delegates the entire 3D-rig + gap-field draw to
        `RENDER3D.paint` each frame (see render step below); when `null`, the mount
        draws its built-in rig. `rctx = { runtime, config, expanded, W, H }` — the
        same `runtime`/`config` as `ctx`, plus the live `expanded` config (so the
        renderer can index per-slice sections/offsets and `runtime.lastSolve
        .perSliceField`). The registered renderer fully owns the viewport draw for
        that frame; it manages its own state and any header control via the
        existing `registerHeaderControl` seam. No per-mount teardown is needed
        (`paint` is stateless from the mount's view).
      - `ctx` handed to every `build`/`onPointer` is
        `{ runtime, config, view, requestRebuild() }` — `requestRebuild` re-runs
        `expand(config)` and rebuilds the runtime (for geometry/topology edits).
    - `UnifiedMotor.mount(host) → unmount` — the tab body. It:
      1. Resolves the initial config: `UnifiedMotor.defaultConfig` if set
         (Phase 6/7 override it), else a built-in default it constructs inline
         (a current-fed wound machine via `ConfigSchema.expand`). The built-in
         default uses the same parameter values as the `woundConfig()` fixture
         defined in §Task 5.5.1 (a known-working geometry that satisfies the
         'rotor visibly turns' criterion).
      2. Builds the bespoke interior in `host`: a header strip (Reset, Pause,
         and a header-control slot wired from `HEADER_CONTROLS`); an upper
         **3-zone** region (a 3D viewport canvas + two cross-section view
         canvases); a right shelf built with `LIB.Registry.mkRow` for the
         drive/load scalar sliders (current/voltage amp, frequency, load torque)
         plus any `PANELS` with `zone:"shelf"`; a bottom region with `LIB.Plot`
         time-series panes (torque, ω, currents) + a readout column
         (torque, ω, θ, per-circuit current, flux linkage).
      3. Computes `expanded = expand(config)` (retained for the render context),
         creates `runtime = LIB.MotorRun.create(expanded)`, and runs its own
         rAF + accumulator loop: `acc += dtFrame (clamped); while (acc ≥ PHYS_DT)
         { runtime.step(PHYS_DT); acc −= PHYS_DT; }`. `PHYS_DT = 1/(opts.physHz
         ?? 240)`. (`requestRebuild` re-runs `expand(config)`, replaces both
         `expanded` and `runtime`, and clears the warm-start cache.)
      4. Renders each frame: it builds the `LIB.Layout3D.orbital` camera `L3`
         (from the orbit-camera tool's state), then **if `UnifiedMotor.RENDER3D`
         is registered, delegates the whole 3D-rig + gap-field draw to
         `UnifiedMotor.RENDER3D.paint(ctx, L3, { runtime, config, expanded, W,
         H })`**; otherwise it draws its built-in rig — `LIB.CoilRender` polylines
         for slot conductors / end-windings, plus the gap field via
         `LIB.FieldRender.drawGapField` fed from `runtime.lastSolve
         .perSliceField[*]` + the slice grid obtained via
         `runtime.stack.sliceGrid(k)`. Slider values are written into
         `runtime.circuits`/`runtime.mechanical` on change.
      5. Pointer arbitration: a built-in orbit-camera tool and a rotor-drag tool
         are registered first; `TOOLS` entries are muxed after them.
      6. Reset zeroes true state (`runtime.reset()`); Pause halts stepping;
         editing geometry/topology calls `ctx.requestRebuild()` (which
         re-expands the config and clears the warm-start cache).
      7. Returns `unmount()` that cancels the rAF, removes pointer listeners,
         tears down registered panels/controls, and clears `host`.
  - `lessons/unified_motor/index.html` — the page. `<link rel="stylesheet"
    href="../../lib/shell.css">`. Loads scripts in this exact order, each a
    plain `<script src>` (no modules):
    `../../lib/util.js`, `../../lib/canvas-type.js`, `../../lib/registry.js`, `../../lib/plot.js`,
    `../../lib/integrate.js`, `../../lib/draw.js`, `../../lib/layout3d.js`, `../../lib/em-physics.js`, `../../lib/field-render.js`,
    `../../lib/coil-render.js`, `../../lib/app.js`, then the engine libs `../../lib/airgap-grid.js`,
    `../../lib/airgap-solve.js`, `../../lib/airgap-torque.js`, `../../lib/motor-compile.js`, `../../lib/winding-model.js`,
    `../../lib/excitation.js`, `../../lib/motor-circuit.js`, then the Phase-5 app modules
    `./config-schema.js`, `../../lib/motor-slice.js`, `../../lib/motor-stack.js`,
    `../../lib/motor-run.js`, `./mount.js`, then **the module extension region**:
    ```html
    <!-- unified-motor modules: later phases append <script> tags below this line ONLY -->
    <!-- /unified-motor modules -->
    ```
    then the mount call:
    ```html
    <script>
      LIB.App.runTabs({
        title: "Unified Motor",
        tabs: [{ label: "unified-motor", mount: window.UnifiedMotor.mount }],
      });
    </script>
    ```
- **Files to modify**: none.
- **Tests**: the headless `agnostic-pipeline.test.js` reads `mount.js` source for
  the machine-name grep (Task 5.5.1). Visual/interaction behaviour is verified
  via the browser checklist below (user-required).
- **Acceptance criteria**:
  - Served from the repo root, `http://localhost:<port>/lessons/unified_motor/index.html`
    loads with **no console errors or warnings**.
  - The splash card appears; selecting it mounts the 3-zone interior (3D
    viewport + two cross-section views + right shelf sliders + bottom plots +
    readouts).
  - With a drive applied, the rotor **visibly turns** in the 3D viewport and the
    gap-field heatmap animates; the torque/ω/current plots populate and the
    readouts update.
  - Reset returns the rotor to rest and clears plot history; Pause halts motion.
  - `window.UnifiedMotor` exposes `mount`, `registerPanel`, `registerTool`,
    `registerHeaderControl`, `registerRender3D`, the `PANELS`/`TOOLS`/
    `HEADER_CONTROLS` arrays, and the `RENDER3D` slot (initially `null`).
  - When a renderer is registered via `registerRender3D`, the mount calls its
    `paint(ctx, L3, { runtime, config, expanded, W, H })` each frame in place of
    the built-in 3D-rig draw (exercised by Phase 9); with none registered, the
    built-in rig + `drawGapField` draws (the Phase-5 default path).
  - `mount.js` source contains no string literal matching any of the 13 machine
    names (asserted in `agnostic-pipeline.test.js`).
  - **(User-required)** The implementer/user completes the CLAUDE.md "Verifying
    a new lesson" browser checklist and confirms the rotor turns, the field
    paints, and Reset/Pause behave — recording the result in `spec/progress.md`.

---

## Wave 5.5: Agnosticism milestone test

### Task 5.5.1: pipeline test suite + fixtures (the milestone)

- **Description**: The Phase-5 validation suite, including the agnostic-pipeline
  milestone: ≥3 structurally-different configs plus one `N=2` config pushed
  through the *identical* `LIB.MotorRun` path, asserting the rotor turns, live
  Maxwell-vs-co-energy agreement, and that `lib/` + `mount.js` are free of
  machine names. Also unit-tests `config-schema`, `motor-slice`, and
  `motor-stack`.
- **Files to create**:
  - `tests/pipeline/_fixtures.js` — not a test file (no `.test.js`). On require:
    `const LIB = require("../_shim.js");` (installs `window` + engine libs),
    then **direct** `require` of `../../lib/motor-compile.js`,
    `../../lib/winding-model.js`, `../../lib/excitation.js`,
    `../../lib/motor-circuit.js`, `../../lib/motor-slice.js`,
    `../../lib/motor-stack.js`, `../../lib/motor-run.js`, and
    `../../lessons/unified_motor/config-schema.js`. Re-exports `assertClose` from
    `require("../engine/_fixtures.js")`. Exports:
    - `LIB`, `UnifiedMotor` (`= window.UnifiedMotor`).
    - `MACHINE_NAMES` — the frozen token list grepped for (case-insensitive):
      `["bldc","pmsm","srm","squirrel","stepper","brushed","universal-motor",
      "wound-field"]`. (Physics terms — `reluctance`, `induction`, `synchronous`,
      `commutation` — are deliberately **excluded**: they name physics, not a
      machine identity, and are legitimate per invariant #1. The exhaustive
      repo-wide audit is Phase 10.)
    - `woundConfig()` — a current-fed wound machine: a single stator `W` ring
      (`standard:{ m:1, p:2, Q:6, coilPitch:3, turns:20 }`) on a small annulus,
      one `DC` circuit (`commutation:{mode:"none"}`, finite `R`), a salient `I`
      rotor (2 teeth) so reluctance torque is non-zero off alignment,
      `stack.slices:1`, `mechanical:{ J:1e-4, damping:1e-5, loadTorque:0 }`,
      `poles:2`.
    - `pmConfig()` — a PM machine: an `M` rotor (`magnets:2`), a current-fed
      stator `W` ring, one `DC`/`AC` circuit, `stack.slices:1`.
    - `salientConfig()` — a salient-iron reluctance machine: an `I` rotor
      (2 teeth) and a `C` stator (concentrated coils), one `DC` circuit,
      `stack.slices:1`.
    - `skewN2Config()` — the wound machine of `woundConfig()` with
      `stack.slices:2`, `sliceOffsets:[0, 0.05]` (a small skew), one shared
      circuit threading both slices.
    - `tinySection({ withMagnet, withIron, turns })` — a hand-built Phase-2
      `section` (grid `Nr:6, Ntheta:24, rInner:0.04, rOuter:0.05, ell:0.1`,
      `gapBand:{iInner:2,iOuter:4}`, one stator conductor circuit and an optional
      rotor magnet/iron feature) for the `motor-slice`/`motor-stack` unit tests
      (no dependence on `config-schema`).
  - `tests/pipeline/config-schema.test.js` — `require("./_fixtures.js")`:
    - › `"expand produces Phase-2 sections"` — `expand(woundConfig())`: every
      `slices[0].section.features[*].kind ∈ {conductor,magnet,iron}` and
      `LIB.MotorCompile.compile(slices[0].section)` runs without throwing.
    - › `"nCircuits matches circuits length"` —
      `expand(woundConfig()).nCircuits === woundConfig().circuits.length`.
    - › `"no magnet ⇒ no magnet feature (zero-not-skip)"` — `salientConfig()`
      (magnet-free) yields zero `magnet` features and, after compile, all-zero
      `magnetization.Mr`/`Mtheta`.
    - › `"N=1 default and N=2 stack"` — `expand(woundConfig()).slices.length ===
      1`; `expand(skewN2Config()).slices.length === 2` with
      `slices[1].offset === 0.05`.
    - › `"flux-source sign flips magnet per slice"` — a 2-slice config with a
      `stack.fluxSources` entry `sliceSigns:[+1,−1]` on an `M` ring: the slice-0
      and slice-1 magnet features' `Mr` are exact negatives.
    - › `"validate rejects bad config"` — a config with `circuits.length`
      mismatching the resolved circuit count returns `ok:false` with a non-empty
      `errors`.
    - › `"no machine-name string in source"` — read
      `lessons/unified_motor/config-schema.js` and assert none of
      `MACHINE_NAMES` appears (case-insensitive).
  - `tests/pipeline/motor-slice.test.js` — `require("./_fixtures.js")`:
    - › `"solve returns finite torque + flux of length nCircuits"` — build
      `LIB.MotorSlice.create(tinySection({ withIron:true }))`; `r = slice.solve(0,
      Float64Array([5]))`; assert `Number.isFinite(r.torque)`,
      `r.fluxLinkages.length === slice.nCircuits`, `r.field.Br.length ===
      6*24`, and `Number.isFinite(r.field.satScale)` is true (confirms the
      default coarse backend routed `solve` through `AirgapSolve.solveSaturated`,
      the ceiling path — `pcg`/`linearSolve` returns no `satScale`).
    - › `"field changes with rotor angle"` — `slice.solve(0, i).field.Br` and
      `slice.solve(0.3, i).field.Br` differ in at least one entry by `> 1e-12`.
    - › `"magnet-free section ⇒ zero λ_pm"` — `extractCoeffs(0)` on
      `tinySection({ withMagnet:false })` has `lambdaPm[0] === 0` and
      `dLambdaPmdth[0] === 0`.
    - › `"honors a custom SolveBackend"` — wrap the coarse backend in a spy that
      counts `prepare`/`solveSaturated`/`linearSolve` calls and delegates to it;
      `s = LIB.MotorSlice.create(tinySection({ withIron:true }), { backend: spy })`;
      after `s.solve(0, Float64Array([5]))` and `s.extractCoeffs(0)`, assert
      `spy.prepare` ran exactly once and `spy.solveSaturated`/`spy.linearSolve`
      each ran ≥ 1 time, and the `solve` torque equals the default-backend
      slice's torque to `1e-9` relative (the spy only observes; it changes no
      result).
  - `tests/pipeline/motor-stack.test.js` — `require("./_fixtures.js")`:
    - › `"N=1 stack equals its single slice"` — build a stack from a 1-slice
      `expand` (or a hand `{ slices:[{section,offset:0}], nCircuits, … }`); assert
      `stack.solve(0.2, i).torque` equals the same slice's `solve(0.2, i).torque`
      to `1e-9` relative.
    - › `"N=2 zero-offset sums torque and flux"` — a 2-slice stack of identical
      zero-offset sections returns `torque` ≈ `2×` and `fluxLinkages[k]` ≈ `2×`
      the single-slice values (to `1e-9` relative).
    - › `"offset changes torque"` — the same 2-slice stack with
      `slices[1].offset = 0.4` returns a torque differing from the zero-offset
      case.
    - › `"perSliceField length equals nSlices"` — `stack.solve(0, i).perSliceField.length
      === stack.nSlices`.
    - › `"coenergyTorque returns finite parts"` — `stack.coenergyTorque(0.2, i)`
      has finite `reluctance`,`pm`,`mutual`,`total`.
  - `tests/pipeline/agnostic-pipeline.test.js` — `require("./_fixtures.js")`:
    - › `"all configs run the identical MotorRun path and the rotor turns"` —
      for each `cfg` in `[woundConfig(), pmConfig(), salientConfig(),
      skewN2Config()]`: `rt = LIB.MotorRun.create(UnifiedMotor.ConfigSchema.expand(cfg))`;
      run `rt.step(1/240)` for `600` steps; assert `Number.isFinite(rt.state.theta)`
      and `Math.abs(rt.state.theta) > 1e-3` (the rotor moved). The loop body is
      byte-identical across all four configs (the "identical code path" proof).
    - › `"N=2 config drives two slices"` — for `skewN2Config()`,
      `rt.stack.nSlices === 2`.
    - › `"live Maxwell agrees with co-energy within 10%"` — for each `cfg` whose
      mid-run torque magnitude exceeds a floor `1e-6`: after `300` steps,
      `arkkio = rt.lastSolve.torque`;
      `coe = rt.stack.coenergyTorque(rt.state.theta, rt.state.i).total`; assert
      `Math.abs(arkkio − coe) ≤ 0.10·Math.max(Math.abs(arkkio), Math.abs(coe))
      + 1e-6`.
    - › `"lib/ and mount.js are free of machine names"` — read every `*.js` file
      in `lib/` plus `lessons/unified_motor/mount.js`; for each file and each
      token in `MACHINE_NAMES`, assert no case-insensitive match. (Reads via
      `node:fs`; enumerated, not interactive.)
- **Files to modify**: none.
- **Acceptance criteria**:
  - `npm test` runs all `tests/pipeline/*.test.js` (alongside the engine /
    winding / excitation / circuit suites) and exits 0.
  - All four smoke configs reach `|θ| > 1e-3` within 600 steps from rest.
  - The Maxwell-vs-co-energy relative agreement holds at `≤ 0.10` for every
    config with non-trivial torque.
  - The machine-name grep over `lib/` + `mount.js` finds zero matches.
  - `tests/pipeline/_fixtures.js` is not collected as a test (no `.test.js`
    suffix) and is `require`-able by every pipeline test file.
  - `tests/_shim.js` is byte-unchanged from its Phase-1 state.
  - All tests pass.
