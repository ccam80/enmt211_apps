# Spec Review: Phase 3 — excitation-commutation

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0          | 0                 | 0     |
| major    | 1          | 3                 | 4     |
| minor    | 1          | 1                 | 2     |
| info     | 0          | 1                 | 1     |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 3.1.1 — `excitation.js`: `commutationPhase`/`supplyValue`/`sectorGate`/`evalTerminal`/`evalDrive`; terminal states `{AC,DC,PULSE,STEP,OPEN,SHORT}`; commutation `{none,mechanical,electronic-trap,electronic-sine,sequencer}`; zero deps, DOM-free | yes | Full API spelled out with signatures, return types, and dispatch table |
| 3.1.2 — Closed-form suite: supply waveforms; emergent balanced/N-phase summing to zero; single-phasing `OPEN`; 6-step `electronic-trap` conduction table; `mechanical` DC-chop + AC-commutation; `sequencer` step pattern; each `commutationPhase` mode vs formula. Own headless loader `tests/excitation/_fixtures.js` | yes | All enumerated closed-form checks appear; three tests use discovery phrasing instead of concrete values (see D1, D2, D3) |
| Plan verification: "each excitation source and commutation mapping matches its closed form" | yes | Covered by `sources.test.js` and `commutation.test.js` assertions |
| Plan verification: "semi-implicit current step stable for `dt > L/R`" | n/a | Phase 4 concern; correctly absent |
| Plan verification: "shorted-winding config shows induced current" | n/a | Phase 4 concern; correctly absent |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | Phase 3 §"Wave 3.2: Tests" section heading | Wave heading reads "Wave 3.2" but the task immediately underneath is numbered `3.1.2` (prefix `3.1`). Every other phase uses wave-aligned task IDs (wave 1.4 → tasks 1.4.1/1.4.2; wave 2.3 → task 2.3.1). The plan assigns this task `3.1.2` and the manifest correctly records `T3.1.2` in wave `3.2`; the inconsistency is in the spec heading only. | Add a parenthetical to the wave heading only: rename "Wave 3.2: Tests" → "Wave 3.2: Tests (Task 3.1.2 — plan numbering retained)". This is mechanical because it adds only a clarifying label without changing any ID, restructuring any wave, or touching the manifest. (A full renumber to `3.2.1` would require coordinated edits to both the spec and the manifest and is Decision-Required — see D4.) |

---

### Decision-Required Items

#### D1 — "PULSE dead sector" test lacks a concrete theta value (major)

- **Location**: Phase 3 §Task 3.1.2, `tests/excitation/sources.test.js`, test `"PULSE dead sector is open, active sector is ±amp"`
- **Problem**: The spec reads:
  > `evalTerminal` with `terminal:{type:"PULSE",amp:48,conductionAngle:2π/3}`, `commutation:{mode:"electronic-trap",poles:2}`: at `theta = π/6` → `{kind:"voltage", V:48}`; **at `theta` giving `θ_comm ∈ [2π/3, π)` → `{kind:"open"}`**.
  The first assertion pins `theta = π/6`. The second does not pin a concrete theta — "at `theta` giving `θ_comm ∈ [2π/3, π)`" requires the implementer to derive or choose a theta that lands in the dead sector. With `poles:2` and `loadAngle` defaulting to `0`, `θ_comm = theta`, so any `theta ∈ [2π/3, π)` satisfies the condition — but the implementer must make that deduction and choose a specific value. This is discovery phrasing at `major` severity per the review rules.
- **Why decision-required**: Multiple concrete theta values are valid (e.g. `3π/4`, `5π/6`). Pinning one is an arbitrary choice; a reasonable reviewer might pick a different value.
- **Options**:
  - **Option A — Pin `theta = 3π/4`**: Replace `at theta giving θ_comm ∈ [2π/3, π)` with `at theta = 3π/4 (θ_comm = 3π/4 ∈ [2π/3, π))`.
    - Pros: `3π/4` is the midpoint of the dead sector; easy to verify by inspection; unambiguous.
    - Cons: None material — any value in the range is equally valid; midpoint is as good as any other.
  - **Option B — Pin `theta = 5π/6`**: Replace with `at theta = 5π/6 (θ_comm = 5π/6 ∈ [2π/3, π))`.
    - Pros: Tests the far end of the dead sector, away from the boundary.
    - Cons: Less intuitive than the midpoint; no functional difference.
  - **Option C — Reword as two concrete assertions**: `theta = π/6 → {kind:"voltage", V:48}; theta = 3π/4 → {kind:"open"}`. Remove the range qualifier entirely.
    - Pros: Both values pinned; no range description needed; no discovery required.
    - Cons: Slightly rewords the test structure; functionally equivalent to Option A.

---

#### D2 — "STEP in mode:none" test lacks a concrete `t` value (major)

- **Location**: Phase 3 §Task 3.1.2, `tests/excitation/sources.test.js`, test `"STEP in mode:none at a dead-sector angle holds voltage, not open"`
- **Problem**: The spec reads:
  > `evalTerminal` `terminal:{type:"STEP",amp:10,freq:1,phaseOffset:0,conductionAngle:2π/3}`, `commutation:{mode:"none"}`, **at `t` such that `sectorGate(2π·1·t, 2π/3) === 0`**: result is `{kind:"voltage", V:10}`, not `{kind:"open"}`.
  The phrase "at `t` such that…" requires the implementer to find a `t` in the dead sector of a `freq:1` gate. With `freq:1`, the first dead sector falls at `ψ = 2πt ∈ [2π/3, π)`, i.e. `t ∈ [1/3, 1/2)`. The implementer must compute this interval and pick a value. This is discovery phrasing at `major` severity.
- **Why decision-required**: Multiple concrete values of `t` satisfy the condition. Choosing one is an arbitrary decision; a reasonable reviewer might pick `t = 5/12`, `t = 0.40`, or `t = 0.45`.
- **Options**:
  - **Option A — Pin `t = 5/12`**: Replace `at t such that sectorGate(2π·1·t, 2π/3) === 0` with `at t = 5/12 (ψ = 5π/6, in the dead sector [2π/3, π))`.
    - Pros: `5/12` is the midpoint of the first dead sector `[1/3, 1/2)`; the derivation is self-documenting. Verify: `2π·(5/12) = 5π/6 ≈ 2.618`; `sectorGate(5π/6, 2π/3) = 0` because `5π/6 ∈ [2π/3, π)`.
    - Cons: None material.
  - **Option B — Pin `t = 0.40`**: Use `t = 0.40` (ψ ≈ 2.513 rad ∈ `[2π/3, π)`).
    - Pros: Decimal is simpler to type in test code.
    - Cons: Less self-documenting than `5/12`; requires a comment to explain why `0.40` is in the dead sector.

---

#### D3 — "Mechanical AC commutation" test lacks concrete `(t, theta)` values (major)

- **Location**: Phase 3 §Task 3.1.2, `tests/excitation/commutation.test.js`, test `"mechanical commutates AC (universal motor) — both phases present"`
- **Problem**: The spec reads:
  > `AC`+`mechanical` `{poles:2}`, `conductionAngle:π`: `V` equals `sectorGate((poles/2)·theta) · amp·cos(2π·freq·t + phaseOffset)` (`assertClose`) **for a `(t, theta)` where the gate is `−1` and the cosine is positive** (so the product is negative — confirms both arguments enter).
  "For a `(t, theta)` where the gate is `−1` and the cosine is positive" requires the implementer to find a pair. With `poles:2` and `conductionAngle:π`, the gate is `−1` when `θ_comm = theta ∈ [π, 2π)`. Choosing e.g. `theta = 3π/2` gives gate `−1`. A positive cosine requires `cos(2π·freq·t + phaseOffset) > 0`. Neither `theta` nor `t` (nor `freq`, `amp`, `phaseOffset`) are pinned. The implementer must jointly satisfy two inequality conditions and also choose all four free parameters. This is discovery phrasing at `major` severity.
- **Why decision-required**: The correct `(t, theta, freq, amp, phaseOffset)` tuple is not unique. The choice affects the exact numeric assertion value. A reasonable reviewer might choose different parameters.
- **Options**:
  - **Option A — Pin all parameters and expected value**: Replace the vague qualifier with explicit fixture: `terminal:{type:"AC",amp:10,freq:1,phaseOffset:0}`, `commutation:{mode:"mechanical",poles:2,conductionAngle:π}`, `ctx:{t:0, theta:3π/2}`. Expected: `sectorGate(3π/2, π) = −1`; `cos(0) = 1`; `V = −1 · 10 · 1 = −10`. Assert `assertClose(result.V, −10, 1e-9)`.
    - Pros: Fully pinned; exactly one expected value; no implementer judgement required. Arithmetic verifiable: `3π/2 ∈ [π, 2π)` → gate `= −1`; `cos(0) = 1` → product `= −10`.
    - Cons: Requires spec author to verify the arithmetic (done above).
  - **Option B — Pin values inline as "e.g." and require them**: Reword as: "use `amp=10, freq=1, phaseOffset=0, theta=3π/2, t=0`; `sectorGate(3π/2) = −1`, `cos(0) = 1`, assert `assertClose(V, −10, 1e-9)`." Make clear these are the required values, not suggestions.
    - Pros: Preserves the explanatory formula context while pinning the concrete case.
    - Cons: Must say "use these values" not "e.g." to eliminate any discovery residual.
  - **Option C — Split into two separate assertions**: One assertion: `sectorGate(theta, π) === −1` at `theta = 3π/2` (tests gate logic). Second assertion: the combined product at `(t=0, theta=3π/2)` equals `−10` (tests end-to-end composition). Eliminates the joint-condition discovery while keeping each assertion individually simple.
    - Pros: Decomposed assertions are individually easier to diagnose on failure.
    - Cons: Slightly more test code; marginally increases task 3.1.2 scope.

---

#### D4 — Full renumber of task `3.1.2` to `3.2.1` requires coordinated spec + manifest edits (minor)

- **Location**: Phase 3 §Wave 3.2 heading; §Task 3.1.2 heading; manifest `phases[3].waves[1].task_groups[0].tasks[0].id = "T3.1.2"`; Task 3.1.1 cross-reference "authored in Task 3.1.2"
- **Problem**: M1 above proposes a heading-only annotation as the mechanical fix. The underlying mismatch between wave `3.2` and task prefix `3.1` can also be resolved by renumbering the task to `3.2.1` — but that requires editing three locations (spec task heading, manifest task ID, and the Task 3.1.1 cross-reference). This is a broader change than a heading annotation and is a decision, not a mechanical fix, because it deviates from the plan's numbering (`3.1.2`) and breaks any external cross-references to that ID.
- **Why decision-required**: Two valid approaches exist with different tradeoffs. The right choice depends on whether plan-alignment or wave-alignment is the canonical source of task IDs.
- **Options**:
  - **Option A — Renumber to `3.2.1`**: Change spec task heading to `Task 3.2.1`, update manifest `T3.1.2` → `T3.2.1`, update the Task 3.1.1 body cross-reference "authored in Task 3.1.2" → "authored in Task 3.2.1".
    - Pros: Consistent with every other phase's wave-aligned convention (wave `N.M` → task `N.M.k`); removes the anomaly permanently.
    - Cons: Deviates from the plan's numbering; any external reference to `3.1.2` (e.g., tickets, changelogs) breaks.
  - **Option B — Keep `3.1.2` with M1 annotation only**: Apply the M1 mechanical fix (add parenthetical to wave heading). Leave the task ID, manifest, and cross-references unchanged.
    - Pros: Plan-consistent; no manifest change; minimum diff.
    - Cons: The heading annotation is unusual; the anomaly persists for future readers.

---

#### D5 — `DC` in `evalTerminal` step 3 reads `terminal.amp` directly while step 2 routes DC through `supplyValue` (info)

- **Location**: Phase 3 §Task 3.1.1 `evalTerminal` step 2 (mode `"none"`, AC/DC clause) and step 3 (electronic-sine/trap/sequencer, DC clause)
- **Problem**: Step 2 specifies `AC/DC → { kind: "voltage", V: supplyValue(terminal, ctx.t) }` — routing DC through `supplyValue`. Step 3 specifies `DC → { kind: "voltage", V: supplyValue(terminal, ctx.t) }` — the same wording. On re-reading, step 3's DC clause actually does say `supplyValue`, matching step 2. So there is no functional inconsistency. However, step 3 also says for the electronic modes: `"base = commutationPhase(commutation, ctx)"` is computed and then DC ignores `base` entirely. An implementer may ask why `base` is computed and discarded for DC. The spec does not explain this.
- **Why decision-required**: Whether to add an explanatory note is a judgment call; the behaviour is correctly specified.
- **Options**:
  - **Option A — Add one clarifying sentence in step 3**: After the `DC` bullet in step 3, add: "(DC is a constant bus voltage; commutation phase `base` is irrelevant for DC — only `PULSE`, `STEP`, and `mechanical` modes shape DC into a switched waveform.)"
    - Pros: Prevents implementer confusion about why `base` is computed but not used for DC; documents design intent inline; consistent with the plan's "zero machine identity" explanation style.
    - Cons: Minor prose addition; a careful reader of the dispatch table can already infer this.
  - **Option B — Leave as-is**: The spec is logically complete. A conforming implementer will produce correct code from the dispatch table alone.
    - Pros: No change; shorter spec.
    - Cons: Discovery risk if an implementer "corrects" the DC case in step 3 by applying `base` (e.g. as `supplyValue(terminal, ctx.t, base)`), which would break DC behaviour under electronic commutation.
