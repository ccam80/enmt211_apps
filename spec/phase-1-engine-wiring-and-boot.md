# Phase 1: Engine wiring + boot

## Overview

Make the live unified-motor app run on the FEA engine in the browser. Today
`lessons/unified_motor/index.html` loads `motor-stack.js`/`motor-run.js` but **not**
the FEA libraries they depend on, and it never awaits `LIB.FeaSolver.init()`, so the
first `LIB.MotorRun.create(expanded)` inside `mount.js` would throw at mount (the
`MotorSlice` constructor requires a completed solver init). This phase adds the FEA
engine `<script>` tags (and the render/UI tags) to `index.html` in dependency order
and replaces the bare `LIB.App.runTabs(...)` call with a boot that awaits
`LIB.FeaSolver.init()` before mounting.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

`mount.js` requires **no edit in this phase**. Its wall-budgeted
`runtime.step(orderedStepDt, FRAME_BUDGET_MS)` loop (`mount.js:631–642`), playback
slider (`mount.js:391–397`), slow-mo badge (`mount.js:703–709`), and
`requestRebuild()` (`mount.js:411–415`) are already wired against the current engine
contract. The only `mount.js` code that referenced the removed contract — the
readout block's undefined `solved` variable (`mount.js:687,696–700`) — is re-sourced
from `runtime.lastSolve` by **Phase 0** (`spec/phase-0-stale-reference-dead-path-removal.md`,
T0.1.1 edit #1: `const solved = runtime.lastSolve;`). Phase 1 therefore owns only the
`index.html` wiring.

`index.html` is the **sole-owned** wiring file for the whole integration: it carries
the `<script>` tags for files that later phases deliver, so those phases never edit
it. Four of those files do not exist yet:

- `lessons/unified_motor/render3d.js` (content delivered by Phase 5),
- `lessons/unified_motor/machine-picker.js` (Phase 4),
- `lessons/unified_motor/geometry-panel.js` (Phase 4),
- `lib/gap-eval.js` (Phase 2 — `LIB.GapEval`; Phase 2's spec fixes this as a new
  standalone lib file).

A `<script src>` to a non-existent file is a 404/file-not-found console error in the
browser, not a no-op — which would violate the "boots with no console errors" check.
So Phase 1 also creates these four files as **empty no-op stubs** (comment-only, no
statements). The later phase replaces the stub *contents* (it owns the behavior; Phase
1 owns only the empty file + the tag). This mirrors the plan's Phase-0 file-locality
exemption and is recorded in `spec/plan.md`.

The headline behavior ("app boots with no console errors, rotor visibly turns") is
inherently browser-observable and is validated by the **Phase 6 user-required browser
pass**. The automated layer this phase ships is: an `index.html` structure test and a
**headless** engine boot+step test (the engine runs under `node --test`) that proves
the wired default machine steps and the rotor advances.

## Files Owned

- `lessons/unified_motor/index.html` — modified (T1.1.1: add FEA + render/UI script tags, await-init boot)
- `lessons/unified_motor/render3d.js` — created as empty no-op stub (T1.1.1); **content owned by Phase 5**
- `lessons/unified_motor/machine-picker.js` — created as empty no-op stub (T1.1.1); **content owned by Phase 4**
- `lessons/unified_motor/geometry-panel.js` — created as empty no-op stub (T1.1.1); **content owned by Phase 4**
- `lib/gap-eval.js` — created as empty no-op stub (T1.1.1); **content owned by Phase 2**
- `tests/unified_motor/index-wiring.test.js` — created (T1.1.1)
- `tests/unified_motor/app-boot.test.js` — created (T1.1.1)

> The four empty-stub files are a deliberate, plan-recorded exception to single-phase
> ownership, not silent overlaps. See `spec/plan.md` → "Phase 1 stub-seeding
> exception". `mount.js` is **not** owned by this phase — Phase 0 owns its sole edit.

## Wave 1.1: index.html script load + solver boot

### Task 1.1.1: Wire index.html — FEA + render/UI tags + await-init boot

- **Description**:
  Insert the FEA engine `<script>` tags so they load **before** the already-present
  `motor-stack.js`/`motor-run.js`, insert the render/UI tags **after** `mount.js`
  inside the marked module-extension region, create the four not-yet-existing files as
  empty no-op stubs, and replace the synchronous `runTabs` call with an
  `await LIB.FeaSolver.init()` boot. `index.html` is hereafter the sole owner of all
  unified-motor `<script>` tags.

- **Files to modify**:
  - `lessons/unified_motor/index.html`:
    - Insert these seven tags, in this order, immediately **before** the existing
      `<script src="../../lib/motor-stack.js"></script>` line (currently line 31,
      right after `./config-schema.js`). All paths are `../../lib/`:
      1. `fea-solver.js`
      2. `motor-mesh.js`
      3. `motor-mesh-view.js`
      4. `airgap-mortar.js`
      5. `gap-eval.js` (stub created by this task; content delivered by Phase 2)
      6. `bdf-integrator.js`
      7. `motor-slice.js`
    - Insert these four tags, in this order, in the marked region **after**
      `<script src="./mount.js"></script>` (line 33) and the
      `<!-- unified-motor modules: ... below this line ONLY -->` comment (line 34),
      and **before** the first machine fixture
      `<script src="./machines/pmsm.js"></script>` (line 35). All paths are `./`:
      1. `cross-section-render.js` (already exists)
      2. `render3d.js` (stub created by this task)
      3. `machine-picker.js` (stub created by this task)
      4. `geometry-panel.js` (stub created by this task)
    - Replace the final boot block (currently lines 51–56):
      ```html
      <script>
        LIB.App.runTabs({
          title: "Unified Motor",
          tabs: [{ label: "unified-motor", mount: window.UnifiedMotor.mount }],
        });
      </script>
      ```
      with a boot that gates the mount on solver init:
      ```html
      <script>
        LIB.FeaSolver.init().then(function () {
          LIB.App.runTabs({
            title: "Unified Motor",
            tabs: [{ label: "unified-motor", mount: window.UnifiedMotor.mount }],
          });
        }).catch(function (err) {
          console.error("FeaSolver.init() failed; unified-motor not mounted:", err);
        });
      </script>
      ```

- **Files to create**:
  - `lib/gap-eval.js` — empty no-op stub. Content is a single leading comment stating
    the file will define `LIB.GapEval` (the in-gap field reconstruction helper) and
    currently loads as a no-op placeholder so `index.html` can carry its `<script>` tag
    without a 404. No executable statements.
  - `lessons/unified_motor/render3d.js` — empty no-op stub. Comment states the file will
    define the unified-motor 3-D renderer (`UM.Render3D`, registered via
    `UM.registerRender3D`) and is currently an empty placeholder. No executable statements.
  - `lessons/unified_motor/machine-picker.js` — empty no-op stub. Comment states the file
    will define the machine-picker header control (`UM.MachinePicker`) and is currently an
    empty placeholder. No executable statements.
  - `lessons/unified_motor/geometry-panel.js` — empty no-op stub. Comment states the file
    will define the geometry/material/slice editor panel (`UM.GeometryPanel`) and is
    currently an empty placeholder. No executable statements.

- **Tests**:
  - `tests/unified_motor/index-wiring.test.js` — reads `lessons/unified_motor/index.html`
    as UTF-8 text and asserts (via `String.prototype.indexOf` ordering, no DOM):
    - `tests/unified_motor/index-wiring.test.js` → test `"FEA engine tags load before motor-stack.js"` —
      asserts each of `../../lib/fea-solver.js`, `../../lib/motor-mesh.js`,
      `../../lib/motor-mesh-view.js`, `../../lib/airgap-mortar.js`,
      `../../lib/gap-eval.js`, `../../lib/bdf-integrator.js`, `../../lib/motor-slice.js`
      is present and its tag's index is less than the index of `../../lib/motor-stack.js`.
    - `tests/unified_motor/index-wiring.test.js` → test `"render/UI tags load after mount.js and before the first machine fixture"` —
      asserts `./mount.js` index < index of each of `./cross-section-render.js`,
      `./render3d.js`, `./machine-picker.js`, `./geometry-panel.js`, and each of those
      < index of `./machines/pmsm.js`.
    - `tests/unified_motor/index-wiring.test.js` → test `"boot awaits FeaSolver.init before runTabs"` —
      asserts the source contains `LIB.FeaSolver.init(`, contains exactly one
      occurrence of `runTabs(`, and that `indexOf("LIB.FeaSolver.init(")` is less than
      `indexOf("runTabs(")`.
  - `tests/unified_motor/app-boot.test.js` — requires `../pipeline/_fixtures.js`
    (engine shim + `initSolver`, `woundConfig`, `feaOpts`, `CS`, `LIB`); proves the
    wired engine boots and steps, headless (no DOM):
    - `tests/unified_motor/app-boot.test.js` → test `"default machine boots and steps: lastSolve finite, rotor turns"` —
      `await initSolver()`; build `const cfg = woundConfig(); cfg.mechanical = { J: 0.1, damping: 0.05, loadTorque: 0 };`
      (the mount default-machine mechanical params); create
      `const runtime = LIB.MotorRun.create(CS.expand(cfg), feaOpts());`; seed a small
      initial rotor offset so the salient machine is off its zero-torque equilibrium:
      `runtime.state.theta = 0.05;`; call `runtime.step(1/240, 30)` 60 times; then
      assert: `runtime.lastSolve` is not `null`; `Number.isFinite(runtime.lastSolve.torque)`
      is true; every entry of `runtime.lastSolve.fluxLinkages` satisfies
      `Number.isFinite`; `runtime.state.theta` is finite and
      `Math.abs(runtime.state.theta - 0.05) > 0` (the rotor advanced relative to its
      seeded start).

- **Acceptance criteria**:
  - `index.html` contains all seven engine-block tags, each ordered before `motor-stack.js`.
  - `index.html` contains the four render/UI tags in the marked region, after `mount.js`
    and before `machines/pmsm.js`.
  - The boot block calls `LIB.FeaSolver.init()` and only calls `runTabs` inside the
    resolved `.then(...)`; there is no top-level synchronous `runTabs` call.
  - `lib/gap-eval.js`, `lessons/unified_motor/render3d.js`, `machine-picker.js`, and
    `geometry-panel.js` exist, contain no executable statements (comment-only), and load
    without error.
  - `tests/unified_motor/index-wiring.test.js` and `tests/unified_motor/app-boot.test.js`
    pass.
  - The full `node --test` suite is green (no new failures introduced).

## Notes / cross-phase dependencies

- **`mount.js` is owned by Phase 0.** Phase 0's T0.1.1 re-sources the readout block
  from `runtime.lastSolve` (`const solved = runtime.lastSolve;`), which is the only
  `mount.js` code that referenced the removed contract. Everything else in `mount.js`
  is already wired against the current engine contract, so Phase 1 makes no `mount.js`
  edit. Execution order is Phase 0 → Phase 1.
- **`lib/gap-eval.js` is owned by Phase 2.** Phase 2 (`spec/phase-2-in-gap-field-reconstruction-helper.md`)
  creates `LIB.GapEval` as a new standalone `lib/gap-eval.js`. Because `index.html` is
  sole-owned by Phase 1 and the render files (Phase 3/5) consume `LIB.GapEval`, Phase 1
  carries the `../../lib/gap-eval.js` tag now and seeds the file as an empty stub; Phase 2
  fills it. No `index.html` edit is needed in Phase 2.
