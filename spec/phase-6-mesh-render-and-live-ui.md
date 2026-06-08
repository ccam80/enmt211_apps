# Phase 6: Mesh-native render + live UI

## Overview

Land the user-facing layer of the FEA rebuild: replace the grid heatmap with a
first-class mesh-native render (`fea-engine-rebuild.md` §10 R1–R5) and wire the
live controls the old build never had — a machine picker, geometry sliders, and
a per-ring material card. The new 2-D and 3-D render paths consume only the
Phase-5 mesh-native `field` (D3) and the `runtime.stack.sliceMesh(k)` accessor
(D2); no grid sampling, no adapter shim. `mount.js`'s gap-field overlay block
and built-in grid 3-D rig are rewritten to dispatch through a new
2-D-render seam (mirroring the existing `registerRender3D` seam), and
`index.html` gains the FEA library `<script>` tags plus the `LIB.FeaSolver.init()`
boot await. **Element-kind / material-kind dispatch only — no machine
identity** (binding constraint §11.1#1; the renderers read
`mesh.materials[matId].kind`, `mesh.elems[].srcId`, and feature counts — never
a machine name or type, and the picker treats `UM.MACHINES` entries as opaque
`{id, label, config}` triples).

### Locked decisions for this phase (settled with the author 2026-05-27)

- **D1 — 2-D-render seam (mirrors `registerRender3D`).** `mount.js` gains a
  single new seam: `UM.CROSS_SECTION_2D = null` and
  `UM.registerCrossSection2D(entry)`. `entry = { paint(mountCtx, canvases,
  rctx) → void }` where `canvases = [canvas2DA, canvas2DB]` (top → bottom);
  the registrant decides which slice/view goes in which canvas. Mount calls
  the seam each frame if registered, else paints a small "no renderer
  registered" placeholder on each canvas. The existing built-in
  `drawCrossSection` / `drawFeatureSectors2D` / `drawFeatureSectors3D` /
  `fillSector2D` / `fillSector3D` / `drawSlotConductors3D` / `drawRing3D` /
  `ringPoints` helpers and the **entire built-in-rig `else` branch** (lines
  ~978–1082) of `frame()` are **deleted** — `render3d.js` always registers,
  so the fallback is dead code that still references the removed
  `sliceGrid`/`perSliceField.Br/.Bt`. The `UM.PANELS` / `UM.TOOLS` /
  `UM.HEADER_CONTROLS` / `UM.RENDER3D` seams stay byte-identical; only the
  new `UM.CROSS_SECTION_2D` slot is added. **`mount.js` is in Phase 6's Files
  Owned for this rewrite** (the plan's earlier "mount.js seam API unchanged"
  framing referred to the four existing seams — those still hold; the 2-D
  seam is purely additive).

- **D2 — Field contract (consumer side; matches Phase 5 D3 verbatim).** The
  render reads `runtime.lastSolve.perSliceField[k]` per Phase 5: `{rotor:
  {mesh, Anode, Belem:{mag,Bx,By}}, stator:{…}, gap:{harmonics:{rotor:{a,b},
  stator:{a,b}}, phi}}`. Static mesh access (before the first solve, and as
  the stable reference Phase 6 caches off — e.g. for the topology-signature
  guard that skips re-allocation of `Path2D` glyph caches) uses
  `runtime.stack.sliceMesh(k) → {rotor, stator}` (Phase 5 D2). The body's
  `mesh.gapR` carries `r_mr` (rotor) and `r_ms` (stator);
  `gap.harmonics.rotor.a.length − 1 === K`. **No new contract surface is
  added on the slice or stack** — Phase 5 provides everything Phase 6 needs.

- **D3 — Field-viz toggles (independent, no always-on).** Header control
  "Field view" exposes six independent checkboxes; state lives in
  `UM.fieldViz` (plain object on the `UnifiedMotor` namespace, written by the
  header control and read by both 2-D and 3-D renderers each frame). Initial
  state `{ fluxLines:true, modulusB:false, saturation:false, magnetization:false, currentDensity:false, gapLoop:false }` — flux-lines on by default; every other overlay opt-in. `gapLoop` is the mesh-structural overlay (the uniform-Δθ mid-gap circle from Phase 2's `BodyMesh.gapLoop`); off by default so the production cross-section is clean, but exposed so a user can switch it on for understanding the gap-harmonic seam. The analytic in-gap `A(r,θ)` reconstruction
  (R5) renders whenever `fluxLines` is on. The toggles register
  declaratively via `UM.registerHeaderControl` (same seam the existing
  "Compiled overlay" used).

- **D4 — Saturation viz reads `|B|/Bknee`, not ν.** Phase 5's
  `field.<body>.Belem` carries `(mag, Bx, By)` but no `nuElem`, and the
  Brauer `ν(B²)` parameters live inside the slice. Rather than duplicate D5
  in render code or expose a `__internals` accessor, the saturation overlay
  renders **`|B(elem)| / Bknee_eff`** as a 0..2 viridis-style colormap
  (1.0 = at the knee). `Bknee_eff = mesh.materials[matId].Bknee` when
  finite-and-positive, else the literal fallback `1.6 T` (the same default
  Phase 5 D4 uses for `BkneeDefault`). Non-iron elements (`kind !== "iron"`)
  are not shaded by saturation. This conveys "where is iron saturating"
  without depending on the slice's Brauer fit and stays correct under any
  future B–H model.

- **D5 — R5 analytic in-gap `A(r,θ)` reconstruction in `render3d.js`.**
  Phase 4's "Out of Scope" explicitly delegates this to Phase 6. The pure
  helper `LIB.GapEval.evalA(gap, r_mr, r_ms, r, theta) → A` lives in a
  small standalone file `lib/gap-eval.js` (so the 2-D and 3-D renderers can
  both call it without circular dependency). For each harmonic
  `k = 1..K`, solve the 2×2 system
  `[r_mr^k  r_mr^{-k}; r_ms^k  r_ms^{-k}] · [α_k; β_k] = [Â_rotor,k(φ);
  Â_stator,k]` (with the rotor harmonic phase-rotated by `[cos kφ, −sin kφ;
  sin kφ, cos kφ]` applied to its `(a_k, b_k)`), then evaluate
  `A(r,θ) = a_0(r) + Σ_{k=1..K} [α_a,k·r^k + β_a,k·r^{-k}]·cos kθ +
  [α_b,k·r^k + β_b,k·r^{-k}]·sin kθ`. The `k=0` mode uses
  `a_0(r) = â_rotor,0 + (â_stator,0 − â_rotor,0)·ln(r/r_mr)/ln(r_ms/r_mr)`
  (the source-free Laplace solution `a₀ + b₀·ln r` written through the two
  Dirichlet values). The helper is pure (no DOM); both renderers call it on
  a sampling grid spanning the unmeshed annulus when `UM.fieldViz.fluxLines`
  is on.

- **D6 — `matrix-panel.js` is the home for the geometry + material cards.**
  The existing per-ring matrix table (element / member / excitation /
  commutation selectors + global poles) stays byte-stable in layout; two
  collapsed expander cards are added per row:
  - **Geometry** (collapsed by default): `rRange[0]`, `rRange[1]`
    (m, continuous) for every ring; integer `teeth` for `I`/`C` rings,
    `magnets` for `M` rings, `Q` for `W`/`C`/`K` rings (via the ring's
    `winding.standard.Q` slot). Dispatch on `ring.element` only.
  - **Material** (collapsed by default): `muR` (≥1, continuous) for any
    ring whose element produces iron or magnet material (`I`, `M`, and
    iron-bearing `W`/`C`/`K` rings with `muR`); `Mr` (A/m, continuous) for
    `M` rings; `Bknee` (T, continuous; null shows as "default 1.6") for
    iron-bearing rings.
  Both cards mutate `ctx.config.rings[idx]` in place and call
  `ctx.requestRebuild()` — same path the existing element/excitation
  selectors use (via the panel's `applyChange` ↔ `synthesize` flow extended
  to round-trip the new fields).
  A new **global gap-length slider** (`g`, m, continuous, log-scaled
  `[1e-4, 1e-2]`) sits next to `poles` at the bottom of the panel. Gap is
  **derived**: changing `g` re-positions the rotor's outermost-feature
  outer radius and the stator's innermost-feature inner radius symmetrically
  around the current mid-gap so `(stator_bore) − (rotor_surface) = g`,
  preserving every other ring radius. The derivation is a pure helper
  `applyGapLength(config, g) → config`; matrix-panel calls it on slider
  change then `ctx.requestRebuild()`.

- **D7 — Machine picker is its own file `machine-picker.js`, a header
  control.** A new file `lessons/unified_motor/machine-picker.js` registers
  one header control: a `<select>` populated from `UM.MACHINES` (the
  fixture-registered `[{id, label, config}, …]`; preset-loader semantics —
  no machine identity stored). On selection, it **deep-copies** the chosen
  fixture's `rings`, `circuits`, `stack`, `grid`, `mechanical`, `poles`, and
  `label` fields into the live `ctx.config` object **in place**
  (`for (const k of MUTABLE_KEYS) ctx.config[k] = deepCopy(picked.config[k])`),
  then calls `ctx.requestRebuild()` — `mount.js`'s requestRebuild closure
  reads the same `config` reference, so the new config takes effect on the
  next frame. The picker reads only `id`/`label` (presentation; never
  consulted by physics) and `config` (mutable seed). Once a fixture is
  picked, every field is editable via the matrix panel's existing
  selectors + the new geometry/material cards — there is no "machine
  identity" anywhere downstream.

- **D8 — `LIB.FeaSolver.init()` is awaited at app boot, not inside
  `mount`.** `index.html`'s bootstrap changes from
  `<script>LIB.App.runTabs({...});</script>` to
  `<script>LIB.FeaSolver.init().then(() => LIB.App.runTabs({...}));</script>`.
  `mount.js` stays sync. (Phase 5 says the slice wrapper lazily awaits
  `init` on first solve; for the live app a deterministic up-front await is
  cleaner than fielding a first-frame promise inside the rAF loop.)

- **D9 — `index.html` is the single owner of the post-Phase-0 script tag
  additions, all in this phase.** Phase 6 adds these tags (in dependency
  order). **Before `./mount.js`** (so libs are present when mount captures
  them):
  - `../../lib/fea-solver.js`
  - `../../lib/motor-mesh.js`
  - `../../lib/motor-mesh-view.js`
  - `../../lib/airgap-harmonic.js`
  - `../../lib/gap-eval.js`
  - `../../lib/motor-slice.js`
  **After `./mount.js`** (so registrants run after the `UnifiedMotor` seams
  exist) — these become a new "panels + renderers" cluster between the
  `mount.js` tag and the `machines/*` block:
  - `./cross-section-render.js`
  - `./render3d.js`
  - `./matrix-panel.js`
  - `./machine-picker.js`

- **D10 — User-required browser pass is Wave 6.3 only.** Waves 6.1 and 6.2
  verify headlessly (recording-mock 2-D contexts; pure helpers + the
  `LIB.GapEval` analytic solution). The single user-required browser pass
  in Wave 6.3 exercises all three waves together: picker loads each of the
  15 fixtures live; geometry + material sliders rebuild geometry; rotor
  turns; field paints under each viz toggle; Reset works.

## Render-side contracts the renderers stand on

What each render layer reads — quoted from Phase 5 D2/D3 + Phase 2's
`BodyMesh` contract, no extensions:

- **R1 (material shading + glyphs)** — `mesh.elems`, `mesh.matId`,
  `mesh.materials[matId].kind`, `mesh.srcId`, `mesh.turns`,
  `mesh.materials[matId].mrMag`, `mesh.magDir`, plus the **live circuit
  currents** `runtime.state.i` for current-sign tinting.
- **R2 (flux lines + |B| shading)** — `field.<body>.Anode` (per-node `A_z`
  for iso-contour marching), `field.<body>.Belem.mag` (per-element `|B|`).
- **R3 (diagnostics)** — `field.<body>.Belem.mag` + `mesh.materials[].Bknee`
  for saturation; `mesh.magDir` + `mesh.materials[].mrMag` for magnetization
  arrows; `mesh.srcId` + `mesh.turns` + `runtime.state.i` for current density.
- **R4 (rotor rotation)** — `field.gap.phi` to rotate the rotor `BodyMesh`'s
  body-local node coordinates rigidly for draw; stator mesh fixed. (The
  mesh nodes themselves are never mutated; the rotation is in the draw
  transform.)
- **R5 (analytic in-gap `A(r,θ)`)** — `field.gap.harmonics.{rotor,stator}` +
  `field.gap.phi` + `field.rotor.mesh.gapR` (`r_mr`) +
  `field.stator.mesh.gapR` (`r_ms`), fed to `LIB.GapEval.evalA`.

## Files Owned

- `lib/motor-mesh-view.js` — modified (Wave 6.1; extends Phase 2's M0
  visualizer to the production 2-D render)
- `lib/gap-eval.js` — created (Wave 6.2; the pure R5 analytic-annulus helper)
- `lessons/unified_motor/cross-section-render.js` — modified (Wave 6.1;
  rewritten to mesh-native; registers the new 2-D-render seam)
- `lessons/unified_motor/mount.js` — modified (Wave 6.1; adds 2-D seam,
  rewires the 2-D canvases through it, deletes the dead built-in grid rig
  `else` branch and its helpers — D1)
- `lessons/unified_motor/render3d.js` — created (Wave 6.2; mesh extrusion,
  end-windings, per-slice in-gap analytic field, registers `UM.RENDER3D`)
- `lessons/unified_motor/index.html` — modified (Wave 6.2; D8 boot await +
  D9 script tags)
- `lessons/unified_motor/matrix-panel.js` — modified (Wave 6.3; geometry +
  material cards + gap-length slider; existing element/excitation/
  commutation selectors and `synthesize`/`deriveTogglesFromConfig` flow
  preserved)
- `lessons/unified_motor/machine-picker.js` — created (Wave 6.3; header
  control reading `UM.MACHINES`)
- `tests/render/_fixtures.js` — created (Wave 6.1; loader + recording-mock
  2-D context + the small geometry helpers Phase 6 tests share)
- `tests/render/mesh-view-prod.test.js` — created (Wave 6.1)
- `tests/render/cross-section-render.test.js` — created (Wave 6.1)
- `tests/render/mount-2d-seam.test.js` — created (Wave 6.1)
- `tests/render/gap-eval.test.js` — created (Wave 6.2)
- `tests/render/render3d.test.js` — created (Wave 6.2)
- `tests/ui/_fixtures.js` — created (Wave 6.3; loader + the JSDOM-lite DOM
  shim Phase 6's UI tests share)
- `tests/ui/matrix-panel-geometry.test.js` — created (Wave 6.3)
- `tests/ui/matrix-panel-material.test.js` — created (Wave 6.3)
- `tests/ui/machine-picker.test.js` — created (Wave 6.3)

> **Task groups are not declared here.** They live in `spec/manifest.json`.

> File-locality check: `mount.js` is touched **only** by Wave 6.1;
> `index.html` is touched **only** by Wave 6.2; `matrix-panel.js` is touched
> **only** by Wave 6.3. Each wave is file-disjoint; one implementer per
> wave. Phase-6 files do not appear in any other phase's Files Owned
> (Phase 2 created `motor-mesh-view.js`; Phase 6's extension is sequential,
> not parallel).

---

## Wave 6.1: Mesh-native 2-D cross-section + diagnostics + 2-D seam (R1+R2+R3)

### Task T6.1.1: Promote `motor-mesh-view.js`, rewrite `cross-section-render.js` mesh-native, add the 2-D seam to `mount.js`, delete the dead built-in grid rig

- **Description**: Extend `lib/motor-mesh-view.js` (Phase 2's M0 visualizer)
  with the production R1+R2+R3 surface: element shading by material, the
  marching-squares iso-contour pass over `Anode`, the `|B|` colormap,
  saturation / magnetization / current-density overlays, and the
  discrete-winding dot/cross glyphs at conductor element centroids.
  Rewrite `lessons/unified_motor/cross-section-render.js` to read
  **`runtime.stack.sliceMesh(k)`** + **`runtime.lastSolve.perSliceField[k]`**
  (Phase 5 D2/D3) and the `UM.fieldViz` toggle state, dispatching to the
  new `motor-mesh-view.js` methods; register the 2-D seam
  `UM.registerCrossSection2D({paint(mountCtx, canvases, rctx)})` from this
  file. In `mount.js`: add the new seam slot + register function (mirroring
  `RENDER3D`), replace the body of `drawCrossSection` with a seam-dispatch
  (placeholder text when not registered), and delete the dead built-in grid
  rig `else` branch in `frame()` plus the orphaned helpers
  `drawFeatureSectors2D` / `drawFeatureSectors3D` / `fillSector2D` /
  `fillSector3D` / `drawSlotConductors3D` / `drawRing3D` / `ringPoints` /
  `featureColor` / the `KIND_COLORS` table. The existing built-in
  Compiled-overlay header control in `cross-section-render.js` is replaced
  by the D3 "Field view" header control (six independent checkboxes
  writing to `UM.fieldViz`).

- **Files to create**:
  - `tests/render/_fixtures.js` — `"use strict";` `if (!globalThis.window)
    globalThis.window = globalThis;` then in order (Phase 5's
    `tests/slice/_fixtures.js` is the template — no DOM): `require` shim,
    `util.js`, `winding-model.js`, `excitation.js`, `motor-circuit.js`,
    `motor-mesh.js`, `motor-mesh-view.js`, `airgap-harmonic.js`,
    `gap-eval.js`, `fea-solver.js`, `motor-slice.js`, `motor-stack.js`,
    `motor-run.js`, `config-schema.js`, then (Phase 6 mounts the live
    panels in JSDOM-lite for some tests) the four
    `lessons/unified_motor/{cross-section-render,render3d,matrix-panel,
    machine-picker}.js` files — gated by a `if (!process.env.RENDER_TESTS_
    HEADLESS_ONLY) try { require } catch(e) {}` so the Wave-6.1 tests can
    drive the prod render without forcing JSDOM. Exports:
    - `LIB`, `UnifiedMotor`, `CS`, `loadMachine(id)`, `sectionFromConfig`,
      `polesFromConfig`, `feaOpts(extra)`, `initSolver`,
      `assertClose`, `relErrInf`.
    - `recordingCtx() → { ctx, log }` — a 2-D context mock that **records**
      every method call (with arguments) and every state-property assignment
      (`fillStyle`/`strokeStyle`/`globalAlpha`/`lineWidth`/`font`/
      `textAlign`/`textBaseline`) into `log: Array<{op: string, args?: any[],
      key?: string, value?: any}>` in order; `ctx.canvas = { width, height
      }`; every drawing method is a no-op. Used in mesh-view + cross-section
      tests to assert call counts + draw order without a real DOM.
    - `dummyMountCtx(runtime, config) → mountCtx` — `{ runtime, config,
      view:{yaw:0, pitch:0, dist:0.25}, requestRebuild: () => {} }`.
    - `dummyRctx(runtime, expanded, W, H) → rctx` — `{ runtime, config:
      expanded.config, expanded, W, H }`.
    - `solveOnce(slice, theta, currents)` — `await initSolver(); return
      slice.solve(theta, currents);` (used to populate `lastSolve` before
      render).
  - `tests/render/mesh-view-prod.test.js` — `node:test` + `node:assert/strict`.
  - `tests/render/cross-section-render.test.js` — `node:test` +
    `node:assert/strict`.
  - `tests/render/mount-2d-seam.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**:
  - `lib/motor-mesh-view.js` — extend `LIB.MotorMeshView` with these
    additions (the Phase 2 `colorFor` and `draw` stay; everything below is
    new):
    - `drawMaterial(ctx, bodyMesh, opts)` — element fill by
      `materials[matId].kind`, replacing the Phase 2 `draw`'s default
      coloring. `opts = { palette?, alpha=1, lineWidth=0.5, stroke=true }`.
    - `drawFluxLines(ctx, bodyMesh, Anode, opts)` — marching-squares
      iso-contour over `Anode` on the body's elements. `opts = { levels:
      number | number[] (default 12 evenly spaced over Anode's min..max),
      color="rgba(255,255,255,0.7)", lineWidth=1 }`.
    - `drawModulusB(ctx, bodyMesh, Belem, opts)` — per-element fill by
      `Belem.mag` mapped through a viridis-like colormap. `opts = { range:
      [number,number] | "auto", alpha=0.85 }`.
    - `drawSaturation(ctx, bodyMesh, Belem, opts)` — per-iron-element fill
      by `Belem.mag[e] / Bknee_eff` (D4). `opts = { BkneeDefault=1.6,
      alpha=0.85 }`. Non-iron elements are not drawn by this method.
    - `drawMagnetization(ctx, bodyMesh, opts)` — arrow per magnet element
      from its centroid along `magDir`, length proportional to
      `materials[matId].mrMag`. `opts = { arrowLenPx=8, color }`.
    - `drawCurrentDensity(ctx, bodyMesh, currents, opts)` — dot/cross glyph
      per conductor element at its centroid; color from a palette by
      `srcId`, glyph by `sign(currents[srcId] · turns)`. `opts = {
      palette?, glyphRadiusPx=4 }`.
    - `drawGapLoop(ctx, bodyMesh, opts)` — already present from Phase 2;
      keep.
    - All methods are pure-functional drawing — they read the inputs, draw,
      and return nothing. None mutate the mesh.
    - The Phase-2 `colorFor` and `draw` are preserved (the mesh-dev harness
      still calls them); the new methods are additive.
  - `lessons/unified_motor/cross-section-render.js` — full rewrite of
    `drawSemantic` and `register`; **delete** `compileForOverlay`,
    `drawCompiledOverlay`, `buildGeometry`, `resolveWinding`, the
    `circuitColor` palette wiring at the file's old call sites (the new
    `motor-mesh-view.drawCurrentDensity` owns palette logic), the
    "Compiled overlay" header-control registration, and the
    `MotorCompile`/`UM.ConfigSchema.expand` overlay path. The new file:
    - Exports `UM.CrossSectionRender = { paint, register }`.
    - `paint(mountCtx, canvases, rctx)` — the seam entry: for each canvas
      (`canvases[0]` ← slice 0, `canvases[1]` ← slice 1 if expanded.slices
      ≥ 2 else slice 0 again), fit DPR, clear, look up
      `rctx.runtime.stack.sliceMesh(k)` (static) and
      `rctx.runtime.lastSolve?.perSliceField[k]` (per-frame, may be null
      before the first solve). Apply the rotor's `field.gap.phi` (or
      `rctx.runtime.state.theta` if `lastSolve` is null) as a body-local
      rotation when drawing the rotor mesh. Compose the overlays in this
      fixed order (each gated on `UM.fieldViz`): material → saturation →
      modulusB → magnetization → currentDensity → fluxLines (and R5
      analytic gap fill via `LIB.GapEval.evalA` sampled across the
      annulus, drawn as additional iso-contours bridging the rotor and
      stator mesh's flux lines) → gapLoop overlay (when `UM.fieldViz.gapLoop`).
      Both canvases are repainted on every `paint`.
    - `register(UM)` — registers the 2-D seam via
      `UM.registerCrossSection2D({paint})` and registers the D3 header
      control via `UM.registerHeaderControl({id:"field-view", build:
      buildFieldViewToggles})` (five checkboxes; writes to
      `UM.fieldViz`).
    - `buildFieldViewToggles(host, ctx)` — six labeled checkboxes wired
      to `UM.fieldViz.fluxLines`, `.modulusB`, `.saturation`,
      `.magnetization`, `.currentDensity`, and `.gapLoop` (the
      mesh-structural gap-circle overlay). Initializes `UM.fieldViz` with
      D3's default state (six fields) if not already present. Returns an
      `unmount` function that detaches listeners.
    - `register(UM)` is called at file load (guarded by
      `if (UM.registerHeaderControl)`).
  - `lessons/unified_motor/mount.js` — surgical changes (every other line
    byte-identical):
    1. After `if (UM.RENDER3D === undefined) UM.RENDER3D = null;` add
       `if (UM.CROSS_SECTION_2D === undefined) UM.CROSS_SECTION_2D = null;`.
    2. After `UM.registerRender3D = function …`, add
       `UM.registerCrossSection2D = function (entry) { UM.CROSS_SECTION_2D
       = entry; };`.
    3. Add `if (!UM.fieldViz) UM.fieldViz = { fluxLines:true,
       modulusB:false, saturation:false, magnetization:false,
       currentDensity:false, gapLoop:false };` immediately after the
       seam-init block (six fields; mirrors D3's locked initial state so
       the registrant in `cross-section-render.js` finds the same shape
       it expects).
    4. **Delete** the entire body of `drawCrossSection(canvas, features,
       field, grid, thetaR, currents, label)` and replace with a
       seam-dispatch wrapper invoked from `frame()`. Remove
       `drawCrossSection` itself as a separate function. In `frame()`,
       replace the two `drawCrossSection(...)` calls + the surrounding
       slice-0/slice-1 selection block with a single
       `if (UM.CROSS_SECTION_2D) {
          UM.CROSS_SECTION_2D.paint(buildCtx(), [canvas2DA, canvas2DB],
            dummyRctx)
        } else {
          paint2DPlaceholder(canvas2DA, "no 2-D renderer");
          paint2DPlaceholder(canvas2DB, "no 2-D renderer");
        }` (with `dummyRctx = { runtime, config, expanded, W: <auto>,
       H: <auto> }`). A tiny `paint2DPlaceholder(canvas, label)` helper
       fills the canvas with `--panel` background and centers the label
       text — about ten lines.
    5. **Delete** the dead `else` branch in `frame()` that draws the
       built-in grid 3-D rig (the block beginning `// Built-in rig:
       machine structural geometry + gap-field heatmap overlay.` through
       its closing `}`); the `if (UM.RENDER3D) { UM.RENDER3D.paint(...) }`
       branch is the only remaining 3-D path. The mount-time
       precondition (an actual `RENDER3D` is registered before the first
       frame) is satisfied by D9 (the `<script>` tag for `render3d.js`
       loads before `runTabs`).
    6. **Delete** these now-orphan helpers, with their `const KIND_COLORS`
       table and the comment headers immediately above them: `featureColor`,
       `fillSector2D`, `drawFeatureSectors2D`, `ringPoints`, `drawRing3D`,
       `fillSector3D`, `drawFeatureSectors3D`, `drawSlotConductors3D`.
    7. **Delete** the local `smoothedMagScale` variable + the
       `let smoothedMagScale = 1;` declaration + the per-frame
       `smoothedMagScale` update block (it fed the deleted built-in rig).
    8. The `circuits` / `mechanical` / `applyDrive` / `reapplyDrive` /
       `requestRebuild` / `buildCtx` / plots / readouts / pointer / reset /
       pause / unmount logic is unchanged.
    9. **Stepping is wall-budgeted, not fixed-cadence.** `PHYS_DT` and
       `STEPS_PER_FRAME` are removed. Each frame advances the sim by
       `orderedStepDt` of SIM-time (the "ordered speed" — a Playback slider,
       default `1/240` s) via a single `runtime.step(orderedStepDt,
       FRAME_BUDGET_MS)`; the engine's adaptive loop bails after
       `FRAME_BUDGET_MS = 30` ms of WALL-time (always after ≥1 solve), so a
       heavy commutation transient never stalls the frame. When the cap lands
       the frame short of `orderedStepDt` the sim is playing below the ordered
       speed → a header **slow-motion warning** shows the achieved fraction.
       This needs the engine seam `runtime.step(dt, wallBudgetMs?)`
       (`lib/motor-run.js`): when `wallBudgetMs` is given the internal solve
       loop breaks once that much wall-time has elapsed; omitted → deterministic
       full-`dt` coverage (the path every test drives).

- **Tests**:
  - `tests/render/mesh-view-prod.test.js`:
    - `"drawMaterial fills one polygon per element"` — load `pmsm` via
      `loadMachine`; `mesh = LIB.MotorMesh.build(sectionFromConfig(cfg)).
      rotor`; `const { ctx, log } = recordingCtx();
      LIB.MotorMeshView.drawMaterial(ctx, mesh, {})`; assert
      `log.filter(e => e.op === "fill").length === mesh.elems.length / 4`.
    - `"drawFluxLines emits stroke calls proportional to levels"` — same
      mesh; `Anode = new Float64Array(mesh.nodes.length / 2)` filled with
      `cos(2 * atan2(y, x))` per node (a smooth field with content across
      multiple iso-levels);
      `LIB.MotorMeshView.drawFluxLines(ctx, mesh, Anode, { levels: 8 })`;
      assert `log.filter(e => e.op === "stroke").length >= levels - 1`
      (proportionality of contours to level count — hard assertion: a
      working marching-squares pass produces at least one stroke per
      threshold band that the field actually crosses, and the smooth
      `cos(2θ)` field crosses every band) and
      `log.filter(e => e.op === "stroke").length <= levels * (mesh.elems.length / 4)`
      (sanity upper bound).
    - `"drawFluxLines emits no strokes for a constant Anode"` — `Anode`
      filled with `1.0` everywhere; assert no `stroke` operations issued
      by the marching pass (degenerate iso-contours emit nothing).
    - `"drawModulusB respects `range:'auto'` extent"` — `Belem.mag =
      new Float64Array(mesh.elems.length / 4)` filled with linearly
      increasing values 0..1; assert at least one element gets the
      colormap's lowest color and one gets the highest (`fillStyle` log
      entries span at least two distinct strings).
    - `"drawSaturation only shades iron elements"` — mesh built from
      `pmsm` (has iron + magnet + conductor + air); after calling
      `drawSaturation(ctx, mesh, Belem, {})`, the count of `fill` ops
      equals the count of elements whose `materials[matId].kind === "iron"`,
      and zero `fill` ops are issued for non-iron elements.
    - `"drawSaturation uses BkneeDefault when material.Bknee is null"` —
      synthetic mesh whose only iron material has `Bknee:null`; render
      with `Belem.mag[0] = 1.6`; assert the fill color at element 0 is
      the colormap's mid-band (`|B|/Bknee_eff === 1.0`).
    - `"drawMagnetization emits one arrow per magnet element"` — mesh
      from `pmsm`; `recordingCtx`; call `drawMagnetization(ctx, mesh,
      {})`; count `moveTo + lineTo` pairs and assert it equals
      `(count of magnet elements) * (1 line + 2 arrowhead lines == 3)` —
      tolerate ±1 in case of arrowhead variants by asserting `>=
      magnetElemCount * 3`.
    - `"drawCurrentDensity emits one glyph per conductor element"` —
      mesh from `pmsm` (3-phase wound stator); `currents =
      new Float64Array([5, -2.5, -2.5])`; recording ctx;
      `drawCurrentDensity(ctx, mesh, currents, {})`; count `arc`
      operations and assert it equals the conductor element count.
    - `"drawCurrentDensity flips glyph with current sign"` — same setup
      with `currents = [5, …]` vs `[-5, …]`: the recording log for the
      first conductor element's draw block contains different stroke
      structure (cross when product is negative, dot when positive).

  - `tests/render/cross-section-render.test.js`:
    - `"register() installs the 2-D seam"` — `UM.CROSS_SECTION_2D = null`;
      `UM.CrossSectionRender.register(UM)`; assert
      `typeof UM.CROSS_SECTION_2D.paint === "function"`.
    - `"register() installs the field-view header control"` — clear
      `UM.HEADER_CONTROLS = []`; call `register(UM)`; assert one entry
      with `id === "field-view"`; calling its `build(host, ctx)` against
      a JSDOM-lite host returns a function (the unmount), and
      `UM.fieldViz` is initialized to D3's defaults (`fluxLines: true,
      modulusB: false, saturation: false, magnetization: false,
      currentDensity: false, gapLoop: false`).
    - `"paint clears and draws the rotor + stator on each canvas"` —
      build a slice end-to-end via `await initSolver(); cfg =
      loadMachine("pmsm"); expanded = CS.expand(cfg); runtime =
      LIB.MotorRun.create(expanded, feaOpts({poles: expanded.poles}));
      runtime.step(1/240);`. Two recording-ctx canvases;
      `UM.CrossSectionRender.paint(dummyMountCtx(runtime, cfg),
      [canvas2DA, canvas2DB], dummyRctx(runtime, expanded, 600, 600));`.
      Assert each canvas's log starts with a `clearRect`/`fillRect`
      background, has ≥ `(Ne_rotor + Ne_stator) / 4` `fill` ops (one per
      element across both bodies in the slice-0 view), and ends after
      drawing the gapLoop overlay.
    - `"paint dispatches each viz toggle"` — set `UM.fieldViz =
      {fluxLines:false, modulusB:true, saturation:false, magnetization:
      false, currentDensity:false}`; run `paint`; assert the recorded log
      contains the modulus-B colormap calls (look for the colormap's
      characteristic `fillStyle` sequence) and **does not** contain any
      stroke pattern matching `drawFluxLines` (no `stroke` ops on
      open polylines inside the body interior).
    - `"paint paints a placeholder when lastSolve is null"` — fresh
      `runtime` without calling `step()`; assert `paint` does not throw,
      and the rendered canvases contain the static material/glyph layer
      but no field overlay (no fill ops with the |B| colormap signature).
    - `"paint rotates the rotor mesh by gap.phi"` — same setup; after
      one `runtime.step(1/240)` solve at `state.theta === 0`, capture
      the rotor's first-element four corner positions from the
      recording-ctx log; advance ten `runtime.step(0.01)` calls so
      `state.theta > 0.05`; re-paint and capture; assert at least one
      corner's `(x,y)` has changed by `> 1e-3` (the rotor visibly
      rotated).
    - `"no DOM access at module load"` — re-require
      `lessons/unified_motor/cross-section-render.js` with
      `globalThis.window = globalThis` and no `document`; the require
      succeeds; `register` defines `UM.CrossSectionRender = {paint,
      register}` but does NOT call `register(UM)` (the auto-call is
      guarded by `if (UM.registerHeaderControl)` which is absent).
    - `"no machine names in the rewritten file"` — `cat
      lessons/unified_motor/cross-section-render.js`; grep for each entry
      in the `MACHINE_NAMES` list from `tests/pipeline/_fixtures.js`;
      assert zero hits.

  - `tests/render/mount-2d-seam.test.js`:
    - `"mount.js exposes UM.CROSS_SECTION_2D and registerCrossSection2D"`
      — `delete window.UnifiedMotor; require('../../lessons/unified_
      motor/mount.js');` assert `UM.CROSS_SECTION_2D === null` and
      `typeof UM.registerCrossSection2D === "function"`.
    - `"registerCrossSection2D stores the entry"` — fresh require;
      `UM.registerCrossSection2D({ paint: () => {} })`; assert
      `UM.CROSS_SECTION_2D && typeof UM.CROSS_SECTION_2D.paint ===
      "function"`.
    - `"UM.fieldViz initialized at mount.js load"` — fresh require;
      assert `UM.fieldViz` deep-equals `{ fluxLines:true, modulusB:false,
      saturation:false, magnetization:false, currentDensity:false, gapLoop:false }`.
    - `"the four legacy seams remain"` — fresh require; assert
      `Array.isArray(UM.PANELS)`, `Array.isArray(UM.TOOLS)`,
      `Array.isArray(UM.HEADER_CONTROLS)`, `UM.RENDER3D === null`, and
      `typeof UM.registerRender3D === "function"`.
    - `"mount.js no longer references the deleted built-in helpers"` —
      read the file as text; assert it contains zero matches for each of
      `featureColor`, `fillSector2D`, `drawFeatureSectors2D`,
      `drawFeatureSectors3D`, `fillSector3D`, `drawSlotConductors3D`,
      `drawRing3D`, `ringPoints`, `KIND_COLORS`, `smoothedMagScale`,
      `sliceGrid`, `.perSliceField[`, `field.Br`, `field.Bt`, and
      `drawGapField`.

- **Acceptance criteria**:
  - `lib/motor-mesh-view.js` exposes the seven new production methods
    (`drawMaterial`, `drawFluxLines`, `drawModulusB`, `drawSaturation`,
    `drawMagnetization`, `drawCurrentDensity`, `drawGapLoop`) reading only
    `BodyMesh` + per-element field arrays + `runtime.state.i`. The Phase 2
    `colorFor`/`draw` surface is preserved byte-stable.
  - `cross-section-render.js` registers a single
    `UM.registerCrossSection2D` entry and a single `field-view` header
    control; renders both canvases mesh-native; reads only Phase-5
    `lastSolve.perSliceField[k]` + `runtime.stack.sliceMesh(k)`; contains
    no grid-coupled symbol (`sliceGrid`, `perSliceField.Br/.Bt`,
    `drawGapField`, `MotorCompile`).
  - `mount.js` carries the additive seam (`UM.CROSS_SECTION_2D`,
    `registerCrossSection2D`, `UM.fieldViz`), dispatches its 2-D canvases
    through the seam, and has zero references to the deleted built-in
    grid rig (the audit in `mount-2d-seam.test.js` `"no longer
    references..."` returns clean).
  - All listed tests pass.
  - No machine names in any modified file (grep audit, in-test).
  - No DOM/canvas access at module load in `lib/motor-mesh-view.js` or
    `cross-section-render.js`.

---

## Wave 6.2: 3-D rig + rotation + analytic in-gap field + script-tag wiring (R4+R5)

### Task T6.2.1: `render3d.js` + `lib/gap-eval.js` + `index.html` boot await and script tags

- **Description**: Create `lessons/unified_motor/render3d.js` — the
  axial-extrusion 3-D rig that registers `UM.RENDER3D`. The rig consumes
  `runtime.stack.sliceMesh(k)` for each slice and the
  `runtime.lastSolve.perSliceField[k]` field bundle; rotor meshes are
  rigidly rotated by `field.gap.phi` in the projection step (mesh nodes
  unchanged); end-windings are arcs over the stack ends connecting each
  conductor element's go-side to its return-side (the existing slot
  conductor pattern, projected); the unmeshed gap annulus is painted by
  sampling `LIB.GapEval.evalA(...)` on a polar grid (R5) so the cross-gap
  flux lines are exact. Field-viz mode toggles are consulted via
  `UM.fieldViz` (same shared state that drives the 2-D view). Create
  `lib/gap-eval.js` — the pure R5 helper. Modify `index.html` for the boot
  await and the D9 script tags.

- **Files to create**:
  - `lib/gap-eval.js` — IIFE attaching `window.LIB.GapEval = { evalA,
    evalAOnGrid }`.
    - `evalA(gap, r_mr, r_ms, r, theta) → Az` — D5 closed form. `gap =
      { harmonics:{ rotor:{a:Float64Array(K+1), b:Float64Array(K+1)},
      stator:{a:…, b:…} }, phi: number }`. Throws if `r < r_mr - 1e-9` or
      `r > r_ms + 1e-9` (the helper is for the unmeshed annulus only;
      callers clamp).
    - `evalAOnGrid(gap, r_mr, r_ms, opts) → { rs:Float64Array(Nr),
      thetas:Float64Array(Ntheta), Az:Float64Array(Nr*Ntheta) }` — sample
      `evalA` on a uniform polar grid. `opts = { Nr=8, Ntheta=64 }`
      (small by design; the gap annulus is thin).
    - DOM-free; no top-level `require`; no machine identity.
  - `lessons/unified_motor/render3d.js` — IIFE attaching
    `UM.Render3D = { register, paint }`.
    - `paint(mountCtx, L3, rctx)` — the `UM.RENDER3D` entry. For each slice
      `k` in `rctx.expanded.slices`: project the stator mesh (fixed) and
      the rotor mesh (rotated rigidly by
      `mountCtx.runtime.lastSolve?.perSliceField[k]?.gap.phi ??
      mountCtx.runtime.state.theta`) at `planeZ = slices[k].offset`; draw
      the material layer (per `UM.fieldViz` toggles, using projected
      polygons fed into the same overlay logic as
      `motor-mesh-view.draw{Material,ModulusB,Saturation,Magnetization,
      CurrentDensity}` — the 3-D version uses a small inline polygon
      projector since the 2-D helpers assume a flat ctx). Then draw the
      end-windings (Wave-6.2 implementation detail: for every conductor
      element pair `(go, return)` of the same `srcId` whose centroid
      angles bracket a 2π/p · k arc, draw a 3-D arc over each stack end
      face — simple constant-radius arcs in the `z = ±ell/2` planes).
      Finally paint the gap-fill (R5) when `UM.fieldViz.fluxLines` is on:
      call `LIB.GapEval.evalAOnGrid(field.gap, rotor.mesh.gapR,
      stator.mesh.gapR, {Nr:6, Ntheta:96})` per slice; march iso-contours
      across that grid; project into the slice plane.
    - `register(UM)` — calls `UM.registerRender3D({paint})` once at load
      time (guarded by `if (UM.registerRender3D)`).
  - `tests/render/gap-eval.test.js` — `node:test` + `node:assert/strict`.
  - `tests/render/render3d.test.js` — `node:test` + `node:assert/strict`.

- **Files to modify**:
  - `lessons/unified_motor/index.html` — two changes (D8 + D9):
    1. Replace `<script>` at the very bottom (currently
       `LIB.App.runTabs({title:"Unified Motor", tabs:[{label:"unified-motor",
       mount: window.UnifiedMotor.mount}]});`) with
       `LIB.FeaSolver.init().then(function () {
          LIB.App.runTabs({ title: "Unified Motor", tabs:
            [{ label: "unified-motor", mount: window.UnifiedMotor.mount }] });
        });`.
    2. Insert D9's library tags between
       `<script src="./config-schema.js"></script>` and
       `<script src="../../lib/motor-stack.js"></script>`, in this order
       (so `motor-slice.js` finds `motor-mesh`/`airgap-harmonic`/
       `fea-solver`/`gap-eval` already loaded):
       ```
       <script src="../../lib/fea-solver.js"></script>
       <script src="../../lib/motor-mesh.js"></script>
       <script src="../../lib/motor-mesh-view.js"></script>
       <script src="../../lib/airgap-harmonic.js"></script>
       <script src="../../lib/gap-eval.js"></script>
       <script src="../../lib/motor-slice.js"></script>
       ```
       (Note: Phase 0 removed `../../lib/motor-slice.js` and the four
       grid libs; Phase 6 re-introduces `motor-slice.js` here as the
       FEA-native one, alongside the new lib tags.)
       Insert D9's panel tags between `<script src="./mount.js"></script>`
       and the first `<script src="./machines/pmsm.js"></script>`:
       ```
       <script src="./cross-section-render.js"></script>
       <script src="./render3d.js"></script>
       <script src="./matrix-panel.js"></script>
       <script src="./machine-picker.js"></script>
       ```
       The HTML-comment markers `<!-- unified-motor modules: later phases
       append <script> tags below this line ONLY -->` and `<!-- /unified-motor
       modules -->` are preserved at their existing positions.

- **Tests**:
  - `tests/render/gap-eval.test.js`:
    - `"evalA reproduces a manufactured analytic field"` — pick a known
      `A(r,θ) = a_0 + b_0·ln(r/r_mr)·… + Σ (α_k r^k + β_k r^{-k})(cos kθ
      α_a,k + sin kθ α_b,k)` for K=4, `r_mr=0.045`, `r_ms=0.051`; sample
      it at the rotor and stator circles (uniform `Ntheta=64`); compute
      `aRotor, bRotor = AH.project(rotorTheta, ArotorNodal)` (and same
      for stator); apply `phi=0`; build `gap = { harmonics:{rotor,stator},
      phi:0 }`; assert
      `relErrInf(evalAOnGrid(gap, r_mr, r_ms, {Nr:8, Ntheta:64}).Az,
      analyticAzOnSameGrid) < 1e-9` (analytic ↔ analytic round-trip).
    - `"evalA honors rotor phase φ"` — same setup; rotate the rotor's
      boundary data by `φ=0.4` (sample the field at `θ−φ`); compute its
      `aRotor, bRotor`; build `gap` with `phi=0.4`; assert `evalA(gap,
      r_mr, r_ms, r=(r_mr+r_ms)/2, θ=0.3)` agrees with `evalA(gap_phi0,
      r_mr, r_ms, r, θ=0.3 + φ_correction)` — operationally: an
      out-of-band check confirms `evalA` at `phi=0.4` matches the
      manufactured field's value at `(r, θ)` to within 1e-9.
    - `"evalA throws outside the annulus"` — assert `() => evalA(gap,
      r_mr, r_ms, r_mr - 1e-3, 0.0)` throws; same for
      `r_ms + 1e-3`. Within the closed interval `[r_mr, r_ms]` evalA
      returns finite.
    - `"k=0 mode interpolates linearly in ln(r)"` — `aRotor =
      [1, 0,…,0]`, `aStator = [3, 0,…,0]`, all `b` zero; assert
      `evalA(gap, r_mr, r_ms, r_mid, 0.0) === 1 + (3-1) *
      ln(r_mid/r_mr)/ln(r_ms/r_mr)` within 1e-9 for several `r_mid`.
    - `"no DOM access on module load"` — assert `LIB.GapEval` materializes
      with `globalThis.window = globalThis`.

  - `tests/render/render3d.test.js`:
    - `"register installs UM.RENDER3D"` — fresh seam state;
      `UM.Render3D.register(UM)`; assert `UM.RENDER3D &&
      typeof UM.RENDER3D.paint === "function"`.
    - `"paint draws stator and rotor meshes per slice"` — run a real
      end-to-end solve (`await initSolver(); cfg = loadMachine("pmsm");
      runtime = LIB.MotorRun.create(CS.expand(cfg), feaOpts({poles:4}));
      runtime.step(1/240);`); recording ctx; construct an
      `LIB.Layout3D.orbital` projection; call `UM.RENDER3D.paint(
      mountCtx, L3, rctx)`; assert `fill` ops issued at least
      `Ne_rotor + Ne_stator` times across the rotor + stator meshes
      (mesh-native material layer).
    - `"paint rigidly rotates the rotor mesh"` — same setup at θ=0,
      capture the first projected rotor-element vertex; advance ten
      runtime steps so theta moves perceptibly; re-paint; assert the
      first projected vertex shifted by ≥ 1 px.
    - `"paint paints analytic gap when fluxLines is on"` — `UM.fieldViz
      = { …all-false, fluxLines:true }`; recording ctx; `paint`; assert
      the recorded log contains polylines whose vertex `(x,y)` coordinates
      fall strictly inside the projected annulus (between rotor.gapR and
      stator.gapR) — at least one such polyline per slice.
    - `"paint omits the analytic gap when fluxLines is off"` — same
      setup but `UM.fieldViz.fluxLines = false`; assert the recorded log
      contains NO polylines whose vertices lie in the gap annulus.
    - `"paint paints a placeholder when lastSolve is null"` — fresh
      `runtime` without stepping; assert `paint` does not throw and
      issues some `fill` calls (the material layer) but no
      polyline strokes from the analytic gap (no field data).
    - `"no DOM access on module load"` — assert `UM.Render3D` materializes
      with `globalThis.window = globalThis`.
    - `"no machine names"` — grep audit on `render3d.js`.

- **Acceptance criteria**:
  - `lib/gap-eval.js` reproduces a manufactured analytic in-gap field to
    `< 1e-9` and honors the rotor phase `φ`; throws cleanly outside the
    annulus.
  - `render3d.js` registers exactly one `UM.RENDER3D` entry; paints rotor
    + stator meshes per slice, rotates the rotor rigidly by
    `field.gap.phi`, and overlays the analytic gap iso-contours when
    `UM.fieldViz.fluxLines` is on.
  - `index.html` awaits `LIB.FeaSolver.init()` before `LIB.App.runTabs`;
    contains the six new `lib/*` script tags and the four new
    `lessons/unified_motor/*` panel tags; passes the Phase 0 retained-tag
    list audit unchanged for the surviving non-grid scripts.
  - All listed tests pass.
  - No DOM access at module load in either new file; no machine-identity
    branch in either.

---

## Wave 6.3: Machine picker + geometry sliders + material card

### Task T6.3.1: `machine-picker.js` (header control) + matrix-panel geometry/material extension + gap-length slider

- **Description**: Create `lessons/unified_motor/machine-picker.js` — a
  header control that reads `UM.MACHINES` and loads the chosen fixture
  config into the live `ctx.config` in place (deep-copy of `rings`,
  `circuits`, `stack`, `grid`, `mechanical`, `poles`, `label`), then calls
  `ctx.requestRebuild()`. Extend `matrix-panel.js` with:
  - Two collapsed expander cards per ring (Geometry + Material) per D6.
  - A global gap-length slider (`g`) using the pure
    `applyGapLength(config, g)` helper defined inside `matrix-panel.js`
    (derived split symmetric around the existing mid-gap).
  - The existing `synthesize` / `deriveTogglesFromConfig` flow extended to
    round-trip the new per-ring fields (`rRange`, `teeth`/`magnets`/`Q`,
    `muR`, `Mr`, `Bknee`) — the snapshot stored in
    `config.matrixState.rings` carries them so subsequent reads honor the
    user's edits.
  Both files register through the existing seams (panel via
  `UM.registerPanel`; picker via `UM.registerHeaderControl`); **no
  `mount.js` change in this wave** (it was added to Files Owned in
  Wave 6.1; 6.3 does not touch it).

- **Files to create**:
  - `lessons/unified_motor/machine-picker.js` — IIFE.
    - `MUTABLE_KEYS = ["rings", "circuits", "stack", "grid", "mechanical",
      "poles", "label"]`.
    - `applyFixture(ctx, fixture) → void` — for each key in
      `MUTABLE_KEYS`, `ctx.config[key] = structuredClone(fixture.config[key])`
      (or a small in-file `deepCopy` if Node's structuredClone isn't
      assumed); also strips `ctx.config.matrixState` (so the matrix panel
      derives fresh from the new config). Then calls
      `ctx.requestRebuild()`.
    - `buildPicker(host, ctx)` — builds a `<select>` populated from
      `UM.MACHINES` (`[{id, label, config}, …]`) plus a leading "current"
      option; on `change`, looks up the fixture by `id` and calls
      `applyFixture(ctx, fixture)`. Returns an unmount that removes the
      element.
    - `register(UM)` — `UM.registerHeaderControl({id:"machine-picker",
      build: buildPicker})`. Auto-call guarded by
      `if (UM.registerHeaderControl)`.
    - Exports: `UM.MachinePicker = { applyFixture, buildPicker, register,
      MUTABLE_KEYS }`.

  - `tests/ui/_fixtures.js` — small JSDOM-lite shim for headless
    UI testing. Exports:
    - `installDomShim()` — installs minimal `document`/`HTMLElement`
      polyfills on `globalThis` so the panel/picker `build(host, ctx)`
      paths run headless. The shim implements `createElement(tag) → {
      tagName, style:{}, children:[], appendChild, removeChild, addEventListener,
      removeEventListener, getAttribute, setAttribute, innerHTML='',
      value, checked, textContent, type, options:[], … }` — enough for
      the panel + picker code paths and for assertions to inspect the
      built DOM tree (the tests read the tree directly, never simulate
      pixel events).
    - `dispatch(el, type, payload?)` — invoke the `type` event listener
      registered on `el` (no bubble, no capture); used to simulate a
      `<select>` `change` event in picker tests.
    - `findFirst(root, predicate) → el | null`.
    - `loadConfigSchema()` — `require` chain that makes
      `UnifiedMotor.ConfigSchema` available headless (`util.js`,
      `winding-model.js`, `config-schema.js`).
    - `LIB`, `UM`, `loadMachine(id)`, `loadAllMachines()`,
      `seedDefaultConfig()` (returns `mount.js`'s `makeDefaultConfig`).
    - `freshMount() → { ctx, rebuildCalls }` — installs the DOM shim,
      seeds a `config = seedDefaultConfig()`, and returns a `ctx` shape
      mirroring what `mount.js`'s `buildCtx()` produces:
      `{ runtime: null, config, view: {…}, requestRebuild: () => { rebuildCalls.count++ } }`.
      Used so the panel + picker can drive `applyChange` /
      `applyFixture` without standing up a full runtime.

  - `tests/ui/matrix-panel-geometry.test.js` — `node:test`.
  - `tests/ui/matrix-panel-material.test.js` — `node:test`.
  - `tests/ui/machine-picker.test.js` — `node:test`.

- **Files to modify**:
  - `lessons/unified_motor/matrix-panel.js`:
    1. Extend `toggleSpace()` to also return `geometryFields` and
       `materialFields` keyed by element kind:
       `geometryFields = { I:["rRange[0]","rRange[1]","teeth"], M:[…],
       W:[…], C:[…], K:[…] }`;
       `materialFields = { I:["muR","Bknee"], M:["muR","Mr"],
       W:["muR","Bknee"], C:["muR","Bknee"], K:["muR","Bknee"] }` —
       pure metadata, no UI here.
    2. Extend `synthesize(toggles, base)` to honor explicit `rRange`,
       `teeth`/`magnets`/`Q`, `muR`, `Mr`, `Bknee`, and `gapLength` (`g`)
       carried on `toggles` — these override the current
       `computeRRange` even-split logic when present, and pass through
       into the configRing entries unchanged. `gapLength` triggers
       `applyGapLength(synthesizedConfig, g)` as the final step before
       returning.
    3. Add a pure helper `applyGapLength(config, g) → config` (mutates
       in place and returns):
       - Partition rings using the existing `ring.member` field (already on every
         `config.rings[]` entry per `config-schema`'s ring contract;
         values: `"rotor"` or `"stator"`). No new schema field is added —
         this finding originally proposed adding `ring.body`, but the
         existing `ring.member` already serves this purpose. The
         `applyGapLength` helper reads `ring.member` directly; no
         `config-schema.js` change and no fixture-file change is needed.
       - `r_rotor_surface = max(ring.rRange[1] for ring in config.rings if ring.member === "rotor")`.
       - `r_stator_bore = min(ring.rRange[0] for ring in config.rings if ring.member === "stator")`.
       - Current mid-gap `r_mid = (r_rotor_surface + r_stator_bore) / 2`.
       - Desired: `r_rotor_surface_new = r_mid − g/2`,
         `r_stator_bore_new = r_mid + g/2`.
       - For every ring with `ring.member === "rotor"`, shift its `rRange`
         by `(r_rotor_surface_new − r_rotor_surface)`.
       - For every ring with `ring.member === "stator"`, shift its `rRange`
         by `(r_stator_bore_new − r_stator_bore)`.
       - Update `config.grid.rInner` to the smallest rotor `rRange[0]`,
         `config.grid.rOuter` to the largest stator `rRange[1]`.
       - **Re-verify harmonic-gap adequacy (added 2026-05-27).** After
         the gap-shift, compute `K = LIB.AirgapHarmonic.defaultK(slots,
         poles)` and `N_gap = 4·K + nBandsPerSector·P_body` (the Phase 4
         `N_gap ≥ 4K` Nyquist-plus-margin floor). If the post-shift
         geometry would mesh with `N_gap < 4·K`, throw with a message
         naming the resulting gap, the required `N_gap` floor, and the
         user-facing remedy ("increase gap length, reduce harmonic
         truncation, or accept aliasing"). The user's slider drag from a
         comfortable 4 mm gap to a tight 0.1 mm gap can otherwise
         silently invalidate the harmonic truncation that was adequate
         at 4 mm; the throw forces the slider's drag handler to clamp
         or warn rather than producing a wrong field.
       - Throws if any ring lacks a `member` field, if any `member` value
         is neither `"rotor"` nor `"stator"`, or if the resulting radii
         are non-positive or non-increasing.
    4. Extend `deriveTogglesFromConfig(config)` to also read each ring's
       current `rRange`, `teeth`/`magnets`/`Q`, `muR`, `Mr`, `Bknee` into
       the snapshot, and to derive the current `gapLength` from
       `r_stator_bore − r_rotor_surface` so the slider initializes to
       the right value when a fixture loads.
    5. In `buildPanel(host, ctx)`'s `render()` function, add per-row a
       `<details>` element with `summary="Geometry"` (collapsed by
       default) containing input rows for the fields named in
       `geometryFields[ring.element]`, and a sibling `<details>` with
       `summary="Material"` (collapsed) containing
       `materialFields[ring.element]`. Each input is a `<input
       type="number" step="…">` plus a `<label>`; on `change`, write
       the value back to `currentToggles.rings[idx][field]` (with
       sensible nesting for `rRange[0]` / `rRange[1]`) and call
       `applyChange()` (the existing change-propagation function).
    6. Add a new global section below the `poles` selector with one
       slider (`<input type="range">` log-scaled `[1e-4, 1e-2]`) +
       numeric box for `gapLength` (m). On `change`, write to
       `currentToggles.gapLength` and call `applyChange()` —
       `synthesize` calls `applyGapLength` as part of the assembly.
    7. The existing `applyChange()` already mirrors `currentToggles`
       into `ctx.config.matrixState.rings`; extend the mirror to also
       persist `gapLength` and the new per-ring fields.
    All other lines of `matrix-panel.js` (the per-row Member / Element /
    Excitation / Commutation selects, the `synthesize` skeleton, the
    `deriveTogglesFromConfig` skeleton) are preserved byte-stable; the
    edits above are additions.

- **Tests**:
  - `tests/ui/matrix-panel-geometry.test.js`:
    - `"applyGapLength shifts radii symmetrically"` — load `pmsm` config;
      capture current `r_rotor_surface` and `r_stator_bore`;
      `applyGapLength(cfg, 0.002);` assert
      `r_stator_bore_new − r_rotor_surface_new` ≈ `0.002` within
      `1e-9` and `(r_rotor_surface + r_stator_bore)/2 ===
      (r_rotor_surface_new + r_stator_bore_new)/2` (the mid-gap is
      preserved).
    - `"applyGapLength preserves non-gap-adjacent radii"` — load
      `pmsm`; record the inner radius of the rotor's innermost ring;
      `applyGapLength(cfg, 0.001);` assert the inner ring's
      `rRange[0]` changed by `(r_rotor_surface_new − r_rotor_surface)`
      (a uniform rotor-side shift), and the stator-yoke outer radius
      similarly shifted by the stator-side delta.
    - `"applyGapLength throws on non-positive g"` — assert
      `() => applyGapLength(cfg, 0)` and `() => applyGapLength(cfg,
      -0.001)` both throw.
    - `"applyGapLength throws when N_gap < 4K after shift"` (added
      2026-05-27) — load `pmsm` (slots=48, poles=8 → K=144,
      4K=576); call `applyGapLength(cfg, 1e-5)` (10 µm — far too
      tight to mesh with adequate gap nodes); assert it throws
      with a message that names the K value and the inadequate
      N_gap. Then call `applyGapLength(cfg, 0.003)` (3 mm — the
      original baseline gap); assert no throw and the gap is
      `~0.003`.
    - `"deriveTogglesFromConfig reads gapLength"` — load `pmsm`;
      `t = deriveTogglesFromConfig(cfg);` assert
      `Math.abs(t.gapLength − (r_stator_bore − r_rotor_surface)) <
      1e-12`.
    - `"synthesize round-trips per-ring rRange"` — start from a fresh
      `pmsm` toggle snapshot; set `t.rings[0].rRange = [0.030, 0.040]`;
      `cfg2 = synthesize(t, {});` assert `cfg2.rings[0].rRange ===
      [0.030, 0.040]` (deep equal).
    - `"synthesize round-trips per-ring teeth/magnets/Q"` — same setup;
      set `t.rings[0].magnets = 6` (an `M` ring); assert
      `cfg2.rings[0].magnets === 6`.
    - `"panel exposes per-row Geometry and Material details elements"` —
      `installDomShim(); const {ctx} = freshMount();
      buildPanel(host, ctx);` then assert for each ring there exist
      two `<details>` children whose `summary.textContent` is "Geometry"
      and "Material" respectively, and that both have the `open === false`
      attribute (collapsed by default).
    - `"editing a geometry input fires requestRebuild"` —
      `installDomShim()`; spy on `ctx.requestRebuild`; locate the
      `rRange[0]` input for ring 0 in the rendered DOM; set its
      `.value = "0.025"`; `dispatch(input, "change");` assert
      `rebuildCalls.count === 1` and
      `ctx.config.rings[0].rRange[0] === 0.025`.

  - `tests/ui/matrix-panel-material.test.js`:
    - `"M ring exposes Mr in its Material card"` — load `pmsm` (rotor
      ring 0 is M); `buildPanel`; assert the Material details for
      ring 0 contains an input labeled "Mr".
    - `"I ring does not expose Mr"` — synthesize a config with one I
      ring; `buildPanel`; assert no input in the I ring's Material
      details has label "Mr".
    - `"editing muR mutates the live config + triggers rebuild"` —
      `installDomShim`; spy; locate `muR` input for ring 0; set value
      `2000`; dispatch change; assert `ctx.config.rings[0].muR === 2000`
      and `rebuildCalls.count === 1`.
    - `"editing Bknee mutates the live config"` — same flow with the
      `Bknee` input; assert `ctx.config.rings[0].Bknee === 1.7`.
    - `"Bknee:null renders the placeholder text 'default 1.6'"` —
      load a config whose iron ring has `Bknee:null`; assert the
      Bknee input's `placeholder` (or sibling label) contains
      "default 1.6".

  - `tests/ui/machine-picker.test.js`:
    - `"register installs the picker header control"` — fresh seams;
      `UM.MachinePicker.register(UM)`; assert one
      `UM.HEADER_CONTROLS` entry with `id === "machine-picker"`.
    - `"select populates from UM.MACHINES"` — load all 15 fixtures;
      `installDomShim`; `buildPicker(host, ctx)`; find the `<select>`;
      assert its `options.length === UM.MACHINES.length + 1` (the
      leading "current" option), and option labels match each
      fixture's `label`.
    - `"selecting a fixture deep-copies its config in place"` —
      `installDomShim`; spy; pick the `pmsm` option (set
      `select.value = "pmsm"`; `dispatch(select, "change")`);
      assert (a) `ctx.config.rings` deep-equals the `pmsm` fixture's
      `rings` (same shape, but a different object reference — D7
      semantics); (b) `ctx.config.matrixState === undefined` (cleared);
      (c) `rebuildCalls.count === 1`.
    - `"the picker does not branch on machine identity"` — read the
      file as text; assert it contains zero matches for any entry in
      the `MACHINE_NAMES` list (the per-test list mirroring
      `tests/pipeline/_fixtures.js`'s).
    - `"applyFixture mutates the same config reference"` — capture
      `cfgRef = ctx.config`; pick a fixture; assert `ctx.config ===
      cfgRef` (same reference — requestRebuild's closure reads it).
    - `"no DOM access on module load"` — assert `UM.MachinePicker`
      materializes with `globalThis.window = globalThis` and no
      `document`.

- **Acceptance criteria**:
  - `machine-picker.js` registers exactly one header control; its
    `<select>` is populated from `UM.MACHINES`; selecting an entry
    deep-copies the chosen config's `MUTABLE_KEYS` into `ctx.config` in
    place and triggers exactly one `ctx.requestRebuild()`; the picker
    contains zero machine-name string literals (audit in-test).
  - `matrix-panel.js` renders two collapsed `<details>` cards per ring
    (Geometry, Material) with field sets dispatched on `ring.element`
    only; editing any field mutates `ctx.config.rings[idx]` and triggers
    a rebuild; the existing element / member / excitation / commutation
    flow is preserved.
  - `applyGapLength(config, g)` shifts rotor and stator radii
    symmetrically around the current mid-gap, preserves every other
    radius's relative position, updates `config.grid.{rInner,rOuter}`,
    and throws on non-positive `g`.
  - **User-required browser pass** (the single Phase 6 browser pass —
    Wave 6.1 and 6.2 are headless): with a static server rooted at the
    repo (`python -m http.server 8765`), open
    `http://localhost:8765/lessons/unified_motor/index.html`, and
    confirm:
    1. The page loads (`LIB.FeaSolver.init()` resolves; no console errors).
    2. The machine picker header control lists all 15 fixtures.
    3. Selecting each fixture re-renders the matrix panel with the
       fixture's rings, redraws both 2-D cross-sections and the 3-D rig,
       and spins the rotor (under whatever the fixture's default
       excitation/load is, possibly aided by the existing drive sliders).
    4. The Geometry card for a chosen ring expands and editing
       `rRange`/`teeth`/`magnets`/`Q` rebuilds geometry visibly.
    5. The Material card edits (`muR`, `Mr`, `Bknee`) take effect — for
       example, raising `Mr` of a PM rotor's magnet ring visibly
       strengthens the cogging/back-EMF; lowering `muR` of the stator
       yoke visibly reduces flux density.
    6. The gap-length slider visibly increases/decreases the unmeshed
       annulus width while preserving the rotor/stator geometry inside.
    7. The five field-view toggles each turn their overlay on and off
       independently on both the 2-D and 3-D views; with flux-lines on,
       the R5 analytic in-gap flux lines visibly bridge the rotor and
       stator surfaces (smooth, no stair-stepping).
    8. Reset re-zeroes the rotor angle/speed and clears plot history;
       Pause halts the sim.
    9. The **Playback `step/frame` slider** ("ordered speed") changes how
       much sim-time each frame advances — raising it visibly speeds the
       rotor up to the point where solves saturate the 30 ms wall budget,
       at which the **slow-motion warning** appears in the header showing the
       achieved fraction of the ordered speed (and clears when the rotor
       settles and solves are cheap again).
  - All listed headless tests pass.

## Wave 6.4: Click-to-place feature editor

> Restored to scope 2026-05-27 — it was a non-negotiable in the original
> spec session that got dropped when Phase 6 was first written. Without it
> the schema's per-feature flexibility (the ability to express asymmetric
> configurations by listing individual rings with `teeth: 1, theta0: <angle>`)
> is not usable without hand-editing fixture `.js` files.

### Task T6.4.1: Per-feature add/move/delete via the cross-section canvas

- **Description**: Extend the 2-D cross-section render seam with a
  click-to-place feature-editor mode. When the user toggles "Edit features"
  in the matrix panel, the cross-section canvas accepts pointer events:
  - **Click on an empty angular region of a ring** → add a feature of the
    ring's current `element` kind at that angle (a new I tooth, M magnet,
    W slot, etc.) with the default `spanFraction` for that element. The
    new feature is written into `config.rings` as its own entry
    (`teeth: 1` or `magnets: 1`, with `theta0: clickedAngle`).
  - **Click on an existing feature** → select it; show a small floating
    properties card with `theta0`, `spanFraction`, and (for magnets) magDir
    sign; `rRange` is inherited from the parent ring and is not edited
    per-feature.
  - **Drag a selected feature's angular handle** → updates `theta0`;
    pointer-move events debounce mesh rebuild to pointer-up so the live
    UI stays responsive.
  - **Right-click a feature OR `Delete` key on selected feature** →
    removes the corresponding `config.rings` entry; rebuilds the mesh.
  - **Element-kind dispatch only** — the editor reads `element` and
    `member` from the parent ring; never machine identity (binding
    constraint §11.1#1).

- **Files to create**:
  - `lessons/unified_motor/feature-editor.js` — IIFE.
    - `enterEditMode(ctx) → exitFn` — installs pointer-event handlers
      on the 2-D canvas via the registered cross-section seam; returns
      a function that uninstalls.
    - `hitTestFeature(layout, body, mx, my) → {ringIdx, featureIdx}|null`
      — given a click in canvas coordinates, returns the parent-ring
      index in `config.rings` and the in-ring feature index that was
      hit (using `BodyMesh.elems[matId/srcId]` for material/circuit
      identity, plus angular bin from `gapTheta`).
    - `addFeatureAt(ctx, ringIdx, theta) → void` — appends a new
      single-feature entry to `config.rings` mirroring the parent
      ring's element/material/rRange/muR/etc., with
      `theta0: theta, teeth: 1` (or `magnets: 1` per the element kind).
      Calls `ctx.requestRebuild()`.
    - `moveFeature(ctx, ringIdx, featureIdx, newTheta) → void`,
      `deleteFeature(ctx, ringIdx, featureIdx) → void` — analogous.
    - `register(UM)` — `UM.registerToolMode({id:"feature-editor",
      enter: enterEditMode})`. The matrix-panel UI surfaces an "Edit
      features" toggle that calls `UM.enterToolMode("feature-editor")`.
    - Exports: `UM.FeatureEditor = { enterEditMode, hitTestFeature,
      addFeatureAt, moveFeature, deleteFeature, register }`.

  - `tests/ui/feature-editor.test.js` — headless tests using the
    `installDomShim()` from `tests/ui/_fixtures.js`:
    - `addFeatureAt` on a 4-magnet PMSM fixture at θ=π/2 produces a 5th
      magnet entry in `config.rings`; the rebuilt mesh has one more
      magnet feature in `section.features`.
    - `moveFeature` updates `theta0` and `ctx.requestRebuild` fires
      exactly once.
    - `deleteFeature` removes the entry and rebuilds with one fewer
      feature.
    - `hitTestFeature` against a known mesh + click coordinates returns
      the expected ring/feature indices.

- **Files to modify**:
  - `lessons/unified_motor/matrix-panel.js` — add the "Edit features"
    toggle button to each ring's Geometry card; the toggle enters/exits
    the editor mode via `UM.enterToolMode`.
  - `lessons/unified_motor/mount.js` — add `UM.registerToolMode` /
    `UM.enterToolMode` / `UM.exitToolMode` to the seam surface (tiny
    additive change matching the pattern of the existing
    `UM.registerPanel` / `UM.PANELS` machinery; no behavior change for
    callers that don't register a tool).

- **Acceptance criteria**:
  - Pointing at the 2-D cross-section in edit mode and clicking adds a
    feature; clicking it again selects it; dragging moves it; right-
    click / Delete removes it. The change round-trips through
    `config.rings` so a fixture exported via `JSON.stringify(config)`
    after edits captures every user change.
  - The new feature is mesh-conforming (the column edges produced by
    `buildAngularColumns` snap to the new feature's `theta0` boundary)
    — verified by the existing `findStraddlingElements` check from
    `tests/mesh/feature-templates.test.js` applied to the post-edit
    section.
  - Edit-mode pointer events do NOT interfere with the simulation
    when edit mode is off (default).
  - All listed headless tests pass.

## Wave 6.5: Concentrated windings + winding-editor revival

> Also restored to scope 2026-05-27. Concentrated windings were a
> non-negotiable in the original spec session: they're the standard for
> high-pole-count BLDC, fractional-slot servo, and many traction motors.
> The current `winding-model.js` only knows `winding.standard`
> (distributed integer-slot windings). `winding-editor.js` was preserved
> but never re-loaded.

### Task T6.5.1: `concentrated` winding mode + winding-editor.js wiring

- **Description**: Extend `lib/winding-model.js` with a new
  `concentrated({m, p, Q, slotsPerPhase, coilSpan, turns, …})` mode
  that produces a fractional-slot concentrated-winding routing (one or
  two coils per tooth, phase-belt layout per the Cros-Carrick rule).
  Revive `lessons/unified_motor/winding-editor.js` as a panel that
  visualises the per-slot per-coil layout and lets the user edit
  individual coil assignments (phase, direction, turns) when the
  fixture's winding uses the new `winding.custom: { coils: [...] }`
  mode.

- **Files to modify**:
  - `lib/winding-model.js` — add:
    - `concentrated({m, p, Q, slotsPerPhase, coilSpan, turns, member,
      rRange, slotTheta}) → routing` — produces the same routing shape
      as `standardWinding` so downstream consumers don't branch. The
      phase-belt rule is the Cros-Carrick double-layer concentrated
      pattern; q = Q/(2pm) need not be integer (Phase 2.5 already
      removed that constraint). Throws on q < 1/(2m) (sub-physical)
      and on coilSpan > Q/p (would alias).
    - `customRouting({coils, member, rRange, slotTheta}) → routing` —
      direct per-coil specification; each coil entry is `{slotGo,
      slotReturn, phase, turns}`. Validation: `slotGo, slotReturn ∈
      [0, Q)`, `phase ∈ [0, m)`, `turns > 0`.
    - `LIB.WindingModel = {..., concentrated, customRouting}` (joins
      `cageRouting` from Phase 2.5).
  - `lessons/unified_motor/config-schema.js` — `resolveWinding(ring)`
    recognises `winding.concentrated` and `winding.custom` in
    addition to `winding.standard` and `cage`. The validator routes
    each correctly.
  - `lessons/unified_motor/winding-editor.js` — REVIVED. Re-architect
    as a panel that:
    - Renders the per-slot coil layout (rectangular grid: slot index ×
      coil layer) using the same color palette as the cross-section.
    - When the active ring uses `winding.standard` or
      `winding.concentrated`, the editor is read-only (shows the
      algorithm output).
    - When the active ring uses `winding.custom`, individual coil
      cells are clickable: click cycles phase; right-click flips
      direction; numeric input edits turns.
    - Edits round-trip through `config.rings[i].winding.custom.coils`.
    - Registered via `UM.registerPanel({id:"winding-editor", build:
      buildEditor})`.
  - `lessons/unified_motor/index.html` — add the
    `<script src="./winding-editor.js"></script>` tag.

- **Files to create**:
  - `tests/winding/winding-model.concentrated.test.js` — at least 6
    tests:
    - 12-slot/14-pole BLDC concentrated (m=3, p=14, Q=12, slotsPerPhase=4):
      produces 12 coils distributed across 3 phases × 4 coils each,
      with alternating polarity matching the published Cros-Carrick
      reference.
    - 9-slot/8-pole servo (m=3, p=8, Q=9, slotsPerPhase=3): 9 coils,
      no phase imbalance.
    - q = 0.25 case (super-fractional): produces a determinate
      routing; per-phase coil count differs by at most 1.
    - Throws on q < 1/(2m).
    - Throws on coilSpan > Q/p.
    - `nCircuits` reported matches the expected per-phase count.

  - `tests/winding/winding-model.custom.test.js` — at least 4 tests:
    - 6 custom coils in a 12-slot stator round-trip through the
      validator with `nCircuits = 6 / coils-per-circuit` (depends on
      phase grouping).
    - Validator catches out-of-range `slotGo`/`slotReturn`.
    - Validator catches negative `turns`.
    - Validator catches `phase ≥ m`.

  - `tests/ui/winding-editor.test.js` — headless:
    - Read-only mode renders the standard-winding layout from a PMSM
      fixture and refuses click edits.
    - Edit mode (custom winding fixture) accepts a phase-cycle click
      and writes through to `config.rings[i].winding.custom.coils[j].phase`.
    - Direction-flip and turns-edit round-trip the same way.
    - `ctx.requestRebuild` fires after each edit.

- **Acceptance criteria**:
  - `LIB.WindingModel.concentrated` is the canonical fractional-slot
    concentrated routing function; downstream consumers (the existing
    circuit / motor-stack / motor-run / config-schema / cross-section
    layers) do not branch on which winding mode produced the routing.
  - The 12 and 9-slot examples above match published Cros-Carrick
    reference output to within phase-polarity-sign equivalence (the
    overall winding can be inverted as a whole).
  - The revived `winding-editor.js` registers as a panel and shows up
    in the live UI; editing a `winding.custom` fixture's coils
    rebuilds the mesh and circuit correctly.
  - All listed headless tests pass.

## Out of Scope (Phase 6)

- The Phase 7 physics validation (`tests/fea-engine/*`, `tests/machines/*`
  re-point; saturated-cogging headline) — Phase 6 ships the live UI; the
  numbers it shows are validated by Phase 7.
- The §9-G5 Schur condensation and the off-thread worker — both
  measurement-gated (§11.4), surfaced by Phase 5's perf diagnostic and
  authorized by the user as scope additions if triggered.
- `schematic-panel.js` revival: preserved in the repo per the plan's
  "preserved unchanged" list but not loaded by `index.html` today and
  Phase 6 does not load it. Future phase.
- Any rebuild of `cross-section-render.js` / `matrix-panel.js` /
  `schematic-panel.js` physics-facing contracts (preserved unchanged
  per `spec/plan.md`). Note: `winding-editor.js` IS in scope this
  phase (see Wave 6.5).
- New machine fixtures beyond what's already in the 15 — the picker
  consumes `UM.MACHINES` as a registry whose contents are owned by
  their own `machines/*.js` files (Phase 0's frozen-set + Phase 2.5's
  `p`-normalization + Phase 3's WFS CURRENT-terminal flip).
- **Continuous skew, interior-magnet pockets, arc-shaped flux barriers**:
  the schema is ring-stack-only by design (see `spec/plan.md`
  "ring-stack scope" note). Syncrel's multi-barrier rotor is a
  stylised approximation, not a real syncrel — documented limitation,
  not a Phase 6 deliverable.
