# Phase 9: Saturation (nonlinear) + 3D render polish

## Overview

The final fidelity-and-presentation layer on the agnostic pipeline. Two
independent waves:

1. **Wave 9.1 — Nonlinear saturation.** `lib/airgap-nonlinear.js`: a third
   field-solve tier as a Phase-5 `SolveBackend`, sibling to Phase 8's
   `lib/airgap-refine.js`. Where the Live tier carries a **global scalar**
   flux-dependent ceiling (Phase 1) and the refined tier wraps that same global
   ceiling around a finer grid (Phase 8), the nonlinear tier iterates a
   **per-cell** `ν(B)` (Picard with under-relaxation, tabulated B–H) over the
   teeth-in-domain iron cells. That local saturation is what resolves the SRM
   **aligned-vs-unaligned differential** and tooth-tip rolloff — exactly the
   Phase-6 **class-C carve-out** that deferred those magnitudes to this phase.
   It runs in the Phase-8 Detailed worker via the tier selector added to
   `airgap-worker.js` (Phase 8, amended), and is validated headlessly through the
   same `MotorStack`/`MotorSlice` path the worker uses.

2. **Wave 9.2 — 3D render polish.** `lessons/unified_motor/render3d.js`: the
   polished 3D rig — axial extrusion of the cross-section geometry, end-winding
   arcs joining go/return slots over the stack ends, per-slice gap-field paint,
   and a field-viz mode control. It plugs into the main viewport through the
   **render seam** added to `mount.js` (Phase 5, amended): when a renderer is
   registered the mount delegates the whole 3D-rig draw to it; otherwise the
   built-in inline draw runs. It consumes the Phase-5 `field-render.drawGapField`
   extension **unchanged**.

### Relationship to the consumed phases (amended seams)

Phase 9 is purely **additive in its own Files Owned**. The three runtime seams it
needs are added to the earlier phases' own specs (those phases are unbuilt, so
this is a spec edit, not a migration):

- **Phase 1 (`lib/airgap-grid.js`)** gains two additive, rotor-safe `op`
  primitives — `op.getReluctivity()` and `op.setIronReluctivity(nuValues,
  ironMask)` — so the nonlinear tier can snapshot the rotor-positioned material,
  apply per-cell `ν(B)`, and restore it. No existing `op` method changes.
- **Phase 5 (`lessons/unified_motor/mount.js`)** gains a render-layer seam
  `UnifiedMotor.registerRender3D(entry)` / `UnifiedMotor.RENDER3D`; the mount
  delegates the 3D-rig + gap-field draw to it when present.
- **Phase 8 (`lib/airgap-worker.js`, `lessons/unified_motor/detailed-toggle.js`)**
  gains a backend **tier selector** (`backendOpts.tier ∈ {"refined","nonlinear"}`,
  default `"refined"`), a **guarded** `importScripts("airgap-nonlinear.js")`, and a
  "Saturation (nonlinear)" checkbox in the Detailed panel.

`lib/airgap-nonlinear.js` therefore depends on **Phase 8's `LIB.AirgapRefine`**
(it reuses `refineSection` / `filletCorners` / `buildHierarchy` / `vcycleSolve`),
on **Phase 1's `LIB.AirgapGrid` / `LIB.AirgapSolve`**, and on **Phase 2's
`LIB.MotorCompile`**.

### Conventions fixed for this phase

- **App vs lib split.** `lib/airgap-nonlinear.js` attaches to `window.LIB`
  (`LIB.AirgapNonlinear`) as a DOM-free IIFE importing only other `lib/` modules.
  The app-layer `lessons/unified_motor/render3d.js` attaches to
  `window.UnifiedMotor` (`UnifiedMotor.Render3D`) using the lazy idiom
  `const UM = window.UnifiedMotor || (window.UnifiedMotor = {});` and is DOM-free
  **at module load** (it only defines functions and guard-registers the seams;
  `paint` touches the canvas only when called at runtime, exactly like
  `detailed-toggle.js`).
- **`MU0 = 4π × 1e-7`** declared once at the top of `airgap-nonlinear.js`. Air
  reluctivity `airNu = 1/MU0`.
- **Grid-array conventions** inherited unchanged from Phases 1–2: row-major
  `Float64Array`, `idx = i*Ntheta + j`.
- **Backend tier selection** (Phase-8 convention, consumed here):
  `backendOpts.tier === "nonlinear"` selects `LIB.AirgapNonlinear.backend(opts)`;
  anything else selects the refined backend. The nonlinear backend reads the same
  `factor`/`fillet`/`mg` fields the refined backend does, plus its own
  `curve`/`relax`/`maxOuter`/`tol`.
- **Render seam contract** (Phase-5 convention, consumed here): a registered
  renderer is `{ id:string, paint(ctx, L3, rctx) → void }` where `rctx =
  { runtime, config, expanded, W, H }`. The renderer fully owns the 3D-viewport
  draw for that frame.
- **Machine-agnosticism** (load-bearing, invariant #1/#2/#5): neither
  `airgap-nonlinear.js` nor `render3d.js` reads an element letter, a machine name,
  or a machine-type field. The nonlinear loop saturates whatever cells the
  agnostic `ironMask` marks (a config with no iron → no iron cells → the loop is a
  one-pass identity to the refined linear solve — zero-not-skip). `render3d.js`
  builds geometry from `expanded.slices` / `config.rings` data only. Each module's
  source is grepped for the `MACHINE_NAMES` token list (zero matches required).
- **Test runner**: `node:test` + `node:assert/strict`; `npm test` → `node --test`.
  - `tests/saturation/_fixtures.js` `require`s `../detailed/_fixtures.js` (Phase 8)
    and `../machines/_fixtures.js` (Phase 6) **read-only**, then `require`s
    `../../lib/airgap-nonlinear.js` directly.
  - `tests/render/_fixtures.js` `require`s `../pipeline/_fixtures.js` (Phase 5)
    **read-only**, then `require`s `../../lessons/unified_motor/render3d.js`
    directly.
  - **No earlier test loader is modified.** `tests/_shim.js`,
    `tests/pipeline/_fixtures.js`, `tests/detailed/_fixtures.js`, and
    `tests/machines/_fixtures.js` are byte-unchanged by this phase.

## Files Owned

- `lib/airgap-nonlinear.js` — created
- `lessons/unified_motor/render3d.js` — created
- `lessons/unified_motor/index.html` — modified (append **one** `<script>` tag
  inside the marked module-extension region only; no other line changes)
- `tests/saturation/_fixtures.js` — created
- `tests/saturation/airgap-nonlinear.test.js` — created
- `tests/saturation/srm-differential.test.js` — created
- `tests/saturation/live-ceiling.test.js` — created
- `tests/render/_fixtures.js` — created
- `tests/render/render3d.test.js` — created
- `tests/render/wiring.test.js` — created

> **`lessons/unified_motor/index.html`** is created by Phase 5 with the
> comment-marked module-extension region (the sanctioned shared append-point).
> Phase 9 appends inside that region only (Task 9.2.2) — the single page script is
> `./render3d.js`. `airgap-nonlinear.js` is **not** a page script: it loads inside
> the worker via the Phase-8 guarded `importScripts`.

> **Files owned by other phases that Phase 9 consumes but does NOT modify:**
> `lib/airgap-grid.js` (Phase 1 — gains the per-cell `ν` primitives in *its own*
> spec), `lessons/unified_motor/mount.js` (Phase 5 — gains the render seam in its
> own spec), `lib/airgap-worker.js` + `lessons/unified_motor/detailed-toggle.js`
> (Phase 8 — gain the tier selector + checkbox in their own spec),
> `lib/field-render.js` (Phase 5 — `drawGapField` consumed unchanged).

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 9.1: Nonlinear saturation

### Task 9.1.1: airgap-nonlinear.js — per-cell ν(B) SolveBackend

- **Description**: The nonlinear field-solve tier as a Phase-5 `SolveBackend`. It
  reuses the Phase-8 refined grid + corner regularization + multigrid, replacing
  the global scalar ceiling with a per-cell `ν(B)` Picard iteration over the iron
  cells. Reads only compiled arrays + the Phase-1 `GridOperator` contract (now
  including `getReluctivity`/`setIronReluctivity`) — no winding/element/machine
  knowledge.
- **Files to create**:
  - `lib/airgap-nonlinear.js` — IIFE attaching `LIB.AirgapNonlinear`. `MU0 =
    4π×1e-7` at module top. Load-time guard: `if (!LIB.AirgapRefine) throw new
    Error("LIB.AirgapNonlinear requires lib/airgap-refine.js");` (and likewise for
    `LIB.AirgapGrid`, `LIB.AirgapSolve`, `LIB.MotorCompile`). API:
    - `LIB.AirgapNonlinear.reluctivityCurve({ Bknee = 1.6, muRUnsat = 1000,
      sharpness = 8, Bmax = 5, nTab = 256 } = {}) → curve` — pure. Builds a
      tabulated single-valued reluctivity-vs-flux-density curve for iron from the
      closed form `muR(B) = 1 + (muRUnsat − 1) / (1 + (B/Bknee)^sharpness)`,
      `nu(B) = 1/(MU0·muR(B))`, sampled at `nTab` uniform points on `B ∈ [0,
      Bmax]`. Returns `{ nuOf(Bmag) → number, Bknee, muRUnsat, table:{ B, nu } }`
      where `nuOf` linearly interpolates the table and **clamps** below `0` to
      `table.nu[0]` and above `Bmax` to `table.nu[nTab−1]`. Monotone non-decreasing
      in `B`; `nuOf(0) = 1/(MU0·muRUnsat)`; `nuOf` → `airNu = 1/MU0` as `B`
      grows (iron de-permeabilises toward air under saturation).
    - `LIB.AirgapNonlinear.solveNonlinear(op, b, { x0 = null, tol = 1e-4,
      linTol = 1e-7, maxOuter = 25, relax = 0.5, ironMask, curve, hierarchy = null
      }) → { x, outer, iters, residual, converged, satScale }` — the outer Picard
      loop with under-relaxation. `airNu = 1/MU0`. Inner linear solve helper: when
      `hierarchy` is supplied, `LIB.AirgapRefine.vcycleSolve(op, b, { x0, tol:
      linTol, hierarchy })`; otherwise `LIB.AirgapSolve.pcg(op, b, { x0, tol:
      linTol })`. Steps:
      1. `nu0 = op.getReluctivity()` (snapshot of the **rotor-positioned**
         material — `motor-slice` has already called `op.setRotorAngle` before this
         runs); `work = nu0.slice()`.
      2. `r = innerSolve(x0)`; `x = r.x`; `iters = r.iters`; `outer = 0`;
         `converged = false`.
      3. Repeat up to `maxOuter`:
         - `{ Br, Bt } = op.field(x)`; `maxDelta = 0`.
         - For each `idx` with `ironMask[idx]`: `Bmag = Math.hypot(Br[idx],
           Bt[idx])`; `target = curve.nuOf(Bmag)`; `next = (1−relax)·work[idx] +
           relax·target`; `maxDelta = Math.max(maxDelta, Math.abs(next −
           work[idx]) / airNu)`; `work[idx] = next`.
         - `op.setIronReluctivity(work, ironMask)`.
         - `r = innerSolve(x)`; `x = r.x`; `iters += r.iters`; `outer += 1`.
         - if `maxDelta ≤ tol`: `converged = true`; break.
      4. `op.setIronReluctivity(nu0, ironMask)` — restore the snapshot so the next
         `slice.solve` at a new angle starts from clean (unsaturated) materials.
      5. `satScale` = the peak local saturation ratio `max over iron cells
         (work[idx] / nu0[idx])` at convergence (`1` when nothing saturated).
         Return `{ x, outer, iters, residual: r.residual, converged, satScale }`.
    - `LIB.AirgapNonlinear.backend({ factor = 3, fillet = { strength: 1 },
      mg = {}, curve = {}, relax = 0.5, maxOuter = 25, tol = 1e-4 } = {}) →
      backend` — a Phase-5 `SolveBackend`:
      - `prepare(section)`: `refined = LIB.AirgapRefine.refineSection(section, {
        factor })`; `op = LIB.AirgapGrid.create(refined.grid)`;
        `compiled = LIB.MotorCompile.compile(refined)`;
        `nuFillet = LIB.AirgapRefine.filletCorners(compiled.nu, refined.grid,
        fillet)`; `op.setMaterials({ nu: nuFillet })`;
        `op.setRotorRegion({ rotorMask: compiled.rotorMask })`;
        `op.setGapBand(refined.gapBand)`;
        `op._nlHierarchy = LIB.AirgapRefine.buildHierarchy(nuFillet, refined.grid,
        mg)`; `op._nlCurve = LIB.AirgapNonlinear.reluctivityCurve(curve)`;
        returns `{ op, compiled }`.
      - `solveSaturated(op, b, o)`: `LIB.AirgapNonlinear.solveNonlinear(op, b, {
        x0: o.x0, linTol: o.tol ?? 1e-6, tol, maxOuter, relax,
        ironMask: (o.ceiling && o.ceiling.ironMask) || o.ironMask,
        curve: op._nlCurve, hierarchy: op._nlHierarchy })`. (The Phase-5
        `motor-slice` passes the linear tolerance as `o.tol` and the iron mask in
        `o.ceiling.ironMask`; the backend maps the former to `linTol` and supplies
        its own outer-loop `tol`.)
      - `linearSolve(op, b, o)`: `LIB.AirgapRefine.vcycleSolve(op, b, { ...o,
        hierarchy: op._nlHierarchy })` — the inductance extraction (`extractCoeffs`)
        is an intentionally **linear** unit-current solve, so it bypasses the
        nonlinear loop.
- **Files to modify**: none.
- **Tests** (authored in Task 9.1.2): `tests/saturation/airgap-nonlinear.test.js`,
  `tests/saturation/srm-differential.test.js`,
  `tests/saturation/live-ceiling.test.js`.
- **Acceptance criteria**:
  - `reluctivityCurve()` returns `nuOf(0) === 1/(MU0·1000)` within `1e-6` relative,
    a `nuOf` that is monotone non-decreasing across the sampled table, and
    `nuOf(8·Bknee) ≥ 0.9·airNu` (saturated toward air).
  - Below the knee (a source giving iron `|B| < Bknee`): `solveNonlinear` reaches
    `converged === true` with `satScale` within `1e-3` of `1`, and its `x` matches
    `LIB.AirgapRefine.vcycleSolve(op, b, { hierarchy }).x` within `1e-3`
    relative-L2 (no saturation → the nonlinear tier reproduces the refined linear
    solve).
  - Past the knee (a source giving iron `|B| ≫ Bknee`): `solveNonlinear` reaches
    `converged === true` within `maxOuter`, `satScale > 1`, and the iron-cell
    `Bpeak` of its solution is strictly below the iron-cell `Bpeak` of the
    un-saturated linear solve on the same `op`/`b`.
  - The backend honours the `SolveBackend` contract through a `MotorSlice`
    (asserted in `srm-differential.test.js`): `slice.solve(θ, currents)` returns a
    finite `torque`, a `field` whose `Br.length === refinedNr·refinedNtheta`, and
    `slice.extractCoeffs(θ)` returns finite `L`/`lambdaPm`.
  - The module throws a descriptive `Error` at load if `LIB.AirgapRefine` is
    absent; with the dependency present it loads under `require` with no DOM
    access; its source contains no `MACHINE_NAMES` token (asserted in
    `airgap-nonlinear.test.js`).
  - All tests pass.

### Task 9.1.2: saturation test suite + worker-tier wiring check

- **Description**: The Phase-9 saturation validation: the nonlinear tier's own
  unit behaviour, the SRM aligned-vs-unaligned saturated differential and
  tooth-tip rolloff (the Phase-6 class-C carve-out, now magnitude-checked), the
  Live global-ceiling flattening across structurally-different configs, and the
  Phase-8 worker tier selector routing to the nonlinear backend. All headless —
  the nonlinear tier is exercised through the same `MotorStack`/`MotorSlice` path
  the worker uses, so no worker is needed for the assertions.
- **Files to create**:
  - `tests/saturation/_fixtures.js` — not a test file (no `.test.js`). On require:
    `const D = require("../detailed/_fixtures.js");` (installs `window` + every
    engine/pipeline/refine/worker lib and provides `D.LIB`, `D.UnifiedMotor`,
    `D.assertClose`, `D.MACHINE_NAMES`, `D.woundConfig`, `D.pmConfig`,
    `D.salientConfig`, `D.coggingConfig`, `D.refinedStack`, `D.coarseStack`,
    `D.sweepTorque`, `D.ripple`, `D.mean`, `D.amp`); `const M =
    require("../machines/_fixtures.js");` (registers all 15 fixtures; provides
    `M.byId`, `M.fitCos2`, `M.sweepInductance`); then **direct** `require` of
    `../../lib/airgap-nonlinear.js`. Exports:
    - `LIB` (`= D.LIB`), `UnifiedMotor` (`= D.UnifiedMotor`),
      `assertClose` (`= D.assertClose`), `MACHINE_NAMES` (`= D.MACHINE_NAMES`),
      `byId` (`= M.byId`), `fitCos2` (`= M.fitCos2`),
      `woundConfig`, `pmConfig`, `salientConfig`, `coggingConfig` (re-exported).
    - `expand(config) → expanded` — `UnifiedMotor.ConfigSchema.expand(config)`.
    - `nonlinearStack(config, opts = {}) → stack` — `LIB.MotorStack.create(
      expand(config), { backend: LIB.AirgapNonlinear.backend(opts) })`.
    - `linearRefinedStack(config, factor = 2) → stack` — `LIB.MotorStack.create(
      expand(config), { backend: LIB.AirgapRefine.backend({ factor }),
      ceiling: { enabled: false } })` (the refined tier with the global ceiling
      **disabled** — a pure-linear reference that shows no saturation).
    - `coarseStack` (`= D.coarseStack`), `refinedStack` (`= D.refinedStack`),
      `sweepTorque`, `ripple`, `mean`, `amp` (re-exported).
    - `srmConfig() → config` — `byId["switched-reluctance"].config` (the Phase-6
      fixture; read-only).
    - `fluxAt(stack, theta, currents) → Float64Array` — `stack.solve(theta,
      currents).fluxLinkages`.
    - `ironBpeak(op, x, ironMask) → number` — `max over iron cells
      hypot(Br[idx], Bt[idx])` from `op.field(x)`.
    - `alignedUnaligned(stack, k = 0, n = 48) → { thAlign, thUnalign, Lalign,
      Lunalign }` — sweep circuit-`k` self-inductance `extractCoeffs(θ).L[k*m+k]`
      over `θ ∈ [0, 2π/(stack rotor saliency period))` (use `[0, Math.PI/2)` for
      the 4-tooth SRM rotor); return the argmax (`thAlign`,`Lalign`) and argmin
      (`thUnalign`,`Lunalign`).
  - `tests/saturation/airgap-nonlinear.test.js` — `require("./_fixtures.js")`:
    - › `"reluctivity curve saturates from iron toward air"` — `c =
      LIB.AirgapNonlinear.reluctivityCurve()`; assert `assertClose(c.nuOf(0),
      1/(MU0*1000), 1e-6·rel)`, `c.nuOf` monotone non-decreasing over
      `c.table.B`, and `c.nuOf(8*c.Bknee) ≥ 0.9/MU0`.
    - › `"below the knee the nonlinear solve equals the refined linear solve"` —
      `be = LIB.AirgapNonlinear.backend({ factor:2 })`;
      `{ op, compiled } = be.prepare(expand(coggingConfig()).slices[0].section)`;
      `op.setRotorAngle(0.1)`;
      `Jz = compiled.assembleJz(Float64Array([2,0,0]))` (small);
      `b = op.assembleRHS({ Jz, magnetization: compiled.magnetization })`;
      `rNL = LIB.AirgapNonlinear.solveNonlinear(op, b, { ironMask: compiled.ironMask,
      curve: op._nlCurve, hierarchy: op._nlHierarchy })`;
      `xLin = LIB.AirgapRefine.vcycleSolve(op, b, { hierarchy: op._nlHierarchy }).x`;
      assert relative-L2 `‖rNL.x − xLin‖/‖xLin‖ < 1e-3` and
      `Math.abs(rNL.satScale − 1) < 1e-3`.
    - › `"past the knee per-cell saturation lowers iron Bpeak"` — same `op`,
      `Jz = compiled.assembleJz(Float64Array([400,0,0]))` (large — tune to push
      iron `|B| ≫ Bknee`); `b = …`;
      `bpkLin = ironBpeak(op, LIB.AirgapRefine.vcycleSolve(op, b, { hierarchy:
      op._nlHierarchy }).x, compiled.ironMask)`;
      `rNL = LIB.AirgapNonlinear.solveNonlinear(op, b, { ironMask: compiled.ironMask,
      curve: op._nlCurve, hierarchy: op._nlHierarchy })`;
      assert `rNL.converged === true`, `rNL.satScale > 1`, and
      `ironBpeak(op, rNL.x, compiled.ironMask) < bpkLin`.
    - › `"backend honours the SolveBackend contract through MotorSlice"` —
      `slice = LIB.MotorSlice.create(expand(coggingConfig()).slices[0].section, {
      backend: LIB.AirgapNonlinear.backend({ factor:2 }) })`;
      `r = slice.solve(0.1, new Float64Array(3))`; assert
      `Number.isFinite(r.torque)`, `r.field.Br.length === 16*128` (// coggingConfig
      base grid Nr:8, Ntheta:64; AirgapRefine factor:2 → 16 × 128 = 2048), and
      `slice.extractCoeffs(0.1)` returns finite `L`/`lambdaPm`.
    - › `"worker tier selector routes to the nonlinear backend"` —
      `cfg = woundConfig()`; `exp = expand(cfg)`;
      `cur = new Array(exp.nCircuits).fill(0)`; `cur[0] = 5`;
      `thetas = [0.1, 0.4, 0.8]`;
      `res = LIB.AirgapWorker.compute({ kind:"sweep", expanded: exp,
      currents: cur, thetas, backendOpts: { tier:"nonlinear", factor:2 } })`;
      assert `res.kind === "sweepResult"`, every `res.torques[i]` finite, and each
      equals `nonlinearStack(cfg, { factor:2 }).solve(thetas[i],
      Float64Array.from(cur)).torque` within `1e-9` relative (the Phase-8 selector
      built the Phase-9 nonlinear backend).
    - › `"no machine-name string in source"` — read `lib/airgap-nonlinear.js`;
      assert no `MACHINE_NAMES` token (case-insensitive).
  - `tests/saturation/srm-differential.test.js` — `require("./_fixtures.js")`. The
    headline Phase-9 acceptance — the Phase-6 class-C carve-out, magnitude-checked
    (`i1`/`i2` are the only tunable scalars and may be adjusted *only* to bracket
    the iron knee; the assertions are regime-relative ratios, never absolute):
    The SRM stator `C` ring contributes the only circuits (phases 0,1,2; the `I`
    rotor contributes none), so phase 0 is circuit index `0` and a phase-0
    excitation is `Float64Array([i, 0, 0])`; flux linkage of circuit 0 is
    `fluxAt(stack, θ, currents)[0]`. Fixed for the whole file:
    `linS = linearRefinedStack(srmConfig(), 2)`,
    `nlS = nonlinearStack(srmConfig(), { factor:2 })`,
    `{ thAlign, thUnalign } = alignedUnaligned(linS)` (geometric positions from the
    linear tier — saturation does not move them), `i1 = 4`, `i2 = 40` (the only
    tunable scalars). Define
    `la1_lin = fluxAt(linS, thAlign, Float64Array([i1,0,0]))[0]`,
    `la2_lin = fluxAt(linS, thAlign, Float64Array([i2,0,0]))[0]`,
    `lu2_lin = fluxAt(linS, thUnalign, Float64Array([i2,0,0]))[0]`,
    `la1_nl  = fluxAt(nlS,  thAlign, Float64Array([i1,0,0]))[0]`,
    `la2_nl  = fluxAt(nlS,  thAlign, Float64Array([i2,0,0]))[0]`,
    `lu1_nl  = fluxAt(nlS,  thUnalign, Float64Array([i1,0,0]))[0]`,
    `lu2_nl  = fluxAt(nlS,  thUnalign, Float64Array([i2,0,0]))[0]`.
    - › `"linear refined tier shows no aligned saturation"` — assert
      `assertClose(la2_lin/la1_lin, i2/i1, 0.05·(i2/i1))` (linear flux scales
      linearly with current — the linear tier cannot resolve saturation, which is
      *why* the nonlinear tier exists).
    - › `"nonlinear aligned flux saturates while unaligned stays linear"` —
      aligned ratio `ra = la2_nl/la1_nl`, unaligned ratio `ru = lu2_nl/lu1_nl`;
      assert `ra ≤ 0.9·(i2/i1)` (the aligned tooth saturates — sub-linear flux) and
      `Math.abs(ru − i2/i1) ≤ 0.10·(i2/i1)` (the unaligned, gap-dominated position
      stays linear).
    - › `"saturation compresses the aligned-vs-unaligned differential"` — at `i2`:
      `dNL = la2_nl − lu2_nl` (nonlinear) and `dLin = la2_lin − lu2_lin`
      (linear refined); assert `dNL > 0` (aligned still exceeds unaligned —
      present, correct sign) and `dNL < dLin` (saturation narrows the differential
      at high current — the aligned-vs-unaligned differential the Live tier and
      the linear refined tier cannot produce).
    - › `"tooth-tip saturation rolls torque off below the unsaturated square law"`
      — at the angle `thPk` maximising `|nlS.solve(θ, Float64Array([i2,0,0])).torque|`
      over `[thUnalign, thAlign]` (evaluate `n = 32` uniform samples over
      `[thUnalign, thAlign]`; `thPk` is the sample angle with maximum `|torque|`):
      `T1 = nlS.solve(thPk, Float64Array([i1,0,0])).torque`,
      `T2 = nlS.solve(thPk, Float64Array([i2,0,0])).torque`; assert
      `Math.abs(T1) > 1e-7` and `Math.abs(T2) < 0.9·(i2/i1)² · Math.abs(T1)`
      (below the knee reluctance torque is `∝ i²`; saturation forces a sub-square
      rolloff).
  - `tests/saturation/live-ceiling.test.js` — `require("./_fixtures.js")`. The
    Live global ceiling, on three structurally-different configs:
    - › `"the Live global ceiling flattens torque past the iron knee"` — for `cfg`
      in `[srmConfig(), pmConfig(), woundConfig()]`, energising **circuit 0** (the
      first circuit in declared order for all three) via `curK(i) = (() => { const
      c = new Float64Array(expand(cfg).nCircuits); c[0] = i; return c; })()`,
      `i1 = 4` (below knee) and `i2 = 40` (well past knee — the only tunable
      scalars): `ceil = coarseStack(cfg)` (Live tier, global ceiling enabled) and
      `noCeil = LIB.MotorStack.create(expand(cfg), { ceiling: { enabled:false } })`
      (Live grid, ceiling off);
      `Tc1 = ceil.solve(0.2, curK(i1)).torque`, `Tn1 = noCeil.solve(0.2,
      curK(i1)).torque`, `Tc2 = ceil.solve(0.2, curK(i2)).torque`,
      `Tn2 = noCeil.solve(0.2, curK(i2)).torque`; assert
      `assertClose(Tc1, Tn1, 0.02·Math.abs(Tn1) + 1e-7)` (ceiling inactive below
      the knee) and `Math.abs(Tc2) < Math.abs(Tn2)` with the ceilinged solve
      reporting `ceil.solve(0.2, curK(i2)).perSliceField[0].satScale > 1` (the
      `field.satScale` exposed by `motor-slice.solve` — the ceiling flattens torque
      past the knee on every config). Note: `perSliceField[k]` carries the
      per-slice `field.satScale` returned by `motor-slice.solve` — specified in
      Phase 5 §Task 5.1.2.
- **Files to modify**: none.
- **Acceptance criteria**:
  - `npm test` runs all `tests/saturation/*.test.js` (alongside the existing
    suites) and exits 0.
  - The SRM aligned flux saturates (`ra ≤ 0.9·i2/i1`), the unaligned flux stays
    linear, and the aligned-vs-unaligned differential is positive and strictly
    compressed versus the linear refined tier — the Phase-6 class-C carve-out is
    discharged with a magnitude check.
  - The tooth-tip torque rolloff is sub-square at high current.
  - The Live global ceiling is provably inactive below the knee and flattens
    torque past it on a reluctance, a PM, and a wound config.
  - The Phase-8 worker tier selector builds the Phase-9 nonlinear backend when
    `backendOpts.tier === "nonlinear"` and the sweep matches the direct
    `nonlinearStack` torque.
  - `tests/saturation/_fixtures.js` is not collected as a test and is
    `require`-able by every saturation test file; `tests/_shim.js`,
    `tests/pipeline/_fixtures.js`, `tests/detailed/_fixtures.js`, and
    `tests/machines/_fixtures.js` are byte-unchanged.

---

## Wave 9.2: 3D render polish

### Task 9.2.1: render3d.js — polished 3D rig + field-viz, via the Phase-5 render seam

- **Description**: The polished 3D viewport renderer, registered through the
  Phase-5 render seam. Pure 3D-geometry builders (axial extrusion, end-winding
  arcs, slice planes, cell radii) are headless-testable; the `paint` entry and the
  field-viz header control are browser-verified. The renderer is config-agnostic:
  it builds geometry from `expanded.slices` / `config.rings` data and reads the
  solver field from `runtime.lastSolve` — never a machine name.
- **Files to create**:
  - `lessons/unified_motor/render3d.js` — IIFE, lazy idiom
    `const UM = window.UnifiedMotor || (window.UnifiedMotor = {});`. Attaches
    `UM.Render3D`. DOM-free at load (no `document`/`canvas`/render-lib access until
    `paint`/`build` run). API — **pure geometry builders** (no render-lib
    dependency):
    - `Render3D.cellRadii(grid) → Float64Array` — cell-centre radii of length
      `grid.Nr`: `r[i] = grid.rInner + (i + 0.5)·(grid.rOuter − grid.rInner)/grid.Nr`.
    - `Render3D.slicePlanes(nSlices, { ell, gap = 0.25·ell } = {}) → number[]` —
      axial centre `z` of each slice plane, length `nSlices`, symmetric about `0`:
      `z_k = (k − (nSlices − 1)/2)·(ell + gap)`. Monotone increasing; spacing
      `ell + gap`.
    - `Render3D.ringCircle(radius, z, nAz) → {x,y,z}[]` — `nAz` points around a
      circle of `radius` in the world x–y plane at axial `z`:
      `{ x: radius·cosθ_j, y: radius·sinθ_j, z }`, `θ_j = j·2π/nAz`.
    - `Render3D.extrudeAnnulus(rInner, rOuter, z0, z1, nAz) → { front, back,
      innerWall, outerWall }` — four ring polylines: `front = ringCircle(rOuter,
      z0, nAz)`, `back = ringCircle(rOuter, z1, nAz)`, `innerWall =
      [ringCircle(rInner, z0, nAz), ringCircle(rInner, z1, nAz)]`, `outerWall =
      [ringCircle(rOuter, z0, nAz), ringCircle(rOuter, z1, nAz)]` (`front`/`back`
      are single `nAz`-point rings at `z0`/`z1` radius `rOuter`; `innerWall` and
      `outerWall` are 2-element arrays of `nAz`-point rings at `z0` and `z1`,
      radius `rInner` and `rOuter` respectively, so `paint` can render the
      iron-body barrels).
    - `Render3D.endWindingArc(go, ret, zFace, bulge, nSeg = 16) → {x,y,z}[]` — a
      `nSeg+1`-point arc from `go` to `ret` (two `{x,y,z}` slot-mouth points on
      the end face at axial `zFace`) that bows out of the stack end along the face
      normal by `bulge`: linear x/y interpolation with a parabolic axial bump
      `z(t) = zFace + bulge·4·t·(1−t)·sign`, `sign = Math.sign(zFace) || 1`,
      `t = i/nSeg`. Endpoints equal `go`/`ret` (at `t = 0,1` the bump is zero).
    - `Render3D.conductorSegment(rSlot, theta, z0, z1) → [{x,y,z},{x,y,z}]` — the
      axial straight run of an in-slot conductor: two points at `(rSlot·cosθ,
      rSlot·sinθ, z0)` and `(…, z1)`.
    - **State + paint** (browser):
    - `Render3D.vizMode` — one of `"heatmap" | "vectors" | "off"` (module-level,
      default `"heatmap"`); `Render3D.setVizMode(mode)` sets it (ignores unknown
      values).
    - `Render3D.paint(ctx, L3, rctx) → void` — `rctx = { runtime, config,
      expanded, W, H }`. Owns the whole 3D-rig draw for the frame:
      1. **Per-slice gap field** (skipped when `vizMode === "off"`): compute a
         stack-wide `magScale = max |B|` across every `runtime.lastSolve
         .perSliceField[k]`; for each slice `k`, `geom = { Nr, Ntheta, r:
         cellRadii(expanded.slices[k].section.grid), rInner, rOuter, planeZ:
         slicePlanes(expanded.slices.length, { ell: expanded.grid.ell })[k] }`;
         call `LIB.FieldRender.drawGapField(ctx, L3, perSliceField[k], geom, {
         magScale, vectors: vizMode === "vectors" })`. (Consumes the Phase-5
         `drawGapField` unchanged.)
      2. **Axial extrusion**: depth-sorted iron-body annuli (rotor yoke, stator
         yoke from `config.rings` `*Range` bands) drawn with
         `LIB.CoilRender.drawConductor3D` from `extrudeAnnulus` ring polylines.
      3. **Conductors + end-windings**: for each circuit, in-slot
         `conductorSegment` runs and `endWindingArc`s over both stack ends,
         tinted by per-circuit current sign (`LIB.CoilRender.voltageColor` /
         `drawConductor3D`) with `drawCurrentDots3D` animating `runtime.state.i`.
      `paint` reads only `runtime`/`config`/`expanded` — no machine identity.
    - `Render3D.register(UM) → void` — guarded: when `UM.registerRender3D` exists,
      `UM.registerRender3D({ id: "unified-motor-3d", paint })`; when
      `UM.registerHeaderControl` exists, register a field-viz control
      `{ id: "field-viz-mode", build(host, ctx) → unmountFn }` whose button cycles
      `heatmap → vectors → off` via `setVizMode`. Invoked at module load **only
      when the seams exist** (under the headless shim the seams are absent, so load
      only defines the namespace + builders — exactly the Phase-8
      `detailed-toggle.register` pattern).
- **Files to modify**: none.
- **Tests** (authored in Task 9.2.2): `tests/render/render3d.test.js`.
- **Acceptance criteria**:
  - `slicePlanes(n, { ell })` returns `n` values symmetric about `0`, strictly
    increasing, with adjacent spacing `ell + gap`.
  - `cellRadii(grid)` returns `grid.Nr` strictly-increasing radii inside
    `(rInner, rOuter)`.
  - `ringCircle(r, z, n)` returns `n` points all at radius `r` (`hypot(x,y) === r`
    within `1e-12`) and axial `z`, evenly spaced in angle.
  - `extrudeAnnulus(rInner, rOuter, z0, z1, nAz)` returns `front` (single
    `nAz`-point ring at `z0`, radius `rOuter`) and `back` (single `nAz`-point
    ring at `z1`, radius `rOuter`); `innerWall` and `outerWall` are each a
    2-element array of `nAz`-point rings at `z0` and `z1`, at radius `rInner`
    and `rOuter` respectively.
  - `endWindingArc(go, ret, zFace, bulge)` returns `nSeg+1` points whose first
    equals `go` and last equals `ret` (within `1e-9`), with `max |z − zFace| ≈
    bulge` (within `1e-9`).
  - `setVizMode`/`vizMode` round-trip; `register(UM)` with no seams present is a
    no-op that still defines `UnifiedMotor.Render3D`.
  - The module loads under `require` with no DOM access; its source contains no
    `MACHINE_NAMES` token.

### Task 9.2.2: render test suite + index.html wiring + browser verification

- **Description**: The headless render-geometry suite, the `index.html` page
  wiring that loads `render3d.js`, and the browser verification of the polished
  live viewport (which no headless agent can perform — flagged **user-required**
  in the manifest).
- **Files to create**:
  - `tests/render/_fixtures.js` — not a test file. On require:
    `const P = require("../pipeline/_fixtures.js");` (installs `window` + the
    engine/pipeline libs incl. `UnifiedMotor.ConfigSchema`, and provides `P.LIB`,
    `P.UnifiedMotor`, `P.MACHINE_NAMES`, `P.woundConfig`, `P.pmConfig`,
    `P.salientConfig`, `P.skewN2Config`), then **direct** `require` of
    `../../lessons/unified_motor/render3d.js`. Exports:
    - `LIB` (`= P.LIB`), `UnifiedMotor` (`= P.UnifiedMotor`),
      `Render3D` (`= P.UnifiedMotor.Render3D`),
      `MACHINE_NAMES` (`= P.MACHINE_NAMES`),
      `expand(config)` (`= UnifiedMotor.ConfigSchema.expand`),
      `woundConfig`, `pmConfig`, `skewN2Config` (re-exported).
  - `tests/render/render3d.test.js` — `require("./_fixtures.js")`:
    - › `"slicePlanes places N symmetric, evenly-spaced planes"` — for `n = 2` and
      `n = 4` (`ell = 0.1`): assert length, symmetry about `0` (`z[k] === −z[n−1−k]`
      within `1e-12`), strict increase, and constant spacing.
    - › `"cellRadii lie strictly inside the annulus"` — for a `{ Nr:6, rInner:0.03,
      rOuter:0.055 }` grid: 6 strictly-increasing radii, all in `(0.03, 0.055)`.
    - › `"ringCircle points lie on the circle at z"` — `ringCircle(0.04, 0.2, 24)`:
      24 points, each `hypot(x,y) === 0.04` (±`1e-12`), each `z === 0.2`.
    - › `"extrudeAnnulus builds front/back/inner/outer rings"` —
      `extrudeAnnulus(0.03, 0.055, -0.05, 0.05, 24)`: `front` is a single
      24-point ring at `z=-0.05` radius `0.055`; `back` is a single 24-point ring
      at `z=0.05` radius `0.055`; `innerWall` is a 2-element array of 24-point
      rings at `z=-0.05` and `z=0.05`, radius `0.03`; `outerWall` is a 2-element
      array of 24-point rings at `z=-0.05` and `z=0.05`, radius `0.055`.
    - › `"endWindingArc bows over the end face and hits its endpoints"` —
      `go = {x:0.05,y:0,z:0.05}`, `ret = {x:0,y:0.05,z:0.05}`,
      `arc = endWindingArc(go, ret, 0.05, 0.02, 16)`: length `17`, `arc[0]` ≈ `go`,
      `arc[16]` ≈ `ret` (±`1e-9`), and `max(arc.map(p => p.z)) − 0.05` ≈ `0.02`.
    - › `"render geometry keys on numbers, not machine identity"` — the geometry
      builders take plain numbers/grids, never a config or machine name: assert
      `slicePlanes(2, { ell:0.1 })` deep-equals a second identical call, and
      `extrudeAnnulus(0.03, 0.055, -0.05, 0.05, 24)` deep-equals a second identical
      call (deterministic, input-driven — no machine awareness anywhere in the
      builder path).
    - › `"vizMode round-trips; register is a guarded no-op under the shim"` —
      `Render3D.setVizMode("vectors")`; assert `Render3D.vizMode === "vectors"`;
      `Render3D.setVizMode("bogus")` leaves it unchanged; `Render3D.register(
      window.UnifiedMotor)` (no seams) does not throw and `UnifiedMotor.Render3D`
      stays defined.
    - › `"no machine-name string in source"` — read
      `lessons/unified_motor/render3d.js`; assert no `MACHINE_NAMES` token.
  - `tests/render/wiring.test.js` — `require("./_fixtures.js")` + `node:fs`:
    - › `"index.html loads render3d.js inside the marked region"` — read
      `lessons/unified_motor/index.html`; locate the substring between
      `<!-- unified-motor modules:` and `<!-- /unified-motor modules -->`; assert
      that region contains a `<script src>` for `./render3d.js` and that both
      marker comments are present exactly once.
- **Files to modify**:
  - `lessons/unified_motor/index.html` — inside the existing module-extension
    region (between the `<!-- unified-motor modules: later phases append … -->`
    and `<!-- /unified-motor modules -->` markers, created by Phase 5), append:
    ```html
    <script src="./render3d.js"></script>
    ```
    No other line of `index.html` changes. (`airgap-nonlinear.js` is **not** added
    here — it loads inside the worker via the Phase-8 guarded `importScripts`.)
- **Acceptance criteria**:
  - `npm test` runs `tests/render/*.test.js` (alongside the existing suites) and
    exits 0.
  - `tests/render/_fixtures.js` is not collected as a test and is `require`-able by
    both render test files.
  - The single `<script src="./render3d.js">` tag appears inside the `index.html`
    marked region; no other line of `index.html` changed.
  - **(User-required)** Served from the repo root over `http://`,
    `http://localhost:<port>/lessons/unified_motor/index.html` loads with no
    console errors; the user completes the browser checklist and records the
    result in `spec/progress.md`:
    1. The polished 3D rig renders: axially-extruded iron bodies, in-slot
       conductors, and end-winding arcs joining go/return slots over the stack
       ends.
    2. The per-slice gap field paints on each slice plane (visible on a
       multi-slice config — `skew-demo` or `hybrid-stepper`).
    3. The field-viz-mode header control cycles **heatmap → vectors → off** and
       the viewport responds.
    4. With Detailed mode (Phase 8) enabled and the **Saturation (nonlinear)**
       checkbox ticked, the Detailed panel shows the nonlinear refined field (the
       SRM aligned-vs-unaligned differential is visible) while the polished Live
       rig keeps animating; unticking returns the worker to the refined tier.
    5. Reset and the orbit-camera tool still work with the render module active.
- **User action required**: the browser checklist above; acked via
  `bash "${CLAUDE_PLUGIN_ROOT}/scripts/ack-user-gate.sh" T9.2.2 "<evidence>"`.

---

## Phase acceptance (rolls up to the manifest verification)

- `npm test` exits 0 with all `tests/saturation/*.test.js` and
  `tests/render/*.test.js` files plus every existing suite.
- The nonlinear tier resolves the SRM aligned-vs-unaligned saturated differential
  (aligned flux saturates, unaligned stays linear, the differential is positive
  and compressed vs. the linear refined tier) and the tooth-tip torque rolloff —
  discharging the Phase-6 class-C carve-out with magnitude checks.
- The Live global flux-dependent ceiling is inactive below the iron knee and
  flattens torque past it on a reluctance, a PM, and a wound config.
- The Phase-8 worker tier selector builds the Phase-9 nonlinear backend on
  `backendOpts.tier === "nonlinear"`, exercised headlessly through
  `LIB.AirgapWorker.compute`.
- The polished 3D rig (extrusion + end-windings + per-slice field paint + field-viz
  mode) renders through the Phase-5 render seam, browser-verified.
- Neither `lib/airgap-nonlinear.js` nor `lessons/unified_motor/render3d.js` reads
  an element letter or machine name; both source greps for `MACHINE_NAMES` return
  zero.
