# Spec Review: Phase 6 — Mesh-native render + live UI

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 1 | 2 | 3 |
| minor    | 1 | 1 | 2 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 6.1.1 — R1+R2+R3 + 2-D seam (`motor-mesh-view.js`, `cross-section-render.js`, `mount.js` rewrite) | yes | Fully covered by T6.1.1 |
| 6.2.1 — R4+R5 + `render3d.js` + `lib/gap-eval.js` + `index.html` boot/scripts | yes | Fully covered by T6.2.1 |
| 6.3.1 — machine picker + geometry sliders + material card | yes | Fully covered by T6.3.1 |
| Plan verification: mesh-native cross-section draws conforming teeth + glyphs + iso-contours + |B| | yes | Tests in T6.1.1 assert all four; acceptance criteria confirm |
| Plan verification: 3-D rig extrudes cross-section with end-windings + per-slice in-gap field | yes | T6.2.1 covers R4+R5 |
| Plan verification: machine picker loads each of the 15 fixtures live | yes | T6.3.1 acceptance criteria item 2–3; browser pass item |
| Plan verification: geometry sliders trigger topology rebuild (re-mesh + re-analyze) | yes | T6.3.1 acceptance criteria items 4, 6 |
| Plan verification: no grid render path remains | yes | mount-2d-seam.test.js audit + acceptance criteria |
| Plan verification: user-required browser pass | yes | T6.3.1 acceptance criteria (user-required, 8-point checklist) |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | Phase-6 §T6.2.1 "Files to create" | The two test files `tests/render/gap-eval.test.js` and `tests/render/render3d.test.js` are described in the T6.2.1 "Tests" subsection but are **not listed** in T6.2.1's "Files to create" section. They are correctly listed in the top-level Files Owned section as "created (Wave 6.2)." An implementer reading only the task's formal "Files to create" list would miss these two deliverables. | Add to T6.2.1's "Files to create" bullet list: `- tests/render/gap-eval.test.js — node:test + node:assert/strict.` and `- tests/render/render3d.test.js — node:test + node:assert/strict.` (matching the pattern used in T6.1.1's "Files to create" for its test files). |

---

### Decision-Required Items

#### D1 — `UM.showGapLoop` is an undeclared state variable (major)

- **Location**: Phase-6 §T6.1.1 "Files to modify" → `cross-section-render.js` paint function description, line: "→ gapLoop overlay (when `UM.showGapLoop`)"
- **Problem**: The spec quotes the paint function's overlay composition order as ending with "→ gapLoop overlay (when `UM.showGapLoop`)". However, `UM.showGapLoop` is never defined anywhere in Phase 6. Decision D3 defines `UM.fieldViz` with exactly five properties: `{ fluxLines:true, modulusB:false, saturation:false, magnetization:false, currentDensity:false }`. `showGapLoop` is not among them. No task in Phase 6 declares or initializes `UM.showGapLoop`. In Phase 2, `showGapLoop` is an `opts` parameter passed directly to `motor-mesh-view.draw()` — it is not a `UM` namespace variable. An implementer cannot determine whether to read `UM.showGapLoop`, `UM.fieldViz.gapLoop`, always show the overlay, or treat it as internal/diagnostic only.
- **Why decision-required**: The gapLoop overlay is a diagnostic aid for mesh development (showing the uniform-Δθ circle). Its correct role in a production render — always on, never on, or user-togglable — is a product decision. The four options below reflect meaningfully different UX and implementation choices.
- **Options**:
  - **Option A — Add `gapLoop` as a 6th toggle in `UM.fieldViz`**: Extend D3's initial state to `{ fluxLines:true, modulusB:false, saturation:false, magnetization:false, currentDensity:false, gapLoop:false }`. Add a 6th checkbox to `buildFieldViewToggles`. Change the paint condition to `UM.fieldViz.gapLoop`.
    - Pros: Consistent with the existing toggle architecture; gives users explicit control; the gapLoop circle aids understanding of the gap-harmonic seam.
    - Cons: Adds a 6th toggle to what is already a dense control; the gapLoop is a mesh diagnostic, not a physical field quantity — mixing it with `modulusB`, `fluxLines` etc. may confuse users.
  - **Option B — Always show the gapLoop overlay (unconditional)**: Delete the `UM.showGapLoop` condition; the gapLoop is drawn on every paint call as a fixed visual element.
    - Pros: Simplest implementation; no state variable needed; the gap circle is a subtle overlay and always-on is defensible for a production physics tool.
    - Cons: Users cannot suppress it; may clutter the cross-section view during field visualization.
  - **Option C — Never show the gapLoop in production render (remove the reference)**: Delete the "→ gapLoop overlay (when `UM.showGapLoop`)" clause entirely from the paint composition order. The gapLoop remains accessible via Phase 2's `motor-mesh-view.drawGapLoop()` but is not part of the production 2-D render path.
    - Pros: Cleanest production render; eliminates the undeclared variable; the mesh-dev harness (`mesh-dev.html`) already exercises gapLoop visualization.
    - Cons: Removes a seam that might be wanted for gap-coupling diagnostics; cannot be easily re-added later without touching `cross-section-render.js`.

---

#### D2 — `applyGapLength` shifts all rotor/stator radii uniformly but the spec description is ambiguous about which rings are "rotor" vs "stator" (major)

- **Location**: Phase-6 §D6 "global gap-length slider" description and §T6.3.1 "Files to modify" → `matrix-panel.js` step 3 `applyGapLength` spec
- **Problem**: The `applyGapLength(config, g)` algorithm is specified as: find `r_rotor_surface = max(outer radii of rotor rings)`, find `r_stator_bore = min(inner radii of stator rings)`, then "shift its `rRange` by `(r_rotor_surface_new − r_rotor_surface)`" for every rotor ring and similarly for every stator ring. The spec does not define how to identify which rings belong to the rotor body and which to the stator body. The `config-schema` ring vocabulary uses `rRange`, `element`, `winding`, etc. — there is no explicit `body: "rotor"|"stator"` field documented in Phase 6 or visible in the config-schema spec. An implementer must infer the rotor/stator partition from the ring ordering (e.g., "rings with `rRange[1] < mid-gap` are rotor, rings with `rRange[0] > mid-gap` are stator"), which may fail for unusual configurations. The test `"applyGapLength preserves non-gap-adjacent radii"` describes a "uniform rotor-side shift" applied to the inner ring, implying the algorithm shifts ALL rotor rings together — but the logic for how the implementer discovers which rings are rotor-side vs stator-side is never stated.
- **Why decision-required**: The correct partition rule depends on how `config-schema` encodes body membership. If `config-schema` provides an explicit `body` or ordering convention, the spec should cite it. If it must be inferred geometrically (e.g., from relative position to `config.grid.rInner`/`rOuter` or a mid-gap threshold), the spec must state the inference rule. Two reasonable rules produce different behavior for multi-gap machines or unusual ring orderings.
- **Options**:
  - **Option A — Infer rotor/stator by radial position relative to current mid-gap**: A ring whose `rRange[1] ≤ r_mid` (outer radius at or below mid-gap) is a rotor ring; a ring whose `rRange[0] ≥ r_mid` is a stator ring. Rings straddling `r_mid` throw. Add this rule explicitly to the `applyGapLength` spec.
    - Pros: Purely geometric; no schema change needed; works for any config whose rings do not straddle the gap.
    - Cons: Breaks for any ring that straddles mid-gap (must specify error behavior); does not handle multi-gap machines.
  - **Option B — Use `config.grid.rInner` and `config.grid.rOuter` as the partition pivot**: Rings that are entirely below `(grid.rInner + grid.rOuter)/2` are rotor; rings entirely above are stator. This matches the `applyGapLength` update that already writes `config.grid.{rInner,rOuter}`.
    - Pros: Consistent with the `rInner`/`rOuter` fields the function already updates; no new schema concept.
    - Cons: `grid.rInner`/`rOuter` may not be kept in sync before `applyGapLength` is called; the spec does not confirm these fields always reflect the actual ring radii at call time.
  - **Option C — Require the config-schema to carry an explicit `ring.body: "rotor"|"stator"` field**: Add this field to `config-schema.js` in a small vocabulary extension (or confirm it already exists and cite it). `applyGapLength` reads `ring.body` directly.
    - Pros: Unambiguous; works for multi-gap and unusual topologies; makes the body membership explicit everywhere.
    - Cons: Requires a schema change (even if small); potentially affects Phase 3's Bknee passthrough or other ring-level fields; adds scope to Phase 6.

---

#### D3 — Test assertion for `drawFluxLines` lower bound is loose (minor)

- **Location**: Phase-6 §T6.1.1 "Tests" → `tests/render/mesh-view-prod.test.js` → `"drawFluxLines emits stroke calls"` test
- **Problem**: The test asserts `log.filter(e => e.op === "stroke").length >= 1` as the primary non-trivial bound (plus a loose upper bound). For `levels: 8`, asserting at least 1 stroke is very weak — a trivially broken implementation that draws a single degenerate contour segment would pass. The spec mentions "the drawn line count is roughly proportional to `levels` (≥ `levels - 1`)" as a secondary bound, but this is stated in parentheses after the primary `>= 1` assertion, making it ambiguous whether `>= levels - 1` is a hard test assertion or an informational note.
- **Why decision-required**: The right lower bound depends on how the marching-squares implementation handles near-degenerate meshes. If the test mesh (pmsm rotor) reliably produces at least `levels - 1` distinct iso-contours for the given synthetic `Anode`, then `>= levels - 1` is the correct hard assertion. But if the synthetic `cos(2·atan2(y,x))` field on the pmsm rotor mesh can concentrate all crossings in fewer contours, a lower bound is needed. The author must decide.
- **Options**:
  - **Option A — Make `>= levels - 1` the hard assertion**: Rewrite the test body to assert `log.filter(e => e.op === "stroke").length >= levels - 1` (with `levels = 8`, asserts ≥ 7 strokes). Delete the `>= 1` primary assertion.
    - Pros: Meaningfully catches a broken marching-squares that produces too few contours; consistent with the spec's stated intent.
    - Cons: May be too strict if the synthetic `cos(2·atan2(y,x))` field on the pmsm mesh produces fewer than 7 distinct iso-contour segments (depending on element count and geometry).
  - **Option B — Keep `>= 1` as the primary and explicitly demote `>= levels - 1` to informational**: Rewrite to make clear that `>= 1` is the hard assertion (verifying the method fires at all) and the proportionality note is documentation, not a test assertion.
    - Pros: Safer against mesh geometry edge cases; the degenerate-contour test ("emits no strokes for constant Anode") already covers the zero case.
    - Cons: Provides very weak coverage of the actual contour-count behavior; a broken implementation drawing a single line would pass.

---

### Info

| ID | Severity | Location | Observation |
|----|----------|----------|-------------|
| I1 | info | Phase-6 §T6.1.1 "Files to create" → `tests/render/_fixtures.js` | The conditional guard is described as `if (!process.env.RENDER_TESTS_HEADLESS_ONLY) try { require } catch(e) {}` with the comment "so the Wave-6.1 tests can drive the prod render without forcing JSDOM." The logic is correct (when `RENDER_TESTS_HEADLESS_ONLY` is set, skip loading the JSDOM-dependent lesson files), but the comment says "can drive" when the guard's purpose is the opposite — to make it optional. The comment would be clearer as "so Wave-6.1 tests don't require JSDOM unless the caller opts in." No behavior change needed; the implementation logic is unambiguous. |
