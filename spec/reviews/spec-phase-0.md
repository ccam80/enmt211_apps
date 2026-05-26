# Spec Review: Phase 0 — Dead Code Removal

## Verdict: ready

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 1 | 1 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 0.1.1 — Delete seven grid lib/ modules; restore field-render.js to motor-baseline | yes | Full scope covered; exact files enumerated; byte-restore criterion stated |
| 0.1.2 — Delete detailed-toggle.js; remove grid <script> tags from index.html; strip drawGapField call from mount.js; strip compileForOverlay from cross-section-render.js | yes | All four sub-actions present; exact script tag text given; exact function names given |
| 0.1.3 — Relocate assertClose/fitCos2/fitCos2Cos4 to tests/_assert.js; delete grid-tier tests; rewire surviving fixtures | yes | Full scope covered; exact line numbers and require paths given for every fixture edit |
| Verification — zero references in runtime code and surviving tests; field-render.js byte-identical to motor-baseline; preserved suites pass; deferred red tests unchanged | yes | Phase-exit verification section addresses all plan verification measures; exact grep patterns and test command given |

## Findings

### Mechanical Fixes
None found.

### Decision-Required Items

#### D1 — `tests/circuit/_fixtures.js` `fitCos2` removal leaves `fitCos2` still needed by surviving circuit tests (minor)
- **Location**: phase-0 §Task 0.1.3 "Files to modify" → `tests/circuit/_fixtures.js`
- **Problem**: The spec says to "remove `buildSalient`, `fitCos2`, `SALIENT_DEFAULTS` from `module.exports`" of `tests/circuit/_fixtures.js`, but it also says to keep `assertClose` in exports. The surviving circuit test files (`backemf.test.js`, `cache.test.js`, `induction.test.js`, `stepper.test.js`) may import `fitCos2` from `_fixtures.js`. If any surviving circuit test uses `fitCos2`, removing it from the exports would break that test. The spec's Task 0.1.3 acceptance criteria require "The four surviving `circuit` tests … pass under `node --test`" — so if a surviving test uses `fitCos2`, the spec is self-contradictory (remove `fitCos2` from exports AND pass all circuit tests). The spec does not state whether `fitCos2` is used only by `extract.test.js` (deleted) or also by surviving circuit tests.
- **Why decision-required**: Whether `fitCos2` must remain accessible to surviving circuit tests — or can be removed from `_fixtures.js` exports entirely because only the deleted `extract.test.js` used it — depends on the actual import graph of surviving tests, which the spec author has knowledge of but the spec does not state. Two reasonable implementers could make different choices:
- **Options**:
  - **Option A — Remove fitCos2 from _fixtures.js exports entirely**: Trust that `fitCos2` is used only by the deleted `extract.test.js`; remove it as specified. If a surviving test imports it, the test will fail at runtime — contradicting the "four surviving circuit tests pass" acceptance criterion.
    - Pros: Follows the spec text exactly; removes dead export.
    - Cons: Risks breaking surviving tests if the assumption is wrong; no confirmation stated in spec.
  - **Option B — Add explicit statement that fitCos2 is not used by surviving circuit tests**: Augment the spec to say "Note: `fitCos2` is used only by the deleted `extract.test.js`; no surviving circuit test imports it." This makes the removal unambiguous.
    - Pros: Eliminates the implementer's need to guess; prevents silent test failure.
    - Cons: Requires a spec edit before implementation.
  - **Option C — Move fitCos2 to tests/_assert.js alongside assertClose**: Export `fitCos2` from `tests/_assert.js` (it is already a generic helper) and import it from there in any surviving test that uses it.
    - Pros: Consistent with the established pattern of moving helpers to `_assert.js`; survives any surviving-test dependency.
    - Cons: Adds a line to `tests/_assert.js` that may be unnecessary; spec explicitly lists only `assertClose`/`fitCos2`/`fitCos2Cos4` as the three helpers to move, so adding `fitCos2` to `_assert.js` exports is already in scope.

---

### Info

#### I1 — Task ID naming convention: spec headings use `0.1.1` / `0.1.2` / `0.1.3`, manifest uses `T0.1.1` / `T0.1.2` / `T0.1.3`
- **Location**: phase-0 §Wave 0.1 task headings vs `spec/manifest.json` phases[0].waves[0].task_groups[0].tasks
- **Observation**: The phase spec labels tasks as `Task 0.1.1`, `Task 0.1.2`, `Task 0.1.3` (no `T` prefix in the heading), while the manifest stores them as `T0.1.1`, `T0.1.2`, `T0.1.3`. This is consistent across all phases in the manifest (all use the `T` prefix), so it is the project-wide convention. If the implement-hybrid coordinator resolves manifest IDs by stripping the `T` prefix before matching to spec headings, there is no issue. This is noted as info so the coordinator author can confirm the matching logic handles this correctly.
