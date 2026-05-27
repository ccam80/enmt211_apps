# Phase 2.7 — Per-feature tangential mesh + uniform gap band + constraints

> Replaces an earlier (heuristic ν_max × poles uniform-Δθ) draft of this
> phase. Treated as expanded scope on **batch-6** (Phase 2 wave 2.3) for
> the same reason as Phases 2.5 and 2.6. Authorized by the user
> 2026-05-28 after risk-investigation pass.

## Motivation

The previous Phase 2.7 round added physics-derived ν_max but kept the
heuristic-era constraint of uniform Δθ across the whole body, which
forced LCM-alignment to feature boundaries. That gave:
- Massive over-mesh on fixtures with irrational-looking feature angles
  (universal rotor 204 cpp, brushed-DC rotors 108 cpp) when the LCM
  alignment exploded
- Under-mesh on magnet rotors (PMSM rotor 9 cpp) because per-body ν_max
  ignored the stator's harmonics that the gap field carries

The principled fix:
1. **Drop uniform-Δθ-across-whole-body.** Each feature gets cells uniform
   WITHIN itself, no straddling, but adjacent features have different
   cell widths.
2. **Keep uniform Δθ only in the gap-adjacent band** so Phase 4's
   harmonic gap interface sees uniform θ samples as it requires.
3. **ν_max is per-slice**, taken as the maximum across all windings in
   the slice (both rotor and stator), since the gap field couples both
   bodies.
4. **Bridge the per-feature vs uniform-gap mismatch with a constraint
   matrix C** that ties hanging nodes (interior side) to bracketing
   master nodes (gap-band side) via linear interpolation. The mesh
   exports C; Phase 5's assembly applies CᵀKC to the body blocks.

This is the cleanest path that simultaneously:
- Eliminates straddling at material boundaries (which causes 1-3% torque
  error from the wrong-material assignment with iron-air μ ratio of
  ~1000)
- Preserves uniform gap-loop sampling (Phase 4 requirement)
- Bounds total element count (no LCM explosion)
- Resolves the highest MMF harmonic the simulation needs (per-slice
  ν_max ensures both bodies get enough cells)
- Keeps the linear system SPD (constraint preserves SPD under CᵀKC
  transformation)

## Scope of fix

### Lib

`lib/motor-mesh.js` — major rework of `buildAngularColumns` and a new
constraint-matrix builder:

- **`tangentialPhysicsTargets(features, member, opts) → { cellsPerPole,
  nuMax, perFeatureLocalizedExtras }`** — keeps same signature as the
  prior round but now `ν_max` is taken as `max(ν_max_rotor,
  ν_max_stator)` computed across `opts.windings` for the WHOLE slice,
  not per-body. The helper sees both members' windings and returns the
  slice-wide ν_max.

- **Per-feature column generation** in `buildAngularColumns`:
  - Target cell angular width `Δθ_target = 2π / (poles × cells_per_pole)`.
  - For each feature in the member (sorted by `thetaRange[0]`):
    - `n_cells_feature = max(1, round(featureSpan / Δθ_target))`
    - Place `n_cells_feature` cells uniformly within the feature's
      angular span; cell edges land at the feature's exact boundaries
      `thetaRange[0]` and `thetaRange[1]`.
  - **Total Ntheta = sum of per-feature cell counts.** Adjacent features
    have different cell widths in general.
  - No LCM math. No uniform-Δθ assumption across features.

- **Gap-adjacent band uniform-Δθ override**:
  - The radial band immediately adjacent to the gap (top band on rotor,
    bottom band on stator) gets `Ntheta_gap = poles ×
    round(2.4 × ν_max_slice)`, uniform spacing, ignoring feature
    boundaries.
  - Cells in this band may straddle feature boundaries — but every
    feature in the gap-adjacent band is, in the worst case, a magnet
    pole edge or salient tooth tip, where the local feature-edge
    straddling is bounded by the magnet/tooth count (12-50 per body),
    and the `perFeatureLocalizedExtras` already adds 5-10 extra columns
    at each magnet pole-edge / 3 extra at each tooth-tip to densify
    locally. The dominant material per cell still gives bounded error
    because the gap-band feature widths are typically much larger than
    Δθ_gap.

- **Constraint matrix generation** — new internal helper
  `buildBandTransitionConstraints(body, bands) → { slaves: Int32Array,
  masters: Float64Array }`:
  - Walk each pair of adjacent bands.
  - For each transition where the two bands have different column
    structures: nodes on the "more uniform" side are masters; nodes on
    the "less uniform" side that don't coincide (within ε = 1e-9) with
    a master are slaves.
  - Coincident nodes are merged into the master (no constraint needed,
    just shared index).
  - Each slave is constrained to its two bracketing masters with
    weights `(1-w), w` where `w = (θ_slave - θ_master_left) /
    (θ_master_right - θ_master_left)`. The assertion `0 < w < 1` is
    enforced; failures are mesher bugs (bracket logic).
  - Output: `slaves[k] = global_idx_of_slave_k`; `masters[k*4 +
    {0,1,2,3}] = {idx_left, w_left=(1-w), idx_right, w_right=w}` —
    flat Float64Array of master indices and weights, parallel to slaves.

- **`BodyMesh.constraints`** — new optional field on the returned body
  struct, populated only when band transitions create hanging nodes
  (i.e., the gap-adjacent band's Ntheta differs from the next band
  inward). Shape: `{ slaves, masters }` per the helper above. When the
  whole body happens to have uniform columns (e.g., a single-band
  fixture), the field is `null`.

- **Element generation respects per-band column counts**: cells in each
  band connect to nodes within the band's column structure. At band
  transitions, the band on each side has its own column edges; cells
  are quads bounded by within-band column edges. Hanging nodes appear
  on the band-boundary row — they belong topologically to the inner
  band's elements but are constrained by the outer band's nodes.

- **`physicsTargets` and `physicsFromConfig`** (extended in prior
  round): now ν_max is computed slice-wide. `physicsFromConfig` returns
  `windings` as a Map keyed by ringIdx (unchanged), plus a new
  `nuMaxSlice` derived from the max across the map.

- **`signature` (cache key)**: include `nuMaxSlice` and the per-band
  column count vector — when slice-wide ν_max changes, cache
  invalidates.

### Tests

`tests/mesh/per-feature-columns.test.js` (NEW):
- PMSM stator: number of cells in each slot feature equals
  `round(slotSpan / Δθ_target)`; cells are uniform within each feature;
  cell EDGES land EXACTLY on feature boundaries (within 1e-9 rad).
- Universal rotor: total Ntheta is now `Σ round(featureSpan / Δθ_target)`
  not LCM-driven; total elements drop from ~4080 to ~ poles × cells_per_pole
  × layers + localized extras.
- Brushed-DC-PM rotor: same.
- Back-iron full-period feature gets exactly one cell across its angular
  span (or however many `round(span/Δθ_target)` gives, but no special
  per-feature padding).

`tests/mesh/uniform-gap-band.test.js` (NEW):
- For each of the 15 fixtures, the gap-adjacent band has uniform Δθ at
  `2π / Ntheta_gap` where `Ntheta_gap = poles × cells_per_pole`.
- Gap-loop nodes are evenly spaced — `gapTheta[i+1] - gapTheta[i] ===
  gapTheta[1] - gapTheta[0]` within 1e-12 rad for all i.
- Phase 4's `N_gap ≥ 4·K` floor is satisfied for all 15 fixtures at
  default physics opts.

`tests/mesh/constraints.test.js` (NEW):
- For a fixture with non-trivial band transitions (e.g., PMSM where
  back-iron band has different per-feature counts vs slot-iron band):
  - `body.constraints` is non-null
  - Every slave global index is in `[0, body.nodes.length / 2)`
  - Every master index is `< slave's index` (masters come earlier in
    global numbering — convenient for triangular elimination)
  - Every weight pair `(w_left, w_right)` sums to 1.0 within 1e-12
  - Every weight is in `[ε, 1 - ε]` strictly (no degenerate
    constraints — coincident nodes are merged not constrained)
- Full-rank test: for each fixture's `body.constraints`, build C as a
  sparse matrix (N_total × N_master), verify rank = N_master via a
  small singular-value check (use Float64Array sparse SVD if available,
  or assert non-singular by attempting Cholesky factorization on
  CᵀIC = CᵀC for the identity case → must be positive definite).

`tests/mesh/spd-preserved.test.js` (NEW):
- Build a tiny representative K (e.g., 2D Laplacian on a 4×4 grid
  modified to test the CᵀKC transformation with manually-constructed C).
- Verify CᵀKC is SPD (positive diagonal, dominant by sum of off-diag
  magnitudes, Cholesky factorization succeeds).
- Verify CᵀKC condition number is bounded (within 10× of K's
  condition number for typical w values in [0.1, 0.9]).

`tests/mesh/tangential-physics.test.js` (UPDATE from prior round):
- PMSM rotor cells_per_pole now ≥ 41 (was 9 in the prior round) because
  ν_max is slice-wide.
- Universal rotor cells_per_pole now ≤ 30 (was 204) because LCM
  alignment is gone.

`tests/mesh/refine-and-dofbudget.test.js` (UPDATE):
- The "all 15 fixtures satisfy cells_per_pole ≥ 2×ν_max" assertion now
  uses slice-wide ν_max for the body's slice.
- Element count budget: tighten from 10000 to 8000 per body (no
  LCM-driven explosion).

`tests/mesh/tangential-localized.test.js` (UPDATE):
- Magnet pole-edge extras now apply within the uniform gap-adjacent
  band as +5 extra columns per pole edge in the gap-band's uniform
  spacing (added on top of the base ν_max-derived count for that band).
- Salient tooth-tip extras: same pattern, +3 extra per tooth in the
  gap-band's uniform spacing.

**All 96 existing mesh tests**: re-classify under the new architecture.
Expected failure modes:
- Assertions about specific Ntheta values: rewrite to derive from ν_max
  + poles + per-feature math.
- Assertions about uniform Δθ across the whole body: split into "uniform
  in gap-adjacent band" (still asserts) and "per-feature uniform within
  each feature" (new assertion).
- Assertions about "no element straddles a feature boundary" in body
  interior: STILL passes — per-feature columns guarantee no interior
  straddling.
- Assertions in the gap-adjacent band about element-material assignment
  at a feature edge: may need to relax to "dominant material" for that
  band only, since the gap band is uniform and may straddle small
  features.

No tolerance widening. If a test fails because it was asserting
buggy/heuristic behavior, rewrite the assertion to test the principled
behavior. If it fails because the new code has a bug, fix the code.

### Caller updates

- `lessons/unified_motor/mesh-dev.html`: no change (passes
  `physicsFromConfig(config)` unchanged; the helper now returns
  slice-wide ν_max internally).
- The LRU cache key (`signature`) extension already in prior round
  picks up the new behavior because `windings` Map hash captures the
  slice-wide structure.

### What the mesh API exposes to Phase 5

`BodyMesh` adds one new optional field:

```
constraints: {
  slaves: Int32Array      // slave node global indices, length S
  masters: Float64Array   // [idx_left, w_left, idx_right, w_right] per slave, length 4S
} | null
```

Phase 5 reads this field (per rotor and stator body), builds the
constraint matrix C internally, and applies CᵀKC to the body blocks
before invoking the solver. The mesh doesn't know about FEM
assembly; Phase 5 doesn't know about mesh generation. Clean boundary.

## Acceptance

1. **PMSM rotor cells_per_pole ≥ 41** (slice-wide ν_max for m=3 stator
   pulls the rotor up). Was 9.0 in the prior round.

2. **Universal rotor cells_per_pole ≤ 30** and total elements ≤ 1500
   (no LCM-driven explosion). Was 204 cpp / 4080 elements in the prior
   round.

3. **Every fixture's gap-adjacent band has perfectly uniform Δθ** at
   the slice-wide physics target. `gapTheta` spacing constant within
   1e-12 rad on every body of every fixture.

4. **Every fixture's body-interior cells respect feature boundaries**:
   no element's centroid lies on the "wrong side" of a feature boundary
   compared to its dominant material region. (Equivalently: per-feature
   columns guarantee no straddling in interior bands.)

5. **Constraint matrix is full rank** for every fixture (Cholesky on
   CᵀC succeeds; condition number bounded).

6. **All 96 existing mesh tests pass** under re-classification — no
   tolerance softening. Plus the 4 new test files (per-feature-columns,
   uniform-gap-band, constraints, spd-preserved) add ~20 new tests.

7. **`signature` correctly invalidates** the cache when slice-wide
   ν_max changes (e.g., flipping a fixture from m=3 to m=2 stator
   triggers a new mesh build).

## Single API path — physics opts required (added 2026-05-28)

`MotorMesh.build(section, opts)` has ONE code path: physics-derived.
`opts.physics` (with `windings` Map and `poles`) is REQUIRED. If
absent, the mesher throws with a message naming the missing field.
There is no synthetic-Ntheta backdoor, no feature-density heuristic
fallback, no "geometric-only mode". The architecture is uniform
across every caller — production fixtures and unit tests alike.

**Test migration consequence**: every existing mesh test must pass a
valid `opts.physics`. For tests using real fixture configs (via
`ConfigSchema.expand(machineCfg)`), use `physicsFromConfig(config)`.
For tests using synthetic sections (e.g., `singleAnnulusSection()` in
`tests/mesh/_fixtures.js`), the test fixture helper provides minimal
synthetic physics opts:

```js
// in tests/mesh/_fixtures.js
function syntheticPhysics(opts = {}) {
  return {
    windings: new Map([[0, {
      kind: 'wound', m: opts.m ?? 3, p: opts.p ?? 2,
      Q: opts.Q ?? 6, member: opts.member ?? 'rotor',
    }]]),
    poles: opts.poles ?? 2,
  };
}
```

Synthetic tests that DON'T care about specific cell densities pass
`syntheticPhysics()` and assert only what they're testing (e.g.,
coverage error, area conservation, gapLoop uniformity). Synthetic
tests that DO care about cell density assert against the derived
value: `expected_cells_per_pole = round(2.4 × nuMaxForWinding(spec))`.

Tests that were asserting heuristic geometric behavior under the old
`numFeatures × 12` cap either:
- Get rewritten to assert physics-derived behavior (if the property
  they were testing has a principled analog), or
- Get deleted (if they were testing a heuristic that no longer exists).

The implementer makes these test-migration calls during the
re-classification pass; the rule is "what property is this test
trying to verify, and what is the principled assertion for that
property under the new architecture?" — never "loosen until it
passes".

## Strict rules for the implementer

- **NO threshold or tolerance softening** to make assertions pass. If
  a test fails, classify honestly: (a) bug in new code → fix code, or
  (b) assertion tested heuristic behavior → rewrite assertion.
- **NO** silent fallback to LCM alignment. The LCM-based path from the
  prior round must be REMOVED, not preserved as a fallback. With
  per-feature columns and physics-derived gap-band Ntheta, there is no
  scenario requiring LCM.
- **NO** uniform-Δθ-across-whole-body assumption anywhere outside the
  gap-adjacent band override.
- **NO** silent merging of distinct features with the same material at
  the same radius — keep feature identity intact for per-feature column
  generation.
- **NO** `// TODO`, `// for now`, deferred-cleanup comments.

## Out of scope

- **AMR** — same as prior rounds. Stays out.
- **Higher-order p-refinement** — linear quads only.
- **Triangular elements** at band transitions — quads only with
  hanging-node constraints. The constraint mechanism handles the
  topological mismatch; no need for tri transition cells.
- **The Phase 5 assembly-side work** (applying CᵀKC, recovering A from
  Â) is specified in the Phase 5 spec amendment, not here. This phase
  exports `constraints` on the mesh; Phase 5 consumes it.

## Phase 5 amendment summary (for cross-reference)

Phase 5's `motor-slice.js` assembly layer applies the constraint
transformation:
- After assembling K_rotor (triplet form): `K̂_rotor =
  applyConstraints(K_rotor_triplets, body.constraints)`
- Same for K_stator
- After assembling f_rotor: `f̂_rotor = Cᵀ_r · f_rotor` (sparse matvec)
- The harmonic-coupling blocks B_r, B_s and harmonic block M stay
  byte-identical (the gap-loop nodes are in the uniform gap-adjacent
  band, where C is identity for those indices)
- After solving the bordered system for `[Â_rotor, Â_stator, a_b]`:
  `A_rotor = C_r · Â_rotor` and `A_stator = C_s · Â_stator` (sparse
  matvecs to recover full nodal vectors for field extraction)

Phase 1 solver wrapper: **zero changes**. The constrained system is
just another SPD sparse linear problem; SimplicialLDLT factorizes it
identically. Per-solve perf overhead near zero (constraint transformation
is one-time per geometry change; only `Cᵀf` and `C·Â` matvecs happen
per solve, at microsecond cost).
