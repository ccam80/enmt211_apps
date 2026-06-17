# Phase 3: Geometry-faithful 2-D asset render

## Overview

Replace the unified-motor 2-D cross-section with a **ground-up engineering
sprite drawing**: real outlined tooth / tooth-tip / slot-opening profiles,
magnet segments with N/S shading and magnetization arrows, and — the defining
requirement — **individual wound conductor cross-sections drawn as discrete
wires in every slot**, never a single filled rectangle per slot. The prior
per-element "material fill" render (`lib/motor-mesh-view.js`'s `drawMaterial`
surface) and its element-count tests are discarded; they encode a design the
author did not set.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

The drawing is driven by **geometry from config, physics from mesh**:

- **Sprite geometry** comes from `expanded.slices[k].section.features` (the flat
  feature list — `kind`/`member`/`rRange`/`thetaRange`, magnets carry signed
  `Mr`/`Mtheta`, conductors carry global `circuit` + signed `turns`) plus
  `config.rings` (to classify each conductor's owning ring as concentrated `C`
  vs distributed `W`/`K`). Dispatch is only ever on `feature.kind` and
  `ring.element ∈ {W,C,M,I,K}` — both legitimate agnosticism axes; no machine
  name or machine-type is ever read.
- **Field overlays** (flux lines, |B|, saturation, magnetization arrows,
  current-direction glyphs) come from the FE solution `perSliceField[k]`
  (`{rotor,stator}.{Anode, Belem:{mag,Bx,By}, mesh}`, `gap.phi`). Flux lines are
  **smooth/interpolated** (resampled off the mesh onto a polar grid, not
  mesh-edge facets); |B| is a **blended** heatmap; saturation stays
  per-element/mesh-shaped.

The phase owns three render files plus a sanctioned one-tag `index.html`
addition, and rewrites the three render test files. The browser visual pass is
Phase 6; this phase ships headless tests only.

### Design decisions (current-state facts)

- **Sprite primitives live in a new `lib/cross-section-sprite.js`** (`LIB.CrossSectionSprite`),
  matching the repo's reusable-draw-lib convention (`gear-render`, `screw-render`,
  `belt-render`). Phase 5's 3-D rig reuses these primitives. Pure, DOM-free, draws
  into a caller-supplied 2-D context whose world→px transform is already set.
- **`lib/motor-mesh-view.js` is gutted to overlays-only.** It keeps `viridis` and
  the per-element saturation pass (mesh-shaped is acceptable) and gains a polar
  **field resampler** plus grid-based smooth flux-line and blended-|B| passes. The
  geometry/material/winding code (`colorFor`, `KIND_*`, `magnetPoleColor`, `draw`,
  `drawMaterial`, `drawMagnetization`, `drawCurrentDensity`) is deleted — those
  concerns move to the sprite lib.
- **`lessons/unified_motor/cross-section-render.js` is rewritten** to orchestrate:
  background → rotor sprite (rotated by `gap.phi`) → stator sprite → gap ring →
  field overlays gated on `UM.fieldViz` → smooth cross-gap flux via the corrected
  `LIB.GapEval` descriptor. It keeps the `registerCrossSection2D` + field-view
  header-control seams unchanged.
- **The stale `GapEval` call is fixed here.** The draft calls the removed signature
  `evalAOnGrid(field.gap, r_mr, r_ms, {…})`; Phase 2 ships
  `evalAOnGrid({rotor,stator,phi}, {Nr,Ntheta})`. This phase builds the descriptor
  from each body's `gapLoop` node indices + `Anode` + `gapR` + `gap.phi` and calls
  the two-argument form. (This resolves the transient regression Phase 2 documented
  as Phase-3-owned.)
- **Overlay recompute is memoized on `lastSolve` identity.** Resampled grids are
  cached and recomputed only when `runtime.lastSolve` changes; an unchanged/paused
  frame reuses the cache. Output is identical to per-frame recompute, with no
  throttle and no staleness.
- **Wire caps.** Distributed: up to `N_dist = 8` discrete wires per slot, then no
  more. Concentrated: an end-on wrapped bundle of up to `N_conc = 10` wires whose
  radius grows where turns accumulate (excess turns fold into the outer wires).
- **`index.html` one-tag addition (sanctioned overlap with Phase 1).** Phase 1
  declared `index.html` the sole owner of all `<script>` tags and already adds
  `../../lib/gap-eval.js` as its 5th engine tag. Phase 3 adds one additional tag:
  `../../lib/cross-section-sprite.js` (this phase's new lib). The `gap-eval.js`
  tag is already present from Phase 1; Phase 3 does not add a second one.
  `index.html` therefore appears in both Phase 1's and Phase 3's Files Owned by
  design; it is not a silent overlap.

## Files Owned

Created:
- `lib/cross-section-sprite.js` — sprite primitives (`LIB.CrossSectionSprite`)
- `tests/render/cross-section-sprite.test.js` — sprite-primitive headless tests

Modified:
- `lib/motor-mesh-view.js` — gutted to overlays-only (resampler + smooth flux + blended |B| + per-element saturation + `viridis`/`drawGapLoop`)
- `lessons/unified_motor/cross-section-render.js` — rewritten orchestration + corrected `GapEval` descriptor
- `lessons/unified_motor/index.html` — **sanctioned** addition of one `<script>` tag (`cross-section-sprite.js`); `gap-eval.js` already loaded by Phase 1; also owned by Phase 1
- `tests/render/mesh-view-prod.test.js` — rewritten for the overlays-only surface
- `tests/render/cross-section-render.test.js` — rewritten for the sprite render + descriptor call

> `index.html` is a deliberate, plan-anticipated cross-phase overlap with Phase 1
> (see Design decisions). All other files are Phase-3-exclusive.

## Wave 3.1: Sprite primitives + field overlays

Two file-disjoint task groups run in parallel: the sprite lib
(`cross-section-sprite.js`) and the overlays gut (`motor-mesh-view.js`).

### Task 3.1.1: Sprite geometry — iron teeth, magnets, shaft, gap

- **Description**: Create `lib/cross-section-sprite.js` registering
  `window.LIB.CrossSectionSprite` and implement the **passive geometry** sprite
  primitives. Each function is pure, DOM-free, and draws into a caller-supplied
  2-D context whose world→px transform (world metres, +y up, origin at the
  machine centre) is already installed. Inputs are arrays of Phase-2 feature
  objects; no mesh, no machine identity.

- **Files to create**:
  - `lib/cross-section-sprite.js` — IIFE attaching `window.LIB.CrossSectionSprite`
    with at least:
    - `drawIron(ctx, ironFeatures, opts)` — for each feature `{rRange:[r0,r1],
      thetaRange:[t0,t1]}`: a full-annulus feature (`t1−t0 ≥ 2π − 1e−6`) is drawn
      as a plain ring (outer arc CCW + inner arc CW, one closed path); a
      sub-`2π` feature is drawn as an **annular-sector tooth** with a **tooth-tip
      shoulder** near the gap edge — the angular half-width is flared by
      `opts.tipFlare` (default 1.25) over the outer `opts.tipFrac` (default 0.18)
      of the radial extent on the side given by `opts.gapEdge` (`"outer"` for
      rotor, `"inner"` for stator). Laminated-iron fill (`opts.fill`, default a
      steel gray) + outline (`opts.stroke`). The inter-tooth angular space left
      between adjacent sectors is the slot opening — it emerges from the
      narrower-than-pitch sectors and is not separately drawn.
    - `drawMagnet(ctx, magnetFeatures, opts)` — for each feature `{rRange,
      thetaRange, Mr, Mtheta}`: an annular-sector polygon filled **warm** when the
      radial magnetization is outward (`Mr ≥ 0`) and **cool** when inward
      (`Mr < 0`), with a centred "N"/"S" only when `opts.label !== false`. The
      radial-magnetization sign uses `Mr` (the feature already carries the signed
      remanence). Fill colors from `opts.nFill` / `opts.sFill`.
    - `drawMagnetArrows(ctx, magnetFeatures, opts)` — one magnetization arrow per
      magnet feature, from the sector centroid along the unit magnetization
      direction `(Mr·r̂ + Mtheta·θ̂)/|…|` at the centroid angle (the same
      construction the mesher uses), shaft + two-segment head. Length scales with
      `|hypot(Mr,Mtheta)|` normalised across the passed features. (Gated by the
      caller on the `magnetization` toggle.)
    - `drawShaftAndGap(ctx, geom, opts)` — `geom = {shaftR, gapInnerR, gapOuterR}`:
      a filled shaft disc of radius `shaftR` and a stroked air-gap ring between
      `gapInnerR` and `gapOuterR`.
    - A module-private viridis-independent palette is not required here.

- **Files to modify**: none.

- **Tests**:
  - `tests/render/cross-section-sprite.test.js::"drawIron draws one closed sector per tooth"` —
    extract `member:"rotor"`, `kind:"iron"` features from
    `CS.expand(loadMachine("vr-stepper")).slices[0].section` (the VR rotor has
    `teeth:8`); call `LIB.CrossSectionSprite.drawIron(ctx, ironFeats, {gapEdge:"outer"})`;
    assert the number of `closePath` ops equals the iron-feature count, and that
    count is 8.
  - `tests/render/cross-section-sprite.test.js::"a full-annulus iron feature draws a ring, not a flared tooth"` —
    a single synthetic iron feature with `thetaRange:[0, 2π]`; assert `drawIron`
    emits exactly one `closePath` and at least two `arc` ops (outer + inner ring),
    and never flares (no extra angular vertices beyond the ring).
  - `tests/render/cross-section-sprite.test.js::"drawMagnet shades N and S poles distinctly"` —
    magnet features from `CS.expand(loadMachine("pmsm")).slices[0].section`
    (alternating `Mr` sign, 8 magnets); assert the set of distinct `fillStyle`
    values used spans **two** colors (the N fill and the S fill) and that the
    fill count equals the magnet-feature count.
  - `tests/render/cross-section-sprite.test.js::"drawMagnetArrows emits one arrow per magnet"` —
    same pmsm magnet features; assert `lineTo` count ≥ `magnetCount * 3` (shaft +
    two head segments per magnet).
  - `tests/render/cross-section-sprite.test.js::"drawShaftAndGap draws a shaft disc and a gap ring"` —
    `drawShaftAndGap(ctx, {shaftR:0.02, gapInnerR:0.042, gapOuterR:0.044}, {})`;
    assert at least one `fill` (shaft disc) and at least one `stroke` (gap ring),
    and exactly the two `arc` radii 0.02 and (0.042|0.044) appear in the `arc`
    args.
  - `tests/render/cross-section-sprite.test.js::"is machine-agnostic and DOM-free"` —
    read `lib/cross-section-sprite.js` as UTF-8; assert it contains none of the
    machine names `bldc`, `pmsm`, `srm`, `squirrel`, `stepper`, `brushed`,
    `universal-motor`, `wound-field` (case-insensitive) and no `document.`
    reference.

- **Acceptance criteria**:
  - `lib/cross-section-sprite.js` exists and registers `window.LIB.CrossSectionSprite`
    with `drawIron`, `drawMagnet`, `drawMagnetArrows`, `drawShaftAndGap`.
  - Iron teeth render one outlined annular sector per iron feature with a gap-side
    tip shoulder; full-annulus iron features render as plain rings.
  - Magnet segments are N/S-shaded by `Mr` sign with optional arrows.
  - No machine-name/type or DOM reference appears in the file.
  - The five sprite-geometry tests above pass; the full `node --test` suite is green.

### Task 3.1.2: Sprite windings — individual wires (distributed + concentrated)

- **Description**: In `lib/cross-section-sprite.js`, implement the **winding**
  sprite primitive: individual conductor cross-sections, one set per slot,
  driven by the conductor features. The mode (concentrated vs distributed) is a
  per-feature tag the orchestrator supplies from the owning ring's `element`
  (`"C"` → concentrated, `"W"`/`"K"` → distributed); the sprite lib never reads
  config or machine identity — it draws what the tag says.

- **Files to modify**:
  - `lib/cross-section-sprite.js` — add:
    - `WIRE_PALETTE` — a fixed per-phase color cycle (module-private array).
    - `drawWinding(ctx, conductorFeatures, mode, opts)` where each feature is
      `{rRange:[r0,r1], thetaRange:[t0,t1], circuit, turns}`, `mode ∈
      {"distributed","concentrated"}`, and `opts = { currents?, showCurrentGlyph?,
      palette?, Ndist=8, Nconc=10, wireR? }`:
      - Wire color = `palette[((circuit % palette.length)+palette.length)%palette.length]`.
      - Polarity sign `s` = `sign(turns)`, or `sign(turns * currents[circuit])`
        when `showCurrentGlyph` and `currents` is supplied (zero current ⇒ no
        glyph). `s > 0` draws ⊙ (out of page, a filled centre dot); `s < 0`
        draws ⊗ (into page, a two-segment cross). One disc `arc` per drawn wire.
      - **distributed**: `v = min(Ndist, |round(turns)|)` uniform-radius wires
        packed in a grid inside the feature's `[r0,r1] × [t0,t1]` polygon; if
        `|turns| > Ndist`, only `Ndist` wires draw (cap, no widening).
      - **concentrated**: an end-on wrapped bundle of `v = min(Nconc,
        |round(turns)|)` wires laid along the slot's radial extent. The slot
        radial extent `[r0,r1]` is divided into `v` equal intervals; each wire
        centre is placed at the midpoint of its interval (deterministic equal
        spacing). Turn counts are distributed `base = floor(T/v)` per wire with
        the **outer** `T mod v` wires carrying `base + 1` (`T = |round(turns)|`);
        wire radius scales as `wireR · sqrt(turnsOnWire/baseTurns)` (∝
        `sqrt(turnsOnWire)`) so the bundle widens where turns accumulate
        (e.g. `T=11, Nconc=10` ⇒ 9 base-width + 1 wider wire). For `T ≤ Nconc`
        all wires carry one turn (uniform).

- **Tests**:
  - `tests/render/cross-section-sprite.test.js::"distributed slot draws up to Ndist discrete wires"` —
    conductor features from `CS.expand(loadMachine("pmsm")).slices[0].section`
    (stator W, `turns:20`); call `drawWinding(ctx, condFeats, "distributed",
    {Ndist:8})`; assert total `arc` (disc) ops `=== nCondFeatures * 8` (each slot
    capped at 8 wires), and assert per-feature the count never exceeds 8.
  - `tests/render/cross-section-sprite.test.js::"distributed wire count tracks small turn counts"` —
    a synthetic conductor feature with `turns:3`; `drawWinding(...,"distributed",{Ndist:8})`;
    assert exactly 3 disc `arc` ops.
  - `tests/render/cross-section-sprite.test.js::"concentrated coil draws a widening bundle"` —
    a synthetic conductor feature with `turns:11`; `drawWinding(ctx, [feat],
    "concentrated", {Nconc:10, showCurrentGlyph:false})`; capture the radius
    argument of each disc `arc`; assert there are 10 discs, the radii are
    non-decreasing, and there are at least two distinct radii (9 at the base
    radius, 1 larger).
  - `tests/render/cross-section-sprite.test.js::"wire polarity glyph flips with sign"` —
    one feature with `turns:+5` then `turns:-5`; assert the positive case emits a
    centre dot (`fillRect` or a small filled `arc`) and no cross, the negative
    case emits a cross (`moveTo`/`lineTo` pair) — the glyph kind differs between
    the two signs.
  - `tests/render/cross-section-sprite.test.js::"current sign drives the live glyph when showCurrentGlyph"` —
    feature `turns:+5`, `currents:[ -1 ]` (circuit 0), `showCurrentGlyph:true`;
    assert the glyph is the ⊗ (into-page) kind (net `turns*current < 0`), i.e.
    flipped relative to the static `turns`-only polarity.
  - `tests/render/cross-section-sprite.test.js::"phase color cycles by circuit index"` —
    two features with `circuit:0` and `circuit:1`; assert the disc `fillStyle`
    values used for the two features are different palette entries.

- **Acceptance criteria**:
  - Each slot renders individual conductor cross-sections, never a single filled
    slot rectangle.
  - Distributed slots cap at `N_dist` uniform wires; concentrated coils render an
    end-on bundle of ≤ `N_conc` wires that widen where turns accumulate.
  - Wire color cycles by `circuit`; the ⊙/⊗ polarity glyph follows `sign(turns)`
    and, when live currents are supplied, `sign(turns·current)`.
  - All `drawWinding` tests pass; the full `node --test` suite is green.

### Task 3.1.3: Overlays-only `motor-mesh-view.js` — smooth flux, blended |B|, saturation

- **Description**: Gut `lib/motor-mesh-view.js` to the field-overlay surface.
  Delete the geometry/material/winding code. Add a polar **field resampler** so
  flux lines and |B| are computed off the mesh (smooth/interpolated), not as
  mesh-edge facets. Keep saturation per-element (mesh-shaped) and keep `viridis`
  and `drawGapLoop`.

- **Files to modify**:
  - `lib/motor-mesh-view.js`:
    - **Remove** `colorFor`, `KIND_COLORS`, `KIND_PALETTE`, `magnetPoleColor`,
      `draw`, `drawMaterial`, `drawMagnetization`, `drawCurrentDensity` and their
      exports. (The Phase-2-era `draw`/`drawMaterial` element-fill surface is gone.)
    - **Keep** `viridis`, `eachElement`, `elementPath`, `elementCentroid`,
      `drawGapLoop`. (`eachElement`/`elementPath`/`elementCentroid` stay
      **private** module helpers used by the overlay functions — they are not in
      the `Export exactly` list below.)
    - **Add** `elemToNodal(bodyMesh, elemVals) → Float64Array(Nn)` — area-agnostic
      nodal averaging of a per-element scalar (each node = mean of incident
      elements' values).
    - **Add** `resampleField(bodyMesh, nodal, opts) → { rs, thetas, Az, Nr, Ntheta }` —
      resample a per-node scalar onto a uniform polar grid over the body's
      `[rMin, rMax] × [0, 2π)` annulus (`opts = { Nr, Ntheta }`). Build a uniform
      grid of element buckets over the body's annulus (each element placed in the
      bucket(s) its bounding box overlaps) so each grid point's containing-element
      lookup is O(1) expected rather than O(Ne); this index is built once per
      `resampleField` call (or memoized with the grid). For the containing tri/quad
      (quad split into two tris), barycentric-interpolate the three node values;
      grid points outside every element fall back to the nearest node value.
      Returns the grid and `Az` row-major `[i*Ntheta + j]`.
    - **Rewrite** `drawFluxLines(ctx, grid, opts)` to take a **resampled grid**
      (not `bodyMesh, Anode`): marching-squares over the polar grid cells (two
      tris per cell, periodic in `θ`), collecting contour points per level, and
      stroke each contour as a **smoothed** polyline (Catmull-Rom through the
      ordered crossing points, emitted as `bezierCurveTo`/`quadraticCurveTo`), so
      lines are smooth curves, not mesh facets. `opts = { levels=12, color,
      lineWidth }`.
    - **Rewrite** `drawModulusB(ctx, grid, opts)` to take a resampled |B| grid and
      paint a **blended** heatmap: fill each polar cell as a quad whose color is
      `viridis` of the bilearly-interpolated cell magnitude (corner average),
      yielding a smooth blend rather than flat per-element fills.
      `opts = { range="auto", alpha }`.
    - **Keep/rewrite** `drawSaturation(ctx, bodyMesh, Belem, opts)` as the
      per-iron-element flat-`viridis` pass (mesh-shaped retained), `|B|/Bknee`
      mapped 0..2 → 0..1, non-iron skipped, `BkneeDefault=1.6`.
    - Export exactly: `{ viridis, elemToNodal, resampleField, drawFluxLines,
      drawModulusB, drawSaturation, drawGapLoop }`.

- **Tests**:
  - `tests/render/mesh-view-prod.test.js::"resampleField interpolates a nodal field off the mesh"` —
    build the pmsm rotor mesh (`meshOf("pmsm","rotor")`); set `Anode[n] =
    cos(2·atan2(y,x))`; `grid = resampleField(mesh, Anode, {Nr:12, Ntheta:96})`;
    assert `grid.Az.length === 12*96`, `grid.rs.length === 12`,
    `grid.thetas.length === 96`, and that at a sampled interior grid point the
    value is within `0.1` (absolute) of the analytic `cos(2θ)` at that `(r,θ)`.
  - `tests/render/mesh-view-prod.test.js::"drawFluxLines strokes smooth curves from a grid"` —
    a synthetic `cos(2θ)` grid (`{Nr:12, Ntheta:96}`); `drawFluxLines(ctx, grid,
    {levels:8})`; assert the stroke count is `>= 1` (a non-constant field produced
    at least one stroke), and assert the log contains `bezierCurveTo` or
    `quadraticCurveTo` ops (smooth curves, not raw `lineTo` facets).
  - `tests/render/mesh-view-prod.test.js::"drawFluxLines emits no strokes for a constant grid"` —
    a constant-`Az` grid; assert zero `stroke` ops.
  - `tests/render/mesh-view-prod.test.js::"drawModulusB blends across the grid"` —
    a radial |B| ramp grid; `drawModulusB(ctx, grid, {range:"auto"})`; assert the
    number of distinct `fillStyle` values is `>= 8` (smooth blend, many shades),
    not the handful a per-element fill would give.
  - `tests/render/mesh-view-prod.test.js::"drawSaturation only shades iron elements"` —
    pmsm rotor mesh; `drawSaturation(ctx, mesh, { mag })` with `mag` filled `1.0`;
    assert `fill` count equals the rotor iron-element count (`> 0`).
  - `tests/render/mesh-view-prod.test.js::"drawSaturation uses BkneeDefault when material.Bknee is null"` —
    the synthetic single-iron-element mesh (`Bknee:null`, `mag:1.6`); assert the
    first `fillStyle` equals `MMV.viridis(0.5)`.
  - `tests/render/mesh-view-prod.test.js::"the removed geometry surface is gone"` —
    read `lib/motor-mesh-view.js` as UTF-8 and assert it contains none of the
    substrings `drawMaterial`, `drawCurrentDensity`, `colorFor`, `magnetPoleColor`,
    `KIND_PALETTE`.

- **Acceptance criteria**:
  - `lib/motor-mesh-view.js` no longer defines or exports `draw`, `drawMaterial`,
    `colorFor`, `magnetPoleColor`, `drawMagnetization`, or `drawCurrentDensity`.
  - `resampleField` returns a correctly-shaped polar grid that interpolates a
    nodal field to within the stated tolerance off the mesh.
  - `drawFluxLines` and `drawModulusB` consume a resampled grid and produce smooth
    curves and a blended heatmap respectively; `drawSaturation` remains
    per-iron-element.
  - All `mesh-view-prod.test.js` tests above pass; the full `node --test` suite is green.

## Wave 3.2: Orchestration + cross-gap flux + index.html

### Task 3.2.1: Rewrite `cross-section-render.js` + wire `index.html`

- **Description**: Rewrite `lessons/unified_motor/cross-section-render.js` to
  drive the sprite primitives + overlays per slice, and add the one `index.html`
  script tag (`cross-section-sprite.js`). The render reads only `runtime`, `config`, `expanded`, the slice
  mesh, and the per-slice field — no machine identity, no DOM beyond the mount's
  own canvases. Depends on Wave 3.1 (`LIB.CrossSectionSprite`,
  `LIB.MotorMeshView` overlays) and Phase 2 (`LIB.GapEval`).

- **Files to modify**:
  - `lessons/unified_motor/cross-section-render.js` — rewrite so that, per painted
    canvas (slice `k` per the existing two-canvas seam):
    - Resolve `bodies = runtime.stack.sliceMesh(k)`, `section =
      expanded.slices[k].section`, `features = section.features`, `rings =
      config.rings`, `field = runtime.lastSolve?.perSliceField?.[k] ?? null`,
      `phi = field ? field.gap.phi : (runtime.state ? runtime.state.theta : 0)`.
    - Build a fit transform centring the union of both bodies (`+y` up) — preserve
      the existing centre/scale approach.
    - Split `features` by `member` and `kind`. Classify each conductor feature's
      mode by its owning ring: a conductor feature belongs to the ring whose
      `member` matches and whose slot radial extent contains the feature's `rRange`.
      The slot radial extent field is `ring.slotRRange` (falling back to
      `ring.rRange` when `slotRRange` is absent — the same pattern used throughout
      `config-schema.js:82` and `config-schema.js:281`). "Contains" is defined as
      `ring.slotRRange[0] ≤ feature.rRange[0] && feature.rRange[1] ≤ ring.slotRRange[1]`
      (using the resolved fallback value in place of `ring.slotRRange` when absent).
      `mode = (ring.element === "C") ? "concentrated" : "distributed"`.
    - **Rotor sprite** (drawn inside a `save`/`rotate(phi)`/`restore`): `drawIron`
      (rotor iron feats, `gapEdge:"outer"`), `drawMagnet` (rotor magnet feats),
      `drawWinding` per mode (rotor conductor feats; pass `currents =
      runtime.state.i`, `showCurrentGlyph = UM.fieldViz.currentDensity`), and
      `drawShaftAndGap` for the shaft.
    - **Stator sprite** (no rotation): `drawIron` (`gapEdge:"inner"`), `drawMagnet`,
      `drawWinding` per mode.
    - **Gap ring** between the rotor surface and stator bore.
    - **Field overlays**, each gated on `UM.fieldViz` and drawn only when `field`
      is present, using `LIB.MotorMeshView`, with rotor overlays inside the
      `rotate(phi)` frame:
      - `saturation` → `drawSaturation(body.mesh, body.Belem)`.
      - `modulusB` → `resampleField(body.mesh, elemToNodal(body.mesh,
        body.Belem.mag), {Nr,Ntheta})` then `drawModulusB(grid)`.
      - `magnetization` → `LIB.CrossSectionSprite.drawMagnetArrows(magnet feats)`.
      - `fluxLines` → `resampleField(body.mesh, body.Anode, {Nr,Ntheta})` then
        `drawFluxLines(grid)` per body; **plus** the smooth cross-gap pass below.
      - `gapLoop` → `drawGapLoop`.
    - **Cross-gap flux** (when `fluxLines` and `field`): build the Phase-2
      descriptor and call `LIB.GapEval.evalAOnGrid(descriptor, {Nr:8, Ntheta:96})`,
      then march iso-contours of the returned `Az` over the polar grid in the
      **lab** frame. The descriptor is
      `{ rotor: ringFromGapLoop(bodies.rotor, field.rotor.Anode),
         stator: ringFromGapLoop(bodies.stator, field.stator.Anode),
         phi: field.gap.phi }`, where `ringFromGapLoop(body, Anode)` returns
      `{ gapR: body.gapR, gapTheta: Float64Array of atan2(y,x) over body.gapLoop
        node coords, A: Float64Array of Anode[body.gapLoop[i]] }`. The stale
      `evalAOnGrid(field.gap, r_mr, r_ms, …)` call is removed.
    - **Overlay memoization**: cache resampled grids keyed on the current
      `runtime.lastSolve` reference (+ `k` + body + field-kind); recompute only
      when `lastSolve` changes.
    - Keep `register(UM)` installing `registerCrossSection2D({paint})` and the
      `registerHeaderControl({id:"field-view", build})` six-toggle control
      unchanged; keep the load-time auto-register guard (`if
      (UM.registerHeaderControl) register(UM)`); keep `UM.CrossSectionRender =
      {paint, register}`.
  - `lessons/unified_motor/index.html` — add one `<script>` tag:
    - `<script src="../../lib/cross-section-sprite.js"></script>` immediately
      **after** the Phase-1-added `<script src="../../lib/motor-mesh-view.js"></script>`
      line. (`gap-eval.js` is already present from Phase 1, after `fea-solver.js`.
      `cross-section-sprite.js` is in the engine `<script>` block that loads before
      `motor-stack.js`; it depends only on `LIB` already loaded above it, and loads
      before the lesson `cross-section-render.js`.)

- **Tests**:
  - `tests/render/cross-section-render.test.js::"register installs the 2-D seam and field-view control"` —
    (retain) assert `UM.CROSS_SECTION_2D.paint` is a function after `register`, and
    that the `field-view` header control builds a checkbox subtree with the
    six-key `UM.fieldViz` default `{fluxLines:true, modulusB:false,
    saturation:false, magnetization:false, currentDensity:false, gapLoop:false}`.
  - `tests/render/cross-section-render.test.js::"paint draws individual wires, not per-element material fills"` —
    step a pmsm runtime once; paint with `fieldViz` all-off; assert disc `arc` ops
    are present and the total `fill` count is far below the slice mesh element
    count `meshElemTotal(runtime,0)` (sprite teeth/magnets/wires, not one fill per
    element) — concretely `fills < 0.5 * Ne`.
  - `tests/render/cross-section-render.test.js::"paint dispatches modulusB (viridis blend) when toggled"` —
    `fieldViz.modulusB=true, fluxLines=false`; assert `rgb(`-form `fillStyle`
    values (viridis) appear; with `modulusB=false` they do not.
  - `tests/render/cross-section-render.test.js::"paint paints sprites when lastSolve is null"` —
    fresh pmsm runtime, no step (`runtime.lastSolve === null`); assert `paint` does
    not throw and disc `arc` (wire) ops are present (geometry draws without a field).
  - `tests/render/cross-section-render.test.js::"paint rotates the rotor sprite by gap.phi"` —
    set `perSliceField[0].gap.phi = 0.0` then `0.6`; capture the first rotor sprite
    vertex (first `moveTo`/`arc` after the background) each time; assert it moves
    by `> 1e-3`.
  - `tests/render/cross-section-render.test.js::"cross-gap flux calls GapEval with a {rotor,stator,phi} descriptor"` —
    temporarily replace `LIB.GapEval.evalAOnGrid` with a spy returning a minimal
    valid grid; `fieldViz.fluxLines=true`; paint a stepped pmsm runtime; assert the
    spy's first argument has numeric `rotor.gapR`, `stator.gapR`, `phi`, and
    `Float64Array` `rotor.gapTheta`/`rotor.A`/`stator.gapTheta`/`stator.A` of equal
    per-body length, and that the second argument is `{Nr, Ntheta}`. Assert the spy
    was **not** passed the legacy `field.gap` object (no `harmonics` key on arg 0).
  - `tests/render/cross-section-render.test.js::"no DOM access at module load"` —
    (retain) re-require with `window=globalThis` and no `document`; assert no throw
    and that `register` did not auto-run.
  - `tests/render/cross-section-render.test.js::"no machine names in the file"` —
    (retain) assert the file contains none of `bldc`, `pmsm`, `srm`, `squirrel`,
    `stepper`, `brushed`, `universal-motor`, `wound-field` (case-insensitive).
  - `tests/render/cross-section-render.test.js::"index.html loads gap-eval and cross-section-sprite in order"` —
    read `lessons/unified_motor/index.html`; assert it contains both
    `../../lib/gap-eval.js` (added by Phase 1) and `../../lib/cross-section-sprite.js`
    (added by Phase 3); that
    `indexOf("../../lib/fea-solver.js") < indexOf("../../lib/gap-eval.js")` and
    `indexOf("../../lib/gap-eval.js") < indexOf("../../lib/motor-stack.js")`; and
    that `indexOf("../../lib/cross-section-sprite.js") <
    indexOf("./cross-section-render.js")`.

- **Acceptance criteria**:
  - `cross-section-render.js` draws the sprite cross-section (iron teeth, magnets,
    individual wires, shaft, gap) per slice, rotor rotated by `gap.phi` (fallback
    `state.theta`), with the five field overlays gated independently on
    `UM.fieldViz`.
  - The cross-gap flux pass builds the Phase-2 `{rotor,stator,phi}` descriptor from
    `gapLoop` + `Anode` and calls `LIB.GapEval.evalAOnGrid(descriptor, {Nr,Ntheta})`;
    no `field.gap`/`r_mr`/`r_ms` legacy call remains.
  - Painting is safe before the first solve (sprites draw, no overlay, no throw)
    and overlay grids are recomputed only when `runtime.lastSolve` changes.
  - `index.html` loads `gap-eval.js` (after `fea-solver.js`, before `motor-stack.js`)
    and `cross-section-sprite.js` (after `motor-mesh-view.js`, before
    `cross-section-render.js`); the existing Phase-1 `index-wiring.test.js`
    ordering assertions still pass.
  - All `cross-section-render.test.js` tests above pass; the full `node --test`
    suite is green.

## Notes / cross-phase ripples

- **`gap-eval.js` tag owned by Phase 1.** Phase 1 adds `../../lib/gap-eval.js` as
  its 5th engine `<script>` tag in `index.html`. Phase 3 adds only
  `cross-section-sprite.js`; no duplicate `gap-eval.js` tag is introduced here.
- **Phase 5 reuse.** `LIB.CrossSectionSprite` is the primitive surface Phase 5's
  `render3d.js` extrudes; Phase 5 must not re-implement tooth/magnet/wire drawing.
- **Phase 6 audit allow-list.** `lib/cross-section-sprite.js` is a new file that
  `scripts/agnosticism-audit.js` must allow-list alongside the others Phase 6
  already extends (`machine-picker.js`, `geometry-panel.js`, `render3d.js`,
  `gap-eval.js`); Phase 6 owns that edit.
- **Hybrid-stepper edge geometry.** The `C` ring with `poleTeeth` (grouped fine
  teeth) and no `slotFraction` still resolves: its conductor features carry
  explicit `rRange`/`thetaRange` from the expander, and `drawIron` renders each
  emitted tooth feature regardless of grouping — no special case in the render.
