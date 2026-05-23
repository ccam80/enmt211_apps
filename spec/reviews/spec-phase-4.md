# Spec Review: Phase 4 — circuit-ode

## Verdict: ready

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 1 | 0 | 1 |
| info     | 0 | 1 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 4.1.1 `motor-circuit.js`: implicit current step, L(θ) cache, terminal states | yes | Full API specified: all five public functions, exact signatures, algorithm steps, data-type conventions, and the `solveDense` internal helper |
| 4.2.1 Semi-implicit stability at `dt > L/R` where explicit diverges | yes | `stepper.test.js` "implicit step is stable where explicit diverges" runs 200 steps at `dt = 5e-3 > 2L/R = 2e-3`; explicit reference asserted to exceed `1e3` |
| 4.2.1 Shorted-winding config shows induced current | yes | `induction.test.js` "shorted secondary carries induced (Lenz-opposing) current" asserts `Math.abs(i[1]) > 1e-4` and opposing sign on step 1 |
| 4.2.1 Back-EMF appears under motion | yes | `backemf.test.js` "PM back-EMF appears at zero current under motion" and "backEmf computes ω·(dL/dθ·i + dλpm/dθ)" both cover motional EMF; `extract.test.js` dL/dθ test implicitly validates the field-driven component |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | phase-4 §"Conventions fixed for this phase", test-harness paragraph, sentence beginning "`tests/circuit/_fixtures.js` follows the own-loader pattern" | Text reads "(matching Phases 2 and 4)". Phase 4 is the current spec being written; the parenthetical is self-referential. The plan states "Phase 3 establishes this pattern (`tests/excitation/_fixtures.js`); Phases 2 and 4 follow it" — so from Phase 4's vantage the already-established precedents are Phases 2 and 3. | Replace `(matching Phases 2 and 4)` with `(matching Phases 2 and 3)` |

---

### Decision-Required Items

#### D1 — `buildSalient` return-value shape assumed in `extract.test.js` is not cited (info)
- **Location**: phase-4 §Task 4.2.1, `tests/circuit/extract.test.js`, test `"extract recovers L11(θ) matching the analytic salient inductance"`
- **Problem**: The test calls `f.sweepThetaR(θ).L11` where `f = buildSalient({ ...SALIENT_DEFAULTS, current: 1 })`. The `buildSalient` function and `SALIENT_DEFAULTS` are re-exported read-only from Phase 1's `tests/engine/_fixtures.js`. The Phase-4 spec nowhere defines or cites the return-value shape of `buildSalient` — specifically that `f` exposes a `.sweepThetaR(theta)` method returning an object with an `.L11` field. An implementer assigned Phase 4 in isolation cannot verify this contract from the Phase-4 spec alone.
- **Why decision-required**: There are meaningfully different approaches: add a cross-reference note to Phase 4, rely on Phase 1's spec to fully define the fixture, or restructure the test to avoid the dependency. Each has trade-offs the spec author must weigh.
- **Options**:
  - **Option A — Add a cross-reference note inline**: In the `extract.test.js` description add: "`buildSalient` returns a fixture handle; `f.sweepThetaR(theta)` calls the analytic salient model at rotor angle `theta` and returns `{ L11 }` — the self-inductance from a unit-current field solve. Full fixture shape is defined in Phase 1, Task 1.4.2."
    - Pros: Phase-4 is self-documenting for an implementer without Phase 1 at hand; explicit contract reduces mismatch risk.
    - Cons: Introduces cross-phase prose that may go stale if Phase 1 changes the fixture shape.
  - **Option B — Leave as-is, rely on Phase 1's spec**: Accept that a Phase-4 implementer will have Phase 1's spec available as a stated dependency and will find the fixture shape there.
    - Pros: No duplication; Phase 1 stays the single source of truth for its own fixture API.
    - Cons: If Phase 1's spec is incomplete on this point (it is currently — `tests/engine/_fixtures.js` does not yet exist), the implementer discovers the mismatch only at test runtime.
  - **Option C — Define `sweepThetaR` adapter in `tests/circuit/_fixtures.js`**: Wrap whatever Phase 1 returns into a guaranteed `{ L11 }` shape in the Phase-4 fixture file, making Phase 4 fully self-contained.
    - Pros: No runtime mismatch risk; Phase 4 independent.
    - Cons: Thin adapter layer must be maintained; creates a second call-site for the same Phase-1 function.
