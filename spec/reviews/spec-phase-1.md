# Spec Review: Phase 1 — engine-core

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0          | 0                 | 0     |
| major    | 0          | 2                 | 2     |
| minor    | 4          | 2                 | 6     |
| info     | 0          | 1                 | 1     |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 1.1.1 — package.json + node:test runner + window shim | yes | Fully covered; smoke test assertions, shim design, guarded-require pattern all specified |
| 1.2.1 — airgap-grid.js (polar FV operator, sliding band, field/flux, per-cell ν r/w) | yes | Full API including `getReluctivity`/`setIronReluctivity` primitives for Phase 9 |
| 1.3.1 — airgap-solve.js (PCG + warm-start + global flux-dependent ceiling) | yes | Full API with ceiling algorithm and warm-start budget specified |
| 1.4.1 — airgap-torque.js (Arkkio gap-band torque + co-energy decomposition) | yes | Full API; one ambiguity in `coenergy` parameter (see D2) |
| 1.4.2 — Core physics tests (salient closed form, flux balance, convergence, solver) | yes | Five test files with named tests and numeric tolerances |
| Plan verification: `npm test` green | yes | Task 1.4.2 acceptance criteria require all tests pass |
| Plan verification: Arkkio vs analytic salient to gap-resolution tolerance over θ sweep | yes | Spec pins at `< 0.03` relative L∞ at Ntheta=256 and adds justifying note |
| Plan verification: flux balance `∮ B dθ = 0` | yes | `flux-balance.test.js` asserts `< 1e-9` |
| Plan verification: torque/energy convergence with grid resolution | yes | `convergence.test.js` asserts monotone decrease + `< 0.03` at Ntheta=256 |
| Plan verification: warm-started PCG within budget on coarse grid | yes | `solver.test.js` asserts `warm.iters ≤ 0.5·cold_iters` and `< Ntheta` |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | phase-1 §Task 1.1.1 "Files to create", first bullet | Path written with backslash: `` `tests\_shim.js` ``. Shell Compatibility rules require forward slashes. | Replace `` `tests\_shim.js` `` → `` `tests/_shim.js` `` |
| M2 | minor | phase-1 §Task 1.2.1 "Files to create", first bullet | Path written with backslash: `` `lib\airgap-grid.js` ``. | Replace `` `lib\airgap-grid.js` `` → `` `lib/airgap-grid.js` `` |
| M3 | minor | phase-1 §Task 1.4.1 "Files to create", first bullet | Path written with backslash: `` `lib\airgap-torque.js` ``. | Replace `` `lib\airgap-torque.js` `` → `` `lib/airgap-torque.js` `` |
| M4 | minor | phase-1 §Task 1.4.2 "Files to create", first bullet | Path written with backslash: `` `tests\engine\_fixtures.js` ``. | Replace `` `tests\engine\_fixtures.js` `` → `` `tests/engine/_fixtures.js` `` |

---

### Decision-Required Items

#### D1 — `arkkio` formula: `rOuter_gap`/`rInner_gap` undefined (major)

- **Location**: phase-1 §Task 1.4.1 "Files to create" → `LIB.AirgapTorque.arkkio` formula
- **Problem**: The formula reads:

  > `T = (ell / (μ₀·(rOuter_gap − rInner_gap))) · Σ_{i∈gapBand} Σ_j r[i]·Br[idx]·Bt[idx]·dr·dtheta`, where `rOuter_gap`/`rInner_gap` are the gap-band radial extent.

  The `gapBand` property is defined as `{ iInner, iOuter }` — integer radial row indices. The spec never says how to derive physical radii `rOuter_gap` and `rInner_gap` from those indices. At least three interpretations exist (cell-centre radii at the boundary rows, face radii, or full annular span), each producing a different normalization denominator and therefore a different numerical torque value. The implementer of Task 1.4.1 has no unambiguous instruction.

- **Why decision-required**: The derivation is a physics/numerics choice. Cell-centre vs face-centre placement changes the denominator by one `dr/2` on each side; for a small gap band this can be a non-negligible fraction. A correct analytic comparison test can be tuned to pass with any consistent convention, so tests alone will not catch the wrong choice.

- **Options**:
  - **Option A — Cell-centre span**: Add to the `arkkio` description: "where `rOuter_gap = op.r[gapBand.iOuter]` and `rInner_gap = op.r[gapBand.iInner]`."
    - Pros: Uses the already-public `op.r` property; simple one-liner.
    - Cons: Excludes the half-cell margin at each edge of the band; slightly underestimates physical gap width.
  - **Option B — Face-to-face span**: Add: "where `rOuter_gap = op.r[gapBand.iOuter] + op.dr/2` and `rInner_gap = op.r[gapBand.iInner] − op.dr/2`."
    - Pros: Covers the full physical extent of the gap-band cells; consistent with FV face-area accounting.
    - Cons: Slightly more text; requires `op.dr` (already public).
  - **Option C — Replace with cell-count × dr**: Add: "where `rOuter_gap − rInner_gap = (gapBand.iOuter − gapBand.iInner + 1) · op.dr`."
    - Pros: Directly counts gap-band rows without ambiguity about which radius to anchor on.
    - Cons: Does not give individual `rOuter_gap`/`rInner_gap` values; less physically transparent.

---

#### D2 — `coenergy` parameter `Jz` is never consumed by the specified procedure (major)

- **Location**: phase-1 §Task 1.4.1 "Files to create" → `LIB.AirgapTorque.coenergy` signature and procedure
- **Problem**: The signature is:

  > `coenergy(op, solveFn, { thetaR, currents, coilMasks, Jz, magnetization, ironMask=null, dTheta=op.dtheta }) → { reluctance, pm, mutual, total }`

  The procedure that follows describes two kinds of solves:
  1. Unit-current inductance solves: `Jz_l = coilMasks[l]` (assembled internally — the caller-supplied `Jz` parameter is never mentioned).
  2. PM flux-linkage solve: "zero-current magnetization-only solve (Jz = 0, magnetization supplied)" — again the caller's `Jz` is not referenced.

  The caller-supplied `Jz` parameter appears in the signature and nowhere else in the procedure. An implementer cannot know whether to (a) ignore `Jz` entirely, (b) add it as a background source to every unit-current solve, (c) use it only in the PM solve alongside `magnetization`, or (d) treat it as a redundant alias for something else.

- **Why decision-required**: Whether `Jz` is a background operating-point current density, dead weight, or something else changes the physics of what `coenergy` computes. Removing it vs incorporating it are both defensible designs; neither can be inferred from the existing text.

- **Options**:
  - **Option A — Remove `Jz` from the signature**: Drop `Jz` from the parameter object. Add one sentence: "Unit-current solves use `Jz_l = coilMasks[l]` only; the PM solve uses `Jz = 0`. No background current-density parameter is accepted."
    - Pros: Eliminates dead parameter; simplest and most transparent API.
    - Cons: If later phases need a background `Jz` in the inductance extraction (e.g., for a linearized solve at an operating point), the API must be revised.
  - **Option B — Define `Jz` as an additive background source on unit-current solves**: Add to the procedure: "The caller-supplied `Jz` (a `Float64Array` or `null`) is a background current density added to each unit-current source: the effective RHS for circuit `l` is `assembleRHS({ Jz: Jz_l_plus_background, magnetization })` where `Jz_l_plus_background[idx] = coilMasks[l][idx] + (Jz ? Jz[idx] : 0)`. `null` contributes zero (zero-not-skip)."
    - Pros: Supports operating-point linearization; consistent with zero-not-skip principle.
    - Cons: Adds conceptual complexity; the linearized inductance interpretation is not standard for pure coenergy decomposition.
  - **Option C — Define `Jz` as background source for the PM solve only**: Add: "`Jz` (or `null`) is added to the RHS of the PM flux-linkage solve only, giving the PM linkage at an operating-point field rather than at zero current." The unit-current solves remain unaffected.
    - Pros: Distinguishes PM linkage at operating point vs at no-load — a physically meaningful choice.
    - Cons: Inconsistent with the stated "Jz = 0" for the PM solve; would require reconciling with the procedure text.

---

#### D3 — `setGapBand` described but not enumerated in the `GridOperator` method list (minor)

- **Location**: phase-1 §Task 1.2.1 "Files to create" → `op.gapBand` entry
- **Problem**: The `op.gapBand` entry reads: "set via `op.setGapBand({ iInner, iOuter })` (supplied by config/fixture; not auto-detected)." However, `setGapBand` does not appear anywhere in the enumerated method list for the `GridOperator` returned by `LIB.AirgapGrid.create`. The acceptance criterion says "returns an object exposing every method above" — an implementer checking that criterion would not include `setGapBand` since it is not "above" in the list.

- **Why decision-required**: The fix is either adding `setGapBand` as a named method entry or changing the description to say `gapBand` is a plain writable property set by direct assignment. Both are valid designs with different encapsulation implications.

- **Options**:
  - **Option A — Add `setGapBand` to the method enumeration**: Insert a bullet between the `fluxLinkage` and `op.gapBand` entries: "`op.setGapBand({ iInner, iOuter })` — writes the gap-band index range used by `op.gapBand` and consumed by `arkkio`."
    - Pros: Consistent with the existing phrasing; makes the method discoverable in the API list.
    - Cons: Adds a trivial setter that could simply be a writable property assignment.
  - **Option B — Change `gapBand` to a plain writable property**: Replace "set via `op.setGapBand({ iInner, iOuter })`" with "assigned directly: `op.gapBand = { iInner, iOuter }`."
    - Pros: Simpler; no extra method needed; consistent with `op.dA` and `op.r` being plain properties.
    - Cons: Writable public property has no validation; a misconfigured index goes silently undetected.

---

#### D4 — Task 1.1.1 acceptance criterion "All tests pass" contradicts the Note (minor)

- **Location**: phase-1 §Task 1.1.1 "Acceptance criteria" (last bullet) and the "Note" paragraph immediately following
- **Problem**: The acceptance criteria conclude with "All tests pass." The Note immediately below says: "`npm test` is only fully green after all Phase-1 waves complete. Intermediate runs (before `airgap-*.js` modules exist) will skip the guarded `require` calls for those modules without error — this is expected behaviour by design of the guarded-require shim."

  An implementer reading the acceptance criteria literally will attempt to achieve full green `npm test` at Task 1.1.1 completion, which is structurally impossible: `airgap-grid.js`, `airgap-solve.js`, and `airgap-torque.js` do not yet exist. The criterion and the Note say opposite things about what "done" means.

- **Why decision-required**: Two fixes are possible — narrow the criterion to match the Note, or collapse the Note into the criterion. Both require a content choice about scope.

- **Options**:
  - **Option A — Narrow the criterion to the two smoke tests**: Replace the last bullet "All tests pass." with "Both smoke tests (`shim exposes LIB.Integrate` and `rk4 advances a trivial ODE`) pass and `npm test` exits 0."
    - Pros: Precisely describes what is achievable at this task's completion; removes ambiguity without losing the Note.
    - Cons: Minor wording change only.
  - **Option B — Replace the last bullet + Note with a single combined statement**: Remove the Note paragraph; amend the last criterion bullet to: "`npm test` exits 0 with both smoke tests passing. The guarded-require shim silently skips modules not yet created; intermediate test runs during later waves are expected to pass only the tests whose modules exist."
    - Pros: Single canonical statement; no separate Note to reconcile.
    - Cons: Criterion becomes longer; the Note's explanatory function is absorbed into normative text.

---

#### D5 — `coenergy` warm-start strategy across the unit-current sweep is unspecified (info)

- **Location**: phase-1 §Task 1.4.1 "Files to create" → `coenergy` inductance-matrix assembly procedure
- **Problem**: The procedure says unit-current solves are "warm-started from the previous angle's solution." There are `N_circuits` unit-current solves at each of two angles (`thetaR ± dTheta`). "Previous angle's solution" is ambiguous: it could mean (a) circuit `l`'s solve at `thetaR − dTheta` warm-starts circuit `l`'s solve at `thetaR + dTheta`; (b) the operating-point `Az` (full-current field) warm-starts each unit-current solve; or (c) circuit `l−1`'s solve at the same angle warm-starts circuit `l`'s solve. For a Phase-1 test-only function this is low-stakes, but the function is reused in Phase 5's live pipeline where convergence budget matters.

- **Why decision-required**: All three strategies are valid; each produces correct results with different iteration counts. The "correct" warm-start depends on the anticipated access pattern in Phase 5.

- **Options**:
  - **Option A — Warm-start each circuit's `θ+` solve from the same circuit's `θ−` solve**: Add: "For each circuit `l`, solve at `thetaR − dTheta` first (cold start or warm from the prior rotor position); warm-start the `thetaR + dTheta` solve from that result."
    - Pros: Closest-field warm start; fewest iterations.
    - Cons: Requires storing one Az per circuit.
  - **Option B — Cold-start all unit-current solves**: Add: "Unit-current solves use `x0 = null` (cold start); warm-starting is not required for the test-only co-energy function."
    - Pros: Simplest; no storage overhead; correct for Phase-1 scope.
    - Cons: Higher iteration count; may matter if co-energy is promoted to live use.
  - **Option C — Warm-start from the operating-point Az**: Add: "Warm-start each unit-current solve from the operating-point `Az` (full-current field at the same angle), which the caller has already computed."
    - Pros: Operating-point field is typically available from the caller; reasonable first guess.
    - Cons: May diverge more than Option A for high-current operating points.
