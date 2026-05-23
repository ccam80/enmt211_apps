# Spec Review: Phase 8 — detailed-mode

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 2 | 2 |
| minor    | 0 | 3 | 3 |
| info     | 0 | 1 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 8.1.1 airgap-refine.js refined SolveBackend | yes | Fully covered with API signatures, acceptance criteria, and tests |
| 8.2.1 airgap-worker.js worker harness + tier selector | yes | Fully covered with API, message protocol, and tests |
| 8.2.2 detailed-toggle.js Live/Detailed header control + result panel | yes | Fully covered with API and tests |
| 8.3.1 detailed-mode test suite + index.html wiring (browser-verified) | yes | Covered; user-required flag set correctly in manifest |
| Phase 8 verification: worker round-trips a torque-vs-angle table | yes | `airgap-worker.test.js` sweep test covers this |
| Phase 8 verification: refined cogging/detent grid-converged to ~1–5% (Richardson, factor 2 vs 4) | yes | `cogging.test.js` ≤5% criterion between factor:2 and factor:4 |
| Phase 8 verification: provably finer than the Live coarse estimate | yes | `cogging.test.js` asserts Live outside the 5% band |
| Phase 8 verification: UI stays responsive (no blocking) | yes | Browser-verified in Task 8.3.1 user-required checklist |

## Findings

### Mechanical Fixes

None found.

---

### Decision-Required Items

#### D1 — `perSliceField` and `lastSolve` are Phase-5 internal API consumed without being specified (major)

- **Location**: phase-8 §Task 8.2.1 "Files to create" → `compute` / `createSession` / `session.fieldFrame`
- **Problem**: Task 8.2.1 specifies three code sites that depend on undescribed Phase-5 `MotorStack`/`MotorRun` internal API:
  1. `compute({ kind:"fieldMap" })` uses `r = stack.solve(θ, cur)` and then `f = r.perSliceField[request.sliceIndex ?? 0]` — asserting that `MotorStack.solve()` returns an object with a `perSliceField` array.
  2. `createSession` defines `session.fieldFrame(sliceIndex)` as `from runtime.lastSolve.perSliceField[sliceIndex]` — asserting that `LIB.MotorRun.step()` stores a `lastSolve` property containing `perSliceField`.
  3. `compute({ kind:"fieldMap" })` references `g = stack` slice grid for that slice" to populate the `grid` return field — no `MotorStack` method to retrieve a per-slice grid is named or described.

  None of `perSliceField`, `lastSolve`, or a slice-grid accessor appear in Phase 5's plan description, and Phase 8's spec does not call out these as Phase-5 contracts that must exist. An implementer of Phase 8 working from this spec alone cannot know whether `MotorStack.solve()` returns `perSliceField`, what shape `lastSolve` has on `MotorRun`, or what method to call to recover a slice's grid dimensions.

- **Why decision-required**: There are multiple distinct resolution paths, each with implications for Phase 5's spec:
  - Option A pins the required Phase-5 API surface in the Phase-8 spec directly.
  - Option B adds cross-references to Phase 5's spec (or amends Phase 5's spec to document these fields).
  - Option C eliminates `fieldMap` from the Phase-8 `compute` dispatch (deferring field-map capability) and eliminates `fieldFrame` from `createSession`, using only the `sweep` path and `frame.field` streamed from the time-domain run.

- **Options**:
  - **Option A — Pin the Phase-5 API in Phase 8's spec**: Add a "Phase-5 API surface required by Phase 8" subsection to the Phase-8 Conventions block, specifying:
    - `LIB.MotorStack.solve(theta, currents) → { torque, fluxLinkages, perSliceField: Array<{ Br:Float64Array, Bt:Float64Array }> }` — `perSliceField[k]` is the field of slice `k`.
    - `MotorStack` exposes a `sliceGrid(k) → { Nr, Ntheta, rInner, rOuter, r:Float64Array }` method (or equivalent) used by `fieldMap` to populate the `grid` return object.
    - `LIB.MotorRun` stores `runtime.lastSolve` after each `step(dt)`, with shape `{ torque:number, perSliceField: Array<{ Br:Float64Array, Bt:Float64Array }> }`.
    - Pros: Phase-8 spec becomes self-contained; implementer has everything needed; no cross-spec chase.
    - Cons: If Phase 5's spec was written differently, this creates a contradiction between specs that needs reconciling before Phase 8 can be implemented; duplicates API description across phases.
  - **Option B — Add cross-references to Phase 5's spec**: In Phase 8 at each of the three code sites, add an explicit note: "requires `MotorStack.solve()` to return `perSliceField` as specified in Phase 5 §Task 5.2.1" and "requires `MotorRun.lastSolve` as specified in Phase 5 §Task 5.3.1." Amend Phase 5's spec to document these as explicit public API.
    - Pros: Single source of truth stays in Phase 5; Phase 8 implementer knows where to look.
    - Cons: Requires amending Phase 5's spec; an implementer still has two docs to read; Phase 5 may need to be re-reviewed.
  - **Option C — Eliminate `fieldMap` compute kind and `session.fieldFrame`**: Remove `compute({ kind:"fieldMap" })` from the `AirgapWorker.compute` API. Remove `session.fieldFrame()` from `createSession`. The field data is already delivered as the optional `field` attachment in the `"frame"` message streamed during a time-domain run. This is the only consumer path the toggle's result panel uses anyway (it calls `session.fieldFrame()` which reads `runtime.lastSolve.perSliceField`, not `compute`).
    - Pros: Removes the underspecified API surface; simplifies the worker; eliminates the Phase-5 dependency gap.
    - Cons: Loses the ability to request a one-shot field map without starting a time-domain session; the `airgap-worker.test.js` `"fieldMap returns refined-length field arrays"` test would need to be replaced or removed.

---

#### D2 — `importScripts` list omits `winding-model.js` (major)

- **Location**: phase-8 §Task 8.2.1 "Files to create" → worker bootstrap `importScripts` list
- **Problem**: The spec states the worker bootstrap runs:
  ```
  self.importScripts("util.js", "integrate.js", "airgap-grid.js",
  "airgap-solve.js", "airgap-torque.js", "motor-compile.js", "excitation.js",
  "motor-circuit.js", "motor-slice.js", "motor-stack.js", "motor-run.js",
  "airgap-refine.js");
  ```
  `motor-compile.js` is included, but `winding-model.js` is absent. Phase 2's plan task 2.1.1 and 2.2.1 describe `winding-model.js` as a separate module consumed by `motor-compile.js`. If `motor-compile.js` (an IIFE attaching to `window.LIB`) reads `LIB.WindingModel` — which it would if `motor-compile` uses `winding-model`'s conductor-feature data structures — then the worker would throw a reference error when `motor-compile.js` is imported, because `LIB.WindingModel` would not yet exist. The Phase 8 spec does not mention this dependency and gives the implementer no guidance on whether to include `winding-model.js`.

- **Why decision-required**: Whether the omission is a bug depends on Phase 2's `motor-compile.js` implementation: if `motor-compile` is a pure function of raw feature arrays (no `LIB.WindingModel` call at load time), the omission is correct. If it depends on `LIB.WindingModel`, the omission is a bug. Neither this spec nor the plan is explicit. The fix is either to add `winding-model.js` to the list (safe, possibly redundant) or to confirm the omission is intentional by documenting why `motor-compile` does not need it.

- **Options**:
  - **Option A — Add `winding-model.js` to the importScripts list**: Insert `"winding-model.js"` before `"motor-compile.js"` in the list. This is safe whether or not the dependency exists.
    - Pros: Defensive; eliminates any load-order risk; consistent with Phase 2's description of `winding-model` as `motor-compile`'s input.
    - Cons: Loads an extra module the worker may not need; if Phase 2 kept `winding-model` features embedded in `motor-compile`'s closure, this is a no-op load.
  - **Option B — Add an explicit note that `motor-compile.js` is self-contained and does not depend on `winding-model.js` at load time**: Add a parenthetical in the importScripts paragraph: "(`motor-compile.js` rasterizes pre-resolved feature arrays — `winding-model.js` is a build-time-only dependency, not a load-time one; it is not needed in the worker.)"
    - Pros: Documents the design decision; keeps the list minimal.
    - Cons: Introduces a claim about Phase 2's architecture that may be wrong; requires verifying Phase 2's spec.

---

#### D3 — `stepsPerMessage` field-attachment counter is underspecified (minor)

- **Location**: phase-8 §Task 8.2.1 "Files to create" → Worker bootstrap, `"start"` handler
- **Problem**: The spec says the bootstrap `tick()` "posts a `'frame'` (attaching `session.fieldFrame()` every `stepsPerMessage`-th post)." The spec does not specify: (a) where the post counter lives (module-scope variable? session property?), (b) whether it resets on `"start"`, `"reset"`, or neither, (c) whether the first post always includes a field or skips until the nth. An implementer must invent this bookkeeping.
- **Why decision-required**: Multiple semantics are plausible: "every nth post" could mean every nth tick group (post counter mod stepsPerMessage === 0), or every nth frame (running total). Reset behaviour on `"reset"` vs `"start"` is a distinct choice. Any of these would pass the browser-verification checklist.
- **Options**:
  - **Option A — Specify a module-scoped post counter that resets on `"start"` and `"reset"`**: Add: "A module-scoped `let postCount = 0;` increments each time `tick()` posts a frame; field is attached when `postCount % stepsPerMessage === 0`; `postCount` is reset to `0` on `'start'` and `'reset'` messages."
    - Pros: Deterministic; first post always includes a field; easy to test.
    - Cons: Ties the field cadence to absolute post count rather than elapsed steps.
  - **Option B — Specify that field is attached on every `stepsPerMessage`-th call to `tick()`**: Add: "A local `let ticksSinceField = 0;` counter in the tick closure; when it reaches `stepsPerMessage`, attach field and reset to `0`."
    - Pros: Field cadence is purely driven by tick frequency, independent of reset timing.
    - Cons: First field post is delayed by `stepsPerMessage` ticks.

---

#### D4 — `ctx` shape passed to `build(host, ctx)` by Phase-5 registration seams is unspecified (minor)

- **Location**: phase-8 §Task 8.2.2 "Files to create" → `build(host, ctx)` of header control and result panel
- **Problem**: The spec describes `build(host, ctx)` bodies that access `ctx.config`, `ctx.runtime`, `ctx.runtime.state`, `ctx.runtime.state.theta`, `ctx.runtime.state.omega`, `ctx.runtime.state.i`, and `ctx.runtime.circuits`. These fields are provided by the Phase-5 `registerHeaderControl` / `registerPanel` seams. Phase 8's spec does not define the `ctx` shape and does not cross-reference Phase 5's spec for it. An implementer must discover what Phase 5 passes as `ctx` — whether it is a live proxy, a snapshot, or a reference to the same runtime object.
- **Why decision-required**: If `ctx.runtime` is a live reference to the `LIB.MotorRun` instance, then `ctx.runtime.state.theta` changes every tick and the toggle reads current state at activation time. If it is a snapshot, the seeded worker state will be stale. The behaviour of `ctx.config` (mutable config object vs snapshot) affects what `buildStartMessage` receives after a geometry edit. These distinctions matter for correctness.
- **Options**:
  - **Option A — Document the expected `ctx` shape inline in Phase 8's spec**: Add a "Registration seam `ctx` shape" subsection listing the exact fields Phase-5 passes to `build`: `ctx = { config: <the live config object>, runtime: <the LIB.MotorRun instance>, registerHeaderControl, registerPanel, ... }`.
    - Pros: Phase 8 is self-contained; implementer knows the seam contract.
    - Cons: Duplicates Phase 5 detail; may diverge if Phase 5 is revised.
  - **Option B — Add an explicit cross-reference to Phase 5 §Task 5.4.1 for the seam `ctx` shape**: Write: "The `ctx` argument is the seam context object defined in Phase 5 §Task 5.4.1 (pointer-tool registry, panel registry, header-control slot). Implementers must consult Phase 5 for the exact fields."
    - Pros: Single source of truth in Phase 5; makes the dependency explicit.
    - Cons: Phase 5's task 5.4.1 may not define `ctx` in sufficient detail either (same gap elsewhere).

---

#### D5 — `coggingConfig()` gap band has only one radial cell, which may suppress the Arkkio average signal (info)

- **Location**: phase-8 §Task 8.3.1 "Files to create" → `tests/detailed/_fixtures.js` → `coggingConfig()`
- **Problem**: `coggingConfig()` specifies `grid: { Nr:8, ... }` and `gapBand: { iInner:4, iOuter:5 }`. The gap band spans only rows `[4, 5)`, which is a single radial cell. The Arkkio gap-band average is `(1/Ngap) Σ_i T_i` where `Ngap = iOuter − iInner`. With `Ngap = 1`, the Arkkio average degenerates to a single-shell Maxwell-stress evaluation — the minimal case. Whether this is intentional (keeping the cogging test fast) or an error (producing a noisy/atypical torque average) is unclear.
- **Why decision-required**: If the intent is purely speed (keep the multi-grid convergence test fast), the 1-cell gap band is valid — the test is checking ratio convergence across refine factors, not absolute accuracy against an analytic. If the intent is to exercise the full Arkkio average, the gap band should span at least 2–3 cells. The correct fix depends on whether the author wanted a minimal-grid speed test or a representative-accuracy test.
- **Options**:
  - **Option A — Widen the gap band to span 2 cells**: Change `gapBand: { iInner:3, iOuter:5 }` (2 cells at `Nr=8`). The test still runs fast and exercises a more typical Arkkio average.
    - Pros: More representative of real usage; avoids potential confusion for readers of the fixture.
    - Cons: Minor change to fixture values; no functional impact on the convergence test's pass/fail logic.
  - **Option B — Add an explanatory comment in the `coggingConfig` description**: Add: "(`gapBand` spans one cell intentionally — the cogging test checks Richardson-convergence ratios, not absolute accuracy, so a minimal grid keeps test time low.)"
    - Pros: Clarifies intent without changing fixture values.
    - Cons: Does not fix a potential numerical issue if the 1-cell gap band produces degenerate Arkkio averages on a real implementation.
