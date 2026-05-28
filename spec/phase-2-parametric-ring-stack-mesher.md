# Phase 2: Parametric Ring-Stack Mesher

## Overview

Build the custom in-browser quad-dominant ring-stack mesher that **replaces the
polar rasterizer** below the `MotorSlice` seam (`fea-engine-rebuild.md` §3.1–§3.2,
§8). It consumes the **unchanged** `config-schema` per-slice output
`section = {grid, gapBand, features}` and emits a conforming, graded,
quad-dominant mesh per body (rotor, stator) whose element edges lie on feature
boundaries, plus a uniform-Δθ mid-gap circle (`gapLoop`) per body for the
harmonic interface (Phase 4). Rotor and stator mesh independently (no shared
nodes; the harmonic gap couples them). Generation is O(N): a body is periodic in
θ, so one angular sector is meshed as a structured (r,θ) block, tiled by period,
and mapped to Cartesian. Plain JS IIFE modules (no ES modules, no fetch) attached
to `window.LIB`. **Element-kind dispatch only — no machine identity** (binding
constraint §11.1#1; the mesher reads `feature.kind ∈ {iron, magnet, conductor}`
and `feature.member ∈ {rotor, stator}`, never a machine name or type).

This phase has **no FEA solver or assembly** (those are Phases 1 and 5), so it
validates **mesh geometry and topology** only — field/torque convergence is
Phase 7. All checks are headless (`node --test`) against the `BodyMesh` data
structure plus a recording-mock 2-D context for the visualizer; true visual
confirmation is a user-required browser pass.

### Locked decisions for this phase (settled with the author)

- **D1 — `BodyMesh` payload (Option A).** The §8 typed-array spine is extended
  with a per-body `materials[]` table (`matId` indexes it; **index 0 is always
  air**) and a per-element `turns: Float64Array(Ne)` (signed turns for conductor
  elements, 0 otherwise). `magDir` stays a **unit** remanence direction per §8;
  the remanence magnitude `mrMag` lives in the magnet's `materials` entry. Each
  material also carries an optional **`Bknee: number | null`** (Tesla) — the
  Brauer-saturation knee Phase 5's `ν(B²) = k1 + k2·exp(k3·B²)` fit anchors to
  (§11.3). `Bknee` is non-null only for iron-bearing materials when the
  originating feature supplies it (via Phase 3's optional `ring.Bknee` →
  `feature.Bknee` pass-through); otherwise `Bknee === null` and Phase 5 falls
  back to its `opts.saturation.BkneeDefault`. This is the §3.1
  `Material{matId→ν}` / `Magnet{elemId→Mr}` / `Source{elemId→circuit}` intent,
  made self-contained so the per-body cache is self-describing.
- **D2 — gmsh is a dev-time oracle; its `.msh` output is a committed test
  fixture.** gmsh (v4.15.2, installed and on PATH) has no CI/browser build
  (§3.2), so the committed suite never invokes the gmsh **binary**. Instead,
  `scripts/gen-mesh-refs.mjs` (run once by the implementer, who now has gmsh)
  generates static `.msh` references into `tests/mesh/fixtures/` and **commits
  them**; the convergence test diffs against those committed data files — so it
  **runs** (not skips) on any checkout that has the references. A skip-guard
  remains only as a portability fallback for a checkout missing the references.
  The primary M7 oracles stay analytic/intrinsic (annulus area, feature-coverage
  vs config, conformity, min-angle, refinement convergence); the gmsh diff is an
  added independent cross-check.
- **D3 — headless visualizer tests.** `motor-mesh-view.js` exposes a pure
  `colorFor(...)` plus a `draw(ctx, mesh, opts)` tested against a recording-mock
  2-D context (call-count assertions). Real visual confirmation is a
  **user-required** browser pass via `lessons/unified_motor/mesh-dev.html`.
- **D4 — mesh-metric convergence only.** Phase 2 converge-tests area-error,
  min-angle, and coverage error across a refinement sequence; field/torque
  convergence is Phase 7.
- **D5 — regression set = the 15 fixtures.** The existing
  `lessons/unified_motor/machines/*.js` fixtures are the warm-cache + regression
  configs. No new config files are invented.

## The `BodyMesh` contract (what Phases 4 and 5 consume)

`LIB.MotorMesh.build(section, opts) → { rotor: BodyMesh, stator: BodyMesh }`.

```
BodyMesh {
  member:    "rotor" | "stator"
  nodes:     Float64Array(2·Nn)   // x,y interleaved, body-local frame
  elems:     Int32Array(4·Ne)     // CCW node indices; tri = 4th index === -1
  matId:     Int32Array(Ne)       // index into materials[]; 0 === air
  srcId:     Int32Array(Ne)       // circuit index for conductor elems, else -1
  turns:     Float64Array(Ne)     // signed turns for conductor elems, else 0   [D1]
  magDir:    Float64Array(2·Ne)   // UNIT cartesian remanence dir for magnet elems, else (0,0)
  materials: Array<{ kind:"air"|"iron"|"magnet"|"conductor", muR:number, mrMag:number, Bknee:number|null }>  [D1]
  gapLoop:   Int32Array           // ordered node indices on the uniform-Δθ mid-gap circle
  gapTheta:  Float64Array         // θ per gapLoop node (uniform, CCW), length === gapLoop.length
  gapR:      number               // gap-circle radius (rotor r_mr / stator r_ms)
  sig:       string               // topology signature → cache key
}
```

- `materials[0]` is always `{ kind:"air", muR:1, mrMag:0, Bknee:null }`.
  Iron/magnet/conductor materials are appended in first-encounter order; dedup
  key is `(kind, muR, mrMag, Bknee)` — two iron features with the same `muR`
  but different `Bknee` therefore produce two distinct `materials[]` entries
  (Phase 5 needs the per-material Bknee for its Brauer fit and cannot be
  merged across knees).
- `Bknee` is taken from `feature.Bknee` when the feature carries it (Phase 3's
  optional `ring.Bknee` pass-through); otherwise `Bknee === null` and Phase 5
  substitutes its `opts.saturation.BkneeDefault`. Air and conductor materials
  always have `Bknee === null` (they never saturate in the FEA model).
- A magnet element's remanence vector is `mrMag · (magDir.x, magDir.y)`. `mrMag`
  is the per-material magnitude `hypot(feature.Mr, feature.Mtheta)`; `magDir` is
  that vector rotated into Cartesian at the element centroid angle and
  normalized. Pole sign and slice sign (from `config-schema` `fluxSources`) are
  carried entirely by `magDir`'s direction (a 180° flip), so `mrMag` stays
  positive.
- A conductor element's source is `(srcId = feature.circuit, turns = feature.turns · area_e / A_feature)`
  where `area_e` is the element's area and `A_feature = Σ_{e' : srcId[e'] = srcId[e]} area_{e'}`
  is the total cross-sectional area of the feature. This makes `turns[e]` the
  area-weighted share of the feature's ampere-conductor count, so Phase 5's bridge
  `Jz_e = current · turns[e] / area_e = current · feature.turns / A_feature` is
  uniform across the feature and mesh-invariant. `srcId = -1` and `turns = 0` for
  non-conductor elements.

## Collar / gap-circle geometry (§3.3, §9-G0, §11.4)

- `r_rotor_surface = max over rotor features of rRange[1]`;
  `r_stator_bore = min over stator features of rRange[0]`;
  `g = r_stator_bore − r_rotor_surface` (gap length).
- Rotor `gapR = r_rotor_surface + 0.25·g`; stator `gapR = r_stator_bore − 0.25·g`
  (so `r_mr < r_ms`, both strictly inside the gap).
- Each body extends from its conforming feature surface through a **structured
  pure-air collar** of `opts.gapLayers` radial layers to its `gapR` circle; the
  collar's outer circle has uniform Δθ = `2π / N_gap` nodes (`gapLoop` /
  `gapTheta`). The annulus between the two circles is **not meshed**.
- **Gap-node floor `N_gap ≥ opts.gapMinNodes` (the harmonic-interface coupling).**
  Phase 4's harmonic gap (`lib/airgap-harmonic.js`) truncates at `K =
  3·max(slots,poles)` and **requires `N_gap ≥ 4K`** on each body (Nyquist +
  margin, §11.4) — `build` there throws if a body's `gapLoop` is shorter. The
  mesher therefore accepts an optional `opts.gapMinNodes` (a plain integer) and
  raises each body's gap-circle node count to at least that value, **snapped up to
  the next multiple of the body angular period `P_body`** so the collar stays
  structured and the circle stays uniform-Δθ. The mesher stays machine-agnostic:
  it consumes only the integer `gapMinNodes`. The caller that knows the machine's
  pole/slot counts (Phase 5) computes `gapMinNodes = 4·(3·max(slots,poles))` and
  passes it; left unset (`null`), the gap-node count is whatever the angular
  resolution produces. This floor is a hard minimum — `opts.dofBudget` reductions
  (below) must not pull `N_gap` under it (the gap circle is the field interface
  and cannot be starved; budget is recovered from yoke/radial divisions instead).
  The `dofBudget` cap interacts with the body-period `P_body` snap on
  non-gap divisions: the mesher reduces non-gap divisions to fit, but
  because every angular division snaps to a multiple of `P_body`, the
  final `Nn` may overshoot `opts.dofBudget` by up to one body-period of
  nodes. Callers planning DOF budgets tightly should treat
  `opts.dofBudget` as `Nn ≤ opts.dofBudget + P_body` rather than a strict
  upper bound.

## Generation model (architecturally significant; internals left to implementer)

- A body's angular **period** `P_body = gcd` over the angular counts of its rings
  (teeth for `I`/`C`-salient, magnets for `M`, slot count `Q` for `W`/`C`/`K`);
  full-circle features (back-iron) are compatible with any period. The sector
  angle is `2π / P_body`; one sector is meshed as a structured (r,θ) block and
  tiled `P_body` times. This O(N) sector-tiling is what the `sig` keys and what
  keeps generation ~1 ms/body.
- Radial node lines are placed on every feature `rRange` sub-band edge, with
  geometric grading dense→gap (and `opts.yokeCoarsen` coarsening in yokes).
- Within a sector, angular node lines are placed on every feature `thetaRange`
  edge so no element straddles a feature boundary; air fills the inter-feature
  angular gaps.
- The (r,θ)→Cartesian map `(r·cosθ, r·sinθ)` yields near-90° quads by
  construction (no Ruppert-style quality bound needed).

## Public API (`LIB.MotorMesh`)

- `build(section, opts) → { rotor:BodyMesh, stator:BodyMesh }`
- `buildCached(section, opts) → { rotor:BodyMesh, stator:BodyMesh }` — LRU per
  body `sig`
- `signature(section, member, opts) → string`
- `quality(bodyMesh) → { minAngle, maxAngle, maxAspect, nInverted, nDegenerate, areaError }`
  (`areaError = |Σ elem area − annulusArea| / annulusArea`; angles in degrees)
- `cacheStats() → { hits, misses, size }`
- `clearCache()`

`opts` (grading knobs, all optional with defaults): `{ gapLayers=3,
yokeCoarsen=1, dofBudget=null, refine=1, gapMinNodes=null }`. `refine` scales
every angular and radial division count (used by the convergence test);
`dofBudget` caps total nodes by reducing divisions to fit. `gapMinNodes` (the
Phase-4 harmonic-interface floor) forces each body's uniform gap circle to at
least that many nodes, snapped up to the next multiple of the body period
`P_body`; it is a hard floor that `dofBudget` must not violate. `gapMinNodes` is
part of the topology `signature` (it changes `N_gap`).

## Public API (`LIB.MotorMeshView`)

- `colorFor(matId, materials) → cssColorString` — pure; distinct colors per
  material kind.
- `draw(ctx, bodyMesh, opts) → void` — fills one polygon per element (path
  through its node coords), strokes edges, and overlays `gapLoop` when
  `opts.showGapLoop`. `opts = { showGapLoop=true, colorBy:"material"|"circuit",
  palette }`. Only `draw` touches the 2-D context; loading the module is
  DOM-free.

## Files Owned

> `lib/motor-mesh-view.js` is **created** in this phase (Task 2.1.1) and will be
> **extended** in Phase 6 (Wave 6.1, "promote to production render"). The two
> phases are sequential (Phase 6 depends on Phases 2 and 5), so there is no lock
> contention; Phase 6's spec will list it in its own Files Owned when authored.

> `lib/motor-mesh.js` and `tests/mesh/_fixtures.js` are created in Wave 2.1
> and modified by later waves (2.2, 2.3) within this same phase. The waves
> run **strictly sequentially** (Wave 2.2 cannot start until Wave 2.1's
> implementer has marked their work complete, and the same for 2.3), so no
> two task_groups ever hold a lock on the same file at the same wall-clock
> instant. The manifest places the per-wave groups (`2.1.a`, `2.2.a`,
> `2.3.a`) in distinct groups by wave on purpose: each milestone is a
> coherent agent-sized chunk, and collapsing them would exceed the
> per-group file cap and lose the incremental M0→M1→…→M7 deliverability
> structure. The file-locality review rule's sequential-wave carve-out
> (documented in `spec/.context/rules.md`) covers this pattern explicitly.

- `lib/motor-mesh.js` — created
- `lib/motor-mesh-view.js` — created
- `lessons/unified_motor/mesh-dev.html` — created (dev harness; visual-verification vehicle)
- `scripts/gen-mesh-refs.mjs` — created (dev-only gmsh reference generator)
- `tests/mesh/_fixtures.js` — created
- `tests/mesh/mesh-core.test.js` — created
- `tests/mesh/mesh-view.test.js` — created
- `tests/mesh/feature-templates.test.js` — created
- `tests/mesh/collar-gap.test.js` — created
- `tests/mesh/cache.test.js` — created
- `tests/mesh/convergence.test.js` — created
- `tests/mesh/fixtures/*.msh` — created (committed gmsh reference meshes, generated once by `scripts/gen-mesh-refs.mjs`; gmsh 4.15.2 is installed and on PATH)

## Wave 2.1: Mesh struct, visualizer, single annulus, ring stack (M0+M1+M2)

### Task 2.1.1: `BodyMesh` struct + canvas visualizer + single annulus + ring stack
- **Description**: Create `lib/motor-mesh.js` with the `BodyMesh` struct and the
  `LIB.MotorMesh` public API, implementing **M0** (struct + the `build`/`quality`
  surface), **M1** (a single graded iron annulus → Cartesian quads), and **M2**
  (ring stack + gap: radial layering of multiple rings, conforming ring
  interfaces, graded radial spacing toward the gap, separate rotor and stator
  bodies). Create `lib/motor-mesh-view.js` with `colorFor` + `draw` (M0
  visualizer). At this milestone the collar/gapLoop (M4) need not be final, but
  `build` returns both bodies with the full typed-array spine populated for the
  feature kinds present, and `materials[0]` is air.
- **Files to create**:
  - `lib/motor-mesh.js` — IIFE attaching `window.LIB.MotorMesh` with `build`,
    `signature`, `quality`, `buildCached`, `cacheStats`, `clearCache`; the
    `BodyMesh` typed-array spine + `materials[]` + `turns[]` per D1; radial
    grading; (r,θ)→Cartesian map; per-body separation (rotor/stator disjoint node
    sets).
  - `lib/motor-mesh-view.js` — IIFE attaching `window.LIB.MotorMeshView` with the
    pure `colorFor(matId, materials)` and `draw(ctx, bodyMesh, opts)`.
  - `tests/mesh/_fixtures.js` — loader (shim → `util.js`, `winding-model.js`,
    `lessons/unified_motor/config-schema.js`, `lib/motor-mesh.js`,
    `lib/motor-mesh-view.js`) + helpers: `meshFromConfig(config, opts)` (expand →
    take slice-0 `section` → `build`), `singleAnnulusSection()`,
    `ringStackSection()`, `signedAreaOf(mesh, e)`, `annulusArea(r0,r1)`,
    `interiorEdgeSharing(mesh) → { ok: boolean, badEdges: Array<[nodeA, nodeB]> }` —
    returns `{ ok: true, badEdges: [] }` iff every interior edge of `mesh` is
    shared by exactly two elements; otherwise `ok: false` and `badEdges` lists
    the violating `(nodeA, nodeB)` pairs as sorted node-index tuples for
    diagnostic output, `recordingCtx()` (mock 2-D context counting
    `beginPath`/`moveTo`/`lineTo`/`closePath`/`fill`/`stroke`/`arc`), and
    `assertClose` (re-exported from `tests/_assert.js`).
  - `tests/mesh/mesh-core.test.js` — `node:test` + `node:assert/strict`;
    the M0/M1/M2 assertions enumerated below.
  - `tests/mesh/mesh-view.test.js` — `node:test` + `node:assert/strict`;
    the visualizer assertions enumerated below.
- **Files to modify**: (none)
- **Tests**:
  - `tests/mesh/mesh-core.test.js::M0 struct shape` — for a single-iron-annulus
    section, assert `nodes.length === 2*Nn`, `elems.length === 4*Ne`,
    `matId.length === srcId.length === turns.length === Ne`,
    `magDir.length === 2*Ne`; `materials[0]` deep-equals
    `{kind:"air", muR:1, mrMag:0, Bknee:null}`; every entry of `materials`
    has a `Bknee` field (number or `null`); `typeof sig === "string" &&
    sig.length > 0`.
  - `tests/mesh/mesh-core.test.js::Bknee distinguishes otherwise-identical iron
    materials` — build a section with two iron features that share `member`,
    `rRange`, `muR`, and `mrMag` but specify different `Bknee` (e.g. 1.4 and
    1.8); assert `mesh.materials.filter(m => m.kind === "iron").length === 2`
    (the dedup key includes `Bknee`, so the two irons stay distinct), and that
    the two materials' `Bknee` values are exactly `1.4` and `1.8` in
    first-encounter order.
  - `tests/mesh/mesh-core.test.js::M1 no inverted or degenerate elements` —
    assert `quality(mesh).nInverted === 0` and `quality(mesh).nDegenerate === 0`
    (every element signed area `> 1e-12`).
  - `tests/mesh/mesh-core.test.js::M1 total area equals annulus` — assert
    `quality(mesh).areaError < 1e-2` for the single iron annulus.
  - `tests/mesh/mesh-core.test.js::M1 near-90 degree quads` — assert
    `quality(mesh).minAngle > 20` and `quality(mesh).maxAngle < 160`.
  - `tests/mesh/mesh-core.test.js::M2 rotor and stator nodes are disjoint` — for
    the ring-stack section, assert the rotor and stator `BodyMesh` share no node
    coordinate (no `(x,y)` appears in both within 1e-12).
  - `tests/mesh/mesh-core.test.js::M2 conforming interfaces (no hanging nodes)` —
    assert `interiorEdgeSharing(mesh).ok === true` (every interior edge
    referenced by exactly two elements; outer/inner/gap-surface boundary edges,
    the only allowed once-referenced edges, are filtered before the check by
    the helper). On failure the assertion message includes the first three
    entries of `badEdges` for triage.
  - `tests/mesh/mesh-core.test.js::M2 radial grading toward the gap` — assert the
    radial node spacing in the layer adjacent to the gap surface is `<` the
    spacing at the mid-yoke for each body.
  - `tests/mesh/mesh-view.test.js::colorFor distinct per kind` — assert
    `colorFor` returns four pairwise-distinct strings for the air / iron / magnet
    / conductor material indices.
  - `tests/mesh/mesh-view.test.js::draw emits one polygon per element` — with a
    `recordingCtx()`, assert `draw(ctx, mesh, {showGapLoop:false})` calls `fill`
    exactly `Ne` times and `beginPath` at least `Ne` times.
  - `tests/mesh/mesh-view.test.js::draw overlays gapLoop` — assert
    `draw(ctx, mesh, {showGapLoop:true})` issues strictly more path operations
    than with `showGapLoop:false` (the gapLoop overlay is drawn).
- **Acceptance criteria**:
  - `LIB.MotorMesh.build(section, opts)` returns `{rotor, stator}`, each a
    `BodyMesh` with every contract field populated and `materials[0]` air.
  - Single iron annulus: zero inverted/degenerate elements, `areaError < 1e-2`,
    `minAngle > 20°`.
  - Ring stack: rotor and stator node sets are disjoint; no hanging nodes on
    interior edges; radial spacing grades finer toward the gap.
  - `motor-mesh-view.js` loads DOM-free; `draw` against a mock context emits one
    filled polygon per element plus a gapLoop overlay; `colorFor` is pure and
    kind-distinct.
  - All listed tests pass.

## Wave 2.2: Angular feature templates — the 5 element kinds (M3)

### Task 2.2.1: Angular sector templates dispatched on element kind
- **Description**: Implement **M3** in `lib/motor-mesh.js`: the per-ring-type
  angular sector template, dispatched **only** on `feature.kind` /
  `ring.element` ∈ `{I, M, W, C, K}` — `I` uniform/salient iron teeth (air
  between teeth); `M` magnet segments with inter-magnet air and alternating
  `magDir` per pole; `W` yoke + slot/tooth angular division with conductor cells
  carrying `srcId`/`turns`; `C` a salient tooth per coil plus conductor cells;
  `K` slots with bar conductors (routed identically to `W`; the short is a
  circuit-terminal concern upstream, not a mesh branch). Every conductor element
  gets `srcId = feature.circuit` and `turns = feature.turns`; every magnet
  element gets `mrMag` (material) + unit `magDir`. Validated by the
  **feature-coverage diff** against `config-schema`.
- **Files to create**:
  - `tests/mesh/feature-templates.test.js`
- **Files to modify**:
  - `lib/motor-mesh.js` — add the angular sector templates for the five element
    kinds and the per-element `matId`/`srcId`/`turns`/`magDir` tagging; no change
    to the public API signatures.
- **Tests**:
  - `tests/mesh/feature-templates.test.js::no element straddles a feature
    boundary` — for a config exercising each kind, assert every element's four
    corners classify to the **same** feature region (or all air): no element
    spans two distinct `(rRange,thetaRange)` feature footprints.
  - `tests/mesh/feature-templates.test.js::every feature region is tiled` — for
    each `config-schema` feature, assert the summed area of elements whose
    `materials[matId].kind` matches the feature kind and whose centroid lies in
    the feature footprint equals the feature region area within rel tol `1e-2`
    (the coverage diff is zero).
  - `tests/mesh/feature-templates.test.js::I salient iron leaves air between
    teeth` — for an `I` ring with `teeth=N`, assert exactly `N` iron angular
    spans separated by air spans (count of iron→air transitions around the ring
    `=== 2N`).
  - `tests/mesh/feature-templates.test.js::M alternating magnetization` — for an
    `M` ring, assert magnet elements exist, `mrMag === hypot(Mr, Mtheta)`, every
    `magDir` is unit length (`hypot === 1` within 1e-9), and adjacent poles'
    `magDir` point oppositely (dot product `< 0`).
  - `tests/mesh/feature-templates.test.js::W conductors carry circuit and turns`
    — for a `W` ring, assert every conductor element has `srcId >= 0` and
    `turns` equal to the originating feature's signed `turns`; the back-iron iron
    feature is tiled; inter-slot regions are air.
  - `tests/mesh/feature-templates.test.js::C salient teeth plus conductors` — for
    a `C` ring, assert both salient tooth iron elements (one span per slot) and
    conductor elements (with `srcId`) are present.
  - `tests/mesh/feature-templates.test.js::K bar conductors present` — for a `K`
    ring, assert conductor elements with `srcId >= 0` are tiled (mesher treats
    `K` like `W`; no machine-identity branch).
- **Acceptance criteria**:
  - The feature-coverage diff is zero for every kind: every feature footprint is
    exactly tiled by elements of the matching material kind, and no element
    straddles a feature boundary.
  - Magnet `magDir` is unit, alternates per pole, and `mrMag` carries the
    magnitude; conductor `srcId`/`turns` match the source feature.
  - Element-kind dispatch only — no machine name/type read anywhere in
    `lib/motor-mesh.js`.
  - All listed tests pass.

## Wave 2.3: Air collar + gap circle, grading knobs, cache, validation harness (M4+M5+M6+M7)

### Task 2.3.1: Air collar + uniform-Δθ gap circle + grading/quality knobs
- **Description**: Implement **M4** (the structured pure-air collar from each
  body's conforming surface to its uniform-Δθ `gapR` circle; emit
  `gapLoop`/`gapTheta`/`gapR` — the §3.3/§9-G0 handoff) and **M5** (the grading
  and quality knobs: `opts.gapLayers`, `opts.yokeCoarsen`, `opts.dofBudget`,
  `opts.refine`, `opts.gapMinNodes`, surfaced through `quality(...)`). Collar
  radii per §11.4: rotor `gapR = r_rotor_surface + 0.25·g`, stator
  `gapR = r_stator_bore − 0.25·g`. The `opts.gapMinNodes` floor raises each body's
  uniform gap-circle node count to at least `gapMinNodes`, **snapped up to the
  next multiple of the body period `P_body`** (so the collar stays structured and
  uniform-Δθ); it is a **hard floor** — when `opts.dofBudget` is also set, budget
  is recovered from yoke/radial divisions and never by pulling `N_gap` below the
  floor. This is the Phase-4 harmonic-interface coupling (the caller passes
  `gapMinNodes = 4·(3·max(slots,poles))`); the mesher itself reads only the
  integer and stays machine-agnostic.
- **Files to create**:
  - `tests/mesh/collar-gap.test.js`
- **Files to modify**:
  - `lib/motor-mesh.js` — add the air collar, the uniform-Δθ gap circle emission
    (`gapLoop`/`gapTheta`/`gapR`), and the `opts` grading/quality knobs including
    `opts.gapMinNodes` (the gap-node floor, snapped to a multiple of `P_body`,
    overriding any `dofBudget` reduction of the gap circle).
- **Tests**:
  - `tests/mesh/collar-gap.test.js::gapLoop nodes lie on a circle` — for rotor and
    stator, assert every `gapLoop` node radius equals `gapR` within 1e-9.
  - `tests/mesh/collar-gap.test.js::gapTheta is uniform and ordered` — assert
    `gapTheta` is monotonically increasing (CCW), spans `[0, 2π)`, and successive
    differences are all equal to `2π/N_gap` within 1e-9.
  - `tests/mesh/collar-gap.test.js::collar radii match the 0.25·g rule` — compute
    `r_rotor_surface`, `r_stator_bore`, `g` from the section; assert rotor
    `gapR === r_rotor_surface + 0.25·g` and stator
    `gapR === r_stator_bore − 0.25·g` within 1e-9, and `rotor.gapR < stator.gapR`.
  - `tests/mesh/collar-gap.test.js::collar is pure air` — assert every element
    radially between a body's conforming surface and its `gapR` circle has
    `materials[matId].kind === "air"`.
  - `tests/mesh/collar-gap.test.js::gapLayers knob adds radial layers` — assert
    building with `gapLayers:4` yields strictly more collar elements than
    `gapLayers:2`, and `quality(mesh).minAngle > 20` at both settings.
  - `tests/mesh/collar-gap.test.js::dofBudget caps node count` — assert building
    with a small `dofBudget` (e.g. `dofBudget: 200` on a body whose `P_body = 8`)
    produces `Nn <= dofBudget + P_body` (the documented snap overshoot), the
    node count is strictly less than an unbudgeted build of the same section,
    and `quality(mesh).nInverted === 0`.
  - `tests/mesh/collar-gap.test.js::gapMinNodes floors the gap-circle node count`
    — for a representative fixture body, build with `gapMinNodes:200`; assert
    `gapLoop.length >= 200`, `gapLoop.length % P_body === 0` (snapped to a
    multiple of the body period), `gapTheta` is still uniform (successive diffs
    equal within 1e-9), and `quality(mesh).nInverted === 0`. Building the same
    section without `gapMinNodes` yields a strictly smaller `gapLoop.length`.
  - `tests/mesh/collar-gap.test.js::gapMinNodes overrides dofBudget on the gap
    circle` — build with both `gapMinNodes:200` and a small `dofBudget`; assert
    `gapLoop.length >= 200` (the floor wins) while total `Nn` is still reduced
    relative to an unbudgeted build (budget recovered from non-gap divisions).
- **Acceptance criteria**:
  - Each body emits a uniform-Δθ `gapLoop` circle at the §11.4 collar radius; the
    collar is pure air; `rotor.gapR < stator.gapR`, both inside the gap.
  - Grading knobs change layer counts / DOF as specified without producing
    inverted elements or dropping `minAngle` below 20°.
  - `opts.gapMinNodes` raises each body's `gapLoop.length` to at least its value,
    snapped up to a multiple of the body period `P_body`, keeping `gapTheta`
    uniform; the floor holds even under a competing `opts.dofBudget` (binding the
    Phase-4 `N_gap ≥ 4K` handoff).
  - All listed tests pass.

### Task 2.3.2: Signature + LRU cache + validation harness + dev gmsh script + dev harness page
- **Description**: Implement **M6** (per-body topology `signature` + `buildCached`
  LRU cache, keyed by body `sig`; structured so the ~20 ms symbolic `analyze` can
  be cached alongside once Phase 1's solver lands — additive per-body, never
  per-machine, §3.2) and **M7** (the validation harness: **mesh-metric
  refinement convergence** + the **15-fixture regression sweep**, on
  analytic/intrinsic oracles; plus the gmsh-reference cross-check against
  committed `.msh` fixtures). Create `lessons/unified_motor/mesh-dev.html`, a
  standalone dev harness that loads
  `util.js`, `winding-model.js`, `config-schema.js`, `motor-mesh.js`,
  `motor-mesh-view.js`, and all 15 `machines/*.js` fixtures, with a fixture
  picker and rotor/stator canvas panes rendering each body's mesh — the vehicle
  for the user-required visual pass. Create `scripts/gen-mesh-refs.mjs`, a
  dev-only Node script that invokes gmsh (when on PATH) to write static `.msh`
  references into `tests/mesh/fixtures/`; it is **not** run by `node --test`.
- **Files to create**:
  - `tests/mesh/cache.test.js`
  - `tests/mesh/convergence.test.js`
  - `scripts/gen-mesh-refs.mjs` — dev script (run via Node + the on-PATH `gmsh`
    binary); writes a `.geo` per representative body and invokes
    `gmsh <file>.geo -2 -o tests/mesh/fixtures/<name>.msh`; guards on gmsh
    presence and exits with a clear message if absent. Not run by `node --test`.
    Before invoking gmsh on each generated `.geo`, the script writes a
    header comment line into the resulting `.msh` reading
    `// gap_layers: <N>` (where `<N>` is the gap-layer count the
    corresponding mesher build used — passed in as a known constant per
    reference body). The line is inserted as a `// `-prefixed comment at the
    very top of the file (gmsh `.msh` v4 format tolerates leading
    `//`-prefixed lines that downstream parsers ignore). The diff harness
    then has a self-describing reference of expected gap-layer count
    without geometric inference.
  - `lessons/unified_motor/mesh-dev.html` — standalone dev harness (script tags
    only, no ES modules; loads the 15 fixtures + the mesher + the visualizer;
    fixture picker; rotor/stator canvas panes).
  - `tests/mesh/fixtures/*.msh` — committed gmsh reference meshes for a handful of
    representative bodies (generated once by `scripts/gen-mesh-refs.mjs`; gmsh
    4.15.2 is installed and on PATH). At least 2 references committed (one
    magnet-rotor body, one wound-stator body).
- **Files to modify**:
  - `lib/motor-mesh.js` — add `signature`, `buildCached`, `cacheStats`,
    `clearCache` (LRU per body `sig`, capacity ≥ 8 per body).
  - `tests/mesh/_fixtures.js` — add `loadAllFixtures()` (require all 15
    `machines/*.js`, return `UnifiedMotor.MACHINES`), `coverageError(section,
    mesh)`, and `readMsh(path) → { elemCount, minAngle, nodeCount, gapLayers }` —
    parses a gmsh `.msh` v4 file enough to extract the element count, the
    minimum interior angle in degrees, the node count, and the `gap_layers`
    value written by `scripts/gen-mesh-refs.mjs` as a leading
    `// gap_layers: <N>` header comment (returns `null` for `gapLayers` if
    the header is absent — older references generated before that field
    existed).
- **Tests**:
  - `tests/mesh/cache.test.js::signature is stable` — assert
    `signature(section,"rotor",opts) === signature(section,"rotor",opts)` across
    two calls.
  - `tests/mesh/cache.test.js::signature tracks topology` — assert changing a
    topology field (e.g. magnet/teeth count, a radius, `opts.gapLayers`, or
    `opts.gapMinNodes`) changes the signature, while rebuilding an identical
    section/opts does not.
  - `tests/mesh/cache.test.js::buildCached hits the cache` — after `clearCache()`,
    a first `buildCached` is a miss and a second identical call is a hit
    (`cacheStats().hits` increments; the returned body deep-equals the first).
  - `tests/mesh/cache.test.js::LRU evicts oldest` — build more distinct bodies
    than the per-body capacity; assert `cacheStats().size` is capped and
    re-requesting the oldest-evicted body is a miss.
  - `tests/mesh/convergence.test.js::area error converges under refinement` — for
    a representative fixture body, build at `refine ∈ {1, √2, 2}`; assert
    `quality.areaError` is non-increasing across the sequence and the finest is
    `< 2e-3`.
  - `tests/mesh/convergence.test.js::min-angle stays bounded under refinement` —
    assert `quality.minAngle > 20` at every refinement level (no degradation).
  - `tests/mesh/convergence.test.js::coverage error is zero at every level` —
    assert `coverageError(section, mesh) < 1e-2` at every refinement level.
  - `tests/mesh/convergence.test.js::15-fixture regression sweep` — for every
    machine in `loadAllFixtures()`, build rotor + stator and assert
    `nInverted === 0`, `nDegenerate === 0`, `coverageError < 1e-2`, and a
    uniform-Δθ `gapLoop` is emitted for both bodies.
  - `tests/mesh/convergence.test.js::gmsh reference diff` — reads the committed
    `tests/mesh/fixtures/*.msh` references (no gmsh binary invoked at test time);
    for each reference, assert the mesher's element count is within 2× of the
    reference's, `minAngle` within the reference's ±10°, and the gap-layer count
    matches. If (and only if) no `.msh` files are present, `skip` with a message
    naming `scripts/gen-mesh-refs.mjs` (portability fallback for a sparse
    checkout) — with the references committed, this test runs.
- **Acceptance criteria**:
  - `signature` is stable and topology-sensitive; `buildCached` is an LRU keyed
    by body `sig` (capacity ≥ 8 per body) with correct hit/miss/eviction
    behavior; the cache is per-body, never per-machine.
  - Mesh-metric convergence holds: `areaError` non-increasing to `< 2e-3`,
    `minAngle > 20°` at all levels, zero coverage error at all levels.
  - All 15 fixtures mesh with zero inverted/degenerate elements, zero coverage
    error, and a uniform `gapLoop` on both bodies.
  - `scripts/gen-mesh-refs.mjs` has been run (gmsh 4.15.2 on PATH) and at least
    2 `.msh` references are committed under `tests/mesh/fixtures/`; the
    gmsh-reference diff test runs against them (element count within 2×, minAngle
    within ±10°, matching gap-layer count) and is not skipped. The skip path
    triggers only on a checkout missing the references.
  - **User-required**: with a static server rooted at the repo
    (`python -m http.server 8765`), open
    `http://localhost:8765/lessons/unified_motor/mesh-dev.html`, step through all
    15 fixtures, and confirm for each: conforming teeth/magnets/slots, graded gap
    layers, no visibly inverted/tangled elements, and a uniform-circle `gapLoop`
    overlay on both rotor and stator.
  - All listed (non-skipped) tests pass.

## Out of Scope (Phase 2)

- FEM assembly, the SPD operator, local B–H Newton (Phase 5).
- The harmonic-gap coupling that consumes `gapLoop` (Phase 4).
- The FEA solver / symbolic `analyze` (Phase 1) — the cache is structured to key
  it later but does not compute it here.
- Field/torque convergence and any physics acceptance criterion (Phase 7).
- Promotion of `motor-mesh-view.js` to the production cross-section render and
  the live machine picker / geometry sliders (Phase 6).

## Amendments (2026-05-28) — area-weighted `turns[e]` semantic

The original `BodyMesh` contract specified `turns[e] = feature.turns` —
i.e. the full feature `turns` value replicated into every element of a
conductor feature. Combined with Phase 5's bridge formula
`Jz_e = current · turns[e] / area_e`, this made the total ampere-turns
through a slot cross-section equal `K · N · I`, where `K` is the number
of mesh elements covering the feature and `N = feature.turns`. The total
ampere-turns therefore scaled linearly with mesh refinement: doubling the
mesh density doubled the effective excitation, and torque under load was
non-convergent under mesh refinement (the symptom that surfaced T5.2.1's
convergence failure on `pmConfig` with `currents = [5]`).

The fix, settled with the author: `turns[e]` is the area-weighted share
of the feature's ampere-conductor count,
`turns[e] = feature.turns · area_e / A_feature`, with
`A_feature = Σ area_{e'}` over all elements that share `srcId[e]`. Then
`Jz_e = current · turns[e] / area_e = current · feature.turns / A_feature`
is uniform across the feature and independent of how many mesh elements
cover it. Total ampere-turns through the slot is
`∫ Jz dA = current · feature.turns`, the physical N·I, mesh-invariant.

The physical justification is the standard low-frequency magnetostatic
winding model: at 60 Hz the copper skin depth (~8 mm) is several times
larger than any slot dimension in a small machine, so the current density
`Jz` is uniform across the slot cross-section. Dedicated FEA codes
(Maxwell, FEMM, etc.) all use uniform `Jz` for winding sources for this
reason. The cage-rotor "each-bar-its-own-feature" path is unaffected:
each bar is a single feature with its own `srcId`, so the area-weighted
share still gives uniform `Jz` across the bar.

Implementation note: Phase 5's flux-linkage extraction
`λ_k = ell · Σ_{e : srcId[e]=k} A_avg(e) · turns[e]` is also correct under
the new semantic — it becomes `ell · feature.turns · (∫ A dA / A_feature)`,
the area-averaged `A` times the feature turn count, which is the physical
flux linkage per turn integrated over the conductor cross-section.

This amendment does not change the per-element-magnet `magDir` semantic
(magnets remain per-element unit-direction vectors at element centroids,
with magnitude in the material entry) and does not change the `srcId` or
`materials` interpretation. Only the conductor `turns[e]` value is
redefined.
