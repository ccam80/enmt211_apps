# Spec Review: Phase 2 — winding-model-and-compile

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 0 | 2 | 2 |
| info     | 0 | 2 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 2.1.1 — `winding-model.js` routing algebra | yes | All four exported functions fully specified with signatures and behaviour; export surface pinned; acceptance criteria present |
| 2.2.1 — `motor-compile.js` rasterize feature list | yes | Full API, all output arrays described, `assembleJz`, `coveredCells` internal helper, zero-not-skip stated |
| 2.3.1 — Tests (routing / standardWinding / compile / winding-factor) | yes | All plan Phase-2 verification measures are addressed: series→1 circuit, parallel→separate circuits, short-pitch chord shift, array shapes, zero-not-skip |
| Plan verification: series coils → one circuit | yes | Task 2.3.1 `"series coils sum into one circuit"` with exact slot values |
| Plan verification: parallel branches → separate circuits | yes | Task 2.3.1 `"parallel branches split into separate circuits"` |
| Plan verification: short-pitch moves return slots by the chord | yes | Task 2.3.1 `"standardWinding short pitch shifts return slots by the chord"` |
| Plan verification: compiled arrays match solver shapes, zero-not-skip | yes | Task 2.3.1 `"output array shapes"`, `"no magnet → zero magnetization"`, `"no iron → all-air ν"` |
| Plan verification: `winding-model` exposes no field-shaped function | yes | Task 2.1.1 acceptance criterion pins `Object.keys(LIB.WindingModel)` to exactly the four routing functions; Task 2.3.1 `"surface exposes only routing functions"` |

---

## Findings

### Mechanical Fixes

None found.

---

### Decision-Required Items

#### D1 — Unspecified behaviour for non-contiguous `circuit` indices in `motor-compile` (major)

- **Location**: phase-2 §Task 2.2.1 "Files to create" → `LIB.MotorCompile.compile` → `coilMasks` and `nCircuits` definition

- **Problem**: The spec defines `nCircuits` as:

  > "`nCircuits = 1 + max(conductor feature.circuit)`, or `0` when there are no conductor features."

  This formula assumes conductor features' `circuit` indices form a contiguous range `[0, K−1]`. If a caller supplies features with `circuit:0` and `circuit:2` (but no `circuit:1`), the formula gives `nCircuits=3` and `coilMasks[1]` is allocated as an all-zero `Float64Array` silently. Downstream consumers (Phase 4's circuit ODE) would see a phantom zero-current circuit. The spec does not state whether non-contiguous circuit indices are valid input, nor what `compile` should do if it encounters them. The test fixture `compileSection` uses only `circuit:0`, so the test suite does not exercise this edge case.

- **Why decision-required**: There are at least three reasonable resolutions, and each has different implications for the compile contract and downstream phases.

- **Options**:
  - **Option A — Document contiguity as a caller guarantee**: Add one sentence to the `coilMasks` description: "Conductor features must use contiguous circuit indices in `[0, K−1]`; `compile` assumes this invariant is satisfied (it is the config schema's responsibility to guarantee it)." Add a corresponding note in the Phase-5 `config-schema.js` spec that it must emit contiguous indices.
    - Pros: Zero runtime cost; keeps `compile` a pure rasterizer with no validation branch; consistent with the zero-not-skip / no-branch philosophy.
    - Cons: Silently wrong if a caller violates the contract; no test catches the gap at the `compile` boundary.
  - **Option B — Add a fast-fail validation assertion in `compile`**: Specify that `compile` throws a descriptive `Error` when `conductor.circuit` values are non-contiguous (i.e., when `max(circuit) + 1 !== set size of unique circuit values`).
    - Pros: Fail-fast; self-documenting contract; easy to unit-test.
    - Cons: Introduces a conditional branch into a function the plan calls "one unconditional pass over features, dispatching only on `feature.kind`" — minor philosophical tension.
  - **Option C — Use a renumbering pass**: Specify that `compile` collects the unique circuit IDs in declaration order, renumbers them to `[0, K−1]`, then allocates `coilMasks`. Non-contiguous inputs become valid without throwing.
    - Pros: Handles arbitrary inputs transparently.
    - Cons: Changes the output semantics (`coilMasks[k]` no longer corresponds to `feature.circuit === k`); all downstream consumers that map from source circuit ID to mask index must be updated; adds complexity to an intentionally simple function.

---

#### D2 — `coveredCells` periodic-wrap algorithm unspecified for negative lower bound (minor)

- **Location**: phase-2 §Task 2.2.1 "Files to create" → `coveredCells` internal helper description; §Feature-list schema → coverage criterion

- **Problem**: The spec says `coveredCells` handles "periodic `thetaRange` wrap," and the feature-list schema states a cell is covered "when `theta[j]` lies in `[t0,t1]` modulo `2π` (periodic wrap)." No concrete algorithm is given (normalize first? two-interval union?). In practice, `conductorFeatures` generates `thetaRange = [slotTheta[s] − angularWidth/2, slotTheta[s] + angularWidth/2]`. For a slot at `slotTheta[0] = 0` and any positive `angularWidth`, the lower bound is negative (`t0 = −angularWidth/2`). An implementer who tests only for `t1 > 2π` (the other classic wrap trigger) will miss the negative-lower-bound case entirely.

  Furthermore, the existing test that implicitly exercises this path (`"conductorFeatures emits one feature per non-zero slot"`, slot 0 at angle 0) does not catch the failure: it asserts "4 features, all `kind === "conductor"`, with the expected signed `turns` and `circuit:0`." The feature for slot 0 is emitted regardless of whether `coveredCells` handles negative `t0`; the test checks the feature count and metadata, not the covered-cell geometry. So a broken implementation passes the test while producing an incorrect coil-mask shape.

- **Why decision-required**: Specifying a concrete algorithm (normalize to `[0, 2π)` first; or use the "two-interval union" approach) is a design choice. Closing the test gap requires adding a fixture and assertion, which depends on the algorithm chosen.

- **Options**:
  - **Option A — Specify the normalization algorithm and add a direct test**: In the `coveredCells` description, add: "Normalize `t0` and `t1` by adding the smallest multiple of `2π` that makes `t0 ≥ 0`. If the resulting `t0 ≤ t1 < 2π`, the interval is `[t0, t1]`. If `t1 ≥ 2π` (wrap-around case), a cell at angle `θ` is covered if `θ ≥ t0` OR `θ < t1 mod 2π`." Add a `compileSection` variant with `thetaRange:[−π/12, π/12]` and add a `motor-compile.test.js` assertion: cells near angle `0` AND cells near angle `2π − π/12` (i.e., near the end of the grid) are both non-zero in `coilMasks[0]`.
    - Pros: No implementation ambiguity; the exact failure mode (missing the near-`2π` cells) is caught by the new test.
    - Cons: Adds one fixture variant and one test assertion to Task 2.3.1's scope.
  - **Option B — Restrict to `[0, 4π)` and document the pre-normalization requirement at call sites**: Require that callers pass `thetaRange` with `0 ≤ t0` (callers normalize before calling `coveredCells`). Document that `coveredCells` only handles `0 ≤ t0 ≤ t1 ≤ 4π` (allowing `t1 > 2π` for the wrap-past-`2π` case). Update `conductorFeatures` to normalize slot angles: "slot angle for index `s` is `(slotTheta[s] % (2π) + 2π) % (2π)` (reduced to `[0, 2π)`); `thetaRange = [α − angularWidth/2, α + angularWidth/2]` with `α ≥ angularWidth/2`." This pushes normalization to the call site but eliminates the negative-lower-bound case from `coveredCells` itself.
    - Pros: Simpler `coveredCells` implementation; consistent with the `[0, 4π)` model used by many polar-grid codes.
    - Cons: `conductorFeatures` description gains normalization logic; still requires a test to verify the wrap behavior.

---

#### D3 — `"conductorFeatures"` test does not verify covered-cell geometry for the periodic-wrap case (minor)

- **Location**: phase-2 §Task 2.3.1 → `winding-model.test.js` → `"conductorFeatures emits one feature per non-zero slot"`

- **Problem**: The test asserts "returns 4 features, all `kind === "conductor"`, with the expected signed `turns` and `circuit:0`." It does not assert the `thetaRange` values of the returned features, nor does it subsequently call `compile` to check the coil-mask cell coverage. A `conductorFeatures` implementation that produces the correct feature count and metadata but passes `thetaRange = [0, π/6]` for slot 0 (clipping the negative lower bound to `0`) would pass this test while producing an incorrect coil mask — the cells near `2π` that should be covered would be missed.

  This is a companion to D2: D2 is the algorithm-specification gap; D3 is the test-coverage gap that allows a wrong implementation to pass undetected.

- **Why decision-required**: The correct assertion depends on the algorithm chosen in D2. The options below assume D2 is also resolved.

- **Options**:
  - **Option A — Add a `thetaRange` value assertion to the `conductorFeatures` test**: After `conductorFeatures(seriesPhaseRouting(), ...)`, find the feature for slot 0 and assert its `thetaRange[0]` equals `−π/6` (or the normalised equivalent per D2/Option B). This verifies the geometry is preserved, not clipped.
    - Pros: Directly asserts the problematic value; small change.
    - Cons: Couples the test to the chosen normalization convention (D2 must be resolved first).
  - **Option B — Add an integration assertion via `compile`**: After calling `conductorFeatures`, pass the slot-0 feature into `compile` (within a minimal section) and assert that `coilMasks[0]` has non-zero entries both near `theta=0` and near `theta=2π`. This tests the end-to-end correctness of the negative-lower-bound path.
    - Pros: Tests the actual failure mode (wrong cell coverage); no dependence on the internal `thetaRange` representation.
    - Cons: Introduces a `compile` call into `winding-model.test.js`, blurring module-test boundaries; could be placed in `motor-compile.test.js` instead (as suggested in D2/Option A), making this option redundant with D2.
  - **Option C — Accept the gap and note it**: Document in the test description that wrap-correctness is verified only through `motor-compile.test.js` (contingent on D2/Option A being adopted).
    - Pros: No scope increase to `winding-model.test.js`.
    - Cons: Coverage of `conductorFeatures`' wrap path depends on a separate file; a reader of `winding-model.test.js` alone cannot confirm the function is correct for slot 0.

---

#### D4 — `circuitMeta` returned by `ampereConductors` is never asserted in any test (info)

- **Location**: phase-2 §Task 2.1.1 → `ampereConductors` return type; §Task 2.3.1 → `winding-model.test.js` (all test cases)

- **Problem**: `ampereConductors` returns `{ nCircuits, nSlots, turns, circuitMeta }`. The spec defines `circuitMeta` as "an array length `nCircuits` of `{ phaseId, branchIndex }`." No test in the Phase-2 suite asserts the structure or content of `circuitMeta`. The acceptance criteria for Task 2.1.1 make no mention of it. An implementer could return `circuitMeta: []` (empty), `circuitMeta: null`, or `circuitMeta: undefined` and every Phase-2 test would still pass. Phase 4 and Phase 7 depend on `circuitMeta` being populated correctly; the error would surface far from the source.

  The plan's Phase-2 verification measures do not mention `circuitMeta` explicitly, so this gap is not a plan-coverage failure — but it is a quality gap that the spec could close with minimal cost.

- **Why decision-required**: Adding an assertion requires deciding what `phaseId` and `branchIndex` values the fixtures should produce — and whether to assert the exact string value of `phaseId` (which the spec doesn't specify for the plain-fixture routings, only for `standardWinding`).

- **Options**:
  - **Option A — Add a minimal structural assertion**: In `"series coils sum into one circuit"`, also assert: `Array.isArray(circuitMeta) && circuitMeta.length === 1 && circuitMeta[0].branchIndex === 0`. In `"parallel branches split into separate circuits"`, assert `circuitMeta.length === 2`, `circuitMeta[0].branchIndex === 0`, `circuitMeta[1].branchIndex === 1`, and both have the same `phaseId`. This catches absent or empty `circuitMeta` without specifying the exact `phaseId` string.
    - Pros: Low-cost; catches the most likely failure mode (missing field).
    - Cons: Does not verify `phaseId` identity; a downstream phase still needs to interpret `phaseId`.
  - **Option B — Explicitly document the intentional gap**: Add one sentence to the Task 2.1.1 acceptance criteria: "`circuitMeta` shape and values are not independently asserted in this phase; downstream correctness is covered by Phase-4 and Phase-7 tests." This makes the omission intentional rather than accidental.
    - Pros: No test-scope change; honest documentation.
    - Cons: Leaves a structural defect (absent `circuitMeta`) undetectable until Phase 4/7 runs.

---

#### D5 — `"standardWinding generalizes to m≠3"` leaves "sampled slot" undefined (info)

- **Location**: phase-2 §Task 2.3.1 → `winding-model.test.js` → `"standardWinding generalizes to m≠3"`

- **Problem**: The test instructs: "For a sampled slot `s`, assert the assigned phase index and polarity match the general belt formula directly." The word "sampled" is underspecified. An implementer might test only slot `s=0` (trivially satisfied by any implementation that gets the first slot right) or might test all 8 slots. Without naming which slots to sample, two implementers can write tests that both satisfy the letter of the spec while providing very different coverage. In particular, to confirm the general `m`-arbitrary rule is followed and not a hard-coded m=3 path, slots that exercise at least two distinct belt indices (including one with odd polarity) must be included.

- **Why decision-required**: The exact slot set is a quality-of-test decision, not a physics decision, but it determines whether the test is meaningful.

- **Options**:
  - **Option A — Name concrete slots**: Replace "a sampled slot `s`" with: "for slots `s ∈ {0, 1, 3, 5}` of the `m=2, p=2, Q=8` winding." These four slots cover both phases and both polarities (for m=2, p=2, Q=8, q=2: slot 0 is phase 0+ belt, slot 1 is phase 0+, slot 2 is phase 1−, slot 3 is phase 1−, slot 4 is phase 0−, etc. — exact values follow from the formula).
    - Pros: Deterministic; covers both polarities; cannot be satisfied by a trivial implementation.
    - Cons: Requires computing the expected values from the formula and inserting them into the spec.
  - **Option B — Assert all Q slots**: Replace "a sampled slot `s`" with "for every slot `s ∈ [0, Q−1]`." For `Q=8` this is 8 assertions.
    - Pros: Complete coverage; no ambiguity.
    - Cons: Slightly more test code; marginal cost for Q=8.
  - **Option C — Accept the current phrasing as implementer discretion**: The test's purpose (confirming the general formula is used) is stated; the implementer exercises judgment on slot selection.
    - Pros: No spec change.
    - Cons: Test quality is undefined; a careless implementation (testing only slot 0) passes the review but provides weak coverage.
