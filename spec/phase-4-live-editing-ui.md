# Phase 4: Live editing UI — picker + geometry/material/axial

## Overview

Wire the live editing controls for the unified-motor app: a **machine picker**
that loads any of the 15 `UnifiedMotor.MACHINES` fixtures into a fully editable
config, and a **geometry/material/slice/axial editor panel**. Both register
through the existing `mount.js` seams (`registerHeaderControl` /
`registerPanel`), mutate `ctx.config` **in place**, and call
`ctx.requestRebuild()`. **No `mount.js` edit** — Phase 1 owns that file; the two
files this phase fills were seeded as empty no-op stubs by Phase 1.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

### Binding constraint discovered in `mount.js` (current-state fact)

`mount.js` captures the config as a closure `const config` (`mount.js:188`) and
`requestRebuild()` re-expands **that same reference** (`mount.js:411-413`),
handing `ctx.config` to every panel as the identical object (`buildCtx()`,
`mount.js:417-424`). Therefore neither file may **reassign** `ctx.config` — a
reassignment would not reach the closure variable mount re-expands. Both files
**mutate the contents** of `ctx.config` in place (delete/replace own-enumerable
keys for the picker; field-level mutation for the editor) so the object mount
holds is the object that changes.

### Design decisions (current-state facts)

- **Picker copies the entire fixture config.** A fixture `config` is pure JSON
  data (numbers/strings/arrays/plain objects; no functions, no `NaN`/`Infinity`),
  so `JSON.parse(JSON.stringify(fixture.config))` is an exact deep copy. The
  picker copies **all** keys (including `grid`, and `gapBand`/`gapBandMode` where
  a fixture sets them), not a hand-listed subset — `grid` is required by
  `expand`/`validate` (`config-schema.js:402-416`) and a subset that drops it
  would expand the new rings against the previous machine's grid. `config.label`
  falls back to the `MACHINES` entry's `label` when the fixture's own config has
  no `label` (e.g. `machines/pmsm.js` config carries none).

- **Both files expose DOM-free pure helpers and are unit-tested through them.**
  At load time each file only calls `register*` (array pushes — no DOM); the DOM
  lives inside the `build(host, ctx)` callbacks that run at mount. The whole
  repo test suite is headless `node --test`. So the picker exposes
  `UM.MachinePicker = { loadMachine }` and the editor exposes
  `UM.GeometryPanel = { applyGapLength, setSlices, defaultAxial, commitEdit }`;
  tests drive those with a fake `ctx`. The DOM/visual behavior is covered by the
  Phase 6 user-required browser pass.

- **`applyGapLength` is topology-agnostic.** It partitions rings by `member`,
  compares the two groups' mean ring radii to decide which member group is
  radially inner, takes the inner group's outermost occupancy surface and the
  outer group's innermost occupancy surface (the same per-element segment rule
  `deriveGapBand` applies — `config-schema.js:73-92`), and moves both
  symmetrically about the fixed mid-gap. No "rotor is the inner ring"
  assumption; dispatch only on `member` + radius.

- **Every field edit is validity-guarded.** `commitEdit(config, mutateFn)`
  snapshots the config, applies `mutateFn`, runs `UM.ConfigSchema.validate`; on
  failure it restores the snapshot in place and returns `{ ok:false, errors }`.
  The panel calls `ctx.requestRebuild()` only when `ok`. This keeps the runtime
  config always valid even for edits that transiently break a constraint (e.g.
  lowering `Q` below `p·coilPitch`).

- **`stack.axial` appears only at `slices > 1`.** `setSlices(config, n)` resizes
  `stack.sliceOffsets` (pad new entries with `0`), and: for `n > 1` installs a
  default `stack.axial` if none is present (`defaultAxial()`); for `n === 1`
  deletes `stack.axial` so the expansion reduces bit-identically (`buildAxial`
  returns `null` ⇒ `expanded.axial === null` ⇒ `Ψ_s ≡ 0`).

## Files Owned

- `lessons/unified_motor/machine-picker.js` — replaced (stub → content; T4.1.1)
- `lessons/unified_motor/geometry-panel.js` — replaced (stub → content; T4.2.1)
- `tests/unified_motor/machine-picker.test.js` — created (T4.1.1)
- `tests/unified_motor/geometry-panel.test.js` — created (T4.2.1)

> The two `lessons/unified_motor/*.js` files were created as empty no-op stubs by
> Phase 1 (`spec/phase-1-engine-wiring-and-boot.md`), which solely owns
> `index.html` and the `<script>` tags. Phase 4 replaces the **contents**; it does
> not add or move any tag and does not edit `index.html` or `mount.js`. This is
> the plan-recorded stub-seeding ownership split.

## Wave 4.1: Machine picker

### Task 4.1.1: `machine-picker.js` — header control that loads a fixture into the editable config

- **Description**:
  Replace the `machine-picker.js` stub with an IIFE that (a) registers a header
  control listing every `UnifiedMotor.MACHINES` fixture and (b) exposes a DOM-free
  `UM.MachinePicker = { loadMachine }`. Selecting a fixture calls
  `loadMachine(ctx, id)`, which deep-copies that fixture's full config and
  replaces the contents of `ctx.config` in place, then calls
  `ctx.requestRebuild()`. Preset-loader semantics only — no machine id, label, or
  type is retained as behavioral state anywhere; the picker reads ids dynamically
  from `MACHINES` and hardcodes none.

  `loadMachine(ctx, id)` contract:
  1. Find `entry = UM.MACHINES.find(m => m.id === id)`; throw a descriptive
     `Error` if not found.
  2. `const copy = JSON.parse(JSON.stringify(entry.config))`.
  3. If `copy.label == null`, set `copy.label = entry.label`.
  4. Replace `ctx.config` contents in place: delete every own-enumerable key of
     `ctx.config`, then assign every own-enumerable key of `copy` onto it. The
     object reference of `ctx.config` is preserved.
  5. Call `ctx.requestRebuild()`.

  The header-control `build(host, ctx)` renders a `<select>` (one `<option>` per
  `MACHINES` entry, `value=id`, text=`label`) whose `change` handler calls
  `UM.MachinePicker.loadMachine(ctx, selectedId)`. It returns an `unmount`
  function that removes its listener/DOM.

- **Files to create**:
  - `tests/unified_motor/machine-picker.test.js` — headless `node --test`.
    Harness: `globalThis.window = globalThis`; guarded `require` of
    `lib/util.js`, `lib/winding-model.js`, `lessons/unified_motor/config-schema.js`;
    `require` all 15 files in `lessons/unified_motor/machines/` so they populate
    `window.UnifiedMotor.MACHINES`; define a capturing stub
    `window.UnifiedMotor.registerHeaderControl = e => { captured = e; }`;
    `require` `lessons/unified_motor/machine-picker.js`.

- **Files to modify**:
  - `lessons/unified_motor/machine-picker.js` — replace the Phase-1 stub comment
    with the IIFE above. Registers one header control via
    `UM.registerHeaderControl`; attaches `UM.MachinePicker = { loadMachine }`. No
    machine-name string literals; no `document` access outside the `build`
    callback.

- **Tests**:
  - `tests/unified_motor/machine-picker.test.js` → test
    `"registers exactly one header control with an id and a build function"` —
    asserts `captured` is an object, `typeof captured.id === "string"`, and
    `typeof captured.build === "function"`.
  - `tests/unified_motor/machine-picker.test.js` → test
    `"loadMachine replaces ctx.config contents in place and rebuilds"` —
    `let n = 0; const ctx = { config: { stale: 1, grid: {} }, requestRebuild() { n++; } };`
    `const ref = ctx.config;` `UM.MachinePicker.loadMachine(ctx, "pmsm");`
    asserts `ctx.config === ref` (same reference), `ctx.config.stale === undefined`
    (stale key removed), `ctx.config.poles === 8`, `ctx.config.rings.length === 2`,
    `ctx.config.grid.Nr === 50`, and `n === 1`.
  - `tests/unified_motor/machine-picker.test.js` → test
    `"the loaded config is a deep copy of the fixture"` —
    `const ctx = { config: {}, requestRebuild() {} };`
    `UM.MachinePicker.loadMachine(ctx, "pmsm"); ctx.config.rings[0].rRange[0] = 0.999;`
    finds the `pmsm` entry in `UM.MACHINES` and asserts
    `entry.config.rings[0].rRange[0] !== 0.999` (fixture untouched).
  - `tests/unified_motor/machine-picker.test.js` → test
    `"label falls back to the MACHINES entry label when the config has none"` —
    after `loadMachine(ctx, "pmsm")`, asserts
    `ctx.config.label === "PMSM 8p/48s (sinusoidal)"`.
  - `tests/unified_motor/machine-picker.test.js` → test
    `"every one of the 15 fixtures loads into a config that validates and expands"` —
    asserts `UM.MACHINES.length === 15`; for each `entry` of `UM.MACHINES`:
    `const ctx = { config: {}, requestRebuild() {} }; UM.MachinePicker.loadMachine(ctx, entry.id);`
    asserts `UM.ConfigSchema.validate(ctx.config).ok === true` and that
    `UM.ConfigSchema.expand(ctx.config)` does not throw.
  - `tests/unified_motor/machine-picker.test.js` → test
    `"an unknown machine id throws"` — asserts
    `loadMachine({ config:{}, requestRebuild(){} }, "no-such-machine")` throws.
  - `tests/unified_motor/machine-picker.test.js` → test
    `"is machine-agnostic (no hardcoded fixture ids)"` — reads
    `lessons/unified_motor/machine-picker.js` as UTF-8 and asserts it contains
    none of the 15 fixture id strings (`"pmsm"`, `"brushed-dc-pm"`,
    `"brushed-dc-wound"`, `"universal"`, `"bldc"`, `"induction-3ph"`,
    `"induction-1ph"`, `"vr-stepper"`, `"switched-reluctance"`, `"pm-stepper"`,
    `"hybrid-stepper"`, `"synchronous-reluctance"`, `"wound-field-synchronous"`,
    `"skew-demo"`, `"pole-mismatch-demo"`) as quoted literals.

- **Acceptance criteria**:
  - `lessons/unified_motor/machine-picker.js` registers exactly one header
    control and attaches `UM.MachinePicker.loadMachine`.
  - `loadMachine` preserves `ctx.config`'s object identity, fully replaces its
    contents with a deep copy of the named fixture, applies the label fallback,
    and calls `ctx.requestRebuild()` exactly once.
  - All 15 fixtures load into a config that passes `validate` and `expand`.
  - The source contains no hardcoded fixture-id string literals.
  - `node --test tests/unified_motor/machine-picker.test.js` passes; the full
    `node --test` suite is green (no new failures).

## Wave 4.2: Geometry + material + slice/axial editor

### Task 4.2.1: `geometry-panel.js` — per-ring geometry/material, gap length, slice + axial-flux editor

- **Description**:
  Replace the `geometry-panel.js` stub with an IIFE that registers a shelf panel
  (`UM.registerPanel({ id, zone:"shelf", build })`) and exposes the DOM-free pure
  helpers `UM.GeometryPanel = { applyGapLength, setSlices, defaultAxial,
  commitEdit }`. The panel mutates `ctx.config` in place through `commitEdit`
  and calls `ctx.requestRebuild()` after every accepted edit. The panel reads
  config structure generically (rings by `member`/`element`, winding via
  `ring.winding.standard`, slices via `ctx.config.stack`); no machine identity is
  read or stored.

  **Panel control surface** (rendered in `build`, all routed through
  `commitEdit` → `requestRebuild`):
  - **Per ring** — for each entry of `ctx.config.rings`:
    - *Geometry*: `rRange[0]` and `rRange[1]` (continuous radii sliders); integer
      `teeth` (rings with `element === "I"`), integer `magnets` (`element === "M"`),
      integer `winding.standard.Q` (`element ∈ {"W","C"}` with a
      `winding.standard`).
    - *Material*: `muR` (rings that carry `muR`); `Mr` (`element === "M"`);
      `Bknee` (rings that carry `Bknee`).
  - **Global**: one **gap-length `g`** slider driving `applyGapLength`.
  - **Slices**: a numeric readout of `stack.slices` with **"+ add slice"** and
    **"− remove slice"** buttons driving `setSlices(config, n)`. "+ add slice" is
    capped at **4 slices**; "− remove slice" floors at **1**.
  - **Axial-flux netlist** (visible only when `stack.slices > 1`): editable
    controls mapping 1:1 to `stack.axial` — per named branch the numeric fields
    `Br`, `length`, `area`, `muR` (or raw `reluctance` / `mmf`); per loop the
    signed slice incidence (`{s, sign}` with `sign ∈ {−1,+1}`), the selected
    branch names, and `Raxial` / `Fpm`. Edits write `config.stack.axial`.

  **`applyGapLength(config, g)` contract** (pure; mutates `config` in place,
  returns the achieved gap):
  1. `const { rInner, rOuter, Nr } = config.grid; const dr = (rOuter − rInner)/Nr;`
  2. Partition `config.rings` into `rotorRings` (`member === "rotor"`) and
     `statorRings` (`member === "stator"`). For each ring compute its occupancy
     segments using the same per-element rule as `deriveGapBand`
     (`config-schema.js:73-92`): `I` → `[rRange]`; `M` → `[rRange]` (+
     `backIronRRange` when `backIron`); `W`/`K` → `[slotRRange ?? rRange,
     ironRRange ?? rRange]`; `C` → `[slotRRange ?? rRange, ironRRange ?? rRange,
     rRange]`. A ring's lower extent `rLo` = min over its segments of `seg[0]`;
     upper extent `rHi` = max over its segments of `seg[1]`.
  3. Decide orientation by mean ring-midpoint radius: if
     `mean(rotor midpoints) ≤ mean(stator midpoints)` the **inner group** is the
     rotor and the **outer group** is the stator; otherwise inner = stator,
     outer = rotor.
  4. `rIn` = max over inner-group rings of `rHi`; `rOut` = min over outer-group
     rings of `rLo`. `mid = (rIn + rOut)/2`; original gap `g0 = rOut − rIn`.
     `innerOwner` = the inner-group ring whose `rHi` equals `rIn` (on a tie, the
     lower index in `config.rings`); `outerOwner` = the outer-group ring whose
     `rLo` equals `rOut` (same tie-break).
  5. Clamp the requested gap: `gMin = 2.5·dr`;
     `innerRoom = (rIn − innerOwner.rLo) − 0.2·(rIn − innerOwner.rLo)` (i.e. the
     inner gap-facing ring may shrink by at most 80% of its current radial
     thickness — keep ≥ 20%); `outerRoom = 0.8·(outerOwner.rHi − rOut)`;
     `gMax = g0 + 2·min(innerRoom, outerRoom)`; `g = clamp(g, gMin, gMax)`.
  6. Move both gap-facing surfaces symmetrically: set the inner owner's segment
     boundary that equals `rIn` to `mid − g/2`, and the outer owner's segment
     boundary that equals `rOut` to `mid + g/2`. The "segment boundary" is the
     concrete array slot in `rRange` / `slotRRange` / `ironRRange` /
     `backIronRRange` whose value equals `rIn` (resp. `rOut`); update every such
     slot on that owner so the ring stays self-consistent.
  7. Return the achieved gap `mid + g/2 − (mid − g/2) = g`.
  8. `config.grid.rInner` / `config.grid.rOuter` are **not** modified (domain
     bounds, not gap surfaces).

  **`setSlices(config, n)` contract** (pure; mutates in place):
  - `config.stack` is created if absent. `config.stack.slices = n`.
  - Resize `config.stack.sliceOffsets` to length `n`: truncate when shrinking;
    pad new entries with `0` when growing (preserve existing offsets).
  - If `n > 1` and `config.stack.axial == null`, set
    `config.stack.axial = defaultAxial()`.
  - If `n === 1`, `delete config.stack.axial`.

  **`defaultAxial()` contract** — returns a fresh object equal to:
  ```js
  { branches: { pm: { Br: 1.2, length: 0.00628 } },
    loops: [ { slices: [ { s: 0, sign: 1 }, { s: 1, sign: -1 } ],
               branches: ["pm"], Raxial: 0, Fpm: 0 } ] }
  ```
  (the hybrid L=1 two-cup prefill; extends the `machines/hybrid-stepper.js`
  netlist shape with an explicit `Fpm: 0` (which `buildAxial` defaults to 0
  when absent) and passes `validate` at `slices === 2`).

  **`commitEdit(config, mutateFn)` contract** (pure):
  1. `const snapshot = JSON.parse(JSON.stringify(config));`
  2. `mutateFn(config);`
  3. `const v = UM.ConfigSchema.validate(config);`
  4. If `v.ok` return `{ ok:true }`. Otherwise restore in place — delete every
     own-enumerable key of `config` and re-assign every key of `snapshot` — and
     return `{ ok:false, errors: v.errors }`. `config`'s object identity is
     preserved on both paths.

- **Files to create**:
  - `tests/unified_motor/geometry-panel.test.js` — headless `node --test`.
    Harness: `globalThis.window = globalThis`; guarded `require` of `lib/util.js`,
    `lib/winding-model.js`, `lessons/unified_motor/config-schema.js`; `require`
    `lessons/unified_motor/machines/pmsm.js` (for a real config to copy via
    `JSON.parse(JSON.stringify(...))`); define a no-op stub
    `window.UnifiedMotor.registerPanel = () => {};`; `require`
    `lessons/unified_motor/geometry-panel.js`.

- **Files to modify**:
  - `lessons/unified_motor/geometry-panel.js` — replace the Phase-1 stub comment
    with the IIFE above. Registers one shelf panel via `UM.registerPanel`;
    attaches `UM.GeometryPanel = { applyGapLength, setSlices, defaultAxial,
    commitEdit }`. No machine-name string literals; no `document` access outside
    the `build` callback.

- **Tests**:
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"applyGapLength sets a symmetric gap on an inrunner (pmsm)"` — deep-copy the
    `pmsm` config; record `mid0` as the midpoint of the original gap
    (rotor surface `0.042`, stator bore `0.044` → `mid0 = 0.043`, `g0 = 0.002`);
    call `applyGapLength(cfg, 0.003)`; assert the returned value is `0.003`
    (±1e-9), the new rotor-surface (`rings[0].rRange[1]`) is `mid0 − 0.0015`, the
    new stator-bore (`rings[1].rRange[0]` and `rings[1].slotRRange[0]`) is
    `mid0 + 0.0015` (each ±1e-9), and the midpoint is unchanged.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"applyGapLength keeps the config valid and expandable"` — on the deep-copied
    `pmsm` config after `applyGapLength(cfg, 0.003)`, assert
    `UM.ConfigSchema.validate(cfg).ok === true` and that
    `UM.ConfigSchema.expand(cfg)` does not throw and yields a `gapBand` with
    `iOuter − iInner >= 2`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"applyGapLength is topology-agnostic for an outrunner (stator inner, rotor outer)"`
    — build a synthetic config: `grid { Nr:20, Ntheta:64, rInner:0.02, rOuter:0.06,
    ell:0.05 }`, a stator `I` ring `rRange:[0.02,0.030]` and a rotor `I` ring
    `rRange:[0.034,0.060]` (stator radially inside rotor); call
    `applyGapLength(cfg, 0.006)`; assert the **stator** ring's `rRange[1]` and the
    **rotor** ring's `rRange[0]` moved symmetrically about `mid0 = 0.032` (stator
    upper → `0.029`, rotor lower → `0.035`) and the returned gap is `0.006`
    (±1e-9) — proving the inner group was detected as the stator, with no
    rotor-is-inner assumption. (No `expand` — the engine meshes inrunners only.)
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"applyGapLength clamps the gap to keep ≥ 2.5 grid cells"` — on a deep-copied
    `pmsm` config (`dr = (0.066−0.020)/50 = 9.2e-4`, `gMin = 2.3e-3`), call
    `applyGapLength(cfg, 0)` and assert the returned gap is `>= 2.5·dr − 1e-12`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"setSlices grows slices and pads sliceOffsets, installing a default axial"` —
    `const cfg = { stack: { slices: 1, sliceOffsets: [0] } }; setSlices(cfg, 2);`
    assert `cfg.stack.slices === 2`, `cfg.stack.sliceOffsets.length === 2`,
    `cfg.stack.sliceOffsets[1] === 0`, and `cfg.stack.axial` deep-equals
    `defaultAxial()`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"a slices>1 config with the default axial validates"` — deep-copy `pmsm`,
    `setSlices(cfg, 2)`, assert `UM.ConfigSchema.validate(cfg).ok === true` and
    `cfg.stack.axial.loops.length === 1`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"setSlices back to 1 drops stack.axial (bit-identical reduction)"` —
    starting from the `setSlices(cfg, 2)` config, `setSlices(cfg, 1)`; assert
    `cfg.stack.slices === 1`, `cfg.stack.sliceOffsets.length === 1`,
    `cfg.stack.axial === undefined`, and that
    `UM.ConfigSchema.expand(cfg).axial === null`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"commitEdit applies and keeps the config valid"` — deep-copy `pmsm`;
    `const r = commitEdit(cfg, c => { c.rings[0].muR = 500; });` assert
    `r.ok === true` and `cfg.rings[0].muR === 500`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"commitEdit reverts an invalid edit in place and reports errors"` —
    deep-copy `pmsm`; capture `before = JSON.stringify(cfg)` and `ref = cfg`;
    `const r = commitEdit(cfg, c => { c.rings[1].winding.standard.Q = 12; });`
    (`Q=12` violates `coilPitch (6) ≤ Q/p = 12/8`); assert `r.ok === false`,
    `Array.isArray(r.errors) && r.errors.length > 0`, `cfg === ref` (identity
    preserved), and `JSON.stringify(cfg) === before` (fully reverted).
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"editing Q within range does not change the resolved circuit count"` —
    deep-copy `pmsm` (3 circuits); `commitEdit(cfg, c => { c.rings[1].winding.standard.Q = 72; })`
    (Q=72 is valid: coilPitch 6 ≤ 72/8 = 9); assert the commit `ok === true` and
    `UM.ConfigSchema.expand(cfg).nCircuits === 3`.
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"registers exactly one shelf panel"` — asserts the panel entry captured at
    `require` time has `zone === "shelf"` and a `build` function. (Use a capturing
    `registerPanel` stub for this test file.)
  - `tests/unified_motor/geometry-panel.test.js` → test
    `"is machine-agnostic (no fixture-id literals)"` — reads
    `lessons/unified_motor/geometry-panel.js` as UTF-8 and asserts it contains
    none of the 15 fixture id strings (same list as the picker test) as quoted
    literals.

- **Acceptance criteria**:
  - `lessons/unified_motor/geometry-panel.js` registers exactly one shelf panel
    and attaches `UM.GeometryPanel` with `applyGapLength`, `setSlices`,
    `defaultAxial`, and `commitEdit`.
  - `applyGapLength` moves both gap-facing surfaces symmetrically about the fixed
    mid-gap, detects inner/outer group by mean radius (no rotor-is-inner
    assumption), clamps to keep ≥ 2.5 grid cells, leaves `grid.rInner`/`rOuter`
    unchanged, and keeps the config valid + expandable on a real inrunner.
  - `setSlices` grows/shrinks `stack.slices`, pads/truncates `sliceOffsets`,
    installs `defaultAxial()` at `slices > 1`, and drops `stack.axial` at
    `slices === 1` (yielding `expanded.axial === null`).
  - The default axial netlist validates at `slices === 2` and is editable to a
    general signed N-slice / L-loop netlist.
  - `commitEdit` preserves config identity, applies valid edits, and reverts
    invalid edits in place while returning the validation errors.
  - The source contains no hardcoded fixture-id string literals.
  - `node --test tests/unified_motor/geometry-panel.test.js` passes; the full
    `node --test` suite is green (no new failures).

## Notes / cross-phase dependencies

- **Depends on Phase 1.** Phase 1 created `machine-picker.js` and
  `geometry-panel.js` as empty no-op stubs and added their `<script>` tags to
  `index.html` (after `mount.js`, before the first machine fixture). Phase 4
  replaces only the file contents.
- **No `mount.js` edit.** Both files use only the existing seams
  (`registerHeaderControl`, `registerPanel`) and the `ctx` contract
  (`{ runtime, config, view, requestRebuild }`, `mount.js:417-424`). The picker's
  in-place config replacement and the editor's field mutation both rely on
  `requestRebuild()` re-expanding the same `config` reference (`mount.js:411-413`).
- **Parallel with Phase 3.** Phase 3 owns the render files
  (`cross-section-render.js`, `motor-mesh-view.js`); Phase 4 owns the UI files.
  No file overlap.
- **Axial schema authority.** `stack.axial` is parsed/validated by
  `config-schema.js` (`validate` `:625-648`; `buildAxial` `:888-911`); the editor
  emits exactly that shape and never re-implements the netlist semantics.
