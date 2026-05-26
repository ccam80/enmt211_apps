# Spec Review: Phase 5 — FEA slice (the new MotorSlice)

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 1 | 1 |
| minor    | 0 | 4 | 4 |
| info     | 0 | 2 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 5.1.1 — FEM assembly + Brauer Newton (static rotor) | yes | Mapped to T5.1.1; all §11.3 guards (≤ 8 iters, tol < 1e-6, residual < 1e-9) present |
| 5.2.1 — solve / torque / flux-linkage / mesh-native field | yes | Mapped to T5.2.1; D3 field shape fully specified; coggingTorque zero-not-skip present |
| 5.3.1 — extractCoeffs + stack/run reconnection + pipeline re-green + perf diagnostic | yes | Mapped to T5.3.1; sliceGrid→sliceMesh rename, opts.poles passthrough, §11.4 escalation gate all present |
| Verification: MotorSlice contract honored | yes | T5.2.1 contract.test.js covers all five public methods |
| Verification: MotorStack/MotorRun drive it after sliceMesh rename | yes | T5.3.1 re-greens motor-stack.test.js and agnostic-pipeline.test.js |
| Verification: static-rotor convergence (avg torque < 1 %, cogging < 2 % between refinements) | yes | T5.2.1 convergence.test.js with refine ∈ {1.0, √2, 2.0} |
| Verification: Newton guards (§11.3) | yes | T5.1.1 newton.test.js |
| Verification: field↔circuit bridge preserved formula-for-formula | yes | T5.3.1; bridge formula spelled out in the spec's §"Field ↔ circuit bridge" section |
| Verification: mesh-native field return {rotor,stator,gap} | yes | D3 fully pinned; T5.2.1 contract.test.js shape assertions |
| Verification: embed-vs-Schur diagnostic logged | yes | T5.3.1 perf.test.js; §11.4 Clarification Exit path explicit |

## Findings

### Mechanical Fixes

None found.

### Decision-Required Items

#### D1 — `_internals` inventory in T5.1.1 is missing functions that later tests require (major)

- **Location**: phase-5 §Wave 5.1 Task T5.1.1 "Files to create" — `lib/motor-slice.js` internals hatch description; and §Wave 5.2 Task T5.2.1 Tests; and §Wave 5.3 Task T5.3.1 Tests

- **Problem**: T5.1.1 defines the `_internals` object exposed under `slice.__internals` as exactly:
  ```
  _internals = { prepare, assembleInteriorPatternAndValues,
    assembleInteriorMagnetLoadAndJz, brauerNu, newtonSolve,
    eliminateOuterStatorPin, remapGapTriplets, globalLayout }
  ```
  However, tests in later waves reference internals keys that are NOT in this list:

  1. **`assembleCombinedTriplets`** — referenced in two T5.1.1 assembly tests:
     `"combined pattern is symmetric"` and `"combined pattern is φ-invariant"` both call
     `_internals.assembleCombinedTriplets(section, opts, φ)`. This function does not appear
     in the declared `_internals` list at all. An implementer following the list will not
     expose it.

  2. **`bodies`** — `tests/slice/contract.test.js` asserts
     `r.field.rotor.mesh === slice.__internals.bodies.rotor`. `bodies` is not in the
     `_internals` list.

  3. **`solveStaticRotor`** — `tests/slice/newton.test.js` calls
     `_internals.solveStaticRotor(thetaR=0, currents)` in four tests. Not in the
     `_internals` list.

  4. **`K`** — `tests/slice/contract.test.js` asserts
     `r.field.gap.harmonics.rotor.a.length === slice.__internals.K + 1`. `K` is not in
     the `_internals` list.

  5. **`solverSat` / `solverLin`** — `tests/slice/contract.test.js` asserts
     `slice.__internals.solverSat !== slice.__internals.solverLin` and calls
     `slice.__internals.solverSat.factorNnz()`. Neither name appears in the `_internals`
     list.

  6. **`derivedSlots` / `derivedPoles`** — T5.3.1 description says "expose
     `slice.__internals.derivedSlots`/`derivedPoles` for the tests" but neither is in
     the T5.1.1 `_internals` list and no specific test assertion uses them (the description
     says "for the tests" without a named test).

  An implementer who follows only the declared `_internals` list will build an accessor
  that omits all of these. The wave-5.2 and wave-5.3 test files will then fail to compile
  or run meaningful assertions.

- **Why decision-required**: The spec author must decide whether to extend the T5.1.1
  `_internals` list to enumerate all these additional keys, or whether to restructure the
  internals into a different hatch shape. Different implementers would make different
  choices about which internal name corresponds to which concept (e.g., is
  `solveStaticRotor` a separate helper or part of `prepare`'s return? Is `bodies` a direct
  reference to the prepare-time build result?). There is no single unambiguous fix.

- **Options**:
  - **Option A — Extend the `_internals` list in T5.1.1 to enumerate all missing keys**:
    Replace the current `_internals = { ... }` declaration with a complete list including
    `assembleCombinedTriplets`, `bodies`, `solveStaticRotor`, `K`, `solverSat`, `solverLin`,
    `derivedSlots`, `derivedPoles`, and add brief descriptions for each (what they accept,
    what they return). Also specify where `assembleCombinedTriplets` is added relative to
    the existing `prepare` function (is it a sub-step extracted from `prepare`?).
    - Pros: The `_internals` inventory is the single authoritative list an implementer
      consults. Extending it keeps the contract in one place and removes all ambiguity.
    - Cons: The T5.1.1 task description becomes longer; requires the spec author to decide
      on precise signatures for each missing item (especially `solveStaticRotor` and
      `assembleCombinedTriplets`).

  - **Option B — Remove the closed enumeration from T5.1.1 and replace with a rule**:
    Instead of `_internals = { prepare, …, globalLayout }`, state: "expose every internal
    function and named value the Phase-5 tests reference under `slice.__internals`; the
    exhaustive list is derived from the test bodies below (Waves 5.1–5.3)." Then remove
    the enumeration entirely from T5.1.1.
    - Pros: Avoids the spec author needing to enumerate every internal up front; the tests
      themselves become the authoritative list.
    - Cons: The implementer must scan all three waves' test files to discover the full
      set — this is mild discovery phrasing inside the spec task. Also loses the
      explicitness of "these internals and no others are test-visible."

  - **Option C — Keep the T5.1.1 list closed but add a "Test-only internals addendum"
    subsection** that enumerates the additional keys introduced as the waves progressed
    (bodies, solveStaticRotor, K, solverSat, solverLin, assembleCombinedTriplets,
    derivedSlots, derivedPoles), each with a one-line signature:
    - Pros: T5.1.1 stays as written (minimal churn); a clearly marked addendum gives
      implementers the remainder without requiring them to infer it from test bodies.
    - Cons: Two places define `_internals` content; a future edit could leave them
      inconsistent.

---

#### D2 — `θ_e` undefined in the harmonic torque sign-check test (minor)

- **Location**: phase-5 §Wave 5.2 Task T5.2.1 Tests — `tests/slice/contract.test.js`,
  test `"harmonic torque sign convention matches motor convention"`

- **Problem**: The test asserts "the sign matches the sign of `−sin(2·θ_e)` (reluctance
  machines pull toward alignment)." `θ_e` is the electrical angle, but the test fixture
  is `salientConfig` whose pole count is not stated in the Phase-5 spec. The implementer
  must look up the `salientConfig` fixture (in `lessons/unified_motor/machines/`) to learn
  its pole count in order to know `θ_e = (poles/2) · thetaR`. The spec does not provide
  `poles` for `salientConfig` in this context.

- **Why decision-required**: The relationship `θ_e = (poles/2) · thetaR` is not spelled
  out, and different salient fixture pole counts would require different `thetaR` values
  to sit between aligned and unaligned. The spec says `θ = π/8` — whether that is
  electrical or mechanical angle matters for the sign assertion.

- **Options**:
  - **Option A — Add a sentence specifying `θ_e` for the test**: Add "For `salientConfig`
    (`poles = P`), `θ_e = (P/2) · θ_mech`; pick `thetaR = π/8 · (2/P)` so that `θ_e =
    π/8` falls between aligned and unaligned." (The spec author fills in `P` from the
    fixture.) This makes the assertion self-contained.
    - Pros: Implementer needs no external lookup. The sign assertion is unambiguous.
    - Cons: The spec must look up and hard-code the fixture's pole count.

  - **Option B — Change `salientConfig` to a synthetic 2-pole salient section built
    inline**: Replace the test's fixture reference with a hand-constructed 2-pole
    salient section where `θ_e = θ_mech` by definition, making `−sin(2·θ)` directly
    evaluable from `thetaR = π/8`.
    - Pros: Completely self-contained; no fixture lookup.
    - Cons: More setup code in the test; the synthetic section may differ subtly from
      the production fixture.

  - **Option C — Relax the assertion to "torque is non-zero at θ = π/8 and `torque(π/8)
    · torque(0)` have opposite sign"**: This requires only that the reluctance torque
    changes sign across the aligned position, which is pole-count-independent.
    - Pros: The assertion is always correct regardless of `salientConfig`'s pole count.
    - Cons: Weaker — doesn't verify the sign convention explicitly, only that the torque
      is non-trivial.

---

#### D3 — `r1` referent ambiguous in the `"N=2 zero-offset sums torque"` motor-stack test (minor)

- **Location**: phase-5 §Wave 5.3 Task T5.3.1 "Files to modify" — `tests/pipeline/motor-stack.test.js`
  rewrite, item 4 bullet `"N=2 zero-offset sums torque and flux"`.

- **Problem**: The test asserts "`r2.torque ≈ 2·r1.torque` within `1e-9`" and
  "`r2.fluxLinkages[0] ≈ 2·r1.fluxLinkages[0]` within `1e-9`." `r2` is the N=2 result,
  but `r1` is not defined in this test's body. The preceding bullet (`"N=1 stack equals
  its single slice"`) uses the variable name `r1` but it is in a different `it(...)` block
  and therefore out of scope. An implementer must guess whether to re-run the N=1 stack
  or a fresh single slice.

- **Why decision-required**: Two reasonable interpretations exist: (a) `r1` is a
  `woundConfig` N=1 stack solve result computed inline in this test's `it(...)` body,
  or (b) `r1` is a single-slice direct `MotorSlice.solve` result. The tolerance `1e-9`
  relative is tight enough that the wrong interpretation would produce test failures.

- **Options**:
  - **Option A — Define `r1` explicitly in the test bullet**: Replace "`r2.torque ≈
    2·r1.torque`" with "`r2.torque ≈ 2 · (N=1 stack solve result at the same θ and
    currents, computed inline in this test body)`" and specify the variable name.
    - Pros: No ambiguity; implementer knows exactly where `r1` comes from.
    - Cons: Slightly more verbose.

  - **Option B — Express the N=2 zero-offset assertion without referencing `r1`**: Change
    the assertion to "both slices have equal torque contributions: sum equals `2 ·
    slice[0].solve(0.2, [5]).torque` (where `slice[0]` is the stack's first slice built
    directly)."
    - Pros: Completely self-contained.
    - Cons: Requires accessing the stack's internal slice objects directly, which may
      or may not be exposed.

---

#### D4 — "compute the equivalent two extra solves manually" in the `derivStep` test is vague (minor)

- **Location**: phase-5 §Wave 5.3 Task T5.3.1 Tests — `tests/slice/extract.test.js`,
  test `"derivStep override is honored"`

- **Problem**: The test says: "call `extractCoeffs(0.3, { derivStep: Math.PI/360 })`; compute
  the equivalent two extra solves at θ=0.3±π/360 manually and assert `dLdth` matches."
  The phrase "compute the equivalent two extra solves manually" does not specify what
  "manually" means — does it mean calling `extractCoeffs(0.3 + Math.PI/360)` and
  `extractCoeffs(0.3 - Math.PI/360)` separately and reading their `.L` matrices, or
  calling `slice._internals.solveStaticRotor(...)` directly, or something else?

- **Why decision-required**: `extractCoeffs` returns the center-angle `L`, not the raw
  per-angle `L` at the probe angles. Reproducing `dLdth` manually requires either (a)
  calling `extractCoeffs` at offset angles and recovering `L` from them (but the returned
  `L` is already the center value), or (b) driving the linear solver at the two probe
  angles directly. These are meaningfully different implementations of "manually."

- **Options**:
  - **Option A — Specify that "manually" means two additional `extractCoeffs` calls at
    the shifted centers**: "Call `extractCoeffs(0.3 + Math.PI/360)` and `extractCoeffs(0.3
    − Math.PI/360)` with the default `derivStep`; compute `(L_plus − L_minus) / (2 ·
    Math.PI/360)` from the two `L` center values and compare to `coeffs.dLdth`."
    - Pros: Fully self-contained using the public API; no internal access required.
    - Cons: The "manual" check uses a different derivStep (the default π/180) for the
      outer calls, introducing a mismatch — it would only be a true cross-check if those
      outer calls also use π/360.

  - **Option B — Specify that "manually" means calling `extractCoeffs` at the same base
    angle with a very small `derivStep` and comparing the resulting `dLdth`**: This
    simplifies the test to "assert `dLdth` from `derivStep=π/360` call agrees with
    `dLdth` from `derivStep=π/180` call within some tolerance on a smooth-enough operating
    point (e.g., `< 1e-4` relative on a salientConfig at θ=0.3)." Weaker but unambiguous.
    - Pros: No "manual" solve needed; uses only the public API.
    - Cons: Looser — tests only that derivStep doesn't change the answer drastically, not
      that it is used correctly.

  - **Option C — Remove this test and subsume its intent into the `dLdth from extract
    matches central-difference` test** (which already tests the derivStep=π/180 default
    path): The `derivStep` override is then verified by the implementation contract only,
    not by a test assertion.
    - Pros: Removes ambiguity entirely; the existing test already validates the central-
      difference construction.
    - Cons: No test coverage of the `derivStep` override parameter.

---

#### D5 — Production behavior of `create` when called before `LIB.FeaSolver.init()` resolves is unspecified (info)

- **Location**: phase-5 §Wave 5.1 Task T5.1.1 "Files to create" — `lib/motor-slice.js`,
  prepare discussion paragraph: "the slice's `create` contract is sync, so the wrapper
  awaits `init` lazily on first `solve` via a cached promise; the tests await
  `LIB.FeaSolver.init()` themselves before calling `create`."

- **Problem**: The spec specifies what tests must do (await `init` before `create`) but
  does not define what `create` or `solve` do if called before `init` resolves.
  "Awaits `init` lazily on first `solve` via a cached promise" implies `solve` is
  asynchronous or blocks until init completes, but the `MotorSlice` contract section
  declares `solve(thetaR, currents) → { torque, fluxLinkages, field }` as a synchronous
  call. These are in tension.

- **Why decision-required**: Two interpretations: (a) `solve` returns a Promise when init
  is pending (breaking the sync contract), or (b) `solve` throws synchronously if `init`
  has not yet completed (a guard). Neither is stated. The implementer cannot resolve this
  without a decision.

- **Options**:
  - **Option A — Specify that `create` throws (or returns `null`) if called before `init`
    has resolved**: Add to T5.1.1: "`create` asserts `LIB.FeaSolver._ready === true`
    (or equivalent cached promise state) and throws `Error('FeaSolver not initialized;
    await LIB.FeaSolver.init() first')` if called early. This preserves the synchronous
    contract for `solve`."
    - Pros: Synchronous contract preserved end-to-end; production misuse is caught early
      with a clear error.
    - Cons: Caller must always await `init` before calling `create`; the cached-promise
      description implies lazy init was intended.

  - **Option B — Specify that `solve` is async when `init` is pending, resolving after
    init completes**: Update the MotorSlice contract section to declare `solve` as
    returning either `{ torque, … }` synchronously (after init) or a `Promise<{ torque,
    … }>` (before init). Update the test fixture's `initSolver()` helper description to
    clarify this is a convenience, not a requirement.
    - Pros: Lazy-init works; callers can call `create` early and `solve` later.
    - Cons: Breaking change to the "preserved unchanged contract" framing — the original
      MotorSlice contract was synchronous and `MotorStack` is not written to handle a
      Promise from `solve`.

---

#### D6 — Technically discovery-phrased conditional in agnostic-pipeline edit, immediately resolved (info)

- **Location**: phase-5 §Wave 5.3 Task T5.3.1 "Files to modify" — `tests/pipeline/agnostic-pipeline.test.js`
  edit point 4: "extend the `CARVE_OUTS` set ONLY if the agnosticism audit Phase-8
  allow-list (per `spec/plan.md` Phase 8) so dictates"

- **Problem**: The phrase "ONLY if...so dictates" is technically discovery phrasing — it
  requires the implementer to consult Phase 8's spec to determine the action. The sentence
  immediately resolves it by stating the concrete answer ("CARVE_OUTS stays exactly:
  `{ "app.js", "registry.js", "header-buttons.js", "stepper-drive.js", "three-phase.js" }`"),
  but the conditional clause still requires the implementer to understand the dependency
  relationship to trust the stated answer.

- **Why decision-required**: The concrete answer is given and is almost certainly correct;
  the issue is that a future Phase-5 edit that adds a new `lib/` file with a machine name
  would require the implementer to reason about Phase 8 again. The residual discovery risk
  is low, but it exists.

- **Options**:
  - **Option A — Delete the conditional clause entirely**: Replace "extend the `CARVE_OUTS`
    set ONLY if the agnosticism audit Phase-8 allow-list (per `spec/plan.md` Phase 8) so
    dictates; since no new lib file introduces a machine name...CARVE_OUTS stays exactly:
    `{...}`" with simply "`CARVE_OUTS` stays exactly: `{...}`; do not add any entry."
    - Pros: Eliminates discovery phrasing entirely; the concrete answer stands alone.
    - Cons: Loses the rationale for why CARVE_OUTS doesn't grow here.

  - **Option B — Keep as-is with a note**: Add parenthetically "(This determination is
    already made: no new file in Phase 5 introduces a machine name; no further lookup
    required.)"
    - Pros: Preserves the rationale while neutralizing the discovery phrasing.
    - Cons: Slightly more text; still contains the conditional, just clarified.
