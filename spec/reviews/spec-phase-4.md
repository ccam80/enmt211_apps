# Spec Review: Phase 4 — Harmonic-gap sliding interface

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 0 | 3 | 3 |
| minor    | 1 | 0 | 1 |
| info     | 0 | 1 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 4.1.1 — G0+G1+G2: FFT projection + per-harmonic admittance + static-φ bordered coupling | yes | All three milestones present with detailed test assertions |
| 4.2.1 — G3+G4: rotation phase, torque, truncation tuning | yes | All milestones present; torque formula has a gap (see D3) |
| Plan verification: FFT round-trip < 1e-8 | yes | `projection.test.js` "project/reconstruct round-trips a band-limited field to < 1e-8" |
| Plan verification: static-rotor bordered coupling matches meshed-annulus reference (G2) | yes | `admittance.test.js` "surfaceFlux matches the independently-meshed annulus" + "stamp reproduces surfaceFlux" |
| Plan verification: sparsity pattern is φ-invariant (G3) | yes | `rotation.test.js` "sparsity pattern is φ-invariant" |
| Plan verification: field rotates correctly vs remeshed-at-φ reference | yes | `rotation.test.js` "field rotates correctly vs a remeshed-at-φ annulus" |
| Plan verification: harmonic torque cross-checks Arkkio on meshed-gap reference (G4) | yes | `torque.test.js` "harmonic torque matches the meshed Arkkio integral" |

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | T4.1.1 §"Files to create" → `tests/harmonic/_fixtures.js` → `annulusOracle` description | `nTheta≈32` and `nRad≈6` use `≈` (approximately). These values feed the `2e-2` tolerance in the `admittance.test.js` "surfaceFlux matches the independently-meshed annulus" test. An implementer who picks `nTheta=24` or `nRad=4` may get a different error floor. | Replace `nTheta≈32, nRad≈6` with exact values, e.g. `nTheta=32, nRad=6`. The values themselves appear correct; only the approximation marker needs removing. |

(One mechanical fix found.)

### Decision-Required Items

#### D1 — `slots` derivation in `gapLoopsFromConfig` is underspecified (major)
- **Location**: T4.1.1 §"Files to create" → `tests/harmonic/_fixtures.js` → `gapLoopsFromConfig` description
- **Problem**: The spec says `gapLoopsFromConfig(config)` returns "`slots` (max angular feature count)". The exact computation is not given. The `slots` value flows directly into `AH.defaultK(slots, poles) = 3·max(slots, poles)`, which determines `K` and therefore the harmonic truncation of every subsequent test. Two reasonable interpretations exist: (a) the maximum over all rings of that ring's discrete-feature count (tooth count for `W`/`C`/`I` rings, magnet count for `M` rings, bar count for `K` rings); (b) something derived from the compiled `section.features` array (e.g., the maximum `angularCount` field emitted by `config-schema`). If an implementer chooses differently from Phase-5's convention, the `K` values in Phase-4 handoff tests will not match Phase-5's `gapMinNodes = 4·(3·max(slots,poles))` computation, causing the guard in `build` to mismatch in integration tests.
- **Why decision-required**: "Max angular feature count" is unambiguous as a concept but ambiguous as a code path — it could come from the raw `config.rings` array, from `CS.expand(config).sections[0].features`, or from a dedicated helper. Which source is authoritative is a design decision, not a lookup.
- **Options**:
  - **Option A — Derive from `config-schema` expand output**: `gapLoopsFromConfig` calls `CS.expand(config)`, takes `sections[0].features`, and sets `slots = Math.max(...features.map(f => f.angularCount ?? 1))`. Matches exactly what Phase 5 will do if it derives `slots` the same way.
    - Pros: Uses the already-available expanded section; consistent with the compiled feature representation; single code path.
    - Cons: Requires `config-schema.js` to emit a reliable `angularCount` per feature (must be confirmed); couples the fixture helper to the schema's output format.
  - **Option B — Derive directly from `config.rings`**: `slots = Math.max(...config.rings.map(r => r.teeth ?? r.magnets ?? r.Q ?? 1))`. Avoids the expand step; reads raw config.
    - Pros: Simpler; no expand dependency; mirrors how the user sets the value.
    - Cons: Uses raw-ring field names that may not match after expansion; fragile if a ring kind uses a different count field name; may diverge from Phase-5's `expand`-based calculation.
  - **Option C — Add an explicit field to the fixture**: The spec declares `slots` as a caller-supplied argument to `gapLoopsFromConfig` (rather than derived), with the fixture helper requiring the caller pass it. The `handoff.test.js` hard-codes `slots` for each fixture.
    - Pros: Removes ambiguity entirely; the fixture helper stays simple.
    - Cons: Shifts the derivation burden onto each test; defeats the purpose of a helper that "derives" the value; leaves the Phase-4/Phase-5 convention alignment unresolved.

---

#### D2 — `M_k` symmetry test leaves internal accessor vs recomputation to implementer (major)
- **Location**: T4.1.1 §"Tests" → `tests/harmonic/admittance.test.js` → `"M_k is symmetric for each k"` test
- **Problem**: The spec says the 2×2 `M_k` is "(exposed for test via an internal accessor or recomputed from the documented closed form)". This leaves the implementer to decide whether to add a test-only accessor property to `HarmonicGap` (e.g. `gap._Mk(k)`) or to recompute the 2×2 matrix from the `r_mr`, `r_ms`, and `k` values documented in the spec. The public API (`Public API` section) does not include any `M_k` accessor, so an implementer who adds one is extending the contract; one who recomputes from scratch produces a test that only checks the formula, not the actual assembled values. These are not equivalent verifications.
- **Why decision-required**: Adding an internal accessor changes the module's structure; not adding one means the test cannot verify the matrix the module actually uses. Both are valid engineering choices with different trade-offs; neither is obviously correct.
- **Options**:
  - **Option A — Add a test-only accessor `gap.Mk(k)`**: Document `gap.Mk(k) → [[m00,m01],[m10,m11]]` as a test-only method (not part of the production API contract), explicitly noted in the spec as test scaffolding.
    - Pros: Tests the actual matrix the module assembles, not a re-derived approximation; catches formula bugs in the assembly.
    - Cons: Adds a method to the production object that is not part of the production contract; future callers might accidentally depend on it.
  - **Option B — Recompute from documented closed form in the test**: The test constructs `M_k` independently using the `r^{±k}` Laplace formula and asserts it equals `surfaceFlux`-implied values via a comparison against a unit-vector input.
    - Pros: No API surface extension; tests the formula against an independent derivation.
    - Cons: If the module has a subtle indexing error in its `M_k` assembly that happens to be consistent with its `surfaceFlux` output, this test would pass and miss the bug.
  - **Option C — Replace this test with a `surfaceFlux`-based symmetry check**: Instead of testing `M_k` directly, test that `surfaceFlux(A_rotor, zeros, 0).stator` is proportional to `surfaceFlux(zeros, A_stator, 0).rotor` at the same amplitude (symmetry of the DtN map). No accessor needed.
    - Pros: Tests an observable behavior of the API without exposing internals; fully self-contained.
    - Cons: Changes the intent of the test from "the 2×2 matrix is symmetric" to "the applied map is symmetric"; a scalar factor error could satisfy the symmetry test but still be wrong.

---

#### D3 — Harmonic torque formula `f(k, r̂ₖ(φ), ŝₖ)` is not specified (major)
- **Location**: T4.1.1 §"Public API (`LIB.AirgapHarmonic`)" → `torque` description; T4.2.1 §"Tests" → `torque.test.js`
- **Problem**: The spec defines `torque(ArotorGapNodal, AstatorGapNodal, phi) → number` as "structurally `T = (ell/μ0)·Σ_{k=1..K} f(k, r̂ₖ(φ), ŝₖ)`" and says "the precise constant/sign is pinned by the Arkkio and radius-independence acceptance criteria below." The function `f` is not written out. A fresh implementer must derive the standard harmonic Maxwell-stress formula from the literature. The correct formula for the torque contribution from harmonic `k` is a specific bilinear expression in the rotor and stator harmonic amplitudes with a sign and a factor of `k`; the sign in particular depends on orientation conventions (rotor vs stator, CW vs CCW positive) that differ between sources. The tests assert a `2%` agreement with `annulusOracle`, but if the implementer uses the wrong sign the torque will be negated — still passing `|T| < 2%` on a symmetric test case but failing on a loaded one. The acceptance criteria say "`torque` matches the meshed Arkkio integral within `2%`" but do not specify the sign convention.
- **Why decision-required**: Multiple forms of the Maxwell-stress harmonic torque formula appear in the FEA literature with different sign conventions and normalizations. Which form is correct here depends on how the rotor/stator amplitudes are ordered and whether positive torque means "rotor accelerated in +θ direction." The plan references `fea-engine-rebuild.md` §3.3/§9, but that document is not available to the implementer from the spec text alone.
- **Options**:
  - **Option A — Write the complete formula in the spec**: Add the explicit harmonic torque formula, e.g. `T = (ell/μ0)·Σ_{k=1..K} k·Im(ĉ_k^rotor · conj(ĉ_k^stator))` (or the real-pair equivalent with `aₖ`, `bₖ`) and state the sign convention explicitly (positive torque = rotor accelerated in +θ).
    - Pros: Implementer cannot guess wrong; derivation burden removed; sign convention is unambiguous.
    - Cons: Requires the spec author to write out the formula, committing to a specific convention that must be consistent with the Phase-5 torque extraction.
  - **Option B — Specify the sign convention and reference an oracle test with a known-sign case**: Add one torque test case where the expected sign is given explicitly (e.g., "a field with positive rotor-leads-stator phase → positive torque (rotor accelerated)"), so the implementer can orient their formula.
    - Pros: Lighter than writing the full formula; a correctly-oriented implementer will pass; a wrong-sign implementer fails this one explicit case.
    - Cons: Does not prevent a formula constant error; only pins the sign.
  - **Option C — Leave as-is, relying on the Arkkio oracle test**: The `annulusOracle.solve` already computes an Arkkio torque with a known sign (the oracle is internally consistent); `torque(Arotor, Astator, φ)` must agree within 2%. If the sign is wrong the test will fail. An implementer who reads the Arkkio formula in the oracle code can infer the required sign.
    - Pros: No spec change needed; the oracle does constrain the sign indirectly.
    - Cons: An implementer cannot write `torque` before the oracle is built; the oracle's sign convention is embedded in ~100 lines of fixture code, not visible in the task description; spec-completeness rule requires the task to be self-contained.

---

#### D4 — `lib/airgap-harmonic.js` is shared across groups 4.1.a and 4.2.a in different waves (critical)
- **Location**: §"Files Owned" note; `spec/manifest.json` Phase 4 waves 4.1 / 4.2
- **Problem**: `lib/airgap-harmonic.js` appears in T4.1.1's "Files to create" (group `4.1.a`) and in T4.2.1's "Files to modify" (group `4.2.a`). Per the review-spec.md file-locality rule: "if two tasks share any file in their Files-to-create/modify lists, they MUST be in the same manifest group. Split-across-groups → `critical`." The spec's own note acknowledges this: "The two waves run sequentially, so there is no file-lock contention; the manifest places them in separate task groups." The spec's rationale is that wave sequencing prevents concurrent file access, so no actual lock contention arises. The review rule has no explicit "sequential-waves" exception, so the finding is `critical` per the rules; however, the implement-hybrid coordinator enforces that wave 4.2 cannot begin until wave 4.1 is verified complete, making actual contention impossible.
- **Why decision-required**: Merging the two groups into one eliminates the rule violation but forces both tasks into a single agent session (increasing context load and reducing the benefit of wave structure); leaving them split relies on wave-ordering enforcement and requires an explicit exception to the file-locality rule.
- **Options**:
  - **Option A — Merge into one group in wave 4.1**: Combine T4.1.1 and T4.2.1 into a single task group `4.1.a` in wave 4.1. Remove wave 4.2 from the manifest. T4.2.1 becomes a sub-task within the single wave.
    - Pros: Strictly satisfies the file-locality rule; no ambiguity; the combined file set is 7 files (≤ 10 cap).
    - Cons: One agent session must implement both G0–G2 (static coupling) and G3–G4 (rotation + torque) — a large `L`-complexity scope; loses the independent verification checkpoint between the two milestones; the plan explicitly structures these as separate waves.
  - **Option B — Restructure as two files**: Split `lib/airgap-harmonic.js` so that G0–G2 functionality lives in `lib/airgap-harmonic-base.js` (group 4.1.a) and G3–G4 extends or wraps it in `lib/airgap-harmonic.js` (group 4.2.a), with no shared file.
    - Pros: Satisfies the file-locality rule; preserves the two-wave structure; each group touches distinct files.
    - Cons: Creates a module boundary that the rest of the system (Phase 5 callers) would need to know about, or requires an aggregator file; adds unnecessary complexity to what is intentionally a single self-contained module.
  - **Option C — Accept the split with an explicit annotation in the manifest**: Add a `"wave_sequential_exception": true` field to the manifest groups (or a comment) acknowledging that the file-locality rule is satisfied by wave ordering rather than group co-location. No structural change.
    - Pros: Preserves the intended wave structure and agent scope; zero implementation cost; honest documentation.
    - Cons: Requires the implement-hybrid coordinator to actually honor this exception (not currently specified behavior); the review-spec.md rule has no exception clause, so a future review agent will flag it again.

---

#### D5 — `denseSolveSPD` implementation left to implementer choice (info)
- **Location**: T4.1.1 §"Files to create" → `tests/harmonic/_fixtures.js` → `denseSolveSPD` description
- **Problem**: The spec says `denseSolveSPD(nLocal, I, J, V, b) → Float64Array` is "a small dense symmetric solver (LDLT or Gaussian elimination)". Both are mathematically equivalent for the small (~200-DOF) local system, and the test result is not sensitive to which algorithm is used. This is noted for completeness; it does not block implementation.
- **Why decision-required**: Any reasonable implementer will pick one and produce correct results; the "or" is not ambiguous in a way that affects correctness. Reporting as `info` rather than leaving it unrecorded.
- **Options**:
  - **Option A — Specify LDLT**: Pin "use LDLT, mirroring the production solver style."
    - Pros: Consistent with the production solver's Cholesky family.
    - Cons: LDLT is slightly more complex to implement from scratch; Gaussian elimination is simpler for this use.
  - **Option B — Specify Gaussian elimination with partial pivoting**: Pin "use Gaussian elimination."
    - Pros: Simpler; well-known; sufficient for small systems.
    - Cons: Slightly less stylistically consistent with the rest of the codebase.
  - **Option C — Leave as-is**: The "or" is intentional latitude; the test is not sensitive to the choice.
    - Pros: No change needed; implementer latitude here causes no correctness risk.
    - Cons: Technically violates the spec-completeness standard (every implementation choice should be specified).
