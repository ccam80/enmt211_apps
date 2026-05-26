# Spec Review: Phase 2 — Parametric Ring-Stack Mesher

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 1          | 3                 | 4     |
| major    | 2          | 2                 | 4     |
| minor    | 0          | 1                 | 1     |
| info     | 1          | 0                 | 1     |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 2.1.1 — M0+M1+M2: BodyMesh struct + visualizer + single annulus + ring stack | yes | Fully covered including typed-array spine, materials[], turns, magDir, gapLoop stubs |
| 2.2.1 — M3: Angular sector templates for 5 element kinds | yes | All 5 kinds (I, M, W, C, K) covered; feature-coverage diff validated |
| 2.3.1 — M4+M5: Air collar + gap circle + grading/quality knobs | yes | Collar radii, gapMinNodes floor, dofBudget interaction all covered |
| 2.3.2 — M6+M7: Signature + LRU cache + validation harness + gmsh script + dev harness | yes | All items present; user-required browser pass correctly scoped |
| Plan verification: no inverted/degenerate elements | yes | Asserted in M1 tests and 15-fixture regression sweep |
| Plan verification: area = annulus | yes | areaError < 1e-2 / < 2e-3 |
| Plan verification: conforming ring interfaces | yes | interiorEdgeSharing assertion |
| Plan verification: graded anisotropic gap layers | yes | gapLayers knob test + radial grading assertion |
| Plan verification: feature-coverage diff vs config-schema | yes | Assertion in Task 2.2.1 and convergence test |
| Plan verification: uniform-Δθ gapLoop emitted | yes | gapTheta uniform assertion in Task 2.3.1 |
| Plan verification: near-90° quad angles | yes | minAngle > 20 / maxAngle < 160 in Task 2.1.1 |
| Plan verification: per-body signature LRU cache | yes | Task 2.3.2 cache tests |
| Plan verification: mesh-metric refinement convergence | yes | convergence.test.js |
| Plan verification: Bknee in materials[], dedup key includes it | yes | Bknee-distinguishes test in Task 2.1.1 |
| Plan verification: gmsh diff is dev-time oracle, committed suite uses analytic oracles | yes | D2 decision locked; skip-guard for sparse checkout |
| Plan verification: field/torque convergence is Phase 7 (not here) | yes | Explicitly stated in Out of Scope |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | Phase-2 §Task 2.1.1 "Files to create" → `tests/mesh/_fixtures.js` helpers | `assertClose` is described as "re-exported from `tests/engine/_fixtures.js`" but that file is deleted wholesale in Phase 0 (Task 0.1.3 removes all of `tests/engine/*`). Phase 0 creates `tests/_assert.js` as the replacement home for `assertClose`. | Replace `tests/engine/_fixtures.js` → `tests/_assert.js` in the assertClose re-export description. |

---

### Decision-Required Items

#### D1 — Two test files listed in Files Owned have no task assigned to create them (critical)
- **Location**: Phase-2 §"Files Owned" and §Task 2.1.1 "Tests"
- **Problem**: `tests/mesh/mesh-core.test.js` and `tests/mesh/mesh-view.test.js` appear in the Files Owned section (listed as `created`) and are the target of all Task 2.1.1 test assertions, but neither file appears in any task's "Files to create" section. Task 2.1.1's "Files to create" lists only `lib/motor-mesh.js`, `lib/motor-mesh-view.js`, and `tests/mesh/_fixtures.js`. No other task claims these two test files either. An implementer for Task 2.1.1 would have no formal instruction to create them, and a verifier checking Files Owned integrity would find two claimed-created files with no owning task.
- **Why decision-required**: Two different fixes are possible with distinct scope implications for Task 2.1.1.
- **Options**:
  - **Option A — Add both test files to Task 2.1.1's "Files to create"**: Extend Task 2.1.1 "Files to create" to include `tests/mesh/mesh-core.test.js` and `tests/mesh/mesh-view.test.js`. The task description already specifies all the assertions these files should contain, so this is a metadata repair.
    - Pros: Keeps all test authorship for M0/M1/M2 in one task. Consistent with the task already describing every assertion in those files. No scope change.
    - Cons: Task 2.1.1 is already rated `L`; formally adding two more files to create makes its scope explicit rather than implied.
  - **Option B — Split into a new sub-task 2.1.2 owning the test files**: Create a new task 2.1.2 in Wave 2.1 that owns `tests/mesh/mesh-core.test.js` and `tests/mesh/mesh-view.test.js`, depending on 2.1.1's output. Update manifest accordingly.
    - Pros: Separates implementation from testing; each agent can parallelize if manifest places them in separate groups.
    - Cons: The tests require the struct to exist (dependency on 2.1.1) and cannot run independently. Splitting adds manifest overhead with minimal benefit for what is largely boilerplate test authorship.

---

#### D2 — Cross-group file sharing across sequential waves (critical)
- **Location**: Phase-2 §manifest.json, groups 2.1.a / 2.2.a / 2.3.a
- **Problem**: The review rule states "if two tasks share any file in their Files-to-create/modify lists, they MUST be in the same manifest group. Split-across-groups → critical." Three cross-group file overlaps exist:
  - `lib/motor-mesh.js` is created by group 2.1.a (T2.1.1) and modified by group 2.2.a (T2.2.1) and group 2.3.a (T2.3.1 and T2.3.2).
  - `tests/mesh/_fixtures.js` is created by group 2.1.a (T2.1.1) and modified by group 2.3.a (T2.3.2).

  However, these groups are in strictly sequential waves (2.1 completes before 2.2 starts; 2.2 completes before 2.3 starts). No two concurrent groups ever hold the same file simultaneously. The lock-contention scenario the rule is designed to prevent cannot arise here.
- **Why decision-required**: The rule as written is unconditional — it does not contain a "same-wave only" carve-out. Whether the structural wave sequencing resolves the intent of the rule, or whether the letter of the rule requires all modifying tasks to share a group regardless of sequential ordering, is a design policy decision.
- **Options**:
  - **Option A — Accept the current structure as correct**: Document in the spec (or the manifest) that cross-wave file sharing is permitted because wave sequencing guarantees no concurrent access. No manifest or spec changes needed. The rule is interpreted as applying to concurrently-executable groups only.
    - Pros: No restructuring needed. The mesher's incremental-milestone structure (M0+M1+M2, then M3, then M4+M5, then M6+M7) is the whole rationale for sequential waves, and collapsing everything into one group would create a single enormous agent session.
    - Cons: Leaves the spec technically non-compliant with the letter of the rule; a future coordinator that checks only the rule text might reject the manifest.
  - **Option B — Merge all Phase 2 tasks into one group per wave with explicit sequential wave dependency**: Keep the four tasks in their current waves but add a `depends_on` annotation to the manifest entry for each wave making the sequential ordering machine-readable and the cross-wave access explicit.
    - Pros: Makes the sequencing contract explicit in the manifest; no restructuring of task scope.
    - Cons: The manifest schema may not support `depends_on` at the wave level (not visible in the current schema); requires a schema extension.
  - **Option C — Collapse all four tasks into a single wave and single group**: Move T2.2.1, T2.3.1, and T2.3.2 into Wave 2.1 alongside T2.1.1, all in group 2.1.a. The wave-milestone structure is expressed only in the task descriptions.
    - Pros: Fully letter-compliant with the file-locality rule.
    - Cons: A single group of 4 tasks rated L/L/L/M is too large for one agent session. The entire rationale for the milestone-wave split (progressive deliverables) is lost. Total file count: 12 distinct files — above the 10-file cap.

---

#### D3 — `interiorEdgeSharing(mesh)` return contract unspecified (major)
- **Location**: Phase-2 §Task 2.1.1 "Files to create" → `tests/mesh/_fixtures.js`, and §Task 2.1.1 "Tests" → `M2 conforming interfaces (no hanging nodes)`
- **Problem**: The spec defines `interiorEdgeSharing(mesh)` as a helper in `_fixtures.js` and then asserts it "reports every interior edge referenced by exactly two elements (only true outer/inner/gap-surface boundary edges are referenced once)." The word "reports" does not specify the return type. An implementer must choose between: returning a boolean (`true` if all interior edges are shared by exactly two elements), throwing on violation, returning a structured object with edge details, or returning counts. The test cannot be written without knowing what this function returns and how to assert against it.
- **Why decision-required**: Multiple valid implementations exist — the choice determines both the helper implementation and the test assertion form, and these could reasonably differ.
- **Options**:
  - **Option A — Returns a boolean `true`/`false`**: `interiorEdgeSharing(mesh)` returns `true` iff every interior edge is shared by exactly two elements. The test asserts `assert.strictEqual(interiorEdgeSharing(mesh), true)`.
    - Pros: Simplest. The test is a one-liner.
    - Cons: On failure, gives no diagnostic about which edge is bad. Harder to debug.
  - **Option B — Returns `{ ok: boolean, badEdges: Array<[nodeA, nodeB]> }`**: On violation, `badEdges` lists the problematic edges. The test asserts `result.ok === true`.
    - Pros: Useful diagnostic output when the mesh has a defect.
    - Cons: Slightly more implementation work; test must access `.ok`.
  - **Option C — Throws on violation, returns `undefined` on success**: The test uses `assert.doesNotThrow(() => interiorEdgeSharing(mesh))`.
    - Pros: Directly compatible with the word "reports" (reports a problem by throwing).
    - Cons: Throwing in a fixture helper is unconventional; catching and rethrowing in tests is cumbersome.

---

#### D4 — `readMsh` return contract does not cover `gap-layer count` but test asserts it (major)
- **Location**: Phase-2 §Task 2.3.2 "Files to modify" → `tests/mesh/_fixtures.js` (`readMsh` spec), and §Task 2.3.2 "Tests" → `convergence.test.js::gmsh reference diff`
- **Problem**: The spec says `readMsh(path)` should "parse a gmsh `.msh` enough to extract element count / min-angle / node count for the dev-oracle diff." But the corresponding test assertion requires `"gap-layer count matches"` — a quantity that `readMsh` as described would not return (node count ≠ gap-layer count, and `.msh` files do not natively store a "gap-layer count" concept). There is also no specification of how `gen-mesh-refs.mjs` should embed gap-layer count in the `.msh` output so that `readMsh` can retrieve it. An implementer must decide whether to (a) embed gap-layer count as a gmsh mesh comment / physical group annotation in the generated `.msh`, (b) derive it geometrically from the `.msh` node positions, or (c) treat the assertion as an error and drop "gap-layer count matches" from the test. The spec gives no guidance.
- **Why decision-required**: The mismatch between `readMsh`'s specified return value and the test's required assertion involves a non-trivial design decision about the `.msh` file format written by `gen-mesh-refs.mjs` and how the test runner retrieves metadata from it.
- **Options**:
  - **Option A — Embed gap-layer count in the `.msh` file as a comment, extend `readMsh` to parse it**: `gen-mesh-refs.mjs` writes `// gap_layers: N` as the first line of each `.msh` file. `readMsh` returns `{ elemCount, minAngle, nodeCount, gapLayers }`. The test asserts `parsed.gapLayers === opts.gapLayers`.
    - Pros: Self-describing file; no geometric inference needed at test time.
    - Cons: Couples the `.msh` format to a custom convention; requires `gen-mesh-refs.mjs` to know the mesher's `opts.gapLayers` value at reference-generation time.
  - **Option B — Derive gap-layer count geometrically from node positions in `readMsh`**: Count the number of distinct radial levels between the conforming surface and the gap circle from the `.msh` node coordinates. `readMsh` returns `{ elemCount, minAngle, nodeCount, gapLayers }`.
    - Pros: No custom file-format convention; uses only standard `.msh` data.
    - Cons: Geometric inference of layer count from a raw node cloud is fragile (requires knowing what "collar layer" means geometrically); adds substantial implementation complexity to `readMsh`.
  - **Option C — Drop "gap-layer count matches" from the gmsh-diff test assertion**: Remove that assertion entirely; the test asserts only element count within 2× and minAngle within ±10°. Update `readMsh` description to match: `{ elemCount, minAngle }`. The gap-layer property is already verified by the `gapLayers knob` test (in `collar-gap.test.js`) on the mesher's own output.
    - Pros: Eliminates the underspecified dependency; the gap-layer behavior is tested elsewhere.
    - Cons: The gmsh-diff test is weaker; does not verify that the mesher and gmsh produce meshes with comparable internal structure.

---

#### D5 — `dofBudget` cap test assertion has ambiguous strictness bound (minor)
- **Location**: Phase-2 §Task 2.3.1 "Tests" → `collar-gap.test.js::dofBudget caps node count`
- **Problem**: The test spec says: "assert building with a small `dofBudget` produces `Nn <= dofBudget` (within the rounding the spec permits: `Nn <= dofBudget` strictly)". The parenthetical contradicts itself — "within the rounding the spec permits" implies some tolerance, but "(strictly)" then says no tolerance. The implementer cannot tell whether `Nn` must be `<= dofBudget` exactly (strict integer inequality), or whether some rounding margin is allowed.
- **Why decision-required**: The tolerance choice is not mechanical — "within rounding" could mean ±1, ±P_body, or zero. The correct margin depends on the mesher's snapping behavior (which snaps N_gap to a multiple of P_body, so the final `Nn` may slightly exceed a naive budget cap).
- **Options**:
  - **Option A — Strictly `Nn <= dofBudget`**: The implementer must ensure the mesher never exceeds `dofBudget` after all snapping. If P_body snapping would push `Nn` over, the mesher uses the next-lower multiple. Assert `assert.ok(rotor.nodes.length / 2 <= dofBudget)`.
    - Pros: Clear, unambiguous.
    - Cons: Requires the mesher to resolve the P_body-snap vs budget conflict correctly; may need a clarification of which wins in the general case.
  - **Option B — `Nn <= dofBudget + P_body` (one snapping multiple of slack)**: Allow up to one body-period of overshoot from P_body snapping. Assert `assert.ok(rotor.nodes.length / 2 <= dofBudget + P_body)`.
    - Pros: Reflects the real snapping behavior; avoids forcing the mesher into a corner case.
    - Cons: Requires the test to know `P_body` for the chosen section, adding fixture complexity.

---

### Info
| ID | Severity | Location | Note |
|----|----------|----------|------|
| I1 | info | Phase-2 §"Files Owned" — preamble note | The note about `lib/motor-mesh-view.js` being "extended in Phase 6 (Wave 6.1)" and the reasoning about sequential ownership is explanatory prose about the development history and inter-phase handoff. Per `rules.md`, spec sections are current-state contracts, not changelogs. This prose will be stale after Phase 6 is authored. It is not harmful to implementers now, but could mislead a Phase-6 reviewer into thinking Phase 2 still "owns" the file extension. No action strictly required. |
