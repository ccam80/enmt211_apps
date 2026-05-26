# Phase 0: Dead Code Removal

## Overview

Delete the entire polar-grid field engine and every reference to it, so the
FEA rebuild (Phases 1–5) builds the replacement on a clean tree. This removes
seven `lib/` modules, the grid `drawGapField` render helper, the Live/Detailed
worker tier, and the grid-tier test suites; it re-seams the surviving test
fixtures off the grid so that tests of the *preserved* standalone modules
(`WindingModel`, `MotorCircuit`, `config-schema`) keep loading and passing.

Deleting `lib/motor-slice.js` removes the `LIB.MotorSlice` global entirely —
the integration seam that `motor-stack.js` / `motor-run.js` / `mount.js`
consume. Those upper layers are **preserved and deliberately left broken**
until Phase 5 recreates `MotorSlice` FEA-native. This is expected: the app and
the `MotorSlice`-dependent tests do not run between Phase 0 and Phase 5.

After this phase the repo contains **zero references to the deleted grid
modules in all runtime code** (`lib/*.js`, `index.html`, `mount.js`,
`cross-section-render.js`) and in the surviving (loadable) test files. The only
retained references live in the deliberately-red, deferred test trees that
later phases rewrite:

- `tests/pipeline/motor-stack.test.js` and `tests/pipeline/agnostic-pipeline.test.js`
  (consume `MotorSlice`/`MotorStack`/`MotorRun`/`MotorCompile`) — re-greened on
  the FEA slice in **Phase 5** (wave 5.3).
- `tests/machines/*` (route through `MotorStack`→`MotorSlice`; import the fit
  helpers from the deleted `tests/engine/_fixtures.js`) — re-pointed onto the
  FEA slice in **Phase 7** (wave 7.1). These load-crash on the deleted
  `engine/_fixtures.js`; Node's per-file test isolation means this does not
  block the survivors from running. Phase 7 repoints their fit-helper imports to
  `tests/_assert.js` (created here).

`field-render.js` is restored **byte-identical** to its `motor-baseline`
content by removing exactly the `drawGapField` addition (verified: the only
hunk diverging from baseline). No other frozen-EM file (`em-physics.js`,
`coil-render.js`, `layout3d.js`, …) is touched.

## Files Owned

### Created
- `tests/_assert.js` — new grid-free home for the generic test helpers
  `assertClose`, `fitCos2`, `fitCos2Cos4` (relocated verbatim from the deleted
  `tests/engine/_fixtures.js`).

### Modified
- `lib/field-render.js` — remove the `drawGapField` comment + function + its
  `drawGapField,` export entry (the sole `motor-baseline` divergence).
- `lessons/unified_motor/index.html` — remove the `<script>` tags for the five
  deleted grid libs and for `detailed-toggle.js`.
- `lessons/unified_motor/mount.js` — remove the built-in-rig gap-field overlay
  block (the lone `LIB.FieldRender.drawGapField` call site).
- `lessons/unified_motor/cross-section-render.js` — remove the
  `compileForOverlay` function (lone `LIB.MotorCompile` user) and its export
  entry.
- `tests/_shim.js` — drop `airgap-grid.js` / `airgap-solve.js` /
  `airgap-torque.js` from `LIB_FILES` (leaving `util.js`, `integrate.js`).
- `tests/winding/_fixtures.js` — drop the `motor-compile.js` require and the
  `compileSection` helper; import `assertClose` from `../_assert.js`.
- `tests/circuit/_fixtures.js` — drop the `airgap-grid.js` / `airgap-solve.js`
  requires and the `buildSalient` / `fitCos2` / `SALIENT_DEFAULTS` imports;
  import `assertClose` from `../_assert.js`.
- `tests/pipeline/_fixtures.js` — drop the `motor-compile.js` and
  `motor-slice.js` requires; import `assertClose` from `../_assert.js`.
- `tests/pipeline/config-schema.test.js` — remove the two `LIB.MotorCompile.compile`
  assertions; keep every pure config-schema assertion.

### Deleted (wholesale, scripted removal)
`lib/` grid engine (7):
- `lib/airgap-grid.js`
- `lib/airgap-solve.js`
- `lib/airgap-torque.js`
- `lib/airgap-refine.js`
- `lib/airgap-worker.js`
- `lib/motor-compile.js`
- `lib/motor-slice.js`

Runtime UI (1):
- `lessons/unified_motor/detailed-toggle.js`

Grid-tier tests (14):
- `tests/engine/_fixtures.js`
- `tests/engine/flux-balance.test.js`
- `tests/engine/solver.test.js`
- `tests/engine/analytic-salient.test.js`
- `tests/engine/convergence.test.js`
- `tests/detailed/_fixtures.js`
- `tests/detailed/detailed-toggle.test.js`
- `tests/detailed/airgap-worker.test.js`
- `tests/detailed/wiring.test.js`
- `tests/detailed/airgap-refine.test.js`
- `tests/detailed/cogging.test.js`
- `tests/winding/motor-compile.test.js`
- `tests/circuit/extract.test.js`
- `tests/pipeline/motor-slice.test.js`

> The read-and-edited footprint (10 files: 1 created + 9 modified) is within the
> per-group cap; wholesale deletions are scripted `rm`s and do not count toward
> it. One implementer owns the whole phase (see `spec/manifest.json`,
> group `0.1.a`).

## Wave 0.1: Delete the grid engine and re-seam its references

### Task 0.1.1: Delete grid-engine `lib/` modules and restore `field-render.js` to baseline
- **Description**: Remove the seven grid field-engine modules and strip the grid
  `drawGapField` helper from `field-render.js` so the latter is byte-identical
  to `motor-baseline`. The `LIB.MotorSlice` global disappears with
  `motor-slice.js` (it is purely the grid backend); the preserved
  `motor-stack`/`motor-run`/`mount` consume that now-absent contract and are
  deliberately broken until Phase 5.
- **Files to delete** (scripted `rm`, dry-run first):
  - `lib/airgap-grid.js`
  - `lib/airgap-solve.js`
  - `lib/airgap-torque.js`
  - `lib/airgap-refine.js`
  - `lib/airgap-worker.js`
  - `lib/motor-compile.js`
  - `lib/motor-slice.js`
- **Files to modify**:
  - `lib/field-render.js` — delete the contiguous block added on top of
    `motor-baseline`: the `drawGapField` doc-comment (begins
    `//  drawGapField — gap-field annulus heatmap + optional B-vector arrows.`),
    the `function drawGapField(ctx, L3, fieldData, geom, opts) { … }` body, and
    the `drawGapField,` line inside the `LIB.FieldRender = { … }` export object.
    Leave every other function and helper (`drawLoopFieldLines`,
    `drawMomentArrow`, `drawBarMagnet`, `drawVectorArrow`, `drawTorqueArrow`,
    `clamp01`) untouched. Preserve LF line endings.
- **Tests / verification gates**:
  - `git diff motor-baseline -- lib/field-render.js` produces **empty output**
    (exact byte-restore).
  - `git diff motor-baseline -- lib/em-physics.js lib/coil-render.js lib/layout3d.js`
    is empty (the rest of the frozen EM set is untouched by this task).
  - None of the seven deleted `lib/*.js` paths exist on disk.
  - Grep over `lib/` for `LIB.AirgapGrid|LIB.AirgapSolve|LIB.AirgapTorque|LIB.AirgapRefine|LIB.AirgapWorker|LIB.MotorCompile`
    and for `drawGapField` returns **zero hits** in any surviving `lib/*.js`.
- **Acceptance criteria**:
  - The seven grid lib files are gone.
  - `field-render.js` byte-matches `motor-baseline`.
  - No surviving `lib/*.js` references any deleted grid module or `drawGapField`.

### Task 0.1.2: Remove grid wiring from the runtime UI
- **Description**: Delete the Live/Detailed worker tier (`detailed-toggle.js` —
  built entirely on the deleted `airgap-worker` + `drawGapField`; its business
  logic does not survive, and Phase 6 builds a fresh mesh-native render rather
  than reworking it), and strip the two remaining grid references in preserved
  runtime files: the lone `drawGapField` call site in `mount.js` and the lone
  `MotorCompile` user in `cross-section-render.js`. The broader grid-shaped
  render in `mount.js`/`cross-section-render.js` is owned by Phase 6 and is left
  in place (preserved-broken) — this task removes only the deleted-module
  references.
- **Files to delete** (scripted `rm`):
  - `lessons/unified_motor/detailed-toggle.js`
- **Files to modify**:
  - `lessons/unified_motor/index.html` — remove these six `<script>` lines:
    - `<script src="../../lib/airgap-grid.js"></script>`
    - `<script src="../../lib/airgap-solve.js"></script>`
    - `<script src="../../lib/airgap-torque.js"></script>`
    - `<script src="../../lib/motor-compile.js"></script>`
    - `<script src="../../lib/motor-slice.js"></script>`
    - `<script src="./detailed-toggle.js"></script>`
  - `lessons/unified_motor/mount.js` — remove the gap-field overlay block in the
    built-in-rig `else` branch: the comment
    `// Draw gap-field heatmap overlay for each slice.` and the immediately
    following `if (solved) { for (…) { … LIB.FieldRender.drawGapField(ctx3, L3, sliceField, geom, { … }); } }`
    block that contains the sole `drawGapField` call. Leave the surrounding
    geometry-sector loop, stator-bore/rotor rings, and slot-conductor render
    untouched. (The now-unused `solved` / `smoothedMagScale` locals are left for
    Phase 6's render rewrite; they are not grid-module references.)
  - `lessons/unified_motor/cross-section-render.js` — remove the
    `compileForOverlay(config, sliceIndex)` function (doc-comment begins
    `//  compileForOverlay(config, sliceIndex = 0) → { compiled, grid }`) and its
    `compileForOverlay,` entry in the module's exports object. It is the only
    `LIB.MotorCompile` user; `drawSemantic` builds its geometry directly from
    `config` and is unaffected.
- **Tests / verification gates**:
  - `lessons/unified_motor/detailed-toggle.js` does not exist.
  - Grep over `index.html`, `mount.js`, `cross-section-render.js` for
    `airgap-|motor-compile|motor-slice|drawGapField|LIB.MotorCompile|detailed-toggle`
    returns **zero hits**.
  - `index.html` still loads `util/canvas-type/registry/plot/integrate/draw/layout3d/em-physics/field-render/coil-render/app/winding-model/excitation/motor-circuit/config-schema/motor-stack/motor-run/mount`
    and the 15 `machines/*.js` (the non-grid script tags are unchanged).
- **Acceptance criteria**:
  - `detailed-toggle.js` is deleted and de-referenced from `index.html`.
  - `mount.js` and `cross-section-render.js` contain no deleted-grid-module
    reference and no `drawGapField`/`MotorCompile` call.

### Task 0.1.3: Re-seam the test suite off the grid
- **Description**: Relocate the grid-free generic helpers to a new shared module,
  delete every grid-tier / grid-coupled test, and rewire the surviving fixtures
  so that the preserved-module test suites (`WindingModel`, `MotorCircuit`
  advance/back-EMF/cache, `config-schema`) load and pass without the grid. The
  `MotorSlice`/`MotorRun`-dependent pipeline tests (`motor-stack.test.js`,
  `agnostic-pipeline.test.js`) are **not** edited here — they stay red until
  Phase 5 re-greens them.
- **Files to create**:
  - `tests/_assert.js` — export `assertClose`, `fitCos2`, `fitCos2Cos4`, copied
    verbatim (bodies unchanged) from the deleted `tests/engine/_fixtures.js`.
    No `require` of any `lib/` module; no `window`/grid dependency.
- **Files to modify**:
  - `tests/_shim.js` — remove `"airgap-grid.js"`, `"airgap-solve.js"`,
    `"airgap-torque.js"` from the `LIB_FILES` array (leaving `"util.js"`,
    `"integrate.js"`). The fail-soft `MODULE_NOT_FOUND` guard stays.
  - `tests/winding/_fixtures.js` — remove `require("../../lib/motor-compile.js")`
    (line 14) and the `compileSection(...)` helper (used only by the deleted
    `motor-compile.test.js`); change
    `const { assertClose } = require("../engine/_fixtures.js");` to
    `require("../_assert.js")`; drop `compileSection` from `module.exports`.
  - `tests/circuit/_fixtures.js` — remove
    `require("../../lib/airgap-grid.js")` and
    `require("../../lib/airgap-solve.js")` (lines 16–17); replace
    `const { assertClose, buildSalient, fitCos2, SALIENT_DEFAULTS } = require("../engine/_fixtures.js");`
    with `const { assertClose } = require("../_assert.js");`; remove
    `buildSalient`, `fitCos2`, `SALIENT_DEFAULTS` from `module.exports` (keep
    `LIB`, `assertClose`, `rl1`, `mutual2`).
  - Surviving-circuit-test fitCos2 sweep: grep each of `tests/circuit/backemf.test.js`,
    `tests/circuit/cache.test.js`, `tests/circuit/induction.test.js`,
    `tests/circuit/stepper.test.js` for the identifier `fitCos2`. The expected
    result is **zero hits** (the only consumer was the deleted
    `extract.test.js`). On any hit, add
    `const { fitCos2 } = require("../_assert.js");` to that file's imports
    so the helper resolves from its new home (`tests/_assert.js` already
    re-exports it). Acceptance: every surviving circuit-test file loads
    under `node --test` with zero `MODULE_NOT_FOUND` / undefined-export
    errors.
  - `tests/pipeline/_fixtures.js` — remove
    `require("../../lib/motor-compile.js")` and
    `require("../../lib/motor-slice.js")` (lines 17, 27); change
    `const { assertClose } = require("../engine/_fixtures.js");` to
    `require("../_assert.js")`. Keep the `winding-model` / `excitation` /
    `motor-circuit` / `motor-stack` / `motor-run` / `config-schema` requires
    (those files survive).
  - `tests/pipeline/config-schema.test.js` — in the "expand produces Phase-2
    sections" test, remove the `assert.doesNotThrow(function () { LIB.MotorCompile.compile(section); }, …)`
    block; in the "no magnet => no magnet feature" test, remove the
    `const compiled = LIB.MotorCompile.compile(section);` line and the two
    `compiled.magnetization` loops/assertions that follow it. Keep the pure
    config-schema assertions (feature kinds/members/ranges, `nCircuits`,
    `N=1`/`N=2`, flux-source sign, validate, no-machine-name).
- **Files to delete** (scripted `rm`, dry-run first):
  - `tests/engine/_fixtures.js`, `tests/engine/flux-balance.test.js`,
    `tests/engine/solver.test.js`, `tests/engine/analytic-salient.test.js`,
    `tests/engine/convergence.test.js`
  - `tests/detailed/_fixtures.js`, `tests/detailed/detailed-toggle.test.js`,
    `tests/detailed/airgap-worker.test.js`, `tests/detailed/wiring.test.js`,
    `tests/detailed/airgap-refine.test.js`, `tests/detailed/cogging.test.js`
  - `tests/winding/motor-compile.test.js`
  - `tests/circuit/extract.test.js`
  - `tests/pipeline/motor-slice.test.js`
- **Tests / verification gates**:
  - `node --test tests/smoke.test.js tests/winding/ tests/circuit/ tests/pipeline/config-schema.test.js`
    runs with **zero failures**: `smoke`, `WindingModel surface/ampereConductors/validate/conductorFeatures/standardWinding`,
    `MotorCircuit` `stepper`/`induction`/`backemf`/`cache`, and the kept
    `config-schema` assertions all pass.
  - Grep over `tests/_shim.js`, `tests/_assert.js`, `tests/winding/_fixtures.js`,
    `tests/circuit/_fixtures.js`, `tests/pipeline/_fixtures.js`,
    `tests/pipeline/config-schema.test.js`, and every surviving
    `tests/circuit/*.test.js` / `tests/winding/*.test.js` for
    `airgap-|motor-compile|motor-slice|engine/_fixtures|buildSalient|AirgapSolve|MotorCompile`
    returns **zero hits**.
  - The 14 enumerated test files do not exist on disk.
  - `tests/_assert.js` exports `assertClose`, `fitCos2`, `fitCos2Cos4` (a `node -e`
    require returns three functions).
- **Acceptance criteria**:
  - Generic helpers live in `tests/_assert.js`; no surviving test imports from
    the deleted `tests/engine/_fixtures.js` except the Phase-7-deferred
    `tests/machines/*`.
  - The four surviving `circuit` tests, the surviving `winding-model` test, and
    the stripped `config-schema` test pass under `node --test`.
  - `tests/pipeline/motor-stack.test.js` and
    `tests/pipeline/agnostic-pipeline.test.js` are unchanged (left red until
    Phase 5).

## Phase-exit verification (whole-phase)

- `git diff motor-baseline` over the frozen EM set (`em-physics.js`,
  `field-render.js`, `coil-render.js`, `layout3d.js`) is **empty**
  (`field-render.js` restored exactly; the rest never touched).
- Repo-wide grep for `airgap-grid|airgap-solve|airgap-torque|airgap-refine|airgap-worker|motor-compile|motor-slice|drawGapField`
  and for `LIB.AirgapGrid|LIB.AirgapSolve|LIB.AirgapTorque|LIB.AirgapRefine|LIB.AirgapWorker|LIB.MotorCompile`
  returns hits **only** in: `spec/plan.md`, `spec/fea-engine-rebuild.md` (design
  docs), `tests/pipeline/motor-stack.test.js`,
  `tests/pipeline/agnostic-pipeline.test.js`, and `tests/machines/*` (the
  Phase-5/Phase-7-deferred red set). Zero hits anywhere else.
- `node --test` overall: the survivors enumerated above are green; the
  deferred `tests/machines/*` and `tests/pipeline/{motor-stack,agnostic-pipeline}.test.js`
  are red/erroring (expected — Phase 5/7 rebuild them).
