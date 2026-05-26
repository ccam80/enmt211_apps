# Spec Review: Phase 7 — Validation

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 2 | 3 | 5 |
| minor    | 2 | 1 | 3 |
| info     | 2 | 0 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 7.1.1 — New engine-tier FEA tests (convergence, analytic, cross-method, known-machine) | yes | Five files fully specced with concrete assertions |
| 7.1.2 — Re-point 15 machine-fixture tests onto FEA slice | yes | Scripted-edit task with enumerated changes |
| 7.2.1 — Saturated cogging Richardson-convergence < 5 % | yes | Full test bodies with Newton guards |
| Verification measure: `\|λpm\| < 1e-9` non-PM | yes | In known-machine.test.js |
| Verification measure: reluctance L(θ) fit r² ≥ 0.99 | yes | In known-machine.test.js |
| Verification measure: cross-method torque ≤ 2 % | yes | In cross-method.test.js |
| Verification measure: back-EMF < 1 %; gap/inductance < 3 % | yes | In analytic.test.js |
| Verification measure: cogging period = LCM(slots,poles) | yes | In known-machine.test.js |
| Verification measure: WFS self-start un-skip and pass | yes | In T7.1.2 |
| Verification measure: saturated cogging grid-convergent < 5 % | yes | In T7.2.1 |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §T7.1.2 "Affected references — Opts-key flip" | `_fixtures.js:170` cited as containing `ceiling: { enabled: false }` in `crossCheck`. The actual line 170 is `var stackLin = LIB.MotorStack.create(stack.expanded, { ceiling: { enabled: false } });` — the ceiling opt is on line 170 but the spec says it is "inside `crossCheck`". This is correct and the line is confirmed. However, the spec states the edit is at `_fixtures.js:170` but the function definition `crossCheck` begins at line 169 and the ceiling opt is embedded in that function at line 170. The description says `(inside crossCheck)` which matches — no error here. *(This entry is withdrawn; confirmed correct.)* | N/A — confirmed accurate |
| M2 | minor | §T7.1.2 "WFS self-start un-skip — lines 33–42" | The spec says "delete lines 33–42 (the deferred-explanation block-comment)". The actual file has the block comment spanning lines 33–42 (10 lines) and `test(` beginning at line 43 — confirmed correct. However, the spec then says "the test body (line 44–48: `runFromRest(runtime, 150)` + the `assert.ok` line)". In the actual file, line 44 is the `skip:` argument continuation, line 45 is `function () {`, line 46 is `const { runtime } = build(...)`, line 47 is `const state = runFromRest(runtime, 150)`, line 48 is `assert.ok(...)`, line 49 is the assert message string, line 50 is `});`. The spec's parenthetical "(line 44–48)" off-by-one relative to the actual line layout — the assert spans lines 48–49 and `});` is line 50, not line 48. | Replace "(line 44–48: `runFromRest(runtime, 150)` + the `assert.ok` line)" with "(lines 45–50: the `function () { … }` body plus the closing `});`)" |
| M3 | info | §T7.1.1 `_fixtures.js` module exports | The spec lists `gapPeakB(solveResult, r_band) → number` and `coggingAmpAt(slice, polesNum, slotsNum, N) → number` in the exports but the description of `coggingAmpAt` says it calls `slice.coggingTorque(θ)`. In T7.2.1, the same helper is called as `coggingAmpAt(stack.slices[0], ...)`. This is consistent — the param name `slice` in the helper is just the local name. No error. *(Withdrawn.)* | N/A |

Restated mechanical findings (removing the two withdrawn above):

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §T7.1.2 "WFS self-start un-skip" D9 parenthetical | Spec says "The test body (line 44–48: `runFromRest(runtime, 150)` + the `assert.ok` line) is byte-identical to before." In the actual file, the test body occupies lines 45–50 (function body open at 45, `assert.ok` at lines 48–49, `});` at 50). The line range "(line 44–48)" is inaccurate and will confuse an implementer verifying the byte-identical claim. | Replace "The test body (line 44–48: `runFromRest(runtime, 150)` + the `assert.ok` line) is byte-identical to before." with "The test body (lines 45–50: the `function () {…}` wrapper plus `runFromRest`, `assert.ok`, and the closing `});`) is byte-identical to before." |
| M2 | minor | §T7.1.2 "Affected references — comment scrubs" | The spec says 5 comment scrub lines in 2 files; the tally in the "Dry-run requirement" paragraph says "12 single-line edits + 1 multi-line WFS block — 4 import flips + 3 opt-key flips + 5 comment-line scrubs". 4 + 3 + 5 = 12 single-line edits. The synchronous-reluctance.test.js import re-point is listed in "Affected references" (line 9) but the "Files to modify" section does NOT list `tests/machines/synchronous-reluctance.test.js` — it lists only 5 files: `_fixtures.js`, `synchronous-reluctance.test.js`, `switched-reluctance.test.js`, `vr-stepper.test.js`, `wound-field-synchronous.test.js`. Actually it IS listed. However the "Files to create" under T7.1.2 lists `scripts/phase7-repoint.mjs` but the "Files to modify" section header says "(5 files)" — the script is a 6th file touched (created). The "(5 files)" parenthetical is wrong; it should be "(5 files modified + 1 script created)". | In T7.1.2 "Files to modify" section, change the header comment "(5 files; see 'Affected references' above)" — but the parenthetical is already on the "Files to modify" header `- **Files to modify**: (5 files; see "Affected references" above)`. This is accurate (5 files modified). The script is under "Files to create". No actual error here — the 5 files modified is correct. *(Withdrawn — count is correct.)* | N/A |

Final mechanical findings (one confirmed):

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §T7.1.2 D9 / "WFS self-start un-skip" | Spec states "the test body (line 44–48)" is byte-identical. In the actual file, the skip arg is on line 44, function body opens at 45, `runFromRest` at 47, `assert.ok` at 48–49, `});` at 50. The range "(line 44–48)" is off by two lines and includes the `skip:` argument that is being deleted, which contradicts "byte-identical". | Replace `"(line 44–48: runFromRest(runtime, 150) + the assert.ok line)"` → `"(lines 45–50: the function body — runFromRest, assert.ok, and closing });)"` |

---

### Decision-Required Items

#### D1 — `tests/pipeline/_fixtures.js` does not export `initSolver`, `feaOpts`, or `CS` (critical)

- **Location**: Phase 7 §T7.1.1 `tests/fea-engine/_fixtures.js` "Files to create" — first bullet, `require("../pipeline/_fixtures.js")` re-export claim.
- **Problem**: The spec instructs the T7.1.1 implementer to `require("../pipeline/_fixtures.js")` and expect it to re-export `initSolver`, `feaOpts`, and `CS = UnifiedMotor.ConfigSchema`. The actual current `tests/pipeline/_fixtures.js` exports only: `LIB, UnifiedMotor, MACHINE_NAMES, assertClose, woundConfig, pmConfig, salientConfig, skewN2Config, tinySection`. There is no `initSolver`, no `feaOpts`, and no `CS`. These three exports are WASM-solver lifecycle helpers that Phase 5 (T5.3.1) must add to the pipeline fixtures file. Phase 5's spec (T5.3.1) says it "re-green[s] `tests/pipeline/...`" — but it is ambiguous whether that phase's implementer will add `initSolver`/`feaOpts` to `_fixtures.js`. If Phase 5 does not add them, T7.1.1's `_fixtures.js` will fail to load at the first `await initSolver()` call. The T7.1.1 implementer cannot write the `before(async () => { await initSolver(); })` hook without either defining `initSolver` locally or importing it from somewhere that exports it.
- **Why decision-required**: The fix requires deciding who owns adding `initSolver`/`feaOpts`/`CS` to `tests/pipeline/_fixtures.js` — Phase 5 (add them there) or Phase 7 (define them locally in `tests/fea-engine/_fixtures.js` without the cross-require). Both approaches are architecturally coherent; the choice affects Phase 5's spec and the import chain of Phase 7's fixture file.
- **Options**:
  - **Option A — Phase 5 owns the exports**: Add to Phase 5 spec (T5.3.1) an explicit requirement that `tests/pipeline/_fixtures.js` gains `initSolver` (a helper that calls `await LIB.FeaSolver.init()`), `feaOpts(overrides)` (a helper merging FEA-specific opts), and `CS` (shorthand for `UnifiedMotor.ConfigSchema`). Phase 7's spec is then correct as written.
    - Pros: Centralises solver-init helpers where the pipeline tests already live; Phase 7 fixtures stay thin.
    - Cons: Requires modifying the Phase 5 spec retroactively; Phase 5 is already written and may be implemented.
  - **Option B — Phase 7 defines helpers locally**: Remove the claim that `initSolver`/`feaOpts`/`CS` come from `"../pipeline/_fixtures.js"`. Instead define them directly in `tests/fea-engine/_fixtures.js` (e.g., `const CS = UnifiedMotor.ConfigSchema; async function initSolver() { return LIB.FeaSolver.init(); } function feaOpts(o) { return Object.assign({ saturation: { enabled: true } }, o); }`).
    - Pros: Self-contained; no retroactive Phase 5 change needed; clearer dependency.
    - Cons: Slight duplication if Phase 5 pipeline tests also need an `initSolver` helper; the spec's re-export chain claim is wrong and must be corrected.
  - **Option C — Pipeline fixtures file is updated by Phase 7 T7.1.1 itself**: T7.1.1 adds `initSolver`/`feaOpts`/`CS` exports to `tests/pipeline/_fixtures.js` as part of its own work, and adds `tests/pipeline/_fixtures.js` to its "Files to modify" list.
    - Pros: No spec change to Phase 5; Phase 7 is self-contained.
    - Cons: T7.1.1 currently has "Files to modify: none" — adding `tests/pipeline/_fixtures.js` requires an update to both the spec and the manifest (file locality / group assignment).

---

#### D2 — `meshArkkioTorque` denominator inconsistency: `(r_ms − r_mr)` vs `(r_ms − r_stator_bore)` (major)

- **Location**: Phase 7 §T7.1.1 `_fixtures.js` — `meshArkkioTorque` helper description, return statement; and D3 "Three-way cross-method" prose.
- **Problem**: The D3 locked-decision prose says: "integrates `B_r·B_t·r·area` over the stator-body air-collar elements … scaled by `ell / (μ0·(r_ms − r_stator_bore))`." But the `meshArkkioTorque` code spec in T7.1.1 says: `Return T = ell / (mu0 · (r_ms − r_mr)) · Σ`. The denominator `(r_ms − r_mr)` equals the full unmeshed-gap annulus width (stator gap radius minus rotor gap radius), while `(r_ms − r_stator_bore)` equals the stator air-collar thickness only. These are different values: `r_mr` ≈ `r_rotor_surface + 0.25·g` (a small offset into the gap), whereas `r_stator_bore` is the inner surface of the stator iron — a significantly larger radius. The Arkkio method's volume integral is normalised by the thickness of the radial band being integrated, which here is the stator air-collar `(r_ms − r_stator_bore)` per the D3 description, not the full gap width `(r_ms − r_mr)`. Using the wrong denominator will scale the torque by a factor `(r_stator_bore − r_mr) / (r_stator_bore − r_stator_bore)` — wait, both give positive values, but the ratio `(r_ms − r_stator_bore) / (r_ms − r_mr)` will be noticeably less than 1, shifting the Arkkio estimate away from the other two methods and potentially pushing the 2 % agreement bar.
- **Why decision-required**: Both formulas are plausible Arkkio variants (one normalises by the stator collar only, one by the full gap annulus); the correct physics depends on which radial band the integration covers and whether the Arkkio formula's derivation uses the outer-stator-collar radial extent. The T7.1.1 code spec is internally inconsistent with D3; which is the author's intent requires a decision.
- **Options**:
  - **Option A — Use `(r_ms − r_mr)` (the code-spec version)**: Accept the code spec as authoritative; update D3's prose from "`ell / (μ0·(r_ms − r_stator_bore))`" to "`ell / (μ0·(r_ms − r_mr))`". Integration band spans `[r_mr, r_ms]` (full gap annulus).
    - Pros: Consistent with the code spec; the Arkkio integral over the full gap annulus with that denominator is the standard textbook form.
    - Cons: Requires correcting D3 prose.
  - **Option B — Use `(r_ms − r_stator_bore)` (the D3-prose version)**: Fix the code spec's return line to `T = ell / (mu0 · (r_ms − r_stator_bore)) · Σ`, and update the `opts` description to expose `r_stator_bore` as an explicit argument (or derive it from the inner radius of stator iron elements). Also fix step 3's filter `r_c < r_mr` to `r_c < r_stator_bore` to match the collar-only band.
    - Pros: Consistent with D3 prose; physically the stator-collar-only form avoids including rotor-collar elements in the stator sum.
    - Cons: Requires passing/computing `r_stator_bore`; more complex helper signature.

---

#### D3 — `stack.slices[0]` API not guaranteed by the `MotorStack` contract (major)

- **Location**: Phase 7 §T7.2.1 "Tests" — `"saturated cogging amplitude is Richardson-convergent to < 5%"` test body: `amp_r = coggingAmpAt(stack.slices[0], poles=4, slots=12, N=8)`; and `"Newton guards"` test: `slice = LIB.MotorSlice.create(...)`.
- **Problem**: The spec uses `stack.slices[0]` to extract the first slice object from a `MotorStack` for passing to `coggingAmpAt`. The Phase 5 spec describes the `MotorStack` contract (`solve`, `extractCoeffs`, `coenergyTorque`, `sliceMesh`) but does not mention a `.slices[]` array accessor. Phase 5 T5.3.1 references `stack.slices[0]` only in the context of `tests/pipeline/agnostic-pipeline.test.js` without specifying that `MotorStack` exposes this as a public property. If Phase 5's implementation uses a private array not intended for external access, T7.2.1 will fail with `TypeError: Cannot read properties of undefined`. The `"Newton guards"` test does create its own `LIB.MotorSlice.create(...)` directly — which is fine — but `coggingAmpAt` is documented as taking a `slice` parameter and calling `slice.coggingTorque(θ)`, so T7.2.1's first test must provide a slice object, and `stack.slices[0]` is the only mechanism shown.
- **Why decision-required**: Whether `.slices[]` is a public API or internal state of `MotorStack` requires a design decision. Adding it to the public contract affects Phase 5.
- **Options**:
  - **Option A — Declare `.slices[]` as part of the `MotorStack` public API**: Add to Phase 5 spec an explicit statement that `MotorStack.create(...)` returns an object with a `.slices` array of `MotorSlice` instances (one per slice). Update T7.2.1 to note its dependence on this.
    - Pros: Avoids building a `LIB.MotorSlice.create` call just to get a slice in T7.2.1; `stack.slices[0]` is the simplest consumer API.
    - Cons: Requires Phase 5 spec change; exposes internal state as API surface.
  - **Option B — Replace `stack.slices[0]` with an explicit `LIB.MotorSlice.create` call**: In T7.2.1's first test, build the slice directly via `LIB.MotorSlice.create(CS.expand(cfg).slices[0].section, feaOpts({...}))` rather than accessing `stack.slices[0]`. Update `coggingAmpAt`'s documentation to accept a `MotorSlice` instance.
    - Pros: Self-contained; no Phase 5 API change; parallel to what the "Newton guards" test already does.
    - Cons: Builds two separate slice instances at the same refinement level (one for amplitude, one for Newton guards), doubling FEA mesh construction cost in the test; must ensure both use identical refinement opts.

---

#### D4 — `tests/fea-engine/_fixtures.js` is in group `7.1.b` with T7.1.1, but T7.2.1 (group `7.2.a`) reads `saturatedPmConfig` from it — is file locality respected? (major)

- **Location**: Phase 7 §Files Owned (created) + manifest groups `7.1.b` / `7.2.a`; §T7.2.1 "Files to create" `saturated-cogging.test.js`.
- **Problem**: `tests/fea-engine/_fixtures.js` is created by T7.1.1 (group `7.1.b`). T7.2.1 (group `7.2.a`, Wave 7.2) reads from that file via `const { saturatedPmConfig, coggingAmpAt, initSolver } = require("./_fixtures.js")` (implied). The manifest puts T7.2.1 in a separate group `7.2.a`. The file locality rule states: "if two tasks share any file in their Files-to-create/modify lists … they MUST be in the same manifest group." T7.1.1 **creates** `tests/fea-engine/_fixtures.js`; T7.2.1 is described as having "Files to modify: none" and only creating `tests/fea-engine/saturated-cogging.test.js`. Since T7.2.1 only **reads** (not writes) `_fixtures.js`, the file locality rule (which is about write-lock contention) is technically not triggered — T7.2.1 doesn't modify `_fixtures.js`. However, this depends critically on whether Wave 7.2 is allowed to run while Wave 7.1 is still in progress. Waves 7.1 and 7.2 are sequential (7.2 runs after 7.1 per the wave structure), so T7.2.1 cannot start until T7.1.1 has completed and `_fixtures.js` exists. The sequential wave ordering resolves the dependency. This is not a file-locality violation, but an implementability concern: T7.2.1's spec does not explicitly state that it requires `_fixtures.js` to be present (created by T7.1.1). If an implementer reads T7.2.1 in isolation they will not know where `saturatedPmConfig`, `coggingAmpAt`, etc. come from.
- **Why decision-required**: Should T7.2.1 explicitly state its dependency on `tests/fea-engine/_fixtures.js` (and therefore on T7.1.1)? Adding it would improve implementability but changes the spec text.
- **Options**:
  - **Option A — Add explicit dependency statement to T7.2.1**: Add a sentence to T7.2.1's description: "Requires `tests/fea-engine/_fixtures.js` (created by T7.1.1); this task cannot be implemented before Wave 7.1 completes."
    - Pros: Self-contained spec; implementer knows exactly what to import; removes ambiguity.
    - Cons: Minor spec edit; wave ordering already implies this.
  - **Option B — Leave as-is, rely on wave ordering**: The wave structure already guarantees T7.2.1 runs after T7.1.1. No spec change needed.
    - Pros: No change.
    - Cons: An implementer reading T7.2.1 in isolation cannot determine what imports are available without reading all prior tasks.

---

#### D5 — `coenergyTorque` method not specified in Phase 5's `MotorStack` contract (major)

- **Location**: Phase 7 §T7.1.1 `cross-method.test.js` — `"pmsm: harmonic vs mesh-Arkkio vs co-energy agree within 2%"`: `T_coe = stack.coenergyTorque(θ, currents).total`.
- **Problem**: The Phase 5 spec defines the `MotorSlice` contract as `solve / extractCoeffs / coggingTorque / clearWarmStart / nCircuits`. The plan's Phase 5 section references `stack.coenergyTorque(θ, currents).total` as a cross-check method. However, neither Phase 5's task descriptions nor Phase 7's spec defines the `coenergyTorque` method's signature, return structure, or implementation. The existing `tests/machines/_fixtures.js` `crossCheck` function calls `stackLin.coenergyTorque(theta, currents).total`, indicating this method exists on the old grid-based `MotorStack`. Phase 7's spec uses it without verifying whether Phase 5's FEA-based `MotorStack` will implement it. If Phase 5 does not implement `coenergyTorque`, the cross-method test will throw.
- **Why decision-required**: Whether `coenergyTorque` is part of the rebuilt `MotorStack` contract (Phase 5 responsibility) or needs to be implemented within Phase 7 (as a helper on top of `extractCoeffs`) requires a decision. The Phase 5 spec should be explicit about this, and if it already covers it implicitly, Phase 7 should reference that explicitly.
- **Options**:
  - **Option A — Declare `coenergyTorque` as a Phase 5 MotorStack contract method**: Update Phase 5 spec (or note in Phase 7) that `MotorStack` must expose `coenergyTorque(θ, currents) → { total }` computing `−(1/2)·i²·dL/dθ + i·dλpm/dθ` from `extractCoeffs`. Phase 7 can then use it without re-implementing.
    - Pros: Clean API; matches existing machine-test usage; Phase 7 spec is then accurate as written.
    - Cons: Requires Phase 5 spec amendment.
  - **Option B — Phase 7 implements `coenergyTorque` as a local helper**: Define a `coenergyTorque(stack, θ, currents)` helper inside `tests/fea-engine/_fixtures.js` that calls `stack.extractCoeffs(θ)` and computes the co-energy torque from the returned `L, dLdth, lambdaPm, dLambdaPmdth`. Remove the `stack.coenergyTorque(...)` call from the cross-method test.
    - Pros: Phase 7 is self-contained; no Phase 5 change needed.
    - Cons: Duplicates logic that `MotorStack` probably already has; `tests/fea-engine/_fixtures.js` grows.

---

#### D6 — `synchronous-reluctance.test.js` missing from T7.1.2 "Files to modify" list (minor)

- **Location**: Phase 7 §T7.1.2 "Files to modify" list vs "Affected references".
- **Problem**: The "Affected references" section enumerates `tests/machines/synchronous-reluctance.test.js:9` as one of the four import re-point locations (`fitCos2Cos4` → `../_assert.js`). The spec's **Files Owned** section under "Modified" also lists `tests/machines/synchronous-reluctance.test.js`. However, the T7.1.2 "Files to modify" bullet list reads: `tests/machines/_fixtures.js`, `tests/machines/synchronous-reluctance.test.js`, `tests/machines/switched-reluctance.test.js`, `tests/machines/vr-stepper.test.js`, `tests/machines/wound-field-synchronous.test.js` — confirming it IS listed. On re-examination this is correctly included. *(Withdrawn — the file is listed correctly.)*

*(D6 withdrawn after re-read — the file is present in the Files to modify list.)*

---

#### D6 — `no-load back-EMF test` uses numerical central difference to verify `dLambdaPmdth` — potential circular validation (minor)

- **Location**: Phase 7 §T7.1.1 `analytic.test.js` — `"no-load back-EMF matches dλpm/dθ · ω within 1%"` test body.
- **Problem**: The test asserts that the numeric central difference of `λpm` (computed from successive `extractCoeffs` calls at adjacent angles) agrees with `dLambdaPmdth` (returned by `extractCoeffs` at the middle angle). Both `λpm` and `dLambdaPmdth` come from the **same** Phase 5 `extractCoeffs` implementation — the numeric difference is computed from `λpm` values from `extractCoeffs`, and the analytic derivative is also from `extractCoeffs`. This is not a cross-check against an independent analytic reference (e.g., a known PM flux linkage formula); it is a self-consistency check of `extractCoeffs`'s own output. The plan's validation criterion ("no-load back-EMF < 1%") implies comparing against a physical/analytic reference, not against a finite-difference approximation of the same output. The test name says "no-load back-EMF matches `dλpm/dθ · ω`" but no `ω` appears and no actual back-EMF is computed — the test only checks that `extractCoeffs` returns a consistent `λpm` and `dLambdaPmdth`.
- **Why decision-required**: The plan's "no-load back-EMF vs `dλpm/dθ·ω` < 1%" criterion could be satisfied by (a) the self-consistency test as written, or (b) comparing a computed back-EMF against an analytic formula (e.g., `E = N·Φ_peak·ω` from geometry). Option (a) tests only internal consistency, not physics correctness. Option (b) would genuinely validate the FEA field strength.
- **Options**:
  - **Option A — Keep the self-consistency test as written**: Accept that the test validates internal consistency of `extractCoeffs`. Add a comment clarifying that this is a consistency check, not an analytic cross-check.
    - Pros: No change to the test logic; simpler.
    - Cons: Does not validate that the FEA produces the correct physical back-EMF; the plan's intent ("analytic refs") may be unmet.
  - **Option B — Replace with a genuine analytic cross-check**: Compute the peak no-load flux linkage from the slotless PM config's geometry (`Φ = Br · g_m / (g_m + g) · R · ell · 2/p · sin(π/p)` approximately) and compare to `max(λpm)` from an angular sweep. Use ω = 1 rad/s to express `E = dλpm/dθ · ω` in testable units.
    - Pros: Genuinely validates FEA physics against analytic expectation; stronger test.
    - Cons: Requires computing the analytic formula and adding it to the fixture; more complexity in the spec.

---

## Files Owned — Audit

Computing the union of all task Files to create/modify:

**T7.1.1 creates:**
- `tests/fea-engine/_fixtures.js`
- `tests/fea-engine/convergence.test.js`
- `tests/fea-engine/analytic.test.js`
- `tests/fea-engine/cross-method.test.js`
- `tests/fea-engine/known-machine.test.js`

**T7.1.2 creates:**
- `scripts/phase7-repoint.mjs`

**T7.1.2 modifies:**
- `tests/machines/_fixtures.js`
- `tests/machines/synchronous-reluctance.test.js`
- `tests/machines/switched-reluctance.test.js`
- `tests/machines/vr-stepper.test.js`
- `tests/machines/wound-field-synchronous.test.js`

**T7.2.1 creates:**
- `tests/fea-engine/saturated-cogging.test.js`

**Files Owned section declares:**

Created: `tests/fea-engine/_fixtures.js`, `tests/fea-engine/convergence.test.js`, `tests/fea-engine/analytic.test.js`, `tests/fea-engine/cross-method.test.js`, `tests/fea-engine/known-machine.test.js`, `tests/fea-engine/saturated-cogging.test.js`.

Modified: `tests/machines/_fixtures.js`, `tests/machines/synchronous-reluctance.test.js`, `tests/machines/switched-reluctance.test.js`, `tests/machines/vr-stepper.test.js`, `tests/machines/wound-field-synchronous.test.js`.

**Missing from Files Owned**: `scripts/phase7-repoint.mjs` — this file is created by T7.1.2 but does not appear in the Files Owned section. This is a **major** finding (file used by a task but absent from Files Owned).

| Finding | Severity |
|---------|----------|
| `scripts/phase7-repoint.mjs` missing from Files Owned "Created" list | major |

---

## Task Groups Validity

Phase 7 manifest entry:

```
Wave 7.1:
  Group 7.1.a: [T7.1.2 (M)]   user_required_tasks: []
  Group 7.1.b: [T7.1.1 (L)]   user_required_tasks: []

Wave 7.2:
  Group 7.2.a: [T7.2.1 (M)]   user_required_tasks: []
```

**Assignment check:**
- T7.1.1 → group 7.1.b ✓
- T7.1.2 → group 7.1.a ✓
- T7.2.1 → group 7.2.a ✓
- Every task in exactly one group ✓
- All manifest task IDs match spec task IDs ✓

**Complexity values:** T7.1.2 = M ✓, T7.1.1 = L ✓, T7.2.1 = M ✓

**File cap check (≤ 10 files per group):**

Group 7.1.a (T7.1.2): Creates `scripts/phase7-repoint.mjs`; modifies 5 machine test files. Union = 6 files. ✓

Group 7.1.b (T7.1.1): Creates 5 `tests/fea-engine/*.{js,test.js}` files. Union = 5 files. ✓

Group 7.2.a (T7.2.1): Creates 1 file `tests/fea-engine/saturated-cogging.test.js`. Union = 1 file. ✓

**File locality check:**
- No file appears in more than one group's create/modify set. ✓
- `tests/fea-engine/_fixtures.js` is created by T7.1.1 (7.1.b) and read (not written) by T7.2.1 (7.2.a). Read-only access does not trigger the file-locality write-lock rule. ✓

**User-required tasks check:**
- Neither T7.1.1 nor T7.1.2 nor T7.2.1 contain any text requiring a real-world user action (no browser pass, no external deployment, no manual ack). All `user_required_tasks: []` are correct. ✓

**Note**: The file-cap check above for group 7.1.a was computed using the task's actual file footprint including `scripts/phase7-repoint.mjs`. The Files Owned section omits this file (the major finding above), but the manifest cap itself is unaffected (6 ≤ 10). ✓

---

## Summary of All Findings

| ID | Type | Severity | Location | Short Description |
|----|------|----------|----------|-------------------|
| D1 | Decision-Required | critical | §T7.1.1 `_fixtures.js` imports | `tests/pipeline/_fixtures.js` does not export `initSolver`, `feaOpts`, or `CS`; T7.1.1 depends on these non-existent exports |
| D2 | Decision-Required | major | §T7.1.1 `meshArkkioTorque` return + D3 prose | Denominator `(r_ms − r_mr)` in code contradicts `(r_ms − r_stator_bore)` in D3 prose |
| D3 | Decision-Required | major | §T7.2.1 tests | `stack.slices[0]` used to obtain a slice but `MotorStack` public API does not guarantee `.slices[]` array accessor |
| D4 | Decision-Required | major | §T7.2.1 description | T7.2.1's dependency on `tests/fea-engine/_fixtures.js` (created by T7.1.1) is implicit; implementer reading in isolation cannot determine imports |
| D5 | Decision-Required | major | §T7.1.1 `cross-method.test.js` | `stack.coenergyTorque(θ, currents).total` used but not declared in Phase 5 `MotorStack` contract |
| Files Owned | Mechanical | major | §Files Owned "Created" list | `scripts/phase7-repoint.mjs` created by T7.1.2 is absent from the Files Owned section |
| D6 | Decision-Required | minor | §T7.1.1 `analytic.test.js` | Back-EMF test is a self-consistency check of `extractCoeffs` rather than a cross-check against an independent analytic reference |
| M1 | Mechanical | minor | §T7.1.2 D9 / WFS un-skip | Line range "(line 44–48)" for the byte-identical test body is inaccurate; actual body is lines 45–50 |
| Info-1 | — | info | §T7.1.1 `known-machine.test.js` | The `"vr-stepper reluctance torque ∝ i² ratio 4.0 ± 0.2"` test runs with `saturation: { enabled: false }` (linear mode), which is consistent with the "below knee" claim. However the tolerance is stated as `± 0.2` in T7.1.1 but the existing `switched-reluctance.test.js` uses `0.05 * 4 = 0.2` — same tolerance, just expressed differently. No error but worth confirming consistent expression. |
| Info-2 | — | info | §D7 locked decision | D7 says stale `FIX N` comments are out of scope. The existing `switched-reluctance.test.js:77` contains `// FIX 8 trim` — this is left by design per D7. No action needed but documented for traceability. |
