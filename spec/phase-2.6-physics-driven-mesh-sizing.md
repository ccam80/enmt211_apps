# Phase 2.6 — Physics-driven mesh sizing

> Treated as expanded scope on **batch-6** (Phase 2 wave 2.3) for the same reason
> as Phase 2.5: the visual ack for T2.3.2 surfaced foundational defects that
> can't honestly be ack'd without addressing. Authorized by the user 2026-05-27.

## Motivation

The current mesher (after Phase 2.5) is a structured-quad grid generator with
manual user-tunable knobs (`refine`, `dofBudget`, `gapLayers`, `Nr`, `Ntheta`).
Each feature band gets **1 radial layer × refine**, regardless of the physics
that band needs to resolve. Default behaviour for a wound conductor band 6 mm
thick is one radial cell across the entire slot — the conductor cross-section
has zero internal resolution.

A real FEA mesher auto-derives cell sizes from physics:
- Skin depth in conductors (frequency-dependent)
- Saturation-gradient sharpness in iron (B-H knee dependent)
- Geometric curvature at feature corners / tooth tips
- Optional coarse-solve adaptive refinement

This phase adds the first three. Adaptive AMR is out of scope (see §Out of scope).

## Scope of fix

### Lib

- `lib/motor-mesh.js` `buildRadialNodes` — currently gives every feature band
  `Math.max(1, round(1 × refine))` radial layers. Replace with **physics-derived
  per-band layer count**:
  - For W (wound), C (slot+iron), K (cage) conductor bands: target cell radial
    size = `min(skinDepth/3, bandThickness/3)`. Number of layers =
    `max(3, ceil(bandThickness / targetCellSize))`. The `min(…/3, bandThickness/3)`
    guarantees ≥ 3 layers even if skin depth is huge (DC operation).
  - For M (magnet) bands: target cell size = `bandThickness / 4` (4 layers
    minimum across permanent magnet — captures magnetization gradient).
  - For I (salient iron) bands and back-iron bands of W/C/K: target cell size =
    `bandThickness / max(2, ceil(satMultiplier))` where `satMultiplier` is
    derived from expected B-field magnitude (see "Saturation refinement" below).
  - All target counts then multiplied by global `refine ∈ [0.25, 4]`.

- `lib/motor-mesh.js` `buildAngularColumns` — currently `divsPerBand` is uniform.
  Add **per-feature curvature refinement**:
  - For each feature whose `thetaRange` span is less than half the body period
    (i.e. it's a localised tooth/magnet/slot, not a back-iron full-sector), add
    1 extra column edge at the feature mid-angle (so the feature is split into
    2 sub-cells minimum). Cumulatively this gives tooth-tip regions more
    tangential resolution than back-iron regions.
  - All counts multiplied by global `refine` as before.

- `lib/motor-mesh.js` — add the helper `physicsTargets(features, opts) →
  {perBandLayers, perFeatureExtraCols}` so the algorithms above can be
  unit-tested in isolation.

### Physics inputs the mesher needs

The mesher currently takes `section` (geometry features) and `opts` (Nr, refine,
gapLayers, etc.). The physics-driven sizing needs additional information that
isn't in geometry alone:

- **Conductor operating frequency** (for skin depth). Source: per-circuit
  terminal config — `terminal.type` ∈ {DC, AC, STEP, CURRENT} plus
  `terminal.freq` (for AC) or `terminal.chopFreq` (for STEP). For DC and
  CURRENT, use 0 Hz → skin depth = ∞ → layer count falls back to the
  `bandThickness/3` floor (≥3 layers).
- **Iron material Bknee** (for saturation gradient). Already in `materials[]`
  via Phase 5's per-iron `Bknee` passthrough. If null → use 1.6 T as default
  (typical M-19 steel knee).
- **Expected operating current** (for B-field estimation). Source:
  `terminal.amp` from the same circuit.

To pipe these through cleanly, extend the mesher's `opts` to accept:
```
opts.physics = {
  circuits: [{ freq: number|null, amp: number, conductorMaterial: "copper"|"aluminum"|... }, ...],
}
```
plus a per-feature `srcId` already in features (so the mesher knows which
circuit feeds which conductor band).

Provide a small helper `physicsFromConfig(config)` that extracts the physics
shape from a fixture config so the dev page and tests don't have to repeat the
extraction logic.

### Caller updates

- `lessons/unified_motor/mesh-dev.html`: extract physics via
  `physicsFromConfig` and pass to `MotorMesh.buildCached(section, { …, physics })`.
- The LRU cache key (`signature`) must include a hash of the physics inputs —
  otherwise the cached mesh from one operating point is incorrectly reused at
  another. Extend `signature` to take `opts.physics` and fold its hash in.

### Tests

- `tests/mesh/auto-sizing.test.js` NEW:
  - Wound conductor at 60 Hz with copper resistivity gets ≥ ceil(8.5mm /
    targetCellSize) layers across a 6 mm slot. Specifically: at 60 Hz copper
    skin depth = 8.5 mm, targetCellSize = min(8.5/3, 6/3) = 2 mm,
    layers = max(3, ceil(6/2)) = 3.
  - Wound conductor at 10 kHz (PWM) gets denser layers: skin depth ≈ 0.66 mm,
    targetCellSize = 0.22 mm, layers ≈ 27 across 6 mm slot.
  - Iron band whose expected B exceeds 0.7 × Bknee gets ≥ 2× the default
    layer count.
  - Iron band whose expected B is well below Bknee gets the default count.
  - A localised tooth feature (small thetaRange) gets ≥ 2 angular sub-cells.
  - A back-iron full-period feature does NOT get the per-feature extra column.

- `tests/mesh/cache.test.js` (EXTEND, do not weaken):
  - Add: changing `physics.circuits[0].freq` from 60 Hz to 1000 Hz invalidates
    the cache entry for the wound body. The new build produces a strictly
    finer mesh.

- `tests/mesh/convergence.test.js` (EXTEND, do not weaken):
  - Add: PMSM fixture at default opts (refine=1, no manual mesh tuning) passes
    a torque-convergence check against `refine=2` to within 2% — i.e. the
    auto-derived mesh is fine enough that the user doesn't need to crank refine.

### Existing tests

All 48 mesh tests from Phase 2.5 must still pass without softening. If a test
breaks under the new mesher, the same no-softening rule applies: classify as
(a) real mesher bug to fix, or (b) test was asserting buggy behaviour and must
be rewritten.

The 7 refine-and-dofbudget tests in particular must still pass: `refine=0.5`
must produce a coarser mesh than `refine=1`, and `dofBudget=N` must still cap
the element count.

## Acceptance

1. Default `MotorMesh.build(section, { physics })` on every one of the 15
   fixtures produces a mesh whose wound-conductor bands have ≥ 3 radial layers,
   magnets have ≥ 4 layers, irons in saturated regions are refined, and
   localised tooth features have ≥ 2 angular sub-cells.

2. `node --test tests/mesh/*.test.js` is at least 53/53 (48 pre-existing + 5 new
   in auto-sizing + cache + convergence).

3. No fixture's Ne explodes beyond `dofBudget` when one is provided. (i.e. the
   auto-sizing respects the budget.)

4. `signature` correctly invalidates the cache when `physics.circuits[i].freq`
   or `terminal.amp` changes.

5. `mesh-dev.html` continues to render all 15 fixtures cleanly, with brushed-DC
   conductors now visibly having multiple radial cells in the slot region.

## Strict rules for the implementer

- **NO threshold / tolerance softening.** Same rule as Phase 2.5 + Phase 2.6
  mesher-fix rounds. If a test fails, classify and decide; never widen
  tolerances to make assertions pass.
- **NO** silent reuse of cache entries when physics differs.
- **NO** hard-coded conductor material (copper); read it from per-circuit
  config or default to copper with a documented warning at first use.
- **NO** `// TODO`, `// for now`, deferred-cleanup comments.

## Out of scope

- **Adaptive mesh refinement (AMR)** — coarse-solve, estimate residual, refine
  high-residual elements, re-solve. That's a future phase (Phase 5+ has
  convergence sweeps but no AMR).
- **Higher-order p-refinement** — staying with linear quads throughout the
  build.
- **Per-element non-quad shapes** — no triangles, no transition cells. Quad
  count adjusts uniformly per band.
- **Real eddy-current solve** — the mesh is sized for skin depth, but the
  actual eddy-current physics is a Phase 5+ concern.
- **Anisotropic materials** — assume isotropic μ_r and resistivity per material.
