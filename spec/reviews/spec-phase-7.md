# Spec Review: Phase 7 — editors

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 1 | 4 | 5 |
| minor    | 0 | 2 | 2 |
| info     | 0 | 1 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 7.1.1 cross-section renderer (semantic + compiled-overlay) | yes | Matches plan scope fully |
| 7.2.1 winding editor (tap-tooth / route-conductor, live F(θ)/pole-count/back-EMF-shape) | yes | Matches plan scope fully |
| 7.3.1 schematic panel (lowering to per-circuit vocabulary) | yes | Matches plan scope fully |
| 7.4.1 matrix/config panel (synthesizes config from toggles) | yes | Matches plan scope fully |
| 7.5.1 test suite + index.html wiring (user-required browser verification) | yes | Matches plan scope fully |
| Plan Phase-7 verification: routing conductor updates F(θ)/pole-count/back-EMF-shape live | yes | Task 7.2.1 + acceptance criteria in 7.5.1 |
| Plan Phase-7 verification: star/delta, series-R, switches lower to per-circuit vocabulary | yes | Task 7.3.1 acceptance criteria |
| Plan Phase-7 verification: toggleable compiled-feature overlay | yes | Task 7.1.1 + checklist item 3 in 7.5.1 |
| Plan Phase-7 verification: no editor path keyed to a machine | yes | Machine-agnosticism boundary section + per-task checks |

---

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | major | phase-7 §Files Owned | `tests/editors/wiring.test.js` is created by Task 7.5.1 (listed in its "Files to create") but is absent from the top-level Files Owned section. The Files Owned section lists 10 files; the task union is 11 (the missing file is the 11th). | Add `- tests/editors/wiring.test.js — created` to the Files Owned list |

---

### Decision-Required Items

#### D1 — `capPhaseSplit` formula contradicts its stated boundary conditions (major)

- **Location**: phase-7 §Task 7.3.1, `Schematic.capPhaseSplit` API definition
- **Problem**: The spec gives two distinct descriptions that are mathematically inconsistent with each other:
  1. **Formula**: `Δφ = Math.atan2(1/(2π·freq·C), R)` clamped to `[0, π/2]`
  2. **Boundary A**: "returns `π/2` (pure quadrature) when `R === 0` **or** `freq·C → ∞`"
  3. **Boundary B**: "returns `0` when `C === 0`"

  Checking the formula against the stated boundaries:
  - `C = 0`: `1/(2π·freq·0)` = Infinity → `atan2(Inf, R) = π/2`. **But the spec says return `0`.** Contradiction.
  - `freq·C → ∞`: `1/(2π·freq·C) → 0` → `atan2(0, R) = 0`. **But the spec says return `π/2`.** Contradiction.
  - `R = 0` (and C, freq > 0): `atan2(Inf, 0) = π/2`. ✓ Consistent.

  The acceptance criterion `capPhaseSplit(0, 50, 5) === 0` (C=0 returns 0) directly contradicts the formula. An implementer following the formula will fail the test; one special-casing C=0 to return 0 will pass the test but violate the freq·C→∞ boundary. No consistent single implementation satisfies all three constraints simultaneously.
- **Why decision-required**: The correct physical model could go in multiple directions. The formula as written produces neither of the two stated limiting behaviors; the desired physics must be decided.
- **Options**:
  - **Option A — Rewrite formula to match physical intent**: The capacitor phase-split angle in an RC circuit is `φ = atan(Xc/R) = atan(1/(ωRC))` where `ω = 2π·freq`. This gives `atan2(1, 2π·freq·C·R)`:
    - C=0: `atan2(1, 0) = π/2` (pure phase shift with no cap → Hmm, physically a short to ground with no cap makes no sense; depends on the circuit model)
    - freq·C→∞: `atan2(1, ∞) → 0` (large cap → low reactance → no phase shift)
    - R=0: `atan2(1, 0) = π/2` ✓
    This matches the `freq·C→∞` boundary and `R=0` boundary, but not C=0 returning 0. Add explicit guard: `if (C === 0) return 0`.
    - Pros: Physically grounded RC phase model; freq·C→∞ and R=0 boundaries both satisfied by formula; C=0 handled by one guard.
    - Cons: Requires adding the C=0 guard explicitly, which means the formula alone is not sufficient.
  - **Option B — Keep original `atan2(1/(2π·freq·C), R)` with explicit guards**: Keep the formula but add `if (C === 0) return 0; if (freq <= 0) return 0;` guards before evaluating. Accept that `freq·C→∞` → formula gives 0 (revise the boundary statement from π/2 to 0 for freq·C→∞).
    - Pros: Minimal change to the formula; C=0 guard makes the test pass.
    - Cons: The boundary statement "returns π/2 when freq·C→∞" must be corrected; the physical meaning changes (large cap → no phase shift, which may not match the intended teaching model).
  - **Option C — Replace with a pure look-up model**: Drop the formula entirely and specify `capPhaseSplit` as a table-lookup from a design table (e.g., standard single-phase motor cap sizes), removing the formula-boundary tension altogether.
    - Pros: Sidesteps the formula inconsistency; can be tuned to match known motor behavior.
    - Cons: Higher implementation complexity; loses the closed-form simplicity; harder to headless-test with exact assertions.

---

#### D2 — `windingFactor` reference winding not specified (major)

- **Location**: phase-7 §Task 7.2.1, `WindingEditor.windingFactor` API definition
- **Problem**: The spec says the winding factor `k_w` is "the normalized `spatialSpectrum(windingFunction(routing).n[0]).amps[poleHarmonic-1]` **divided by the same quantity for a full-pitch concentrated reference of equal total conductors** (so a full-pitch single-coil winding returns `k_w = 1`)."

  The phrase "equal total conductors" does not specify the reference routing object. An implementer must construct a `routing` object representing a "full-pitch concentrated reference" with the same total conductor count as the input. It is unspecified:
  - How many slots does the reference routing have?
  - What is "full pitch" for an arbitrary input routing with varying coilPitch?
  - Is the reference a 2-slot routing (go + return) with pole-pitch span?
  - How is "equal total conductors" counted (sum of |turns| across all slots? sum of turns for circuit 0 only?)?

  The acceptance criterion `windingFactor(<3/4/24 winding>, 2)` is within `0.01` of `0.966` constrains the result but does not resolve the reference definition — multiple reference definitions might produce values near `0.966` for this specific case while diverging for others.
- **Why decision-required**: There are multiple plausible reference winding definitions. The choice affects correctness for any winding other than the one in the acceptance criterion.
- **Options**:
  - **Option A — Define the reference explicitly as a 2-slot full-pitch single-coil routing**: The reference is `{ nSlots:2, slotTheta:[0, π/poleHarmonic], phases:[{ id:"A", branches:[{ coils:[{ slotGo:0, slotReturn:1, turns: totalTurns }] }] }] }` where `totalTurns = Σ|ac.turns[s]| / 2` (half because go+return each counted). Add this definition verbatim to the spec.
    - Pros: Unambiguous; implementable without guessing; a full-pitch single-coil always returns k_w=1 by construction.
    - Cons: "equal total conductors" must be carefully computed; the `slotTheta` spans half an electrical cycle so must reference the `poleHarmonic` argument.
  - **Option B — Normalize against the fundamental Fourier coefficient of the ampere-conductor step function**: Instead of a reference routing object, define k_w as `amps[poleHarmonic-1] / (4/π · totalAmpConductors / 2)` (the Fourier coefficient of a square wave), which is the classical winding factor formula. No reference routing object needed.
    - Pros: Matches textbook winding factor definition exactly; no ambiguity in "reference routing."
    - Cons: Requires adding the normalization formula explicitly; may differ from what the spec author intended (the current text implies a routing-based comparison, not an analytic normalization).
  - **Option C — Remove `windingFactor` from the headless API and make it browser-display-only**: Show the raw spectrum amplitudes in the UI without a normalized scalar. This sidesteps the normalization question entirely.
    - Pros: No ambiguity; the spectrum display still conveys the same educational information.
    - Cons: The acceptance criterion `windingFactor(…, 2)` within `0.01` of `0.966` is a meaningful test that validates the winding model; dropping it removes a useful verification point.

---

#### D3 — `MatrixPanel.synthesize` `rRange` assignment algorithm unspecified (major)

- **Location**: phase-7 §Task 7.4.1, `MatrixPanel.synthesize` API definition
- **Problem**: The spec says the config's `rings` array is built with "`rRange` (radial bands split evenly between rotor and stator across the gap)." No formula, algorithm, or example is given for how to split radial bands.

  An implementer must decide:
  - How many distinct radial layers are there (one per ring, or grouped by member)?
  - What is the gap boundary between rotor and stator? (`(rInner + rOuter) / 2`? the `gapBand` indices?)
  - How is the available radial space divided among multiple rotor rings or multiple stator rings?
  - Are back-iron layers implicit (e.g., does an `M` ring also get a back-iron sub-band)?

  Without this algorithm, two implementers will produce different `rRange` values, and `ConfigSchema.validate()` (which the acceptance criterion calls) may reject ranges that don't cover the full annulus or overlap incorrectly.
- **Why decision-required**: Multiple reasonable splitting schemes exist; each has different implications for the compiled grid arrays and validation.
- **Options**:
  - **Option A — Simple halving at the gap midpoint, even split within each side**: Stator radial space = `[gapMid, rOuter]` divided evenly among N stator rings. Rotor radial space = `[rInner, gapMid]` divided evenly among N rotor rings. `gapMid = (rInner + rOuter) / 2`. Add this formula and example explicitly to the spec.
    - Pros: Unambiguous; implementable in two lines; consistent with the annular grid shape.
    - Cons: Ignores `gapBand` indices; may produce unrealistic back-iron proportions for machines with thick magnets.
  - **Option B — Use `gapBand` indices to determine the gap boundary**: Convert `gapBand.iInner` and `gapBand.iOuter` to radii via the grid's `Nr` and `rInner`/`rOuter` to find the physical gap center, then split as in Option A.
    - Pros: Uses the grid's own gap definition; more physically consistent.
    - Cons: More complex formula; requires the grid defaults to be resolved first.
  - **Option C — Prescribe a fixed default rRange per element type**: Define a table (e.g., stator W: outer 80% of stator band; stator I: inner 50%; rotor M: outer 60% of rotor band). Tables can be specified exactly.
    - Pros: Maximum concreteness; every element gets a fixed default.
    - Cons: Table is arbitrary and may not generalize; multiple rings of the same type on the same member would overlap.

---

#### D4 — Winding editor `build` does not specify how the "active ring" is determined (major)

- **Location**: phase-7 §Task 7.2.1, `WindingEditor.build(host, ctx)` description
- **Problem**: The spec says pointer events are handled differently depending on "Concentrated (C ring active)" vs "Distributed (W ring active)". But `ctx` provides a `runtime` and `config` — neither `ctx` nor the spec defines what "active ring" means or how it is tracked/selected.

  Specifically unspecified:
  - Is there a ring-selection UI element inside the winding editor panel? (If so, what does it look like, and how does the user switch between rings?)
  - Is the active ring the first `C` or `W` ring found in `config.rings`? Or does the user click/tap a ring to select it?
  - If `config.rings` has both `C` and `W` rings, which takes precedence?
  - Where is `activeRing` stored — in `ctx.config`, in a closure-local variable, or in `runtime.state`?

  The acceptance criterion does not test the interactive pointer flow (it is browser-verified), so there is no test to constrain the implementation. An implementer cannot write `build` without answering these questions.
- **Why decision-required**: Multiple ring-selection models are plausible and each leads to a substantially different UI implementation.
- **Options**:
  - **Option A — Ring picker via a tab strip inside the panel**: Add a description to `build` specifying: the panel renders a per-ring tab strip; clicking a tab sets `activeRing = ringIndex` in a closure-local variable; pointer events dispatch based on `config.rings[activeRing].element`. Add `activeRing` initialization logic (default to first `W` or `C` ring found).
    - Pros: Standard UI pattern; explicit and implementable; consistent with the schematic's per-component right-click for parameter access.
    - Cons: Requires UI layout description to be added to the spec; browser checklist item 2 would need updating to verify the ring selector.
  - **Option B — Implicit ring from pointer hit-test**: The cross-section canvas draws all rings; a pointer-down hit-tests which ring the pointer is in (by `rRange`); the editor infers `element` from that ring. No explicit ring selector needed.
    - Pros: More direct WYSIWYG editing feel; no separate selector needed.
    - Cons: More complex hit-test (polar ring containment); if user pointer-downs in a gap or an `M`/`I` ring, behavior is undefined; requires more spec text to describe the hit-test logic.
  - **Option C — Only one editable ring at a time (config must have exactly one W/C ring)**: Restrict the editor to configs with a single wound ring; `activeRing` is always `config.rings.findIndex(r => r.element === "W" || r.element === "C")`. Document this restriction explicitly.
    - Pros: Simplest implementation; no ring selector needed.
    - Cons: Limits usability for multi-wound-ring configs (e.g., wound stator + wound rotor); may conflict with Phase 6 machine fixtures that have multiple wound rings.

---

#### D5 — `Schematic.lower` capacitor formula uses `terminal.freq` which may be undefined for non-AC terminals (minor)

- **Location**: phase-7 §Task 7.3.1, `Schematic.lower` API definition
- **Problem**: The spec says: "For each component of kind `"capacitor"` on a branch targeting circuit `t`: `circuits[t].terminal.phaseOffset += capPhaseSplit(component.C, circuits[t].terminal.freq, circuits[t].R)`."

  `terminal.freq` is only a defined field when `terminal.type === "AC"` (see the `config.circuits` shape in the Conventions section: `terminal:{ type, amp, freq, phaseOffset, conductionAngle }`). For `DC`, `PULSE`, `STEP`, `OPEN`, or `SHORT` terminals, `freq` may be `undefined`. `capPhaseSplit(C, undefined, R)` would call `atan2(1/(2π·undefined·C), R)` = `atan2(NaN, R)` = NaN, silently corrupting the terminal.

  The acceptance criterion tests only an AC circuit with `freq:50`; no non-AC capacitor test is specified.
- **Why decision-required**: Two reasonable behaviors exist: silently skip the capacitor effect for non-AC circuits, or explicitly throw/warn. Each reflects a different design intent.
- **Options**:
  - **Option A — Guard: skip capacitor effect when `terminal.type !== "AC"`**: Add to the spec: "If `circuits[t].terminal.type !== "AC"`, the capacitor component on that branch has no effect (skip the `phaseOffset` addition)."
    - Pros: Silent and safe; consistent with "absent physics is zero, not skipped" philosophy (the phase effect is zero because there's no AC frequency to create a phase split).
    - Cons: Could silently mask a wiring error in the schematic (user adds a cap to a DC circuit and nothing happens).
  - **Option B — Guard: use `terminal.freq ?? 0` (treat missing freq as DC)**: `capPhaseSplit(C, terminal.freq ?? 0, R)` — with `freq=0`, `1/(2π·0·C)` = Infinity → `atan2(Inf, R) = π/2` (but see D1 for the formula inconsistency). Adds `π/2` to the phaseOffset of a DC circuit.
    - Pros: Formula stays uniform with no branch.
    - Cons: Adding a phase offset to a DC circuit is physically meaningless; inherits the D1 formula bug.

---

#### D6 — `buildGeometry` `nCircuits` accumulation semantics are ambiguous (minor)

- **Location**: phase-7 §Task 7.1.1, `CrossSectionRender.buildGeometry` API definition
- **Problem**: The spec says: "`nCircuits` accumulates `ac.nCircuits` across wound rings (the running global base, matching the Phase-5 global-circuit indexing)." This sentence is ambiguous on two points:

  1. The returned `geom.nCircuits` is a single scalar — is it the **total** across all wound rings (final running sum), or the **count from the last wound ring only**?
  2. "The running global base" implies each ring's conductor entries use a circuit index offset by previous rings' circuit counts (e.g., ring 1 has 3 circuits indexed 0–2; ring 2's circuits are indexed 3–5). The spec lists `conductor.circuit` as the index, but does not say whether this is the ring-local circuit index or the global one.

  The acceptance criterion only tests a single wound ring (`6-slot single-phase W stator`), so the multi-ring accumulation case is untested in the headless suite (only browser-verified).
- **Why decision-required**: The global vs local circuit indexing affects how `circuitColor(circuit, nCircuits)` maps colors — wrong indexing produces wrong colors for the second wound ring's conductors.
- **Options**:
  - **Option A — `conductor.circuit` is the global index; `geom.nCircuits` is the total across all wound rings**: Specify: "Each wound ring's conductor entries use a circuit index starting at the sum of all previous wound rings' `ac.nCircuits`. `geom.nCircuits` equals the total circuit count across all wound rings." Add a 2-wound-ring acceptance criterion to the test spec.
    - Pros: Matches Phase-5's global-circuit indexing by construction; `circuitColor` works directly with no offset.
    - Cons: Requires implementing the accumulation correctly; no headless test currently covers it.
  - **Option B — `conductor.circuit` is the ring-local index; `geom.nCircuits` is the max across rings**: Each ring's conductors use indices 0..m-1. The color function must be called with each ring's local `ac.nCircuits`, not the global total. This is simpler per-ring but the caller must know which `nCircuits` to pass.
    - Pros: Simpler per-ring logic; no accumulation needed.
    - Cons: Inconsistent with Phase-5's global-circuit convention; requires the `drawSemantic` caller to compute per-ring nCircuits, which is not described.

---

#### D7 — `wiring.test.js` index.html marker comment strings not confirmed against Phase-5 spec (info)

- **Location**: phase-7 §Task 7.5.1, `tests/editors/wiring.test.js` description
- **Problem**: The test reads `index.html` and looks for the substring `<!-- unified-motor modules:` and `<!-- /unified-motor modules -->`. These marker comment strings must exactly match what Phase 5 writes into `index.html`. The Phase 7 spec defines these strings but the Phase 5 spec's exact comment text is not visible to this reviewer (the Phase 5 spec file is not in scope for this review).

  If Phase 5 uses a different comment format (e.g., `<!-- BEGIN unified-motor modules -->` / `<!-- END unified-motor modules -->`), the test in Task 7.5.1 would fail with a misleading "markers not found" error even though the append was correct.
- **Why decision-required**: Verifying the marker strings requires reading the Phase 5 spec. The strings should either be confirmed against Phase 5 or the Phase 5 spec should be amended to use the Phase 7–specified strings.
- **Options**:
  - **Option A — Confirm the marker strings match Phase 5**: Read `spec/phase-5-agnostic-pipeline.md`, find the exact comment text in Task 5.4.1 for the module-extension region markers, and update the Phase 7 test description to use exactly those strings. If they already match, no change needed.
    - Pros: Zero risk of marker mismatch at test time.
    - Cons: Requires cross-phase spec read (minor effort).
  - **Option B — Make the marker check configurable/fuzzy**: Specify that the test searches for `unified-motor modules` as a substring (case-insensitive) rather than an exact prefix/suffix pair, tolerating minor format differences.
    - Pros: Resilient to minor Phase 5 comment-format variations.
    - Cons: Less precise; could match an accidentally duplicated comment or a comment in prose documentation.
