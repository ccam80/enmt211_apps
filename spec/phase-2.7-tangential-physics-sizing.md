# Phase 2.7 — MMF-harmonic-derived tangential mesh sizing

> Treated as expanded scope on **batch-6** (Phase 2 wave 2.3) for the same
> reason as Phases 2.5 and 2.6: the visual ack for T2.3.2 cannot honestly
> pass while the tangential mesh sizing remains heuristic. Authorized by
> the user 2026-05-27 after explicit audit finding.

## Motivation

After Phase 2.6 added physics-derived **radial** layer counts (skin depth
in conductors, saturation gradient in irons, magnet pole-thickness floor),
the **tangential** cell count remained heuristic: `Ntheta ≈ numFeatures × 12`
with a hard cap. That formula has no derivation from FEM accuracy
requirements — it just happens to give safe values for the current
15 fixtures. A future fixture with a high pole count and low feature
count would land in a thin tangential mesh without any test catching it
until Phase 5's analytic-reference convergence test failed.

The principled tangential sizing derives cells per pole from the MMF
harmonic content the simulation needs to resolve.

## Physics derivation

For a 2-D magnetostatic motor solve, the relevant spatial scale in the
tangential direction is the highest MMF harmonic carrying significant
energy. For each winding type:

### Wound (W) / slot+iron (C) stators

The stator MMF Fourier decomposition for an m-phase, p-pole, Q-slot
distributed winding has fundamental (ν=1) plus a discrete set of
non-cancelled space harmonics. For integer-slot 3-phase distributed:
ν ∈ {1, 5, 7, 11, 13, 17, 19, 23, 25, …}; the (6k±1) family. The 5th
and 7th carry roughly 4-7% of fundamental MMF amplitude; the 11th and
13th carry roughly 1-2%; higher harmonics drop below 1%. For a
controllable-fidelity solve, the cutoff harmonic `ν_max` is:

- 3-phase distributed (m=3): `ν_max = 17` (≥99% of MMF energy resolved)
- 2-phase (m=2): `ν_max = 13` (hybrid stepper, two-phase brushless)
- 1-phase (m=1): `ν_max = 11` (universal motor, brushed)
- Concentrated fractional-slot: `ν_max = max(p, 13)` (these have
  high-order harmonics by design)

Nyquist requirement: `cells_per_pole ≥ 2 · ν_max`. Adding a safety
factor of 1.2 for asymmetric MMF in fractional-slot:
`cells_per_pole = round(2.4 · ν_max)`.

### Squirrel cage (K) — induction rotors

The rotor cage's effective harmonic content is dictated by the bar
count `N_b` and the stator pole pairs `p_pp = p/2`. The slot
harmonics in the rotor surface MMF are ν = 1 + k·N_b/p_pp (for
integer k). The dominant non-fundamental is ν = 1 + N_b/p_pp; for
N_b=28, p=4 (p_pp=2): ν = 1 + 14 = 15. Apply same Nyquist:
`cells_per_pole = round(2.4 · ν_max)` with `ν_max = max(17, 1 + N_b/p_pp)`.

### Surface magnet (M) — PMSM/BLDC rotors

The rotor permanent-magnet MMF is dominated by the magnet count and
pole arrangement. The magnet-edge discontinuity creates strong local
gradients but the global MMF harmonic content is `ν ∈ {1, 3, 5, 7, …}`
with the magnet pole-arc determining the fundamental's purity. Use
the stator-side `ν_max` (so a 3-phase stator with 8-pole PMSM rotor
uses `ν_max = 17`). Plus localized pole-edge refinement (below).

### Salient iron (I) — switched-reluctance / synchronous-reluctance rotors

Saliency creates strong tooth-tip flux concentration but the global
MMF content is again stator-driven. Use stator `ν_max` plus localized
tooth-tip refinement.

## Localized refinement

Beyond the global `cells_per_pole` count, add cells at two physically
sharp boundaries:

### Tooth-tip refinement (gap-facing salient teeth and stator slot openings)

For each feature within `min(0.3 mm, 0.05 × pole_pitch)` of the
gap-facing surface AND with angular span less than half the body
period (i.e., a localized tooth/slot, not a back-iron full sector):
add `3 × refine` extra column edges within the feature, distributed
uniformly across the feature's angular span. The 3 extra cells
resolve the tooth-tip flux-concentration gradient (which is local to
the corner, not the whole feature).

### Pole-edge magnet refinement

For each magnet feature, add `5 × refine` extra column edges within a
±0.5 mm band at each magnet pole edge (the discontinuity between
adjacent magnet poles or between magnet and inter-pole gap). The
5 extra cells per edge × 2 edges per magnet = 10 cells per magnet of
local refinement, on top of the global cells_per_pole.

## Scope of fix

### Lib

- `lib/motor-mesh.js` — add:
  - `tangentialPhysicsTargets(features, member, opts) → { cellsPerPole, perFeatureLocalizedExtras }`
    - Reads each feature's winding (passed via `opts.windings` per feature
      `srcId`), poles (from `opts.poles`), and applies the per-element-kind
      derivation above.
    - `cellsPerPole` is the global Ntheta target divided by poles.
    - `perFeatureLocalizedExtras` is a Map<featureIdx, extraCount> for
      tooth-tip and pole-edge localized refinement.
  - `buildAngularColumns` consumes `tangentialPhysicsTargets`:
    - **Primary target**: `Ntheta_target = poles × cellsPerPole`
    - **Floor**: the existing `numFeatures × 12 × refine` becomes a fallback
      floor — used ONLY when winding/poles info is unavailable (the
      function is called without `opts.windings`, e.g. by older callers).
      With physics info, the floor is `max(P_body × 8, ν_max × poles × 2)`.
    - **Cap**: the existing cells-per-feature ceiling is removed (it was
      a heuristic safety net; the physics-derived target already bounds
      growth correctly).
    - **Snap**: snap up to nearest multiple of `P_body` for gap-row uniformity.
    - **Localized extras**: after the global target columns are placed,
      insert `perFeatureLocalizedExtras` per-feature extra column edges
      at the appropriate physical locations.

- `lib/motor-mesh.js` `physicsTargets(features, opts)` (from Phase 2.6):
  extend to also return `tangentialPhysicsTargets`'s output, so callers
  get one unified physics structure.

- `lib/motor-mesh.js` `physicsFromConfig(config)` (from Phase 2.6): extend
  to extract per-circuit winding spec (m, p, Q, coilPitch, kind) plus
  per-body poles, and produce `opts.windings` and `opts.poles` for the
  mesher.

### Tests

- `tests/mesh/tangential-physics.test.js` (NEW):
  - For a 48-slot 8-pole 3-phase PMSM fixture, mesh `cells_per_pole`
    is `≥ 34` (=2.4 × 17 for m=3) and `≤ 48` (with safety + alignment).
  - For a 12-slot 14-pole 3-phase concentrated BLDC fixture (when
    Phase 6.5 winding-model concentrated mode lands), `cells_per_pole`
    is `≥ 36` (=2.4 × max(p=14, 13)).
  - For an induction-3ph 28-bar / 4-pole fixture, rotor `cells_per_pole`
    is `≥ 36` (=2.4 × 15) and stator `≥ 41` (=2.4 × 17).
  - For a hybrid-stepper 50-tooth 8-pole fixture, rotor `cells_per_pole`
    is `≥ 41` (=2.4 × 17 from the 2-phase stator's ν_max=13, plus
    the 50-tooth localized refinement adds tooth-tip extras).
  - Each test asserts that the mesh's `gapTheta` count divided by `poles`
    meets the expected `cells_per_pole`.

- `tests/mesh/tangential-localized.test.js` (NEW):
  - PMSM with magnets: count column edges within ±0.5 mm of each
    magnet pole edge; assert ≥ 5 extra per edge.
  - Hybrid-stepper with 50 salient rotor teeth: count column edges
    within each tooth feature; assert ≥ 3 extra per tooth.
  - Back-iron full-sector feature (e.g., outer iron ring): assert NO
    extra columns (the localized refinement is gap-surface-only).

- `tests/mesh/refine-and-dofbudget.test.js` (UPDATE):
  - The existing "every fixture has 6-12 cells per feature at default
    opts" test is rewritten to "every fixture has cells_per_pole ≥
    2 · ν_max_for_its_winding". The old cells-per-feature metric is
    not principled and is replaced.

- `tests/mesh/auto-sizing.test.js` (existing Phase 2.6): MUST still
  pass without softening. The radial sizing is unchanged; only the
  tangential side gets the new physics derivation.

- All 61 existing mesh tests: re-run, classify failures honestly. If a
  test asserted a specific tangential Ntheta value, rewrite the
  assertion to derive from physics rather than hardcoded. No tolerance
  widening to make hardcoded assertions pass.

### Caller updates

- `lessons/unified_motor/mesh-dev.html`: extract winding info via
  `physicsFromConfig` (now richer) and pass to `MotorMesh.buildCached`.
- The LRU cache key (`signature`): include a hash of windings + poles so
  changing winding spec (e.g., flipping from m=3 to m=2) invalidates the
  cached mesh.

## Acceptance

1. Default `MotorMesh.build(section, { physics })` on every one of the
   15 fixtures produces a mesh whose `cells_per_pole ≥ 2.4 · ν_max` for
   the body's winding type.

2. Tooth-tip and pole-edge localized refinement is present in fixtures
   that have those features: magnets get ≥ 5 extra cells per pole edge;
   salient teeth get ≥ 3 extra cells per tooth.

3. Phase 5's slotless-ring-magnet analytic-reference test (added in
   the Phase 5 amendments) PASSES at default `refine=1` without any
   manual mesh tuning — proof that the auto-derived tangential mesh is
   adequate for FEM accuracy, not just visually plausible.

4. `node --test tests/mesh/*.test.js` passes (≥ 65 tests: 61 prior +
   tangential-physics + tangential-localized + at least 2 cache
   invalidation cases).

5. No fixture's Ne explodes beyond a reasonable budget (≤ 8000 elements
   per body at default opts) — the per-pole derivation is bounded above
   by `poles × 48` ≈ a few hundred angular cells per body even for
   high-pole machines, multiplied by the typical 8-12 radial layers.

6. `signature` correctly invalidates the cache when winding spec or
   poles change.

7. The `numFeatures × 12` cap from the previous round is removed (it
   was a heuristic patch over a missing derivation; with the physics
   target in place, it's dead code).

## Strict rules for the implementer

- **NO threshold or tolerance softening.** Same rule as 2.5/2.6.
- **NO** hardcoded `ν_max` values per fixture in the source — they MUST
  be derived from the winding spec (m, p, Q for wound; bars + poles for
  cage; pole count for magnet/salient with stator-side override).
- **NO** silent reuse of cache entries when winding spec changes.
- **NO** `// TODO`, `// for now`, deferred-cleanup comments.

## Out of scope

- **Adaptive mesh refinement (AMR)** — same as Phase 2.6. Stays out.
- **Anisotropic ν_max per harmonic** — using a uniform `ν_max` per
  body is sufficient; we don't try to be denser only at high-harmonic-
  amplitude angles.
- **Time-harmonic eddy-current solve** — Phase 5 amendment statement
  applies; static-magnetostatic remains the assumption for now.

## Why this matters

Without this phase, the mesher's tangential sizing is heuristic in
exactly the same way the user (and the project audit) called out for
Phase 2 as a whole. The Phase 5 analytic-reference test would
eventually fail at default refine if a fixture landed in a bad spot
of the heuristic — and the recovery loop ("Phase 5 fails → implementer
raises cap") is exactly the slop pattern we are explicitly trying to
avoid. Adding the physics derivation here, BEFORE Phase 5
implementation, closes that loop preemptively.
