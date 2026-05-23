# Spec Review: Phase 6 — machine-fixtures

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 2 | 4 | 6 |
| minor    | 2 | 1 | 3 |
| info     | 2 | 0 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 6.1.1 — Author matrix rows 1–7 as one fixture file each | yes | Full detail; all 7 fixtures with complete config specs |
| 6.1.2 — Author rows 8–13 + skew demo + pole-mismatch demo | yes | All 8 fixtures specified; see D2 for vr-stepper circuit ambiguity |
| 6.1.3 — Append 15 `<script>` tags to `index.html` extension region | yes | Exact tag list and ordering stated |
| 6.2.1 — `tests/machines/_fixtures.js` loader + measurement helpers | yes | Every helper function specified with signatures and formulas |
| 6.3.1 — One test per fixture for rows 1–7 | yes | See D3, D4 for induction-1ph ordering and missing guard |
| 6.3.2 — One test per fixture for rows 8–13 + demos | yes | See M1 for synchronous-reluctance typo; see D5 for pm-stepper vagueness |
| Plan verification: every fixture passes its validation test; `npm test` green | yes | Phase acceptance section states this |
| Plan verification: grep of `lib/` + `mount.js` for machine names returns zero | yes | Acceptance criteria in Tasks 6.1.1 and 6.1.2 state this |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | phase-6 §Task 6.3.2, `synchronous-reluctance.test.js`, `"self-inductance follows L₀+L₂cos2θ_e"` | The assertion reads `Math.abs(fit.a2) > 1e-9` but the `fitCos2` return shape is `{ L0, L2, r2 }` everywhere else in the spec (vr-stepper uses `fit.L2`, switched-reluctance uses `fit.L2`). `fit.a2` is an undefined property; the assertion silently passes `Math.abs(undefined) > 1e-9` → `false` in strict mode, always failing. | Replace `fit.a2` → `fit.L2` |
| M2 | minor | phase-6 §Overview "Why three waves" | Contains the sentence: "`plan.md`'s Phase 6 section is updated to match." This is a historical-provenance statement about the plan being updated; specs are current-state contracts and must not record what was changed. | Delete the sentence "plan.md's Phase 6 section is updated to match." |
| M3 | minor | phase-6 §Task 6.3.1, `brushed-dc-pm.test.js`, file-path heading | The path is rendered as `tests\machines\brushed-dc-pm.test.js` (backslash). The spec's own rules.md mandates forward slashes in all paths. Same issue appears for every test file listed in Task 6.3.1 and 6.3.2. | Replace all `tests\machines\<file>.test.js` with `tests/machines/<file>.test.js` throughout §Tasks 6.3.1 and 6.3.2 |
| M4 | info | phase-6 §Task 6.2.1, `crossCheck` helper | The helper field `rel` is labelled as the absolute difference (`rel = Math.abs(arkkio − coe)`), but the name `rel` implies "relative". This is confusing but the `ok` formula is unambiguous (`rel ≤ XC_TOL·max(…) + XC_FLOOR`). No behavioural mismatch, but the field name misleads readers. | Rename the exported field `rel` → `absDiff` in the `crossCheck` return shape, and update the `ok` formula reference accordingly. (Alternatively, leave as-is and add a comment clarifying that `rel` is the raw absolute difference, not a ratio.) |

---

### Decision-Required Items

#### D1 — `induction-1ph` test ordering dependency creates an unrunnable assertion (major)

- **Location**: phase-6 §Task 6.3.1, `tests/machines/induction-1ph.test.js`, first two assertions.
- **Problem**: The spec states the assertions in this order:
  1. `"main winding alone gives ~zero starting torque"` — asserts `Math.abs(Tmain) ≤ 0.05·Tboth` (Tboth "computed below").
  2. `"capacitor-shifted auxiliary winding gives non-zero starting torque"` — computes `Tboth`.

  `Tboth` is used in assertion 1 but not defined until assertion 2. The spec's parenthetical `(Tboth is reused as the denominator of the main-only assertion)` acknowledges the forward reference but does not resolve it. In a `node:test` suite where each test assertion (`assert.*`) runs inside its own `test(…)` callback, `Tboth` cannot be shared between two independent `test()` blocks without module-level state. The spec gives no instruction on how to wire this cross-assertion dependency.
- **Why decision-required**: There are at least two structurally different fixes, each with different trade-offs for test clarity, isolation, and spec correctness.
- **Options**:
  - **Option A — Reverse order, compute Tboth first**: Swap the two assertions so the `"capacitor-shifted"` test runs first and stores `Tboth` at module scope; the `"main-only"` test reads that module-level variable. The spec text order changes.
    - Pros: Each test stays its own `test()` block; avoids a combined test. Matches how the spec describes the denominator relationship.
    - Cons: Module-level state between tests; test isolation is weakened. `"main-only"` silently uses stale `Tboth` if a previous test failed.
  - **Option B — Combine into one test**: Merge both assertions into a single `test("cap-start: auxiliary phase shifts torque vs main-only")` that computes `Tboth` then `Tmain` in one block.
    - Pros: Self-contained; no cross-test state. Common pattern for before/after comparisons.
    - Cons: One test covers two named behaviours; a failure message is less targeted.
  - **Option C — Hardcode a standalone Tboth threshold**: Replace `0.05·Tboth` with a concrete numeric floor (e.g. `1e-5`) derived from the `Tboth > 1e-5` bound already asserted. The `"main-only"` test becomes independent.
    - Pros: Full test isolation; no shared state.
    - Cons: The `0.05·Tboth` bound (5% of the energized case) is tighter and more physically meaningful than a fixed floor; replacing it loses that signal.

---

#### D2 — `vr-stepper` circuit spec embeds a non-vocabulary comment as a pseudo-field (major)

- **Location**: phase-6 §Task 6.1.2, `vr-stepper.js` circuits block.
- **Problem**: The circuit definition reads:
  ```
  { terminal:{type:"STEP",amp:24,conductionAngle:Math.PI},
    commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3,
    phaseOffset:-2π·k/3 via terminal.phaseOffset}, R:0.5 }
  ```
  The text `phaseOffset:-2π·k/3 via terminal.phaseOffset` is not valid JavaScript and not a field in the `commutation` vocabulary (`mode`, `poles`, `loadAngle`, `stepAngleElec`, `conductionAngle` — per §Circuit indexing and the Phase-3 spec). The clarification `i.e. each circuit terminal.phaseOffset = -2*Math.PI*k/3` follows as a separate sentence, but the circuit object shown still contains the non-vocabulary text embedded inside the `commutation:{}` block. An implementer reading only the circuit literal will produce syntactically invalid or semantically wrong JavaScript — `phaseOffset` is in `commutation{}`, not `terminal{}`.
- **Why decision-required**: Two different corrections are possible and they produce different config objects.
- **Options**:
  - **Option A — Remove `phaseOffset` from `commutation` block; move it to `terminal`**: Replace the single malformed circuit template with:
    ```
    { terminal:{type:"STEP",amp:24,conductionAngle:Math.PI,phaseOffset:-2*Math.PI*k/3},
      commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3}, R:0.5 }
    ```
    and delete the clarifying sentence (now redundant).
    - Pros: Matches the vocabulary exactly; no ambiguity.
    - Cons: None — this is the structurally correct fix.
  - **Option B — Replace with a full explicit 3-entry `circuits` array**: List all three circuits explicitly (k=0,1,2) so no template variable `k` is needed and the JavaScript is unambiguous:
    ```js
    circuits: [
      { terminal:{type:"STEP",amp:24,conductionAngle:Math.PI,phaseOffset:0},
        commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3}, R:0.5 },
      { terminal:{type:"STEP",amp:24,conductionAngle:Math.PI,phaseOffset:-2*Math.PI/3},
        commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3}, R:0.5 },
      { terminal:{type:"STEP",amp:24,conductionAngle:Math.PI,phaseOffset:-4*Math.PI/3},
        commutation:{mode:"sequencer",poles:4,stepAngleElec:2*Math.PI/3}, R:0.5 },
    ]
    ```
    - Pros: No template variable; unambiguous to copy-paste.
    - Cons: Verbose; less compact than the `k`-indexed form that every other fixture uses.

---

#### D3 — `crossCheck` missing the `max(|arkkio|,|coe|) > 1e-5` guard in `induction-3ph` and `induction-1ph` standstill cases (major)

- **Location**: phase-6 §Tolerance scheme class (B), and §Task 6.3.1 `induction-3ph.test.js` and `induction-1ph.test.js` crossCheck assertions.
- **Problem**: The class (B) tolerance definition states the cross-check is `asserted only where max(|arkkio|, |coe|) > 1e-5`. The `crossCheck` helper as specified returns an `ok` field that already bakes in `XC_FLOOR = 1e-6` but does **not** implement the `> 1e-5` skip guard — the `ok` formula is:
  ```
  ok = rel ≤ XC_TOL·max(|arkkio|, |coe|) + XC_FLOOR
  ```
  At near-zero torque (`max < 1e-5`), the formula reduces to `rel ≤ XC_FLOOR` (1e-6), which is a numerically impossible bar for a finite-precision solve. The (B) spec says to skip the assertion in that regime, but the `crossCheck` helper has no such guard — it always returns `ok`.

  The `induction-3ph` crossCheck is called at standstill with cage zeroed and stator energised — torque may be near zero at `θ=0`. The `induction-1ph` crossCheck is called at `θ=0.0` with `<cage zeroed, main+aux energized>` — the actual instantaneous torque at the zero crossing is unknown from the spec alone. If torque is near zero, `ok` will be `false` and the test will fail spuriously. The helper spec must state the guard explicitly, or the calling tests must apply it.
- **Why decision-required**: The guard could be applied inside the helper (changing its contract) or outside in each test, and those choices have different consistency implications.
- **Options**:
  - **Option A — Add the guard inside `crossCheck`**: Change the `ok` definition to:
    `ok = max(|arkkio|,|coe|) <= 1e-5 || rel <= XC_TOL·max(|arkkio|,|coe|) + XC_FLOOR`
    and document that the helper skips the assertion (returns `ok:true`) when both torques are near zero.
    - Pros: Single place to enforce the spec's stated guard; all tests inherit it automatically.
    - Cons: `ok:true` for near-zero cases means the test is not actually asserting anything; a helper that auto-passes for trivial inputs is harder to trust.
  - **Option B — Change the standstill crossCheck angle**: For `induction-3ph` and `induction-1ph`, pick a `θ` that is known to produce non-trivial torque (e.g. `θ=0.4` or `θ=π/6`) so the guard never triggers in practice.
    - Pros: Tests actually assert something meaningful; no silent skip.
    - Cons: The implementer must know which angles produce non-zero torque — that is discovery phrasing unless the spec states the angle explicitly.
  - **Option C — Add the guard as an explicit `if` in each calling test**: Each test wraps the assertion: `const xc = crossCheck(…); if (xc.arkkio > 1e-5 || xc.coe > 1e-5) assert.ok(xc.ok)`. The helper's contract stays simple.
    - Pros: The helper is a pure data structure; guard logic stays in test code where it is visible.
    - Cons: Boilerplate duplicated in every crossCheck call site; easy to forget.

---

#### D4 — `pm-stepper` holding-torque test uses a vague energisation mechanism: "`STEP` at `stepIndex 0`" (major)

- **Location**: phase-6 §Task 6.3.2, `pm-stepper.test.js`, `"holding torque pulls the rotor toward alignment when energized"`.
- **Problem**: The test description says "energize phase 0 only (`terminal.amp` held via a `STEP` at `stepIndex 0`)". Under the Phase-3 `sequencer` commutation, `supplyValue` is called with `phaseArg = stepIndex * stepAngleElec + terminal.phaseOffset`. For the pm-stepper, `stepAngleElec = π/2` and for k=0, `phaseOffset=0`, so at `stepIndex=0`, phase arg=0. This causes both circuits to be potentially energised depending on `conductionAngle`. The text says "energize phase 0 **only**", but the config has `conductionAngle:π` — at `stepIndex=0`, both circuits may be within conduction window. An implementer who calls `runFromRest(runtime, 400)` without any modification will run with both circuits active (as `commandStep` is never called), which is the normal `STEP`+`sequencer` mode. It is unclear whether:
  (a) the test uses the fixture as-is with `runFromRest` and no `commandStep` call (both phases may be active),
  (b) the test mutates one circuit's terminal to `OPEN`, or
  (c) some other mechanism is intended.
  The instruction "held via a `STEP` at `stepIndex 0`" describes the config's designed behaviour (no step commanded → stays at index 0), but does not specify whether the test should mutate the circuit or rely on commutation gating.
- **Why decision-required**: The energisation setup is ambiguous in a way that could produce completely different test code, and each interpretation tests a different physical scenario.
- **Options**:
  - **Option A — Use the fixture as-is with `runFromRest` (no mutation)**: Clarify that at `stepIndex=0` the sequencer gates phase k=0 on (positive) and phase k=1 on with offset `−π/2` — both circuits active. Change the test description to "energize the fixture at its reset step position" and verify that the rotor settles (not that only phase 0 is active).
    - Pros: No config mutation; tests the fixture as deployed.
    - Cons: The described "phase 0 only" property is lost; the test becomes less targeted.
  - **Option B — Specify an explicit circuit mutation**: State that the test clones the config, sets circuit 1's `terminal.type = "OPEN"`, builds a new runtime, and calls `runFromRest`. This isolates phase 0 unambiguously.
    - Pros: Precise; the "only phase 0" claim is guaranteed.
    - Cons: Requires config mutation, which is the pattern already used in `induction-1ph` — consistent.
  - **Option C — Specify the `commandStep` call and current state**: State that the test calls `runtime.reset()`, confirms `state.stepIndex===0`, then runs `runtime.step(dt)` in a loop and checks the commutation gating explicitly (e.g. asserts `runtime.lastSolve.i[0] > 0` and `runtime.lastSolve.i[1] ≈ 0` after the first step).
    - Pros: Directly verifies the intended energisation state.
    - Cons: Requires knowledge of implementation-internal `lastSolve` structure; tests more than the spec describes.

---

#### D5 — `wound-field-synchronous` load-angle test mutates `phaseOffset` on live circuits without specifying the mutation mechanism (major)

- **Location**: phase-6 §Task 6.3.2, `wound-field-synchronous.test.js`, `"develops synchronous torque whose sign follows the load angle"`.
- **Problem**: The test states: "set the stator load angle via the three stator circuits' `phaseOffset += δ`". The `runtime` object returned by `build(id)` exposes `runtime.circuits` (a mutable array per Phase-5 spec). However:
  1. It is not specified whether the implementer should mutate `runtime.circuits[k].terminal.phaseOffset` in place and then call `avgTorqueAtSpeed`, or whether a fresh `build` call should be made for each `δ`.
  2. The fixture's stator circuits already have `phaseOffset: -2π·k/3` (for k=0,1,2 of the stator, i.e. circuits 1,2,3 since circuit 0 is the field). Mutating `phaseOffset += δ` in place after calling `avgTorqueAtSpeed` at δ=+0.3 would leave the circuits at `phaseOffset = original + 0.3` before the δ=0 and δ=-0.3 runs — i.e. the runs are not independent unless the mutation is undone. The spec does not say to reset between runs.
  3. The `avgTorqueAtSpeed` helper re-sets `runtime.state.omega` each step, but does not rebuild `runtime.circuits` from the original config.
- **Why decision-required**: The mutation strategy (in-place vs fresh build vs offset delta from initial) determines both the correctness and the structure of the test code.
- **Options**:
  - **Option A — Fresh `build` for each δ, set absolute offsets**: For each δ, call `build("wound-field-synchronous")` and set `runtime.circuits[1..3].terminal.phaseOffset = (-2*Math.PI*k/3) + δ` before running `avgTorqueAtSpeed`. No shared mutable state.
    - Pros: Deterministic; no inter-run contamination.
    - Cons: Three `build` calls; slower but correct.
  - **Option B — Mutate in place, reset between runs**: State explicitly that for each δ the test mutates `runtime.circuits[k+1].terminal.phaseOffset = (-2*Math.PI*k/3) + δ` (for k=0,1,2) and calls `avgTorqueAtSpeed` with a fresh `runtime.reset()` before each run.
    - Pros: One build; mutation is explicit.
    - Cons: In-place mutation is fragile; if `avgTorqueAtSpeed` itself calls `runtime.reset()` (which it does per the spec), the reset happens inside the helper — the phaseOffset mutation must happen after each internal reset call, which is not possible from outside.
  - **Option C — Use `stack.solve` directly with a fixed-omega approach**: Replace `avgTorqueAtSpeed` with a direct `sweepTorque` call where the current vector is computed from the analytic stator current at the given δ, avoiding `runtime` mutation entirely.
    - Pros: No mutation; purely functional.
    - Cons: Requires computing stator currents analytically at synchronous speed — more complex test setup; departs further from the spec text.

---

### Info Items

| ID | Severity | Location | Observation |
|----|----------|----------|-------------|
| I1 | info | phase-6 §Task 6.1.2, `hybrid-stepper.js` acceptance criterion | The criterion states `expand(hybridStepper).slices.length === 2` and "the ring-0 magnet `Mr` of slice 1 is the exact negative of slice 0's". The expanded shape is verified by the test in Task 6.3.2, but the acceptance criterion in Task 6.1.2 is listed under a task whose Wave is 6.1 — the pipeline `expand()` call does not exist yet (Wave 6.2 loader is needed first). The criterion will be validated by the Wave-6.3 test; it reads oddly as a Task-6.1.2 acceptance criterion. No implementation blocker, but the criterion belongs logically to Task 6.3.2. |
| I2 | info | phase-6 §Task 6.3.1, `induction-3ph.test.js`, `crossCheck` current vector | The crossCheck is called with `Float64Array([0,0,0, 24,-12,-12])` — 6 values for a fixture with 3 cage + 3 stator = 6 circuits. This is correct. However, the comment "(cage zeroed, stator energized — instantaneous loaded point)" usefully explains the intent. No issue; the vector is unambiguous and correct. Noted for completeness. |

---

## Task Groups Validity

Phase 6 has an entry in `spec/manifest.json`. Validation:

**Wave 6.1:**
- Group `6.1.a`: task `T6.1.1` (complexity `M`). Files created: 7 fixtures. ≤ 10 cap: pass.
- Group `6.1.b`: task `T6.1.2` (complexity `M`). Files created: 8 fixtures. ≤ 10 cap: pass.
- Group `6.1.c`: task `T6.1.3` (complexity `S`). Files modified: 1 (`index.html`). ≤ 10 cap: pass.
- Task groups non-empty: pass.

**Wave 6.2:**
- Group `6.2.a`: task `T6.2.1` (complexity `M`). Files created: 1. ≤ 10 cap: pass.

**Wave 6.3:**
- Group `6.3.a`: task `T6.3.1` (complexity `L`). Files created: 7 test files. ≤ 10 cap: pass.
- Group `6.3.b`: task `T6.3.2` (complexity `L`). Files created: 8 test files. ≤ 10 cap: pass.

**Task coverage:** All 6 tasks (`T6.1.1`–`T6.3.2`) appear in exactly one manifest group. No manifest task IDs without a spec counterpart.

**File locality:** No two tasks in different groups share any file. T6.1.1 and T6.1.2 share no files. T6.1.3 modifies `index.html`; no other task in any group modifies `index.html` in Wave 6.1. Pass.

**`user_required_tasks`:** No task in Phase 6 contains user-required phrasing (no browser verification step, unlike Phases 5, 7, 8, 9). All groups correctly list `user_required_tasks: []`. Pass.

**Complexity values:** All six tasks carry valid values (`S`, `M`, or `L`). Pass.

---

## Summary of Blocking Issues

The spec is implementable for the majority of its content but has **six major findings** that will cause implementation failure or unverifiable output:

1. **M1 (major, mechanical):** `fit.a2` typo in the synchronous-reluctance test will cause a permanently-failing assertion.
2. **D1 (major, decision-required):** The `induction-1ph` test uses `Tboth` before it is computed; the forward dependency structure cannot be implemented as written.
3. **D2 (major, decision-required):** The `vr-stepper` circuit literal embeds a non-JavaScript token (`phaseOffset:-2π·k/3 via terminal.phaseOffset` inside `commutation:{}`); an implementer will produce syntactically invalid or wrong code.
4. **D3 (major, decision-required):** The `crossCheck` helper does not implement the `max > 1e-5` guard stated in the class-(B) tolerance definition; standstill crossCheck calls in `induction-3ph` and `induction-1ph` will spuriously fail.
5. **D4 (major, decision-required):** The `pm-stepper` holding-torque test's energisation mechanism is ambiguous; "energize phase 0 only via a STEP at stepIndex 0" could be implemented at least three different ways.
6. **D5 (major, decision-required):** The `wound-field-synchronous` load-angle test mutates `phaseOffset` without specifying whether to use fresh builds or in-place mutation between runs, and the in-place approach is undermined by `avgTorqueAtSpeed` calling `runtime.reset()` internally.
