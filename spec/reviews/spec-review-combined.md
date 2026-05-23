# Spec Review: Combined Report

## Overall Verdict: needs-revision → **RESOLVED** (all findings applied 2026-05-24)

> **Resolution:** All 13 Mechanical fixes (6 genuine + 7 cross-reference) and all
> ~36 Decision-Required items were applied via per-file fix-agents. Decisions were
> resolved under three user-supplied rules: (1) keep edits file-scoped where
> possible; (2) never resolve an inconsistency by cheapening a test/feature; (3)
> fan cross-phase contracts back into the earlier owning phase. P7-D1 was decided
> by the user (Option A). Two items resolved to combinations (P2-D1, P6-D3); one
> (P8-D5) was kept 1-cell after a geometry check showed widening would corrupt the
> Arkkio band. Manifest unchanged. False positives (backslash paths, P9-D2
> notation) intentionally not edited.

Ten phase specs (0–9) reviewed by parallel per-phase agents plus a cross-phase
consistency pass. The specs are unusually complete and internally disciplined;
**most findings are clarity/cross-reference items, not architectural gaps.** The
single recurring theme: the consuming phases (4, 8, 9) under-cite contracts that
**are** already specified upstream in Phase 5/Phase 1, so several "major"
Decision-Required items collapse to "add a cross-reference."

Two classes of agent false-positive were caught and dropped in aggregation:
- **Backslash-path findings** (Phase 1 M1–M4, Phase 6 M3): a Read-render artifact.
  Verified by grep — `spec/` contains **zero** backslash paths. Dropped.
- **Already-specified-upstream "gaps"** (Phase 8 D1 partial, D2, D4; Phase 9 D3,
  D5, D6, I1; Phase 5 D2; Phase 4 D1; Phase 7 D7): the interface exists in Phase
  5/1. Re-cast as cross-reference Mechanical fixes (X-M*).

## Per-Phase Verdicts
| Phase | Verdict | critical | major | minor | info |
|-------|---------|----------|-------|-------|------|
| 0 — dead-code-removal | needs-revision | 0 | 0 | 3 | 3 |
| 1 — engine-core | needs-revision | 0 | 2 | 2 | 1 |
| 2 — winding-model-and-compile | needs-revision | 0 | 1 | 2 | 2 |
| 3 — excitation-commutation | needs-revision | 0 | 3 | 1 | 1 |
| 4 — circuit-ode | ready | 0 | 0 | 1 | 1 |
| 5 — agnostic-pipeline | needs-revision | 0 | 2 | 2 | 2 |
| 6 — machine-fixtures | needs-revision | 0 | 6 | 1 | 2 |
| 7 — editors | needs-revision | 0 | 5 | 2 | 1 |
| 8 — detailed-mode | needs-revision | 0 | 1* | 2 | 1 |
| 9 — saturation-and-render-polish | needs-revision | 0 | 1* | 2 | 1 |

\* Phase 8/9 major counts after cross-phase resolution (originally 2/3; the rest
were already-specified upstream).

---

## Mechanical Fixes (apply with user approval)

### Genuine spec defects (clear, no design choice)
| ID | Severity | Phase | Location | Problem | Proposed Fix |
|----|----------|-------|----------|---------|--------------|
| P0-M1 | minor | 0 | §Files Owned blockquote | Historical-provenance prose ("`spec/plan.md` was corrected by the spec-authoring step…") banned by rules.md | Delete the second sentence; keep only "No file content is modified by this phase." |
| P4-M1 | minor | 4 | §Conventions, test-harness paragraph | "(matching Phases 2 and 4)" is self-referential | Replace with "(matching Phases 2 and 3)" |
| P5-M1 | minor | 5 | §Task 5.4.1 index.html script load list | Nine entries after `../../lib/util.js` (`canvas-type.js`…`app.js`) lack the `../../lib/` prefix; literal reading loads them from `lessons/unified_motor/` | Prefix all nine (and verify the engine libs after them) with `../../lib/` |
| P6-M1 | major | 6 | §Task 6.3.2 `synchronous-reluctance.test.js` | `Math.abs(fit.a2) > 1e-9` — `fitCos2` returns `{L0,L2,r2}`; `fit.a2` is `undefined` → assertion always false | Replace `fit.a2` → `fit.L2` |
| P6-M2 | minor | 6 | §Overview "Why three waves" | "`plan.md`'s Phase 6 section is updated to match" — historical-provenance prose | Delete the sentence |
| P7-M1 | major | 7 | §Files Owned | `tests/editors/wiring.test.js` is created by Task 7.5.1 but absent from Files Owned (10 listed, 11 in task-union) | Add `- tests/editors/wiring.test.js — created` |

### Cross-phase-resolved (interface already specified upstream — add a cross-reference / confirming note)
| ID | Severity | Phase(s) | Problem (as raised) | Resolution / Proposed Fix |
|----|----------|----------|---------------------|---------------------------|
| X-M1 | major→info | 8, 5 | Phase 8 §8.2.1 consumes `stack.solve(...).perSliceField` and `runtime.lastSolve` as if unspecified | **Already specified** — Phase 5 §5.2.1 (`solve` returns `perSliceField`) and §5.3.1 step 6 (`runtime.lastSolve = solved`). Add a one-line cross-reference in §8.2.1. |
| X-M2 | minor | 8, 5 | Phase 8 §8.2.2 `build(host, ctx)` uses `ctx.runtime`/`ctx.config` as if unspecified | **Already specified** — Phase 5 §5.4.1 defines `ctx = { runtime, config, view, requestRebuild() }` with a live `runtime`. Add cross-reference. |
| X-M3 | minor | 5, 4 | Phase 5 §5.3.1 maps all voltage conditions to terminalStates `"DC"`; correctness vs Phase 4 unstated | **Correct** — Phase 4 §4.1.1 `stepCurrents` branches only on `OPEN`/`SHORT`; every other token (incl. `"DC"`) uses `V[k]`. Add a one-line note. |
| X-M4 | minor | 9, 5 | Phase 9 §9.1.2 reads `perSliceField[0].satScale`; interface unstated | **Already specified** — Phase 5 §5.1.2 `solve` returns `field:{Az,Br,Bt,satScale}`, and `perSliceField[k]` is that field. Add cross-reference. |
| X-M5 | minor | 9, 8 | Phase 9 §9.1.2 asserts `Br.length === 16*128`; appears to contradict default 256×12 grid | **Correct** — `coggingConfig` (Phase 8) overrides grid to `Nr:8, Ntheta:64`; `factor:2` → `16×128 = 2048`. Add a derivation comment. |
| X-M6 | info | 4, 1 | Phase 4 §4.2.1 uses `buildSalient(...).sweepThetaR(θ).L11`; shape uncited | **Already specified** — Phase 1 §1.4.2 defines `buildSalient → { …, sweepThetaR(θ) → { Az,Br,Bt,L11,torqueArkkio } }`. Add cross-reference. |
| X-M7 | minor | 8, 2 | Phase 8 §8.2.1 `importScripts` omits `winding-model.js` | **Correct omission** — the worker receives `expanded` (already routed via WindingModel on the main thread); `motor-compile` rasterizes pre-resolved features and never calls `LIB.WindingModel`. Add a clarifying note. |

> Note: a spec-wide shorthand `Float64Array([…])` (no `new`) appears in Phases
> 4/5/6/8/9 as pseudo-code for "a Float64Array of these values." Phase 9's agent
> flagged it (its D2). It is understood notation, not a per-phase defect; if
> normalized it should be normalized spec-wide. Recommend: leave as understood
> notation (info, no edit).

---

## Decision-Required Items (user must choose)

> Each item lists a **Recommended** option. Items resolved above are not repeated.

### X-D1 — Per-slice grid accessor on `MotorStack` is unspecified (major, cross-phase: Phase 5 + 8)
- **Problem**: Phase 8 §8.2.1 `compute({kind:"fieldMap"})` and `session.fieldFrame()` need "the slice grid for that slice," and Phase 5's mount (§5.4.1 step 4) feeds `drawGapField` "from `perSliceField[*]` + the slice grid" — but Phase 5's `MotorStack` public API (§5.2.1) exposes no per-slice grid accessor, and `perSliceField[k]` carries `{Az,Br,Bt,satScale}` with **no grid**. `MotorSlice` does expose `slice.grid`, but the stack doesn't surface it.
- **Options**:
  - **A (Recommended)** — Amend Phase 5 §5.2.1 to expose a per-slice grid: add `stack.sliceGrid(k) → { Nr, Ntheta, rInner, rOuter, r }` (or expose `stack.slices[k].slice.grid`). Phase 8 then calls it; mount uses it.
  - B — Attach `grid` into each `perSliceField[k]` entry returned by `solve` (changes the field payload shape; heavier message in the worker).
  - C — Have Phase 8 rebuild the grid from `expanded.slices[k].section.grid` × `factor` instead of asking the stack (couples Phase 8 to the refinement arithmetic).

### X-D2 — Phase 10 exists in the plan but has no spec file and no manifest entry (minor, cross-phase)
- **Problem**: `plan.md` defines Phase 10 (Legacy Reference Review + machine-agnosticism guard, Task 10.1.1) and shows it in the dependency graph, but there is no `spec/phase-10-*.md` and no `phases[]` entry. Its substance (git-diff freeze guard + machine-name audit) is in the manifest's top-level `verification[]`. `implement-hybrid` will run it as final verification, not as an implementation wave.
- **Options**:
  - **A (Recommended)** — Confirm intentional; add a one-line note in `plan.md` that Phase 10 is realized as the manifest `verification[]` block (no implementation files), documenting the discrepancy.
  - B — Author a real `spec/phase-10-*.md` + manifest `phases[]` entry (a no-files audit task) for symmetry.
  - C — Leave as-is (accept the undocumented divergence).

### Phase 1
- **P1-D1 — `arkkio` gap-extent `rOuter_gap`/`rInner_gap` derivation undefined (major).** `gapBand` is integer indices; the normalization denominator depends on cell-centre vs face span. Options: A cell-centre (`op.r[iOuter]−op.r[iInner]`); **B (Recommended)** face-to-face (`op.r[iOuter]+dr/2 − (op.r[iInner]−dr/2)`); C cell-count×dr.
- **P1-D2 — `coenergy` parameter `Jz` is never consumed (major).** Options: **A (Recommended)** remove `Jz` from the signature (unit solves use `coilMasks`; PM solve uses `Jz=0`); B additive background on unit-current solves; C background for the PM solve only.
- **P1-D3 — `setGapBand` used but not in the method enumeration (minor).** Options: **A (Recommended)** add `op.setGapBand({iInner,iOuter})` to the API list; B make `op.gapBand` a writable property.
- **P1-D4 — "All tests pass" criterion contradicts the guarded-require Note (minor).** Options: **A (Recommended)** narrow the criterion to the two smoke tests; B merge the Note into the criterion.
- **P1-D5 — `coenergy` warm-start strategy ambiguous (info).** Options: A same-circuit/opposite-angle; **B (Recommended)** cold-start (test-only function, simplest); C warm-start from operating-point `Az`.

### Phase 2
- **P2-D1 — non-contiguous `circuit` indices in `motor-compile` (major).** `nCircuits = 1+max(circuit)` silently allocates phantom zero masks for gaps. Options: **A (Recommended)** document contiguity as a caller guarantee (+ note in Phase 5 config-schema); B fast-fail validation in `compile`; C renumber pass.
- **P2-D2 — `coveredCells` periodic-wrap algorithm undefined for negative lower bound (minor).** `conductorFeatures` produces `t0 = −angularWidth/2` for slot 0. Options: **A (Recommended)** specify normalize-to-[0,2π) algorithm + add a wrap test; B require callers to pre-normalize `t0≥0`.
- **P2-D3 — `conductorFeatures` test doesn't verify wrap-case geometry (minor, paired with P2-D2).** Options: **A (Recommended)** assert slot-0 `thetaRange[0]` (or via compile, per P2-D2); B integration assertion through `compile`; C accept gap, rely on P2-D2/A.
- **P2-D4 — `circuitMeta` returned by `ampereConductors` never asserted (info).** Options: **A (Recommended)** add a minimal structural assertion; B document the intentional gap.
- **P2-D5 — "sampled slot" undefined in the m≠3 test (info).** Options: **A (Recommended)** name concrete slots covering both polarities; B assert all Q slots; C accept current phrasing.

### Phase 3
- **P3-D1/D2/D3 — three tests use discovery phrasing instead of concrete values (major, grouped).** `"PULSE dead sector"` (θ in `[2π/3,π)`), `"STEP mode:none"` (t in `[1/3,1/2)`), `"mechanical AC commutation"` ((t,θ) with gate −1 & cos +). Options: **A (Recommended)** pin the agent's worked midpoints (θ=3π/4; t=5/12; t=0,θ=3π/2,amp=10,freq=1 → V=−10); B pin alternative concrete values; C split into separate gate+composition assertions.
- **P3-D4 — Wave-3.2 heading vs Task-3.1.2 numbering anomaly (minor; merges the agent's M1+D4).** Options: A annotate the heading only (keep `3.1.2`, plan-aligned); B full renumber `3.1.2→3.2.1` (coordinated spec+manifest+cross-ref edits); **C (Recommended)** annotate the heading (= A) — least churn, stays plan/manifest-consistent.
- **P3-D5 — `DC` under electronic modes ignores `base`; rationale undocumented (info).** Options: **A (Recommended)** add one clarifying sentence; B leave as-is.

### Phase 5
- **P5-D1 — `field-render.js` module-level `LIB.EM` guard vs "no LIB.EM dependency" / "byte-unchanged" (major).** The existing `if(!LIB.EM) throw` fires at load even though `drawGapField` doesn't use EM. Options: A keep guard, future headless tests shim `LIB.EM={}` (+ note); B relax guard to per-function (not byte-unchanged); **C (Recommended)** tighten the acceptance wording — "`drawGapField` body references no `LIB.EM`; module guard byte-unchanged" + note that headless render tests shim `LIB.EM`.
- **P5-D3 — `mount.js` built-in default config underspecified (major).** No params given; the "rotor visibly turns" criterion needs working geometry. Options: A state full params inline; **B (Recommended)** reference the §5.5.1 `woundConfig()` values; C minimal parameter constraints only.
- **P5-D4 — default-backend delegation (`solveSaturated` vs `pcg`) not directly tested (minor).** A wrong impl routing both through `pcg` passes all stated tests. Options: A add a default-backend spy test; **B (Recommended)** assert `r.field.satScale` is finite in the first solve test (behavioral, survives renames); C accept gap, note it.

### Phase 6
- **P6-D1 — `induction-1ph` test uses `Tboth` before it is defined (major).** Options: A reverse assertion order (module-scope `Tboth`); **B (Recommended)** combine into one test block; C use a standalone `1e-6` floor denominator.
- **P6-D2 — `vr-stepper` literal embeds invalid token `phaseOffset:-2π·k/3 via terminal.phaseOffset` inside `commutation:{}` (major; near-mechanical).** Options: **A (Recommended)** move `phaseOffset` into `terminal`, delete from `commutation`, drop the clarifying sentence; B expand to a written-out 3-entry array.
- **P6-D3 — `crossCheck` helper missing the `max(|arkkio|,|coe|)>1e-5` skip guard from the class-(B) definition (major).** At near-zero torque it collapses to `rel≤1e-6` (impossible). Options: **A (Recommended)** add the guard inside `crossCheck`; B move the standstill crossCheck angles to ones with `>1e-5` torque; C guard at each call site.
- **P6-D4 — `pm-stepper` holding-torque test "energize phase 0 only" is unproven (major).** Whether circuit 1 is gated off at `stepIndex 0` depends on Phase-3 `sectorGate` boundary. Options: **A (Recommended)** explicitly set `circuits[1].terminal.type="OPEN"` (clone+rebuild); B replace with a structural self-start/settle check; C pin the `sectorGate` boundary in Phase 3 and reference it.
- **P6-D5 — `wound-field-synchronous` load-angle test uses `phaseOffset += δ` across three sequential runs without reset (major).** Increments accumulate; `avgTorqueAtSpeed` resets state but not `circuits`. Stator circuits are indices 1–3 (field=0), not stated. Options: **A (Recommended)** fresh `build` per δ + absolute offsets `= -2πk/3 + δ` on circuits 1–3; B single build, set absolute offsets before each run; C three pre-built runtimes.
- **P6-I1 (info)** — Task 6.1.2 acceptance lists `expand()`-dependent assertions that can't run until Wave 6.3 (misleadingly forward-looking; covered correctly in 6.3.2). **P6-I2 (info)** — `induction-1ph` crossCheck current vector is a prose placeholder; should be a concrete `Float64Array`. Recommend: tidy both.

### Phase 7
- **P7-D1 — `capPhaseSplit` formula contradicts its boundary statements AND acceptance criteria (major, real bug).** Formula `atan2(1/(2πfC),R)` gives C=0→π/2 (spec says 0) and fC→∞→0 (spec says π/2); acceptance `capPhaseSplit(0,50,5)===0` matches the (physically-backwards) boundary text, not the formula. Options: A adopt `atan2(1,2πfCR)` with `if(C===0)return 0` guard; **B (Recommended)** keep `atan2(1/(2πfC),R)` and replace the three boundary statements with explicit guards (C=0→0, R=0→π/2, drop the fC→∞ claim) so formula+guards+acceptance agree; C fully piecewise definition. **The physical direction (does larger C give more or less phase shift?) must be confirmed by the author.**
- **P7-D2 — `windingFactor` reference winding ("full-pitch concentrated, equal total conductors") undefined (major).** Options: A define a concrete 2-slot full-pitch reference routing; **B (Recommended)** replace with the analytic normalization `k_w = amps[h-1]/(4·T_total/(π·h))` (no reference object); C drop `windingFactor`, show raw spectrum only.
- **P7-D3 — `MatrixPanel.synthesize` `rRange` "split evenly across the gap" algorithm unspecified (major).** Options: A halve at midpoint; **B (Recommended)** derive the rotor/stator boundary from `gapBand` (`gapR = rInner + (rOuter−rInner)·iInner/Nr`), split each side evenly; C fixed per-element lookup table.
- **P7-D4 — winding editor "active ring" selection model undefined (major).** Options: A implicit polar hit-test; **B (Recommended)** explicit ring-picker in the panel (handles multi-wound configs, testable); C default to first wound ring (silent multi-ring limitation).
- **P7-D5 — `Schematic.lower` capacitor uses `terminal.freq`, undefined for non-AC terminals → NaN (minor).** Options: **A (Recommended)** skip when `terminal.type !== "AC"` (zero-not-skip aligned); B treat missing `freq` as 0 (interacts with P7-D1).
- **P7-D6 — `buildGeometry` `nCircuits` / `conductor.circuit` global-vs-local indexing ambiguous for multi-wound configs (minor).** Options: **A (Recommended)** global indices throughout + a 2-wound-ring acceptance test; B ring-local indices with per-ring `circuitColor` calling convention.

### Phase 8
- **P8-D3 — worker `stepsPerMessage` field-attachment counter bookkeeping unspecified (minor).** Where the counter lives, reset on start/reset, first-post behavior. Options: **A (Recommended)** module-scoped `postCount`, reset on `start`/`reset`, field when `postCount % stepsPerMessage === 0`; B tick-local counter resetting after each attach.
- **P8-D5 — `coggingConfig` gap band spans one radial cell (`iInner:4,iOuter:5`) (info).** Options: A widen to 2 cells (`iInner:3,iOuter:5`); **B (Recommended)** add a note that the 1-cell band is intentional (the test checks Richardson ratios, not absolute accuracy).

### Phase 9
- **P9-D1 — `extrudeAnnulus` returns identical `front` and `outerWall` rings; "wall" rings don't span z (major).** Internal inconsistency (description says cylinders; definition gives single rings at z0). Options: A set `outerWall` at z1 (four distinct end-rings); **B (Recommended)** make each wall a `[z0-ring, z1-ring]` pair (matches "wall" semantics, gives `paint` barrel geometry; update the T9.2.2 test); C drop `outerWall` (three-ring return).
- **P9-D4 — tooth-tip rolloff test `thPk` sweep resolution unspecified (minor).** Options: **A (Recommended)** specify `n=32` uniform samples over `[thUnalign,thAlign]`; B pin `thPk=thAlign`; C bisection tolerance.

---

## Items resolved in aggregation (no action; recorded for traceability)
- Phase 1 M1–M4, Phase 6 M3 — **false positives** (backslash paths; grep confirms none). Dropped.
- Phase 8 D1 (perSliceField/lastSolve), D2 (importScripts), D4 (ctx); Phase 9 D3
  (satScale), D5 (grid arithmetic), D6 (coggingConfig props), I1 (markers);
  Phase 5 D2 (terminalStates DC); Phase 4 D1 (buildSalient); Phase 7 D7 (markers)
  — **resolved by cross-phase view**; converted to cross-reference Mechanical
  fixes X-M1…X-M7 (and confirmations).
- Cross-phase shared-file (`field-render.js`, `index.html`) — sanctioned/additive
  → `info`, no action.
