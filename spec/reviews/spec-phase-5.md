# Spec Review: Phase 5 — agnostic-pipeline

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 1 | 3 | 4 |
| minor    | 1 | 2 | 3 |
| info     | 2 | 0 | 2 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 5.1.1 config-schema.js + expand() | yes | Full vocabulary-complete requirement covered |
| 5.1.2 motor-slice.js + SolveBackend | yes | API, coarse backend, extractCoeffs all specified |
| 5.1.3 field-render.js drawGapField extension | yes | Function signature, geom, opts, cell mapping all present |
| 5.2.1 motor-stack.js N≥1 aggregator | yes | No-bypass loop, coenergyTorque, clearWarmStart all present |
| 5.3.1 motor-run.js temporal driver | yes | Per-tick chain, state tiers, reset, clearFieldCache all present |
| 5.4.1 mount.js + index.html + user-required gate | yes | Registration seams, 3-zone layout, rAF loop, user-required flag all present |
| 5.5.1 pipeline test suite + agnosticism milestone | yes | Four smoke configs, Maxwell-vs-co-energy, machine-name grep all present |
| Plan verification: ≥3 structurally-different configs + N=2 through identical path | yes | Four configs in agnostic-pipeline.test.js §"all configs run the identical MotorRun path" |
| Plan verification: rotor visibly turns | yes | `|θ| > 1e-3` assertion in 5.5.1 + browser checklist in 5.4.1 |
| Plan verification: Maxwell-vs-co-energy agreement asserted as a test | yes | `≤ 0.10` relative in agnostic-pipeline.test.js |
| Plan verification: grep of lib/ + mount.js for machine names returns zero | yes | Asserted in agnostic-pipeline.test.js §"lib/ and mount.js are free of machine names" |

---

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §Task 5.4.1 "Files to create" — index.html script load order | After `../../lib/util.js`, nine consecutive lib files (`canvas-type.js`, `registry.js`, `plot.js`, `integrate.js`, `draw.js`, `layout3d.js`, `em-physics.js`, `field-render.js`, `coil-render.js`, `app.js`) are listed without the `../../lib/` prefix. A literal reading would load them from `lessons/unified_motor/`. All nine exist in `lib/`. | Prefix each of those nine entries with `../../lib/`, making them `../../lib/canvas-type.js`, `../../lib/registry.js`, etc. Applies only to those nine; `airgap-grid.js` and the other engine libs listed immediately after already follow the `../../lib/` prefix convention in the spec text. |

---

### Decision-Required Items

#### D1 — `field-render.js` module-level `LIB.EM` guard vs. "no LIB.EM dependency" claim (major)
- **Location**: §Task 5.1.3 "Files to modify" and "Acceptance criteria"
- **Problem**: The existing `lib/field-render.js` opens with a hard dependency check:
  ```js
  if (!LIB.EM) throw new Error("LIB.FieldRender requires lib/em-physics.js");
  ```
  The spec states that `drawGapField` "adds no dependency on `LIB.EM`" and instructs that "existing entries [are] unchanged" / "loop-centric renderers byte-unchanged". It also says the acceptance criterion is that `drawGapField`'s **source** references no `LIB.EM` symbol. However, the module-level guard (which IS in the existing body) will throw at load time if `LIB.EM` is absent — regardless of whether `drawGapField` itself uses it. The `index.html` script list in §Task 5.4.1 includes `em-physics.js` before `field-render.js`, so browser loading is fine. But if a future headless test (Phase 9 render geometry test) tries to `require("field-render.js")` without a shim for `LIB.EM`, it will throw. The spec is silent on whether the implementer should relax or stub the guard, and whether "byte-unchanged" covers the guard.
- **Why decision-required**: Two legitimate interpretations exist with different implementation consequences. "Byte-unchanged" could mean the guard stays and Phase 9 must shim `LIB.EM`; or "no LIB.EM dependency" could mean the guard should be relaxed to allow headless loading. The spec does not resolve this.
- **Options**:
  - **Option A — Guard stays, future phases shim EM**: Leave the module-level guard byte-unchanged. Add a note in §Task 5.1.3 that any headless test importing `field-render.js` must shim `LIB.EM` (an empty object suffices).
    - Pros: Truly "byte-unchanged"; no guard-relaxation logic needed; the browser path (where EM is always loaded) is unaffected.
    - Cons: Future headless phases (Phase 9 render test) silently depend on a shimming convention not stated in this spec; inconsistent with the "no LIB.EM dependency" claim.
  - **Option B — Relax the guard to a conditional**: Change the guard to check `LIB.EM` only for the three functions that actually use it (`drawLoopFieldLines`, `drawMomentArrow`, `drawBarMagnet`), or move it into those functions' bodies, so the module loads headless and `drawGapField` is callable without `LIB.EM`.
    - Pros: Makes "no LIB.EM dependency" literally true at module load; headless tests for `drawGapField` work without shimming.
    - Cons: Is NOT "byte-unchanged" for the existing guard; requires the implementer to edit existing code, which the spec says not to do.
  - **Option C — Leave spec as-is, note the inconsistency as a known limitation**: Document in §Task 5.1.3 that the EM guard is retained and the "no LIB.EM dependency" claim refers only to `drawGapField`'s internal source (not load-time), and that the acceptance criterion "source references no `LIB.EM` symbol" is satisfied because the guard references `LIB.EM` for the module, not for `drawGapField` specifically.
    - Pros: No code change needed; acceptance criterion is technically satisfiable.
    - Cons: Leaves an inconsistency that will confuse the implementer; the acceptance criterion text would need to be made more precise to avoid a wrong implementation.

---

#### D2 — `motor-run.js` step(): circuit-step `terminalStates` mapping drops `AC`/`PULSE`/`STEP`/`DC` distinction (major)
- **Location**: §Task 5.3.1 "Files to create" — `runtime.step(dt)` step 3
- **Problem**: The spec says:
  > "for each `k`, `terminalStates[k] = conditions[k].kind === "open" ? "OPEN" : conditions[k].kind === "short" ? "SHORT" : "DC"`"

  `LIB.Excitation.evalDrive` (Phase 3) returns a `TerminalCondition` with `kind ∈ {"voltage", "open", "short"}`. When `kind === "voltage"`, the spec maps it to `"DC"` regardless of whether the original terminal type was `AC`, `PULSE`, or `STEP`. But Phase 4 (`motor-circuit.js`) defines `V = R·i + dλ/dt` per circuit and the `TerminalCondition` for a voltage source carries `{ kind:"voltage", V }` — so the only thing `motor-circuit.advance` needs is `V` and the `OPEN`/`SHORT` flags. Calling voltage sources `"DC"` in `terminalStates` is a naming convention the implementer must align with Phase 4's `advance` signature. If `LIB.MotorCircuit.advance` uses `terminalStates` values as an enum (and they could be `{"voltage","open","short"}` or `{"DC","AC","OPEN","SHORT"}` — Phase 4's spec determines this), there is a mismatch. The Phase 5 spec does not reproduce the `advance` signature, nor does it state which enum values `motor-circuit.advance` accepts for `terminalStates`.
- **Why decision-required**: The implementer of `motor-run.js` must know what enum values `LIB.MotorCircuit.advance` accepts for `terminalStates[k]`. The Phase 4 spec is the authority, but Phase 5 uses `"DC"` as the voltage fallback without cross-referencing that value against Phase 4's vocabulary. This is a cross-phase interface underspecification that could produce a silent no-op (wrong enum value → branch not taken).
- **Options**:
  - **Option A — Add a cross-reference note**: Add a sentence to §Task 5.3.1 step 3 stating: "`terminalStates[k]` must use the enum values accepted by `LIB.MotorCircuit.advance` for voltage sources — confirm against the Phase-4 spec (`motor-circuit.js`) that `"DC"` is the accepted value; if the enum there is `"voltage"`, substitute accordingly."
    - Pros: Makes the cross-phase dependency explicit without changing the logic; implementer has exact guidance.
    - Cons: Leaves ambiguity until the implementer reads Phase 4; requires two-spec coordination at implementation time.
  - **Option B — Reproduce the accepted enum values from Phase 4 inline**: Inline the relevant excerpt from the Phase 4 spec (the `terminalStates` vocabulary) into §Task 5.3.1 step 3, so the implementer has no cross-phase lookup.
    - Pros: Task 5.3.1 is self-contained; no Phase-4 consultation needed.
    - Cons: Risks desync if Phase 4's spec is revised; duplication.
  - **Option C — Remove the `terminalStates` intermediary, pass `conditions` directly**: Rewrite step 3 to pass `conditions[k]` (the raw `TerminalCondition`) to `LIB.MotorCircuit.advance` directly, and specify that `advance` accepts `{kind:"voltage"|"open"|"short", V}` objects — eliminating the enum-rename step entirely.
    - Pros: No enum translation, no cross-phase naming mismatch, matches the Phase-3 output shape directly.
    - Cons: Would require confirming Phase 4's `advance` accepts this form; may be a change to the Phase 4 contract.

---

#### D3 — `mount.js` built-in default config is underspecified (major)
- **Location**: §Task 5.4.1 "Files to create" — `UnifiedMotor.mount(host)` step 1
- **Problem**: The spec says:
  > "Resolves the initial config: `UnifiedMotor.defaultConfig` if set (Phase 6/7 override it), else a **built-in default it constructs inline** (a current-fed wound machine via `ConfigSchema.expand`)"

  The built-in default config's full parameter set — grid dimensions, `gapBand`, `poles`, `mechanical`, ring definitions, circuit topology, and `stack` — is not specified. The implementer must invent these values. A wrong default (e.g., grid too coarse to produce non-zero torque, or a geometry where no field lines reach the gap band) would cause the "rotor visibly turns" browser acceptance criterion to fail, but the spec provides no grounding values to prevent this. The `woundConfig()` fixture in §Task 5.5.1 specifies a working wound machine that could serve as this default, but the spec does not say to reuse it.
- **Why decision-required**: The implementer could use any geometry that works; the spec author likely has a canonical set of parameters in mind that should be stated explicitly to ensure the browser acceptance criterion is met without trial-and-error.
- **Options**:
  - **Option A — Specify the default config parameters inline**: Add to §Task 5.4.1 step 1 the exact config values the built-in default should use — grid, gapBand, poles, ring definitions, and mechanical params. This could be the same parameters as `woundConfig()` in §Task 5.5.1, stated explicitly.
    - Pros: Implementer has no decisions to make; browser acceptance criterion is deterministically satisfiable.
    - Cons: Duplicates information from §Task 5.5.1 if reusing `woundConfig` values.
  - **Option B — Reference `woundConfig()` explicitly**: Add to §Task 5.4.1 step 1: "The built-in default uses the same parameter values as the `woundConfig()` fixture defined in §Task 5.5.1."
    - Pros: No duplication; unambiguous; the fixture already exists in the spec.
    - Cons: Creates a cross-task dependency (5.4.1 depends on reading 5.5.1); both tasks are in different waves, but `_fixtures.js` is authored in wave 5.5, not available to `mount.js` at wave 5.4 implementation time.
  - **Option C — Defer to implementer judgment with a constraint**: Add a note that the built-in default must be a 2-pole single-stator `W` ring + salient `I` rotor config with `mechanical.J ≥ 1e-5` and grid `Ntheta ≥ 64` — bounding the parameter space without prescribing exact values.
    - Pros: Gives the implementer some freedom while ruling out degenerate configs.
    - Cons: Still leaves parameter guessing; "Ntheta ≥ 64" is not the same as "Ntheta = 256"; the specific torque output is unpredictable.

---

#### D4 — `motor-slice.js` acceptance criterion: "coarse backend uses PCG + global ceiling" is only partially checkable (minor)
- **Location**: §Task 5.1.2 "Acceptance criteria" — second bullet
- **Problem**: The spec states:
  > "With no `opts.backend`, `create` uses the coarse backend (PCG + global ceiling): `prepare` builds the operator at `section.grid` and `solve` delegates to `LIB.AirgapSolve.solveSaturated`, `extractCoeffs` to `LIB.AirgapSolve.pcg`."

  The test for this criterion in `motor-slice.test.js` is described as asserting the spy backend behavior in the fourth bullet ("honors a custom SolveBackend"). However, there is no test described that asserts the *default* backend actually calls `LIB.AirgapSolve.solveSaturated` (rather than `.pcg`) for `solve` and `.pcg` for `extractCoeffs`. The spy test only verifies routing with a *custom* backend. Without a default-backend spy test, an implementer who wires both paths to `.pcg` (skipping the ceiling) would satisfy every stated test while violating this criterion.
- **Why decision-required**: Adding a test requires choosing what to assert: a spy on `LIB.AirgapSolve`, a nominal result comparison, or a structural check of the coarse backend object. Each has different tradeoffs in coupling.
- **Options**:
  - **Option A — Add a default-backend spy test in motor-slice.test.js**: Describe a test `"default backend delegates to AirgapSolve.solveSaturated"` that temporarily replaces `LIB.AirgapSolve.solveSaturated` with a spy, calls `slice.solve`, asserts the spy was called, then restores it. Similarly for `LIB.AirgapSolve.pcg` on `extractCoeffs`.
    - Pros: Directly verifiable; catches wrong-method routing.
    - Cons: Couples the test to the internal delegation structure; fragile if Phase 1 renames the method.
  - **Option B — Assert the satScale is present**: Add to the first `motor-slice.test.js` bullet: `r.field.satScale` is a finite number (it is only populated by `solveSaturated`, not `linearSolve`/`pcg`), confirming the ceiling path was taken.
    - Pros: Tests behavior rather than internal delegation; non-fragile to method renaming.
    - Cons: If `pcg` is incorrectly used but happens to set `satScale`, the test would pass; relies on Phase 1's contract that `pcg` returns no `satScale`.
  - **Option C — Leave as-is with an info note**: Accept that the coarse backend delegation is verified implicitly by the end-to-end behavior (if the ceiling weren't applied, saturation tests elsewhere would catch it) and document this as a known coverage gap.
    - Pros: No spec change needed.
    - Cons: The coverage gap remains; a wrong implementation could pass all Phase-5 tests and fail only at Phase 9 saturation tests — late failure detection.

---

### Info Items

#### I1 — `MACHINE_NAMES` grep list excludes "stepper" in some forms but includes it in others (info)
- **Location**: §Task 5.5.1 `tests/pipeline/_fixtures.js` — `MACHINE_NAMES` definition
- **Problem**: The spec lists `MACHINE_NAMES` as `["bldc","pmsm","srm","squirrel","stepper","brushed","universal-motor","wound-field"]`. The token `"stepper"` is included, but the Phase-6 machine fixture filenames include `vr-stepper`, `pm-stepper`, and `hybrid-stepper` (which would match "stepper" as a substring). Meanwhile, `"synchronous"` is excluded from `MACHINE_NAMES` because it "names physics, not a machine identity" — yet `wound-field-synchronous` is a machine. The list is described as intentionally partial ("the exhaustive repo-wide audit is Phase 10"), so these exclusions are deliberate. This is an observation, not a defect; the rationale is documented inline.
- **No action required** — the spec explains the scope limitation explicitly. Recorded for awareness.

#### I2 — `rctx` parameter naming inconsistency in `registerRender3D` contract (info)
- **Location**: §Task 5.4.1 "Files to create" — `UnifiedMotor.RENDER3D` / `registerRender3D`
- **Problem**: In the `RENDER3D` slot definition, the paint signature is:
  > `entry = { id:string, paint(ctx, L3, rctx) → void }` where `rctx = { runtime, config, expanded, W, H }`

  But in the mount's render step (step 4), the call is written as:
  > `UnifiedMotor.RENDER3D.paint(ctx, L3, { runtime, config, expanded, W, H })`

  The inline call does not name the third argument `rctx` — it constructs the object literal directly. This is not a contradiction (the object shape matches), but the parameter name `rctx` in the type signature is never used in the call site example. Future consumers of the seam (Phase 9) read the paint signature first and may expect a named object, which is fine, but the two presentations could be unified for clarity.
- **No action required** — purely stylistic. Recorded for awareness.
