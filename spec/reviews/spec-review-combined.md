# Spec Review: Combined Report

## Overall Verdict: **needs-revision**

Per-phase reviews ran in parallel; cross-phase consistency checks performed by the coordinator. Phase 0 and Phase 8 are `ready`; every other phase has at least one Decision-Required item.

## Per-Phase Verdicts
| Phase | Verdict | critical | major | minor | info |
|-------|---------|----------|-------|-------|------|
| 0 — dead-code-removal | ready | 0 | 0 | 1 | 1 |
| 1 — fea-sparse-solver | needs-revision | 0 | 3 | 1 | 2 |
| 2 — parametric-ring-stack-mesher | needs-revision | 2 | 2 | 1 | 1 |
| 3 — current-source-terminal | needs-revision | 1 | 1 | 3 | 1 |
| 4 — harmonic-gap-sliding-interface | needs-revision | 1 | 3 | 1 | 1 |
| 5 — fea-slice | needs-revision | 0 | 1 | 4 | 2 |
| 6 — mesh-render-and-live-ui | needs-revision | 0 | 2 | 2 | 1 |
| 7 — validation | needs-revision | 1 | 5 | 2 | 2 |
| 8 — legacy-reference-review | ready | 0 | 0 | 3 | 1 |
| **Cross-phase** | — | 0 | 1 | 0 | 1 |

## Cross-phase Findings

### X-D1 — `tests/pipeline/_fixtures.js` `CS` export gap between Phase 5 and Phase 7 (major)
- **Phases involved**: 5 (modifies `tests/pipeline/_fixtures.js`) and 7 (consumes from it via `tests/fea-engine/_fixtures.js` which re-requires `../pipeline/_fixtures.js`).
- **Problem**: Phase 7 §T7.1.1 expects `tests/pipeline/_fixtures.js` to re-export `initSolver`, `feaOpts`, **and `CS = UnifiedMotor.ConfigSchema`**. Phase 5 §T5.3.1 explicitly adds `initSolver` and `feaOpts` to that fixture but does not add `CS`. Without `CS`, Phase 7's loader pattern (`const P = require("../pipeline/_fixtures.js"); … const CS = P.CS;`) silently produces `CS = undefined` and every `CS.expand(cfg)` in Phase 7 throws.
- **Options**:
  - **A — Add `CS` export to Phase 5's `tests/pipeline/_fixtures.js` modification list**: Phase 5 T5.3.1's edits add `module.exports.CS = UnifiedMotor.ConfigSchema`. Phase 7's read pattern works as written.
  - **B — Phase 7 derives `CS` locally**: `tests/fea-engine/_fixtures.js` does `const CS = P.UnifiedMotor.ConfigSchema;` (since `UnifiedMotor` is already in `P`'s exports). No Phase 5 change.

### X-I1 — Sequential-wave intra-phase file sharing pattern (info)
- **Phases involved**: 2 (motor-mesh.js across 2.1.a → 2.2.a → 2.3.a), 4 (airgap-harmonic.js across 4.1.a → 4.2.a), 5 (motor-slice.js across 5.1.a → 5.2.a → 5.3.a).
- **Observation**: The review-spec file-locality rule (`rules.md`) flags "two tasks share any file → must be in same manifest group" as critical. Each of these phases explicitly notes the waves run sequentially, eliminating lock contention. Each spec acknowledges the constraint; the rule has no stated sequential-wave carve-out. This pattern is consistent across three phases and is best treated as a rule clarification rather than three independent fixes. Per-phase reviews flagged this as Phase 2 D2 (critical) and Phase 4 D4 (critical). Merging to project-level info.

---

## Mechanical Fixes (apply with user approval)
| ID | Severity | Phase | Location | Problem | Proposed Fix |
|----|----------|-------|----------|---------|--------------|
| P2-M1 | major | 2 | T2.1.1 → `tests/mesh/_fixtures.js` helpers | `assertClose` described as re-exported from deleted `tests/engine/_fixtures.js`. | Replace `tests/engine/_fixtures.js` → `tests/_assert.js` in the re-export description. |
| P3-M1 | minor | 3 | T3.1.1 → `tests/excitation/sources.test.js` `"CURRENT under sequencer"` test | Two test cases call `evalTerminal` with no `ctx` `t`/`theta`. | Add `ctx = { t: 0, theta: 0, stepIndex: <0/2> }` explicitly to the two `stepIndex` cases. |
| P3-M2 | minor | 3 | T3.1.1 → `tests/circuit/current-terminal.test.js` `mutual2` helper | Uses invalid JS `Float64Array[L0,M,M,L1]` (square bracket constructor syntax). | Replace with `new Float64Array([L0,M,M,L1])`. |
| P4-M1 | minor | 4 | T4.1.1 → `tests/harmonic/_fixtures.js` `annulusOracle` | `nTheta≈32`, `nRad≈6` use `≈` — implementer could pick variants that bust the `2e-2` tolerance. | Replace `≈` with exact `nTheta=32, nRad=6`. |
| P6-M1 | minor | 6 | T6.2.1 "Files to create" | `tests/render/gap-eval.test.js` and `tests/render/render3d.test.js` described in T6.2.1 "Tests" but absent from T6.2.1 "Files to create" list. | Add both `.test.js` bullets to T6.2.1 "Files to create" (matching T6.1.1 pattern). |
| P7-M1 | major | 7 | §Files Owned "Created" list | `scripts/phase7-repoint.mjs` is created by T7.1.2 but absent from Phase 7's Files Owned "Created" list. | Add `- scripts/phase7-repoint.mjs — scripted edit driver (created)` to Files Owned. |
| P7-M2 | minor | 7 | §T7.1.2 D9 / "WFS self-start un-skip" parenthetical | Line range `(line 44–48)` describes incorrect span — includes the `skip:` line being removed and misses the closing `});`. | Replace `(line 44–48: …)` with `(lines 45–50: the function body — runFromRest, assert.ok, and closing });)`. |

---

## Decision-Required Items

### P0-D1 — `tests/circuit/_fixtures.js` `fitCos2` removal ambiguity (minor)
- **Phase / Location**: 0 / Task 0.1.3 "Files to modify" → `tests/circuit/_fixtures.js`.
- **Problem**: Spec drops `fitCos2` from `module.exports`. Whether any surviving circuit test uses it is not stated.
- **Options**:
  - **A** — Add a spec note: "`fitCos2` is used only by the deleted `extract.test.js`; surviving circuit tests do not import it."
  - **B** — Move `fitCos2` to `tests/_assert.js` exports (it is already moved there from `engine/_fixtures.js`) and re-point any surviving caller; document that re-point requirement.

### P1-D1 — `buildSmallSPD()` size ambiguous ("4×4 (or 3×3)") (major)
- **Phase / Location**: 1 / T1.2.1 → `tests/solver/_fixtures.js`.
- **Problem**: Spec says "fixed 4×4 (or 3×3) SPD system" — choice affects `xExact`, which downstream tests compare against. Verifier cannot reproduce.
- **Options**:
  - **A** — Fix size to 3×3 (simpler hand-computation).
  - **B** — Fix size to 4×4 (more off-diagonal coverage).
  - **C** — Pin the full matrix `I`, `J`, `V`, `b`, `xExact` arrays in the spec.

### P1-D2 — Node test environment setup for classic-script `fea-solver.js` unspecified (major)
- **Phase / Location**: 1 / T1.2.1 → `tests/solver/*.test.js`; T1.1.1 → `lib/fea-solver.js`.
- **Problem**: `fea-solver.js` is a classic IIFE expecting `window.LIB`, dynamically `import()`s `./solver.mjs`. How tests load it under `node --test` (no `window`, CJS/ESM friction, `./solver.mjs` path resolution) is unspecified.
- **Options**:
  - **A** — Add `tests/solver/_shim.js` modelled on `tests/_shim.js` (sets `global.window = { LIB: {} }`, loads `fea-solver.js`, resolves `./solver.mjs` via absolute path).
  - **B** — Use `globalThis.LIB` instead of `window.LIB` in `fea-solver.js`; tests use ESM import (`import.meta.url` resolves paths).
  - **C** — Add thin Node entry `lib/fea-solver-node.js` (CJS wrapper handling `global.window`, path resolution).

### P1-D3 — `_solver_bench/` location relative to repo root never stated (major)
- **Phase / Location**: 1 / T1.1.1 → `lib/solver-src/build.sh` and `README.md`.
- **Problem**: Spec references `_solver_bench/` but `CLAUDE.md` repo layout does not list it. Build script paths depend on its location.
- **Options**:
  - **A** — State the path explicitly in the spec.
  - **B** — Make `build.sh` accept `EMSDK_ROOT` / `EIGEN_ROOT` env vars (location-independent).
  - **C** — Declare the C ABI description as authoritative source; implementer writes `wrapper.cpp` fresh from the spec.

### P1-D4 — Timing assertion contradicts "not an absolute-ms gate" framing (minor)
- **Phase / Location**: 1 / T1.2.1 → `tests/solver/solver.test.js` timing test.
- **Problem**: Test asserts `factorize < 2000ms` while parenthetical says "reported, not asserted" — self-contradictory.
- **Options**:
  - **A** — Keep the hard assert; remove the contradictory parenthetical.
  - **B** — Remove the assert; log only.
  - **C** — Keep relative `solve < factorize` assert only; log absolute timings.

### P2-D1 — Test files in Files Owned have no creating task (critical)
- **Phase / Location**: 2 / Files Owned vs. T2.1.1 "Files to create".
- **Problem**: `tests/mesh/mesh-core.test.js` and `tests/mesh/mesh-view.test.js` appear in Files Owned but in no task's "Files to create".
- **Options**:
  - **A** — Add both test files to T2.1.1 "Files to create" (recommended; metadata repair).
  - **B** — Split into a new sub-task 2.1.2 owning the test files (added manifest overhead).

### P2-D2 — Cross-group file sharing across sequential waves (critical)
- **Phase / Location**: 2 / manifest groups 2.1.a, 2.2.a, 2.3.a.
- **Problem**: `lib/motor-mesh.js` and `tests/mesh/_fixtures.js` are shared across sequential-wave groups. Letter of file-locality rule says they must be in one group; wave sequencing eliminates contention.
- **Options**:
  - **A** — Accept current structure; add spec annotation documenting wave sequencing.
  - **B** — Clarify the rule in `spec/.context/rules.md` to permit cross-wave file sharing (project-wide fix, also resolves Phase 4 D4 and Phase 5's analogous case).
  - **C** — Collapse all four tasks into Wave 2.1 / group 2.1.a (exceeds 10-file cap; loses milestone structure).

### P2-D3 — `interiorEdgeSharing(mesh)` return contract unspecified (major)
- **Phase / Location**: 2 / T2.1.1 → `_fixtures.js` helpers + "M2 conforming interfaces" test.
- **Problem**: Helper "reports" interior edge sharing; return type (boolean / structured object / throw) not specified.
- **Options**:
  - **A** — Returns `true`/`false` (simplest).
  - **B** — Returns `{ ok: boolean, badEdges: [...] }` (better diagnostic).
  - **C** — Throws on violation, returns `undefined` on success.

### P2-D4 — `readMsh` return contract vs. "gap-layer count matches" assertion (major)
- **Phase / Location**: 2 / T2.3.2 → `_fixtures.js` `readMsh` vs. `convergence.test.js::gmsh reference diff`.
- **Problem**: `readMsh` extracts "element count / min-angle / node count"; test asserts "gap-layer count matches" — quantity not in return contract and not natively in `.msh` files.
- **Options**:
  - **A** — `gen-mesh-refs.mjs` writes `// gap_layers: N` header comment; extend `readMsh` return.
  - **B** — Derive gap-layer count geometrically from `.msh` node positions in `readMsh`.
  - **C** — Drop "gap-layer count matches" from the gmsh-diff assertion (already covered by `collar-gap.test.js`).

### P2-D5 — `dofBudget` cap test assertion strictness contradictory (minor)
- **Phase / Location**: 2 / T2.3.1 → `collar-gap.test.js::dofBudget caps node count`.
- **Problem**: "within the rounding the spec permits: `Nn <= dofBudget` strictly" — tolerance vs. strict.
- **Options**:
  - **A** — Strictly `Nn <= dofBudget`.
  - **B** — Allow `Nn <= dofBudget + P_body` (one snapping multiple of slack).

### P3-D1 — `current-schema.test.js` `config-schema.js` require path wrong (critical)
- **Phase / Location**: 3 / T3.1.1 → `tests/excitation/current-schema.test.js` setup.
- **Problem**: Spec says require "relative to `lib/`"; `config-schema.js` lives at `lessons/unified_motor/config-schema.js`. As-written require fails.
- **Options**:
  - **A** — Fix require to `require("../../lessons/unified_motor/config-schema.js")`; keep file at `tests/excitation/`.
  - **B** — Move file to `tests/pipeline/current-schema.test.js` (alongside `bknee-schema.test.js`); update Files Owned + manifest.
  - **C** — Keep file at `tests/excitation/`; use absolute path via `path.join(__dirname, …)`.

### P3-D2 — `supplyValue` fallthrough comment update inaccurate for `CURRENT` (major)
- **Phase / Location**: 3 / T3.1.1 → `lib/excitation.js`.
- **Problem**: Proposed comment includes `CURRENT` and says "sectorGate applies shape" — but sectorGate only gates CURRENT in `mechanical` mode.
- **Options**:
  - **A** — Add `CURRENT`, drop the sectorGate clause: `// DC, PULSE, STEP, CURRENT — return raw amplitude`.
  - **B** — Add `CURRENT` and qualify: `// DC, PULSE, STEP, CURRENT — return raw amplitude; sectorGate applied by evalTerminal for PULSE/STEP and mechanical CURRENT`.
  - **C** — Do not update the comment.

### P3-D3 — T3.1.2 "loading throws no error" criterion unverifiable (minor)
- **Phase / Location**: 3 / T3.1.2 acceptance criteria.
- **Problem**: Fixture is an IIFE assigning to `window.UnifiedMotor.MACHINES`; plain `node -e "require(...)"` throws. Spec doesn't say how to verify; T3.1.2 also says it has no Phase-3-runnable test.
- **Options**:
  - **A** — Weaken to an inspection-only criterion ("inspect: circuit 0 has `terminal.type === 'CURRENT'` with `amp: 12`").
  - **B** — Specify a concrete shimmed Node one-liner.

### P3-D4 — `Iimp` undefined safety contract in `stepCurrents` (info)
- **Phase / Location**: 3 / T3.1.1 → `lib/motor-circuit.js`.
- **Problem**: If `Iimp` is undefined and a terminal state is `"CURRENT"`, the pinning step throws cryptic TypeError. Not stated as either invariant or guard.
- **Options**:
  - **A** — State invariant explicitly: callers that omit `Iimp` must not produce CURRENT states; no defensive guard.
  - **B** — Add throw guard: `if (terminalStates[k] === "CURRENT" && !Iimp) throw …`.

### P4-D1 — `slots` derivation in `gapLoopsFromConfig` underspecified (major)
- **Phase / Location**: 4 / T4.1.1 → `tests/harmonic/_fixtures.js` helper.
- **Problem**: "Max angular feature count" derivation ambiguous — raw `config.rings` vs. expanded `section.features`. Affects `defaultK` and Phase 5 integration consistency.
- **Options**:
  - **A** — Derive from `CS.expand(config)` output (`section.features[].angularCount`).
  - **B** — Derive directly from `config.rings` (`Math.max(...rings.map(r => r.teeth ?? r.magnets ?? r.Q ?? 1))`).
  - **C** — Make `slots` a caller-supplied argument; hard-code per test.

### P4-D2 — `M_k` symmetry test: internal accessor vs. recomputation (major)
- **Phase / Location**: 4 / T4.1.1 → `admittance.test.js::"M_k is symmetric for each k"`.
- **Problem**: Spec says "exposed via internal accessor or recomputed from documented closed form" — neither approach pinned; only the first verifies the assembled matrix.
- **Options**:
  - **A** — Add a test-only `gap.Mk(k)` accessor on the production object.
  - **B** — Recompute from closed form in the test (no API extension; weaker).
  - **C** — Replace with a `surfaceFlux`-based reciprocity check (no internals exposed).

### P4-D3 — Harmonic torque formula `f(k, r̂ₖ(φ), ŝₖ)` not written (major)
- **Phase / Location**: 4 / Public API `torque` + T4.2.1 → `torque.test.js`.
- **Problem**: Formula structurally `T = (ell/μ0)·Σ f(k, …)` but `f` is never given; sign conventions vary. Acceptance criteria only require magnitude within 2 %.
- **Options**:
  - **A** — Write the complete real-pair formula in the spec, with sign convention pinned.
  - **B** — Add a sign-pinning test case (lighter; pins the sign without specifying the full formula).
  - **C** — Leave as-is, relying solely on the Arkkio oracle.

### P4-D4 — `lib/airgap-harmonic.js` shared across manifest groups 4.1.a and 4.2.a (critical)
- **Phase / Location**: 4 / manifest groups 4.1.a, 4.2.a.
- **Problem**: Identical pattern to P2-D2 (sequential-wave file sharing). The spec acknowledges no lock contention; rule has no carve-out.
- **Options**:
  - **A** — Merge T4.1.1 and T4.2.1 into one group in wave 4.1.
  - **B** — Split into two files: `lib/airgap-harmonic-base.js` (4.1.a) + `lib/airgap-harmonic.js` (4.2.a).
  - **C** — Codify sequential-wave exception in manifest schema or rules.md (resolves with X-I1 / P2-D2 / P5 analog).

### P5-D1 — `_internals` inventory in T5.1.1 missing keys later waves reference (major)
- **Phase / Location**: 5 / T5.1.1 internals hatch vs. T5.2.1/T5.3.1 test bodies.
- **Problem**: T5.1.1 declares closed `_internals = { … 8 entries … }`. Tests reference `assembleCombinedTriplets`, `bodies`, `solveStaticRotor`, `K`, `solverSat`, `solverLin`, `derivedSlots`, `derivedPoles` — none in the list.
- **Options**:
  - **A** — Extend the `_internals` list in T5.1.1 to enumerate every needed key with brief signatures (recommended).
  - **B** — Replace the closed enumeration with a rule: "expose every internal the Phase 5 tests reference."
  - **C** — Keep T5.1.1 list closed; add a "Test-only internals addendum" subsection.

### P5-D2 — `θ_e` undefined in harmonic-torque sign-check test (minor)
- **Phase / Location**: 5 / T5.2.1 → `contract.test.js::"harmonic torque sign convention"`.
- **Problem**: Test uses `salientConfig` at `thetaR = π/8` and asserts sign of `−sin(2·θ_e)` — pole count not stated; mechanical vs. electrical angle ambiguous.
- **Options**:
  - **A** — Specify pole count and compute `thetaR = (π/8)·(2/P)` so `θ_e = π/8`.
  - **B** — Replace with synthetic 2-pole salient section built inline.
  - **C** — Relax to sign-change check (pole-count-independent).

### P5-D3 — `r1` referent ambiguous in N=2 zero-offset test (minor)
- **Phase / Location**: 5 / T5.3.1 → `motor-stack.test.js` item 4 bullet.
- **Problem**: Test asserts `r2.torque ≈ 2·r1.torque`; `r1` defined in different `it(…)` block (out of scope).
- **Options**:
  - **A** — Define `r1` inline within this test as an N=1 stack solve.
  - **B** — Express assertion without `r1`: compare against `stack_n1.solve(...).torque`.

### P5-D4 — "compute the equivalent two extra solves manually" in `derivStep` test (minor)
- **Phase / Location**: 5 / T5.3.1 → `extract.test.js::"derivStep override is honored"`.
- **Problem**: "Manually" doesn't specify mechanism — multiple interpretations give different expected values.
- **Options**:
  - **A** — Two `extractCoeffs` calls at shifted base angles, both with `derivStep = π/360`.
  - **B** — Compare `dLdth` from two different `derivStep` values (weaker; tests stability).
  - **C** — Replace with a unit test that asserts override step is actually used internally.

### P5-D5 — `create` behavior before `LIB.FeaSolver.init()` resolves (info)
- **Phase / Location**: 5 / T5.1.1 → `lib/motor-slice.js` `prepare`.
- **Problem**: Spec hints at "lazily on first solve via a cached promise" but `solve`'s contract is sync. Either lazy-async or throw-on-misuse needs pinning.
- **Options**:
  - **A** — `create` throws if `init` not resolved; sync `solve` contract is unconditional.
  - **B** — Replace "lazily on first solve" language with "init must complete before create"; no lazy-init path.

### P5-D6 — Discovery phrasing in agnostic-pipeline edit, immediately resolved (info)
- **Phase / Location**: 5 / T5.3.1 → `agnostic-pipeline.test.js` edit point 4.
- **Problem**: "extend CARVE_OUTS set ONLY if Phase-8 allow-list so dictates" — discovery phrasing, though answer is given in the same sentence.
- **Options**:
  - **A** — Delete the conditional; state CARVE_OUTS contents directly.
  - **B** — Keep rationale but rewrite as definitive statement.

### P6-D1 — `UM.showGapLoop` is an undeclared state variable (major)
- **Phase / Location**: 6 / T6.1.1 → `cross-section-render.js` paint overlay order.
- **Problem**: References `UM.showGapLoop`, but it's not in D3's `UM.fieldViz` enumeration and never initialized.
- **Options**:
  - **A** — Add `gapLoop` as 6th independent checkbox in `UM.fieldViz`.
  - **B** — Draw gapLoop overlay unconditionally (no toggle).
  - **C** — Remove gapLoop overlay from production render path (kept only in `mesh-dev.html`).

### P6-D2 — `applyGapLength` rotor/stator ring partition rule unspecified (major)
- **Phase / Location**: 6 / T6.3.1 → `matrix-panel.js` `applyGapLength`.
- **Problem**: "For every rotor ring … for every stator ring …" — but how to determine ring membership (no `ring.body` field exists).
- **Options**:
  - **A** — Infer by radial position relative to current mid-gap (straddling rings throw).
  - **B** — Use `config.grid.rInner` / `rOuter` mid-point as the pivot.
  - **C** — Add `ring.body: "rotor"|"stator"` to `config-schema` (cross-phase change; touches Phase 3's owned file + 15 fixtures).

### P6-D3 — `drawFluxLines` lower-bound assertion ambiguous (minor)
- **Phase / Location**: 6 / T6.1.1 → `mesh-view-prod.test.js::"drawFluxLines emits stroke calls"`.
- **Problem**: Primary assert is `>= 1` (very weak); proportionality clause `>= levels - 1` is parenthetical — implementer cannot tell if it's a hard assert.
- **Options**:
  - **A** — Promote `>= levels - 1` to hard assertion.
  - **B** — Keep `>= 1` as the hard assertion; mark `>= levels - 1` as informational comment.

### P7-D2 — `meshArkkioTorque` denominator inconsistent between D3 prose and code spec (major)
- **Phase / Location**: 7 / §D3 prose vs. T7.1.1 code spec.
- **Problem**: D3 says scale by `ell / (μ0·(r_ms − r_stator_bore))`; T7.1.1 code spec returns `ell / (μ0·(r_ms − r_mr))`. Different bands.
- **Options**:
  - **A** — Use `(r_ms − r_mr)` (full gap annulus, code-spec version); update D3 prose.
  - **B** — Use `(r_ms − r_stator_bore)` (stator collar only, D3 prose); add `r_stator_bore` to helper signature.

### P7-D3 — `stack.slices[0]` used but `.slices[]` not declared `MotorStack` API (major)
- **Phase / Location**: 7 / T7.2.1 first test.
- **Problem**: Test does `coggingAmpAt(stack.slices[0], …)`; Phase 5 `MotorStack` contract doesn't declare `.slices[]` as a public accessor.
- **Options**:
  - **A** — Amend Phase 5 to declare `.slices: MotorSlice[]` as `MotorStack` public API.
  - **B** — Replace `stack.slices[0]` with an explicit `LIB.MotorSlice.create(...)` call in T7.2.1.

### P7-D4 — `stack.coenergyTorque` not declared in Phase 5 `MotorStack` contract (major)
- **Phase / Location**: 7 / T7.1.1 `cross-method.test.js`.
- **Problem**: Test uses `stack.coenergyTorque(θ, currents).total`; Phase 5's `MotorStack` contract methods don't explicitly list it. Old grid stack has it; FEA stack might or might not.
- **Options**:
  - **A** — Amend Phase 5 to declare `coenergyTorque(θ, currents) → { total, … }` on `MotorStack`.
  - **B** — Phase 7 implements `coenergyTorque` as a local fixture helper using `extractCoeffs`.

### P7-D5 — Back-EMF test is self-consistency, not analytic cross-check (minor)
- **Phase / Location**: 7 / T7.1.1 → `analytic.test.js::"no-load back-EMF"`.
- **Problem**: Test compares numeric central difference of `λpm` to `dLambdaPmdth` — both from `extractCoeffs`. Plan validation criterion implies an analytic cross-check.
- **Options**:
  - **A** — Accept self-consistency form; clarify that this validates `extractCoeffs` internal consistency.
  - **B** — Replace with analytic peak-flux-linkage cross-check against closed form on `slotlessPmConfig` (requires adding excitation circuits to that config).

### P8-D1 — Manual cross-check remediation path unspecified (minor)
- **Phase / Location**: 8 / §Phase-exit verification "Manual cross-check" bullet.
- **Problem**: If the manual greps surface real hits, no remediation path is given — Phase 8 creates audit, not the code under audit.
- **Options**:
  - **A** — Escalate to coordinator on any hit (Clarification Exit).
  - **B** — Implementer fixes the violation in the referenced file directly (expands Phase 8 scope).

### P8-D2 — "log the missing path" destination ambiguous (minor)
- **Phase / Location**: 8 / T8.1.1 Check B.
- **Problem**: "Files missing on disk are skipped silently … log the missing path and continue" — log to stdout (breaks verbatim PASS format) or stderr (breaks test wrapper's `r.stderr === ""`)?
- **Options**:
  - **A** — Silently skip, no log.
  - **B** — Print `SKIP <path> (not found)` on stdout before the summary block; amend verbatim PASS format.
  - **C** — Assert all BSCOPE_FILES present; fail if any missing.

### P8-D3 — 10-second termination criterion not enforced (minor)
- **Phase / Location**: 8 / T8.1.1 acceptance criteria.
- **Problem**: Self-reported criterion not enforced by wrapper; no `spawnSync` timeout — hangs indefinitely on a runaway.
- **Options**:
  - **A** — Add `timeout: 10000` to `spawnSync` and a fourth assertion `r.signal === null`.
  - **B** — Remove the 10-second criterion entirely (sub-second by design).

### X-D1 — `tests/pipeline/_fixtures.js` `CS` export gap between Phase 5 and Phase 7 (major)
- **Phase / Location**: cross / Phase 5 §T5.3.1 + Phase 7 §T7.1.1.
- **Problem**: See cross-phase findings section above.
- **Options**:
  - **A** — Add `CS` export to Phase 5's `tests/pipeline/_fixtures.js` modification list.
  - **B** — Phase 7 derives `CS` locally from `P.UnifiedMotor.ConfigSchema`.

---

## Full per-phase reports
Each phase's complete review is at `spec/reviews/spec-phase-{n}.md`.
