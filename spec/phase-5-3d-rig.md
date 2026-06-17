# Phase 5: 3-D rig

## Overview

Build `lessons/unified_motor/render3d.js` — the 3-D rendering rig for the
unified-motor app. The rig **axially extrudes the 2-D sprite cross-section**
(reusing the Phase-3 `LIB.CrossSectionSprite` primitives — it must not
re-implement tooth/magnet/wire drawing), draws **end-winding arcs** over both
stack ends, paints the **per-slice in-gap field** via `LIB.GapEval`, rotates the
rotor sprite rigidly by the per-slice rotor angle (stator fixed), and renders
**every slice as its own extruded segment** so a multi-slice machine's cups are
visible. The rig registers through the existing `UM.registerRender3D` seam and is
driven by the wall-budgeted render loop in `mount.js`.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

The 3-D viewport is **orbit-pannable** (`mount.js` updates `orbitYaw`/`orbitPitch`
from pointer drag and rebuilds `LIB.Layout3D.orbital` every frame). There is no
privileged "front" or "back": both axial end caps of the stack are real faces a
viewer can rotate to see, so **both caps are drawn with full sprite detail** and
all faces/walls are composited back-to-front (painter's algorithm).

### Binding seam fact discovered in `mount.js` (current-state) — and its fix

`mount.js` renders the 3-D viewport by calling
`UM.RENDER3D.paint(mountCtx, L3, rctx)` (`mount.js:665`) where
`mountCtx = { runtime, config, view, requestRebuild }`,
`L3 = LIB.Layout3D.orbital(W3, H3, …)`, and
`rctx = { runtime, config, expanded, W, H }`. **None of those three arguments
carries the `viewport3D` canvas or a 2-D context** — unlike the 2-D seam, which
passes the canvases array directly (`mount.js:674`). `mount.js` creates
`ctx3 = viewport3D.getContext("2d")` (`mount.js:647`), `fitCanvas`-fits it
(`mount.js:645`), clears + fills the background (`mount.js:648-650`), then
discards the reference. As written, `render3d.paint` has **no drawing surface**.

This phase fixes that with a **single-line, sanctioned overlap edit** to
`mount.js` (the same cross-phase ownership mechanism the plan already uses for
`index.html` and the Phase-1 stub files): the 3-D seam's `rctx` literal gains a
`canvas: viewport3D` field, and `render3d.paint` reads `rctx.canvas`. `mount.js`
has already `fitCanvas`-fitted and background-cleared the canvas and built `L3`
to its CSS size, so the rig must **not** re-fit or re-clear — it draws on top of
the prepared surface using `L3` for projection. This edit touches no symbol the
`tests/render/mount-2d-seam.test.js` banned-symbol guard forbids.

### Design decisions (current-state facts)

- **Sprite reuse via an affine-per-face transform.** Each slice's axial end face
  is the plane `z = z0` (rig axis = world **z**; the cross-section lies in the
  world **x-y** plane, `+y` up — the same convention `LIB.CrossSectionSprite`
  expects). A planar face under the orbit camera is a projective map; the rig
  approximates it with the **affine** transform pinned by the projections of the
  face centre and two in-plane basis points (`faceAffine`, below), installs it on
  the 2-D context, and calls the unchanged Phase-3 sprite primitives. The affine
  is composed **on top of** the canvas's DPR base transform (it does not clobber
  it). The **side walls** that connect a slice's two caps (radial-extreme
  silhouette quads) are genuine 3-D geometry the rig draws itself — not a sprite
  concern.
- **Uniform per-slice extrusion (no first/last special case).** Every slice `k`
  is an identical extruded segment over `[z0_k, z1_k]` (two full-detail caps +
  walls). The two **outer** caps (slice 0's `−z` cap and slice N−1's `+z` cap)
  are the ones a viewer sees; internal slice-boundary caps are mutually occluded
  and overdraw harmlessly under the painter's-algorithm composite. This keeps the
  code agnostic (no "outer vs inner" branch) and makes each cup's distinctly
  rotated cross-section visible.
- **Rotor rotation uses `gap.phi` directly.** `motor-stack.js` solves slice `k`
  at `thetaR + offset[k]` (`motor-stack.js:96,396`), so
  `perSliceField[k].gap.phi` **already includes** the configured slice offset.
  The rig rotates slice `k`'s rotor sprite by `field.gap.phi` when a solve is
  present, and by `state.theta + expanded.slices[k].offset` only in the
  pre-solve fallback. The stator is never rotated.
- **In-gap field in 3-D is cap-painted flux + |B|, gated on `UM.fieldViz`.** On
  each slice cap, when a field is present, the rig draws (a) per-body smooth flux
  lines via `LIB.MotorMeshView.resampleField` + `drawFluxLines`, (b) the smooth
  **cross-gap** flux via `LIB.GapEval.evalAOnGrid({rotor,stator,phi}, {Nr,Ntheta})`
  using the **same descriptor shape Phase 3 builds** from each solve-result body
  (`field.rotor`/`field.stator`): `field.<body>.mesh.gapLoop` + `field.<body>.Anode`
  + `field.<body>.mesh.gapR` + `field.gap.phi` (see the "Cross-gap flux descriptor"
  paragraph in the task contract), and (c) the blended |B| heatmap via
  `resampleField(elemToNodal(Belem.mag))` + `drawModulusB`. `fluxLines` gates
  (a)+(b); `modulusB` gates (c). Saturation / magnetization / current-density
  glyphs stay 2-D-only (the 2-D cross-section already carries them). Resampled
  grids are memoized on `runtime.lastSolve` identity (× slice × body × kind) so a
  paused/unchanged frame reuses the cache.
- **End-windings are render-owned 3-D arcs.** Conductor features are grouped by
  global `circuit`; within a circuit, opposite-polarity slots (`sign(turns)`) are
  paired and joined by an arc that bulges axially **beyond each outer stack end**
  (`z = ±ell/2`), coloured by the rig's per-phase `WIRE_PALETTE` (the same array
  the rig passes to `drawWinding`, so caps and end-windings match). Rotor-owned
  conductor end-windings rotate with the adjacent end slice's rotor angle; stator
  end-windings are fixed.
- **Pure helpers are unit-tested directly.** Following the Phase-4 convention, the
  numerically/architecturally significant pieces are pure, DOM-free, and exported
  on `UM.Render3D` (`sliceAxialBounds`, `faceAffine`, `endWindingArcs`) so they
  are tested without a canvas; `paint` is the thin wiring layer, covered by a
  spy-based integration test. The whole repo test suite is headless `node --test`.
- **No `index.html` edit.** `index.html` already loads `layout3d.js`
  (`index.html:22`) and — after Phases 1+3 — `cross-section-sprite.js`,
  `gap-eval.js`, and `motor-mesh-view.js` in the engine block (all before the
  Phase-1-added `render3d.js` tag). The rig's dependencies are all present; the
  rig adds no tag and does not edit `index.html`.

## Files Owned

Created:
- `tests/render/render3d.test.js` — created (T5.1.1)

Modified:
- `lessons/unified_motor/render3d.js` — Phase-1 empty stub → full content (T5.1.1)
- `lessons/unified_motor/mount.js` — **sanctioned single-line overlap**: add `canvas: viewport3D` to the 3-D-seam `rctx` literal (T5.1.1)

> `render3d.js` was seeded as an empty no-op stub by Phase 1 (which owns
> `index.html` + its `<script>` tag); Phase 5 replaces the contents. `mount.js` is
> a deliberate, plan-recorded cross-phase overlap (Phase 0 owns its readout
> re-sourcing edit; Phase 5 owns the one-line 3-D-seam canvas-passing edit) — the
> same sanctioned-overlap mechanism the plan uses for `index.html` (Phase 1↔3) and
> the stub files (Phase 1↔2/4/5). See `spec/plan.md` → Phase 5. No other file is
> shared.

## Wave 5.1: render3d.js

### Task 5.1.1: `render3d.js` — extruded sprite cross-section, end-windings, per-slice in-gap field, multi-slice cups

- **Description**:
  Replace the `render3d.js` stub with an IIFE that registers a 3-D renderer
  through `UM.registerRender3D({ paint })` and exposes the DOM-free pure helpers
  `UM.Render3D = { paint, register, sliceAxialBounds, faceAffine, endWindingArcs }`.
  At load time the file only attaches `UM.Render3D` and (guarded) calls
  `register(UM)` — no DOM access, no machine identity. Also apply the single-line
  `mount.js` seam fix so the rig receives the viewport canvas.

  **`paint(mountCtx, L3, rctx)` contract** (the `UM.registerRender3D` seam entry):
  1. `runtime = mountCtx.runtime`; `expanded = rctx.expanded`;
     `config = rctx.config || mountCtx.config`. If `runtime`, `expanded`, or
     `rctx.canvas` is missing, **return without drawing** (the rig requires the
     surface the seam fix supplies).
  2. `ctx = rctx.canvas.getContext("2d")`. Do **not** `fitCanvas` or `clearRect`
     (mount already did). Read `dpr = window.devicePixelRatio || 1`.
  3. `N = expanded.slices.length`; `ell = expanded.grid.ell`;
     `rings = config.rings`.
  4. For each slice `k`: resolve `bodies = runtime.stack.sliceMesh(k)`;
     `field = runtime.lastSolve && runtime.lastSolve.perSliceField
     ? runtime.lastSolve.perSliceField[k] : null`;
     `phi = field ? field.gap.phi : ((runtime.state ? runtime.state.theta : 0) +
     expanded.slices[k].offset)`;
     `features = expanded.slices[k].section.features`;
     `{ z0, z1 } = sliceAxialBounds(k, N, ell)`.
  5. Build a flat list of **draw items**, each `{ depth, paint() }`:
     - one item per slice cap (at `z0` and at `z1`) whose `paint()`
       (a) `ctx.save()`, (b) re-establishes the DPR base
       (`ctx.setTransform(dpr,0,0,dpr,0,0)`), (c) `ctx.transform(...faceAffine(L3, z, rMax))`
       to install the face plane, then draws the cross-section via the Phase-3
       sprite primitives — **rotor inside `ctx.save(); ctx.rotate(phi); … ctx.restore()`**,
       stator unrotated — then the gated field overlays, then `ctx.restore()`;
     - one item per side-wall quad (radial-extreme silhouette between `z0` and
       `z1`), projected through `L3.project` and filled/stroked as a flat polygon;
     - end-winding items (see below) at the two **outer** ends only.
     `depth` is `L3.depthOf` of the item's representative world centroid.
  6. `LIB.Layout3D.depthSort(items, it => it.depth)` (farthest first), then call
     each `item.paint()` in order.

  **Cap sprite layer** (drawn through the installed face affine; rotor inside the
  `rotate(phi)` frame):
  - Split `features` by `member` (`"rotor"`/`"stator"`) and `kind`
    (`"iron"`/`"magnet"`/`"conductor"`).
  - Classify each conductor feature's winding **mode** by its owning ring — the
    ring whose `member` matches and whose `slotRRange ?? rRange` contains the
    feature's `rRange`: `mode = (ring.element === "C") ? "concentrated" :
    "distributed"` (identical to Phase 3's classification).
  - Per body: `LIB.CrossSectionSprite.drawIron(ctx, ironFeats, { gapEdge })`
    (`gapEdge:"outer"` for rotor, `"inner"` for stator),
    `drawMagnet(ctx, magnetFeats, {})`,
    `drawWinding(ctx, condFeats, mode, { palette: WIRE_PALETTE,
    currents: runtime.state ? runtime.state.i : null,
    showCurrentGlyph: !!UM.fieldViz.currentDensity })`. The rotor also draws
    `drawShaftAndGap(ctx, { shaftR, gapInnerR, gapOuterR }, {})`.

  **Field overlays on the cap** (only when `field` present; each gated on
  `UM.fieldViz`; rotor overlays inside the `rotate(phi)` frame; grids memoized on
  `runtime.lastSolve` identity):
  - `fluxLines` → iterate `for (const [member, body] of [['rotor', field.rotor],
    ['stator', field.stator]])`: call `drawFluxLines(ctx, resampleField(body.mesh,
    body.Anode, { Nr, Ntheta }), { levels })` where `body.mesh`, `body.Anode`, and
    `body.Belem` are the per-body fields from `perSliceField[k]` (i.e. from `field`,
    not from `bodies = runtime.stack.sliceMesh(k)`); **plus** the cross-gap pass:
    `LIB.GapEval.evalAOnGrid(descriptor, { Nr: 8, Ntheta: 96 })` with
    `descriptor = { rotor: ringFromGapLoop(field.rotor, field.rotor.Anode),
    stator: ringFromGapLoop(field.stator, field.stator.Anode),
    phi: field.gap.phi }` (see cross-gap flux paragraph below), then march
    iso-contours of the returned `Az` over the polar grid (lab frame).
  - `modulusB` → iterate `for (const [member, body] of [['rotor', field.rotor],
    ['stator', field.stator]])`: call `drawModulusB(ctx, resampleField(body.mesh,
    elemToNodal(body.mesh, body.Belem.mag), { Nr, Ntheta }), { range: "auto" })`.

  **Cross-gap flux descriptor** (`ringFromGapLoop` definition): takes a
  `field.rotor` or `field.stator` object as `body` and an `Anode` array.
  `field.rotor.mesh.gapLoop` and `field.rotor.mesh.gapR` (likewise for stator)
  are the gap-ring geometry fields on the solve result; `bodies` (from
  `runtime.stack.sliceMesh(k)`) is used only in the cap sprite layer.
  `ringFromGapLoop(body, Anode) = { gapR: body.mesh.gapR,
  gapTheta: Float64Array of atan2(y,x) over body.mesh.gapLoop node coords,
  A: Float64Array of Anode[body.mesh.gapLoop[i]] }`.

  **`sliceAxialBounds(k, N, ell)` contract** (pure): the stack spans
  `[-ell/2, +ell/2]` along `z`, divided into `N` equal contiguous segments;
  returns `{ z0, z1, zc }` with `z0 = -ell/2 + k·(ell/N)`, `z1 = z0 + ell/N`,
  `zc = (z0 + z1)/2`. `N === 1` ⇒ `{ z0: -ell/2, z1: +ell/2, zc: 0 }`.

  **`faceAffine(L3, z0, R)` contract** (pure): returns the affine 6-tuple
  `{ a, b, c, d, e, f }` (canvas `setTransform`/`transform` order:
  `px = a·u + c·v + e`, `py = b·u + d·v + f`) mapping a face-local point
  `(u, v)` metres in the plane `z = z0` to CSS pixels, pinned by the camera
  projections of the face centre `O = L3.project({x:0,y:0,z:z0})`,
  `Pu = L3.project({x:R,y:0,z:z0})`, `Pv = L3.project({x:0,y:R,z:z0})`:
  `a = (Pu.px−O.px)/R`, `b = (Pu.py−O.py)/R`, `c = (Pv.px−O.px)/R`,
  `d = (Pv.py−O.py)/R`, `e = O.px`, `f = O.py`. (CSS-px, matching `L3`; the DPR
  base is composed separately by `paint`.) The affine absorbs the camera y-axis
  sense: world `+v` (= world `+y`) maps to decreasing `py` for cameras with
  `pitch ∈ (0, π/2)`, so sprite primitives drawn in their natural world (+y up)
  frame project correctly without an additional y-flip.

  **`endWindingArcs(conductorFeatures, opts)` contract** (pure): `opts =
  { zEnd, bulge, sign, samples = 8, member }`. Group features by `circuit`; within
  each circuit sort by mean angle and pair each `turns > 0` slot with the nearest
  unpaired `turns < 0` slot. For each pair emit one arc object
  `{ circuit, points: Float64Array }` of `samples` `(x,y,z)` triples following a
  smooth curve from the go-slot to the return-slot at radius
  `r = ½(r0+r1)` (the conductor mean radius), with the mid-curve `z` pushed to
  `sign·(|zEnd| + bulge)` (axially beyond the stack end) and the endpoints at
  `z = sign·|zEnd|`. Returns the array of arcs (empty when there are no
  opposite-polarity pairs). Pure: no `L3`, no canvas — `paint` projects the points
  through `L3` and strokes them with `WIRE_PALETTE[circuit % WIRE_PALETTE.length]`.

  **Module-private**: `WIRE_PALETTE` (per-phase color cycle, fixed array);
  `ringFromGapLoop`; the resample memo store keyed on `lastSolve` identity;
  small projection/quad helpers. No machine-name strings anywhere; no `document.`
  reference anywhere (the rig has no `build(host)` — it only paints).

- **Files to create**:
  - `tests/render/render3d.test.js` — headless `node --test`. Harness: `require`
    `./_fixtures.js` (engine shim + `recordingCanvas`, `dummyMountCtx`,
    `loadMachine`, `initSolver`, `feaOpts`, `LIB`, `UnifiedMotor`, `CS`); then
    `require("../../lib/cross-section-sprite.js")` (Phase-3 lib, present by Phase 5)
    so `LIB.CrossSectionSprite` is available; `require("../../lib/gap-eval.js")`
    (guarded); `require("../../lessons/unified_motor/render3d.js")`. Two helpers are
    available: `make3dRctx(runtime, expanded, W, H)` returns ONLY the rctx
    object `{ runtime, config: expanded, expanded, canvas, W, H }` where
    `canvas` is a fresh recording canvas; the recording surface
    `{ canvas, ctx, log }` is obtained separately from the existing
    `recordingCanvas` fixture helper. Tests call both and thread `canvas`
    from `recordingCanvas` into the rctx, matching how the rest of the suite
    uses `recordingCanvas`. Build
    `L3 = LIB.Layout3D.orbital(W, H, { yaw: 0.4, pitch: 0.35, dist: 0.25 })`.

- **Files to modify**:
  - `lessons/unified_motor/render3d.js` — replace the Phase-1 stub comment with the
    IIFE above. Attaches `UM.Render3D`; registers one renderer via
    `UM.registerRender3D`; guarded auto-register `if (UM.registerRender3D)
    register(UM)`. No machine-name string literals; no `document.` reference.
  - `lessons/unified_motor/mount.js` — change the 3-D-seam `rctx` literal
    (`mount.js:659`) from
    `const rctx = { runtime: runtime, config: config, expanded: expanded, W: W3, H: H3 };`
    to
    `const rctx = { runtime: runtime, config: config, expanded: expanded, canvas: viewport3D, W: W3, H: H3 };`.
    No other `mount.js` change.

- **Tests**:
  - `tests/render/render3d.test.js::"registers exactly one 3-D renderer with a paint function"` —
    after require, assert `UM.RENDER3D` is an object with `typeof
    UM.RENDER3D.paint === "function"`, and `UM.Render3D.paint === UM.RENDER3D.paint`.
  - `tests/render/render3d.test.js::"sliceAxialBounds splits the stack into equal centered segments"` —
    `const b = [0,1,2,3].map(k => UM.Render3D.sliceAxialBounds(k, 4, 0.08));`
    assert `b[0].z0` ≈ `-0.04`, `b[3].z1` ≈ `+0.04` (±1e-12), each segment width
    ≈ `0.02`, `b[k].z1 === b[k+1].z0` for `k<3`, and `Math.abs(b[0].zc + b[3].zc) <
    1e-12` (symmetric about 0). Also `sliceAxialBounds(0,1,0.08)` returns
    `{z0:-0.04, z1:0.04, zc:0}`.
  - `tests/render/render3d.test.js::"faceAffine maps face-local metres to the projected z-plane pixels"` —
    `const L3 = LIB.Layout3D.orbital(600,600,{yaw:0.4,pitch:0.35,dist:0.25});`
    `const A = UM.Render3D.faceAffine(L3, 0.0, 0.05);`
    let `ap = (u,v) => ({ px: A.a*u + A.c*v + A.e, py: A.b*u + A.d*v + A.f });`
    assert `ap(0,0)` ≈ `L3.project({x:0,y:0,z:0})` (px,py within 1e-9), and
    `ap(0.05,0)` ≈ `L3.project({x:0.05,y:0,z:0})` and `ap(0,0.05)` ≈
    `L3.project({x:0,y:0.05,z:0})` (px,py within 1e-9).
  - `tests/render/render3d.test.js::"endWindingArcs groups by circuit and bulges beyond the stack end"` —
    synthetic conductor features: circuit 0 with `{turns:+5}` at θ≈0 and
    `{turns:-5}` at θ≈π/4; circuit 1 with `{turns:+5}` at θ≈π and `{turns:-5}` at
    θ≈π+π/4 (each `rRange:[0.05,0.055]`, matching `thetaRange`); call
    `endWindingArcs(feats, { zEnd: 0.04, bulge: 0.01, sign: 1, samples: 8 })`;
    assert the result has 2 arcs, one per `circuit` (`{0,1}` covered), each
    `arc.points.length === 8*3`, every point's `z` is `>= 0.04 - 1e-9`, and at
    least one point per arc has `z >= 0.05 - 1e-9` (the bulge `0.04+0.01`). Assert
    a single-polarity input (`[{turns:+5,...}]`) returns `[]` (no pair).
  - `tests/render/render3d.test.js::"paint draws the extruded cross-section through the sprite primitives"` —
    `await initSolver()`; expand `loadMachine("pmsm")`, create runtime
    (`feaOpts()`), `runtime.step(1/240, 30)` once; set `UM.fieldViz` all-`false`;
    spy-wrap `LIB.CrossSectionSprite.drawIron` and `drawWinding` to count calls;
    call `recordingCanvas(600,600)` to get `{ canvas, ctx, log }`, then
    `make3dRctx(runtime, expanded, 600, 600)` and set its `canvas` field to the
    recording canvas; build `L3`; call `UM.RENDER3D.paint(dummyMountCtx(runtime,
    expanded), L3, rctx)`; assert it does not throw, `drawIron` call count `>= 1`,
    `drawWinding` call count `>= 1`, and the recording `log` contains at least one
    `transform` op (the face affine was installed). Restore the spies.
  - `tests/render/render3d.test.js::"paint renders every slice of a multi-slice stack (cups)"` —
    for `id` in `["hybrid-stepper", "skew-demo"]`: expand+create+step a runtime;
    `fieldViz` all-`false`; spy-count `LIB.CrossSectionSprite.drawIron`; paint;
    assert the `drawIron` call count `>= 2 * expanded.slices.length` (two caps per
    slice) — `>= 4` for hybrid-stepper (2 slices), `>= 8` for skew-demo (4 slices).
  - `tests/render/render3d.test.js::"paint rotates the rotor sprite by gap.phi"` —
    pmsm stepped runtime; force `runtime.lastSolve.perSliceField[0].gap.phi = 0.6`;
    `fieldViz` all-`false`; paint into a fresh recording canvas; assert the `log`
    contains a `rotate` op whose first arg is ≈ `0.6` (±1e-9). Re-paint with
    `gap.phi = 0.0` and assert no `rotate` op has a first arg with
    `Math.abs(arg) > 1e-9`.
  - `tests/render/render3d.test.js::"paint is safe before the first solve"` —
    expand+create a pmsm runtime with **no** step (`runtime.lastSolve === null`);
    `fieldViz` all-`false`; paint; assert it does not throw and
    `LIB.CrossSectionSprite.drawIron` was called `>= 1` (sprites draw from
    features without a field; rotor uses the `state.theta + offset` fallback).
  - `tests/render/render3d.test.js::"paint draws cap field overlays and cross-gap flux when fieldViz.fluxLines is on"` —
    pmsm stepped runtime; `UM.fieldViz = { fluxLines:true, modulusB:false,
    saturation:false, magnetization:false, currentDensity:false, gapLoop:false }`;
    spy-wrap `LIB.MotorMeshView.drawFluxLines` (count) and
    `LIB.GapEval.evalAOnGrid` (capture first call args); paint; assert
    `drawFluxLines` count `>= 1` and `evalAOnGrid` was called with a first argument
    whose `rotor.gapR`/`stator.gapR`/`phi` are finite numbers and whose
    `rotor.gapTheta`/`rotor.A`/`stator.gapTheta`/`stator.A` are `Float64Array`s of
    equal per-body length, with second argument `{ Nr, Ntheta }`; assert the first
    argument has **no** `harmonics` key (not the legacy `field.gap`). Re-paint with
    `fluxLines:false` and assert `evalAOnGrid` is not called again. Restore spies.
  - `tests/render/render3d.test.js::"paint returns without drawing when rctx.canvas is absent"` —
    pmsm stepped runtime; call `paint(dummyMountCtx(runtime, expanded), L3,
    { runtime, config: expanded, expanded, W: 600, H: 600 })` (no `canvas`); assert
    it does not throw and (using a fresh spy) `LIB.CrossSectionSprite.drawIron` was
    not called.
  - `tests/render/render3d.test.js::"mount.js passes the viewport canvas to the 3-D seam"` —
    read `lessons/unified_motor/mount.js` as UTF-8; assert it contains
    `canvas: viewport3D` and that this substring's index precedes the
    `UM.RENDER3D.paint(` call index (the canvas is in the `rctx` the seam receives).
  - `tests/render/render3d.test.js::"no DOM access at module load"` — delete
    `require.cache` for `render3d.js`, ensure `globalThis.window = globalThis` and
    `globalThis.document` is undefined, re-require `render3d.js`; assert no throw.
  - `tests/render/render3d.test.js::"no machine names and no DOM in the file"` —
    read `lessons/unified_motor/render3d.js` as UTF-8; assert it contains none of
    `bldc`, `pmsm`, `srm`, `squirrel`, `stepper`, `brushed`, `universal-motor`,
    `wound-field` (case-insensitive) and contains no `document.` substring.

- **Acceptance criteria**:
  - `lessons/unified_motor/render3d.js` registers exactly one renderer via
    `UM.registerRender3D` and attaches `UM.Render3D` with `paint`, `register`,
    `sliceAxialBounds`, `faceAffine`, and `endWindingArcs`.
  - `mount.js`'s 3-D-seam `rctx` carries `canvas: viewport3D`, and `paint` reads
    `rctx.canvas` (returning without drawing if it is absent).
  - `paint` extrudes the cross-section by drawing **both** axial caps of every
    slice through the Phase-3 `LIB.CrossSectionSprite` primitives (it never
    re-implements tooth/magnet/wire geometry), plus side walls, composited
    back-to-front via `LIB.Layout3D.depthSort`.
  - Each slice's rotor sprite is rotated by `perSliceField[k].gap.phi` (fallback
    `state.theta + offset[k]`); the stator is fixed; a multi-slice stack draws
    every slice so its cups are visible.
  - End-winding arcs are emitted per circuit (go/return paired) and bulge axially
    beyond both outer stack ends, coloured by `WIRE_PALETTE`.
  - When `UM.fieldViz.fluxLines` is on and a field is present, the rig paints
    per-body cap flux lines **and** smooth cross-gap flux via
    `LIB.GapEval.evalAOnGrid({rotor,stator,phi}, {Nr,Ntheta})`; `modulusB` paints
    the blended cap |B| heatmap; both gate independently; grids are memoized on
    `runtime.lastSolve` identity.
  - Painting is safe before the first solve (sprites draw, no overlay, no throw).
  - The source contains no machine-name string literals and no DOM reference.
  - `node --test tests/render/render3d.test.js` passes; the full `node --test`
    suite is green (no new failures).

## Notes / cross-phase dependencies

- **Depends on Phase 3** (`LIB.CrossSectionSprite` primitives `drawIron`,
  `drawMagnet`, `drawShaftAndGap`, `drawWinding`; and
  `LIB.MotorMeshView` overlays `resampleField`, `elemToNodal`, `drawFluxLines`,
  `drawModulusB`) and **Phase 2** (`LIB.GapEval.evalAOnGrid`). The rig must reuse
  these and not re-implement sprite or field-resample geometry.
- **Depends on Phase 1**, which seeded `render3d.js` as an empty stub and added
  its `<script>` tag to `index.html` after `mount.js`. Phase 5 replaces only the
  file contents; it adds no `index.html` tag.
- **`mount.js` sanctioned overlap.** Phase 0 owns `mount.js`'s readout
  re-sourcing edit; Phase 5 owns the one-line 3-D-seam `canvas: viewport3D` edit.
  Both are plan-recorded cross-phase overlaps on `mount.js`. The two edits touch
  disjoint lines and do not conflict.
- **Phase 6 audit allow-list.** `render3d.js` is already in the allow-list set
  Phase 6 extends in `scripts/agnosticism-audit.js`; no Phase-5 action needed.
- **Engine fields are read-only.** The rig reads `expanded.slices[k]`
  (`.section.features`, `.offset`), `expanded.grid.ell`,
  `runtime.stack.sliceMesh(k)`, and `runtime.lastSolve.perSliceField[k]`
  (`.rotor/.stator.{mesh,Anode,Belem:{mag,Bx,By}}`, `.gap.phi`). It mutates no
  engine state and triggers no solve.
