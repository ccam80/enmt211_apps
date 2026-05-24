# Phase 2: Winding model + compile

## Overview

The semantic→grid boundary. Two DOM-free `window.LIB` modules that turn the
editable description of a machine cross-section into the compiled arrays the
Phase-1 air-gap solver consumes (machine-agnosticism invariant #3 — the solver
sees only compiled arrays):

- **`lib/winding-model.js`** — pure **routing algebra**. Conductor routing →
  independent-current-path resolution → per-slot signed ampere-conductor map →
  the conductor-feature list `motor-compile` rasterizes. It emits **no
  field-shaped quantity** (no MMF curve, no `B`, no permeance, no air-gap) — only
  discrete turn data — so it can never become a back-door analytic field path.
  Its sole consumer is `motor-compile`.
- **`lib/motor-compile.js`** — rasterize a uniform **feature list** into the
  solver's grid arrays. Each feature is one of exactly three physical
  contribution kinds (`conductor` / `magnet` / `iron`); compile dispatches only
  on `feature.kind`, never on an element letter, a machine name, or a
  combination of rings.

Both modules are IIFEs (`(function(){ const LIB = window.LIB || (window.LIB =
{}); … })();`) attaching to `window.LIB`, matching the existing `lib/` style
(`lib/em-physics.js:88`). Neither touches `document`, `canvas`, or
`getComputedStyle` at load.

### Conventions fixed for this phase

- **Grid arrays** are row-major `Float64Array`s of length `Nr·Ntheta`, indexed
  `idx = i*Ntheta + j` (`i` radial 0..Nr−1 inner→outer, `j` angular 0..Ntheta−1,
  periodic) — identical to Phase 1.
- **Cell geometry**: `dr = (rOuter−rInner)/Nr`; `dtheta = 2π/Ntheta`;
  cell-centre radius `r[i] = rInner + (i+0.5)·dr`; cell-centre angle
  `theta[j] = (j+0.5)·dtheta`; cell area `dA[idx] = r[i]·dr·dtheta`.
- **`μ₀ = 4π × 1e-7`** declared once in `motor-compile.js`.
- **Reluctivity convention**: air `ν = 1/μ₀` (high); iron `ν = 1/(μ_r·μ₀)`
  (low). This matches the corrected Phase-1 spec.
- **Current-sign convention**: positive `turns` on a conductor feature means
  current in `+z` (out of the cross-section plane, the "dot" glyph); negative
  means into the page (the "cross" glyph). `slotGo` carries `+turns`, `slotReturn`
  carries `−turns`.
- **Circuit** = one independent current path (one eventual circuit-ODE DOF).
  Series-connected coils collapse into one circuit; each parallel branch is its
  own circuit. Phase / terminal / star-delta grouping is **not** resolved here —
  it is deferred to Phases 4 and 7. `circuitMeta` carries the human-facing
  `{ phaseId, branchIndex }` for those layers but no behavioral code in this
  phase reads it.
- **The coil mask is one array serving two roles**: the per-circuit
  `coilMask[k]` is simultaneously the `J_z` basis (`J_z = Σ_k i_k·coilMask[k]`)
  and the flux-linkage weight (`λ_k = Σ_idx A_z[idx]·coilMask[k][idx]·dA[idx]`,
  the Phase-1 `op.fluxLinkage` contract). Defined as turns-per-unit-area so that
  `Σ_idx coilMask[k]·dA = (signed turns of circuit k)`.
- **Test runner**: `node:test` + `node:assert/strict`; `npm test` → `node
  --test`. Phase 2 test files reuse `assertClose` by read-only `require` of the
  Phase-1 fixture `tests/engine/_fixtures.js`. They obtain the `window` global by
  `require`ing the Phase-1 `tests/_shim.js`, then `require` the Phase-2 lib files
  **directly** (`require("../../lib/winding-model.js")` etc.); the IIFEs attach
  to `window.LIB` on require. **`tests/_shim.js` is NOT modified by this phase**
  (it is Phase-1-owned; its `LIB_FILES` array is not extended here).

## Routing schema (input to `winding-model`)

A plain object, the editor's output (Phase 7) and the fixture/config author's
input (Phase 6), with no translation:

```
routing = {
  nSlots:    int,
  slotTheta: number[nSlots],          // angular centre of each slot (radians)
  phases: [
    { id,                             // human-facing label — not read by physics
      branches: [                     // >1 branch ⇒ parallel current paths
        { coils: [ { slotGo:int, slotReturn:int, turns:number }, … ] }
                                       // coils within a branch are in series
      ] }
  ]
}
```

A phase with one branch is a simple series phase (one circuit). A phase with `k`
branches is `k` parallel circuits, each summing its own series coils.

## Feature-list schema (input to `motor-compile`)

The uniform section descriptor. Phase 5's `config-schema.js` expands its
human-friendly config into exactly this shape; Phase 2 owns the shape, Phase 5
conforms to it.

```
section = {
  grid:    { Nr:int, Ntheta:int, rInner:number, rOuter:number, ell:number },
  gapBand: { iInner:int, iOuter:int },           // passed through to op.setGapBand
  features: [
    { kind:"conductor", member, rRange:[r0,r1], thetaRange:[t0,t1], circuit:int, turns:number },
    { kind:"magnet",    member, rRange, thetaRange, Mr:number, Mtheta:number },
    { kind:"iron",      member, rRange, thetaRange, muR:number },
  ],
}
```

- `member ∈ {"rotor","stator"}` — decides what the sliding band rotates.
- `rRange = [r0,r1]` radial extent (m); `thetaRange = [t0,t1]` angular extent
  (radians, may wrap past `2π`/through `0`).
- A cell `(i,j)` is **covered** by a feature when `r0 ≤ r[i] < r1` and
  `theta[j]` lies in `[t0,t1]` modulo `2π` (periodic wrap).
- `conductor.turns` is signed (per the current-sign convention).
- `magnet.Mr/Mtheta` is the magnetization vector directly (radial / tangential
  components, A/m). Alternating N/S is just signs the author/editor set per
  magnet — compile does no pole arithmetic.
- `iron.muR` relative permeability (dimensionless, > 1).
- Air is the default everywhere no feature covers (`ν = 1/μ₀`, zero
  magnetization). Absent kinds contribute zero arrays — never a skipped path.

## Files Owned

- `lib/winding-model.js` — created
- `lib/motor-compile.js` — created
- `tests/winding/_fixtures.js` — created
- `tests/winding/winding-model.test.js` — created
- `tests/winding/motor-compile.test.js` — created

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 2.1: Winding model

### Task 2.1.1: winding-model.js — routing algebra (no field outputs)

- **Description**: The pure routing-to-turns reduction. Resolves series/parallel
  routing into independent current paths, reduces routing to a per-slot signed
  ampere-conductor matrix, expands that into the conductor-feature list
  `motor-compile` consumes, validates routing continuity, and generates canonical
  windings for fixtures. It produces only discrete turn data; it has no concept
  of a field, MMF curve, permeance, or air gap.
- **Files to create**:
  - `lib/winding-model.js` — IIFE attaching `LIB.WindingModel`. **Exactly these
    four exported functions, no others** (the surface is pinned by a test):
    - `LIB.WindingModel.validate(routing) → { ok:boolean, errors:string[] }` —
      checks: `nSlots ≥ 1`; `slotTheta.length === nSlots`; every coil's `slotGo`
      and `slotReturn` are integers in `[0, nSlots)`; `slotGo !== slotReturn`
      (a coil spans two distinct slots — a half-defined / single-slot coil is
      invalid); `turns` is a finite number `!= 0`; at least one branch per phase,
      at least one coil per branch. Returns `ok:false` with one human-readable
      string per violation; never throws on a malformed routing.
    - `LIB.WindingModel.ampereConductors(routing) → { nCircuits, nSlots, turns,
      circuitMeta }` — resolves circuits (one circuit per branch, in phase-then-
      branch declaration order) and accumulates `turns` as a row-major
      `Float64Array(nCircuits·nSlots)` indexed `c*nSlots + s`: for each coil in
      circuit `c`, add `+coil.turns` at `slotGo` and `−coil.turns` at
      `slotReturn`. `circuitMeta` is an array length `nCircuits` of
      `{ phaseId, branchIndex }`. Assumes a valid routing (caller runs
      `validate` first).
    - `LIB.WindingModel.conductorFeatures(routing, slotGeom) → feature[]` where
      `slotGeom = { rRange:[r0,r1], member, angularWidth }` (uniform across slots;
      `angularWidth` in radians). For each circuit `c` and slot `s` whose
      accumulated signed turns `T = turns[c*nSlots+s]` is non-zero, emit one
      feature `{ kind:"conductor", member: slotGeom.member,
      rRange: slotGeom.rRange, thetaRange: [slotTheta[s] − angularWidth/2,
      slotTheta[s] + angularWidth/2], circuit: c, turns: T }`. Slots with zero
      net turns emit nothing.
    - `LIB.WindingModel.standardWinding({ m, p, Q, coilPitch, turns, member,
      rRange, slotTheta=null }) → routing` — generate a canonical double-layer
      lap winding. `q = Q/(m·p)` slots/pole/phase; slot angular pitch `2π/Q`;
      `slotTheta` defaults to uniform `s·2π/Q`. Coil `s` (one per slot, double
      layer) occupies `slotGo = s`, `slotReturn = (s + coilPitch) mod Q`, with
      `turns` turns. Phase + polarity assigned by the standard 60°-electrical
      phase belt using the following general rule for arbitrary phase count `m`:
      slot electrical angle `α(s) = (p/2)·s·(2π/Q)`; belt index
      `b = floor( α(s) / (π/m) ) mod (2m)`; polarity `= (b is even ? + : −)`
      (a `−` belt negates `turns`); phase index `= reorderedLabels[b mod m]`,
      where `reorderedLabels` is the standard double-layer 60°-phase-belt label
      sequence (see below). Each successive belt advances by exactly one label
      and the polarity alternates with `b`.
      Note: the standard 60°-belt sequence for m=3 assigns phase labels in the
      order A, C, B (not A, B, C), producing the canonical map
      `b: 0→A+, 1→C−, 2→B+, 3→A−, 4→C+, 5→B−`. To reproduce this with the
      general formula, the phase label for belt `b` is the `(b mod m)`-th
      element of the reordered sequence `[A, C, B]` (for m=3 the label order over
      a full period reads `[A, C, B, A, C, B]`, not `[A, B, C, A, B, C]`). For
      general `m` the reordered label sequence is the phase-index list
      `[0, m−1, 1, m−2, 2, …]` (alternating from the outside in, `m` entries),
      and `(b mod m)` indexes into it. The m=3 sequence `[A, C, B] = [0, 2, 1]`
      is the concrete instance of this rule. (Note: `b mod m` — NOT `floor(b/2)
      mod m`, which would group two consecutive belts under one phase and is the
      wrong layout.) Each phase is
      one branch (series). Requires `Q` divisible by `m·p` and
      `1 ≤ coilPitch ≤ Q/p`; otherwise throw a descriptive `Error`.
- **Files to modify**: none.
- **Tests** (authored in Task 2.3.1; listed for traceability):
  - `tests/winding/winding-model.test.js` covers all four functions and the
    no-field surface guard.
- **Acceptance criteria**:
  - `Object.keys(LIB.WindingModel)` is exactly
    `["validate","ampereConductors","conductorFeatures","standardWinding"]`
    (order-independent set equality) — no field/MMF/permeance function exists.
  - `ampereConductors` of a two-series-coil single-phase routing returns
    `nCircuits === 1` and a `turns` row whose per-slot values equal the
    hand-computed signed sums.
  - A two-branch (parallel) phase yields `nCircuits === 2`.
  - `validate` returns `ok:false` for a coil with `slotGo === slotReturn`.
  - Module loads under `require` with no DOM access.
  - All tests pass.

---

## Wave 2.2: Compile step (feature list → grid arrays)

### Task 2.2.1: motor-compile.js — rasterize feature list to solver arrays

- **Description**: Rasterize a `section` feature list onto the polar grid,
  producing exactly the arrays the Phase-1 `GridOperator` ingests. One
  unconditional pass over features, dispatching only on `feature.kind`. No
  element/machine/combination branch; absent kinds yield zero arrays
  (zero-not-skip).
- **Files to create**:
  - `lib/motor-compile.js` — IIFE attaching `LIB.MotorCompile`. API:
    - `LIB.MotorCompile.compile(section) → compiled` where `compiled` is:
      - `grid` — echo of `section.grid` plus derived `dr`, `dtheta`, `r`
        (`Float64Array(Nr)`), `dA` (`Float64Array(Nr·Ntheta)`).
      - `nu` — `Float64Array(Nr·Ntheta)`. Initialized to `1/μ₀` (air). For each
        `iron` feature, covered cells are set to `1/(muR·μ₀)`; where multiple
        iron features cover a cell, the **smallest** resulting `ν` (largest
        `muR`) wins (deterministic, order-independent).
      - `magnetization` — `{ Mr, Mtheta }`, two `Float64Array(Nr·Ntheta)`,
        zero-initialized. Each `magnet` feature **adds** its `Mr`/`Mtheta` into
        covered cells (additive superposition; overlaps sum).
      - `coilMasks` — `Float64Array[nCircuits]` (one per circuit), each length
        `Nr·Ntheta`, zero-initialized. For each `conductor` feature: compute the
        feature's slot area `Aslot = Σ_{covered} dA[idx]`; for each covered cell
        add `feature.turns / Aslot` to `coilMasks[feature.circuit][idx]`. (So
        `Σ_idx coilMasks[k]·dA` equals circuit `k`'s signed turns.) `nCircuits =
        1 + max(conductor feature.circuit)`, or `0` when there are no conductor
        features. `compile` throws a descriptive `Error` if the set of distinct
        `circuit` values among conductor features is not exactly the contiguous range
        `[0, max]` (e.g. indices `{0, 2}` with no `circuit:1` are rejected), so a gap
        can never silently allocate a phantom all-zero `coilMask`. (Phase 5
        `config-schema` guarantees contiguous global circuit indices by its cumulative
        base-offset assignment, so this throw is a safety net against malformed
        hand-authored feature lists.)
      - `rotorMask` — `Uint8Array(Nr·Ntheta)`, `1` where any `member==="rotor"`
        feature covers the cell.
      - `ironMask` — `Uint8Array(Nr·Ntheta)`, `1` where any `iron` feature covers
        the cell (the saturable set for the Phase-1 ceiling).
      - `gapBand` — echo of `section.gapBand`.
      - `nCircuits` — integer (as above).
      - `assembleJz(currents) → Float64Array(Nr·Ntheta)` — `currents` length
        `nCircuits`; returns `Σ_k currents[k]·coilMasks[k]`. Zero/empty currents
        and `nCircuits === 0` both yield an all-zero array.
    - Internal helper `coveredCells(section.grid, rRange, thetaRange) → int[]`
      (cell indices), handling periodic `thetaRange` wrap. Not exported. Algorithm:
      given `[t0, t1]`, normalize by adding the smallest non-negative multiple of `2π`
      that makes `t0 ≥ 0` (i.e. `t0 += Math.ceil(-t0 / (2π)) * 2π`, same offset
      applied to `t1`). If the normalized `t1 ≥ 2π` (wrap-around), a cell at angle
      `theta[j]` is covered when `theta[j] >= t0` OR `theta[j] < (t1 − 2π)`;
      otherwise covered when `t0 <= theta[j] <= t1`. (This correctly handles
      `conductorFeatures`' negative lower bound `t0 = slotTheta[0] − angularWidth/2 < 0`
      for slot 0.)
  - Constant `MU0 = 4 * Math.PI * 1e-7` at module top.
- **Files to modify**: none.
- **Tests** (authored in Task 2.3.1):
  - `tests/winding/motor-compile.test.js` covers shapes, the three contribution
    kinds, `assembleJz`, and zero-not-skip.
- **Acceptance criteria**:
  - `compile` dispatches only on `feature.kind`; the module source contains no
    string literal matching any of the 13 machine names and no `element`/`W`/`C`/
    `M`/`I`/`K` letter dispatch (verified by the Phase-10 audit; asserted at the
    feature level by the kind-only contract here).
  - All output arrays have length `Nr·Ntheta` (vectors) / `Nr` (`r`);
    `coilMasks.length === nCircuits`.
  - A section with no `magnet` features yields `Mr`/`Mtheta` all zero; a section
    with no `iron` features yields `nu` uniformly `1/μ₀`.
  - `Σ_idx coilMasks[k][idx]·dA[idx]` equals circuit `k`'s signed turns for a
    single-conductor circuit (to `1e-9` relative).
  - `assembleJz(zeros)` is all-zero; `assembleJz(c)` equals `Σ_k c[k]·coilMasks[k]`
    entrywise.
  - Module loads under `require` with no DOM access.
  - All tests pass.

---

## Wave 2.3: Tests

### Task 2.3.1: Winding-model + compile tests and fixtures

- **Description**: The Phase-2 validation suite plus its shared fixtures.
  Validates routing reduction, the `standardWinding` phase-belt layout (with a
  test-only winding-factor cross-check), continuity validation, the no-field
  surface guard, and compile array shapes / zero-not-skip. All tests run headless
  through the Phase-1 shim's `window` global; lib modules are `require`d directly
  (no `tests/_shim.js` edit).
- **Files to create**:
  - `tests/winding/_fixtures.js` — not a test file (no `.test.js`). On load:
    `require("../_shim.js")` (installs the `window` global + base libs), then
    `require("../../lib/winding-model.js")` and `require("../../lib/motor-compile.js")`.
    Re-exports `assertClose` from `require("../engine/_fixtures.js")`. Exports:
    - `seriesPhaseRouting()` → a `nSlots = 6` routing with one phase, one branch,
      two series coils `{slotGo:0,slotReturn:3,turns:10}` and
      `{slotGo:1,slotReturn:4,turns:10}`, `slotTheta[s] = s · 2π / nSlots`
      (slot 0 at angle 0).
    - `parallelPhaseRouting()` → the same two coils split into **two branches**
      of one coil each (parallel) under one phase; `slotTheta[s] = s · 2π / nSlots`
      (slot 0 at angle 0).
    - `compileSection({ withMagnet=true, withIron=true })` → a small `section`:
      `grid = { Nr:4, Ntheta:12, rInner:0.04, rOuter:0.05, ell:0.1 }`,
      `gapBand = { iInner:1, iOuter:2 }`; one `conductor` feature
      (`circuit:0, turns:5, member:"stator", rRange:[0.045,0.05],
      thetaRange:[0, π/6]`); when `withMagnet`, one `magnet` feature on the rotor
      (`rRange:[0.04,0.043], thetaRange:[0,π], Mr:1e5, Mtheta:0`); when
      `withIron`, one `iron` feature (`rRange:[0.04,0.043],
      thetaRange:[π,2π], muR:1000, member:"rotor"`).
  - `tests/winding/winding-model.test.js` — `require`s `_fixtures.js`. Tests:
    - › `"surface exposes only routing functions"` — assert the `Set` of
      `Object.keys(LIB.WindingModel)` equals
      `{"validate","ampereConductors","conductorFeatures","standardWinding"}`.
    - › `"series coils sum into one circuit"` — `ampereConductors(seriesPhaseRouting())`
      returns `nCircuits === 1`; `turns[0]=+10, turns[1]=+10, turns[3]=−10,
      turns[4]=−10, turns[2]=turns[5]=0`; also assert `circuitMeta` is an array of
      length 1 with entry `{ phaseId: <string>, branchIndex: 0 }` (any non-empty
      string `phaseId`; `branchIndex` is exactly `0`).
    - › `"parallel branches split into separate circuits"` —
      `ampereConductors(parallelPhaseRouting()).nCircuits === 2`; also assert
      `circuitMeta.length === 2`, `circuitMeta[0].branchIndex === 0`,
      `circuitMeta[1].branchIndex === 1`, and both entries share the same `phaseId`
      string.
    - › `"validate rejects a single-slot coil"` — a routing with a coil
      `slotGo === slotReturn` gives `ok:false` and a non-empty `errors`.
    - › `"validate rejects out-of-range slot"` — `slotReturn = nSlots` gives
      `ok:false`.
    - › `"validate rejects nSlots < 1"` — a routing with `nSlots:0` gives
      `ok:false` with a non-empty `errors`.
    - › `"validate rejects mismatched slotTheta length"` — a routing where
      `slotTheta.length !== nSlots` gives `ok:false` with a non-empty `errors`.
    - › `"validate rejects zero turns"` — a routing with a coil whose `turns:0`
      gives `ok:false` with a non-empty `errors`.
    - › `"validate rejects an empty branch"` — a routing with a branch whose
      `coils` array is empty gives `ok:false` with a non-empty `errors`.
    - › `"conductorFeatures emits one feature per non-zero slot"` —
      `conductorFeatures(seriesPhaseRouting(), { rRange:[0.045,0.05],
      member:"stator", angularWidth: (2π/6) })` returns 4 features, all
      `kind === "conductor"`, with the expected signed `turns` and `circuit:0`.
    - › `"standardWinding 3/4/24 full pitch — phase A belt"` — build
      `standardWinding({ m:3, p:4, Q:24, coilPitch:6, turns:1, member:"stator",
      rRange:[0.045,0.05] })`; reduce via `ampereConductors`; assert phase A's
      circuit places `+turns` go-side conductors in the slot set
      `{0,1,12,13}` and `−turns` (the `A−` belt) in `{6,7,18,19}` (the textbook
      60°-belt layout for `q=2`). (Exact go-slot membership; return slots follow
      `+6`.)
    - › `"standardWinding short pitch shifts return slots by the chord"` —
      `coilPitch:5` puts coil `s`'s return at `(s+5) mod 24` (asserted for a
      sample of slots) vs `+6` at full pitch.
    - › `"winding factor matches analytic (test-only)"` — from the phase-A
      per-slot ampere-conductor distribution of the full-pitch `3/4/24` winding,
      compute the fundamental (pole-pair order `p/2 = 2`) DFT amplitude
      normalized by total conductors; assert it is within `0.01` of the analytic
      `k_w = k_p·k_d = 1 · 0.966 = 0.966`. (DFT is computed inline in the test;
      no winding-model function exposes it.)
    - › `"standardWinding throws on non-divisible Q"` — calling
      `standardWinding({ m:3, p:4, Q:23, coilPitch:6, turns:1,
      member:"stator", rRange:[0.045,0.05] })` throws an `Error` (Q:23 is not
      divisible by m·p = 12).
    - › `"standardWinding throws on out-of-range coilPitch"` — calling
      `standardWinding({ m:3, p:4, Q:24, coilPitch:7, turns:1,
      member:"stator", rRange:[0.045,0.05] })` throws an `Error` (coilPitch:7
      exceeds Q/p = 6).
    - › `"standardWinding generalizes to m≠3"` — build a non-3-phase winding,
      e.g. `standardWinding({ m:2, p:2, Q:8, coilPitch:2, turns:1,
      member:"stator", rRange:[0.045,0.05] })`; reduce via `ampereConductors`
      and assert `nCircuits === m === 2` (one series branch per phase). For each
      slot `s ∈ {0, 2, 4, 6}`, compute the expected phase index and polarity from
      the general belt formula — `α(s) = (p/2)·s·(2π/Q)`,
      `b = floor(α(s)/(π/m)) mod (2m)`, phase index `= reorderedLabels[b mod m]`
      with `reorderedLabels = [0, m−1, 1, m−2, …]` (for m=2 this is `[0, 1]`),
      polarity `= (b even ? + : −)` — and assert the `turns` row in the returned
      `ampereConductors` result matches that signed assignment at slot `s` (go-side:
      `turns[phaseIndex*nSlots + s]` has the predicted sign; return-side at
      `(s+coilPitch) mod Q` has the opposite sign). The four chosen slots cover both
      polarities and both phases: for `m:2, p:2, Q:8`, slots 0 and 4 fall in even
      belts (positive) and slots 2 and 6 fall in odd belts (negative), spanning all
      four belt regions — confirming the layout follows the arbitrary-`m` rule, not
      a hard-coded m=3 path.
  - `tests/winding/motor-compile.test.js` — `require`s `_fixtures.js`. Tests:
    - › `"output array shapes"` — `compile(compileSection({}))`: `nu.length`,
      `magnetization.Mr.length`, `magnetization.Mtheta.length`, `rotorMask.length`,
      `ironMask.length`, every `coilMasks[k].length`, `grid.dA.length` all
      `=== 4*12`; `grid.r.length === 4`; `coilMasks.length === nCircuits === 1`.
    - › `"no magnet ⇒ zero magnetization"` —
      `compile(compileSection({ withMagnet:false }))` has `Mr` and `Mtheta`
      entrywise zero.
    - › `"no iron ⇒ all-air ν"` —
      `compile(compileSection({ withIron:false }))` has every `nu` entry equal to
      `1/(4π×1e-7)` within `1e-3` relative.
    - › `"iron lowers ν"` — with iron present, every iron-covered cell has
      `nu === 1/(1000·4π×1e-7)` within `1e-9` relative, and air cells keep
      `1/μ₀`.
    - › `"coil mask integrates to signed turns"` — `Σ_idx coilMasks[0][idx]·
      grid.dA[idx]` equals `5` (the conductor feature's turns) within `1e-9`
      relative.
    - › `"assembleJz is the current-weighted mask sum"` —
      `assembleJz([0])` is all-zero; `assembleJz([3])` equals `coilMasks[0]`
      scaled by `3` entrywise within `1e-12`.
    - › `"rotorMask marks rotor features only"` — cells covered by the rotor
      magnet/iron features are `1`; the stator conductor's cells are `0`.
    - › `"coveredCells handles negative-lower-bound wrap (slot 0)"` — add a variant
      `compileSection` call whose conductor feature has
      `thetaRange: [-Math.PI/12, Math.PI/12]` (i.e. `t0 < 0`, wrapping through 0).
      Assert that `coilMasks[0]` is non-zero for at least one cell near `theta ≈ 0`
      (centre of the positive arc) AND for at least one cell near
      `theta ≈ 2π − π/12` (the wrapped tail just below `2π`). This exercises the
      normalize-wrap algorithm specified in `coveredCells` and confirms the fix for
      the negative lower-bound edge case that slot 0 always produces.
  - **Reuse**: `assertClose` is imported from `tests/engine/_fixtures.js` via
    `_fixtures.js` (read-only `require`; that file is Phase-1-owned and not
    modified).
- **Files to modify**: none.
- **Acceptance criteria**:
  - `npm test` runs the two new `tests/winding/*.test.js` files (alongside the
    existing suite) and exits 0.
  - Every assertion above holds at the stated tolerances.
  - `tests/winding/_fixtures.js` is not collected as a test (no `.test.js`
    suffix) and is `require`-able by both test files.
  - `tests/_shim.js` is byte-unchanged from its Phase-1 state.
  - All tests pass.
