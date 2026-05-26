# Spec Review: Phase 3 — CURRENT-source terminal

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 1 | 1 |
| major    | 0 | 1 | 1 |
| minor    | 2 | 1 | 3 |
| info     | 0 | 1 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 3.1.1 — CURRENT terminal vocabulary, circuit enforcement, run routing, schema validation | yes | Full detail; all four files covered; three test files specified |
| 3.1.2 — Wound-field-synchronous fixture flip DC→CURRENT | yes | Exact field change specified; acceptance criteria clear |
| 3.1.3 — Per-iron `Bknee` passthrough in config-schema | yes | All three edit sites in config-schema.js identified; seven test cases specified |
| Phase 3 verification measure: engine-independent tests prove CURRENT mechanism | yes | Tests listed in T3.1.1/T3.1.3; dynamic self-start deferred to Phase 7 with justification |
| Phase 3 verification measure: WFS fixture uses regulated CURRENT field | yes | T3.1.2 |

## Findings

### Mechanical Fixes
| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | §Task 3.1.1 "Tests" — `"CURRENT under sequencer imposes a constant current"` | The test specifies `commutation { mode: "sequencer", stepAngleElec: Math.PI/2 }` and `stepIndex ∈ {0, 2}` but provides no `t` or `theta` for the `ctx` argument. `evalTerminal` receives a full ctx object; without explicit values an implementer must guess. For CURRENT the result is `t`/`theta`-invariant, so the correct default is `t: 0, theta: 0` (matching every other test in the file). | Add `ctx = { t: 0, theta: 0, stepIndex: 0 }` / `{ t: 0, theta: 0, stepIndex: 2 }` to the two test calls. |
| M2 | minor | §Task 3.1.1 "Files to modify" — `lib/motor-circuit.js`, `stepCurrents` spec, return-value description | The spec defines `mutual2` in the `current-terminal.test.js` setup block using the notation `Float64Array[L0,M,M,L1]`. This is not valid JavaScript constructor syntax (square brackets are array literals, not constructor arguments). An implementer must guess the intent. The correct form is `new Float64Array([L0,M,M,L1])`. | Replace `Float64Array[L0,M,M,L1]` → `new Float64Array([L0,M,M,L1])` in the `mutual2` helper description. |

### Decision-Required Items

#### D1 — `current-schema.test.js` require path for `config-schema.js` is wrong (critical)

- **Location**: §Task 3.1.1 "Files to create" — `tests/excitation/current-schema.test.js` setup block
- **Problem**: The spec states: "Setup: `if (!globalThis.window) globalThis.window = globalThis;` then `require` (relative to `lib/`) `util.js`, `winding-model.js`, `config-schema.js` in that order." `config-schema.js` does **not** live in `lib/` — it lives at `lessons/unified_motor/config-schema.js`. A `require("../../lib/config-schema.js")` from `tests/excitation/` would fail with `MODULE_NOT_FOUND` and the test file would not load. The sibling task T3.1.3 gets this right: its `bknee-schema.test.js` setup block specifies `lessons/unified_motor/config-schema.js` by its full repo-relative path. The discrepancy makes the T3.1.1 test file unrunnable as written.
- **Why decision-required**: Two plausible readings exist. Option A is that the sentence means to use the same pattern as T3.1.3 and the short path is a typo. Option B is that the test was intended to live in a different directory (e.g., `tests/pipeline/` alongside `bknee-schema.test.js`) and the file placement is what needs correcting. Both fix the load error but produce different test-file paths and different require depths, which affects the manifest file-list if either path was intended to be the canonical one.
- **Options**:
  - **Option A — Fix the require path, keep file at `tests/excitation/`**: In the `current-schema.test.js` setup block, change the require of `config-schema.js` to `require("../../lessons/unified_motor/config-schema.js")` (relative to `tests/excitation/`), matching the depth-corrected form of T3.1.3.
    - Pros: File stays in the excitation test directory, which is thematically correct (it validates the `CURRENT` terminal type through the schema). Minimal change.
    - Cons: Introduces a `lessons/` require from a `tests/excitation/` file, which is slightly unconventional (T3.1.3's test sits in `tests/pipeline/` which is arguably closer to config-schema). Requires the implementer to notice the path depth mismatch.
  - **Option B — Move the file to `tests/pipeline/`**: Place `current-schema.test.js` at `tests/pipeline/current-schema.test.js` instead of `tests/excitation/`, matching the directory already used by `bknee-schema.test.js`. Update the require path to `require("../../lessons/unified_motor/config-schema.js")` (same depth as T3.1.3). Update Files Owned and the manifest file list for group 3.1.a accordingly.
    - Pros: All config-schema tests live together in `tests/pipeline/`, making the test directory structure consistent. The require path is the same as T3.1.3.
    - Cons: The test name (`current-schema.test.js`) validates the CURRENT terminal type's schema acceptance — splitting a conceptually excitation-related test into the pipeline directory may confuse future contributors. The Files Owned and manifest entries need updating.
  - **Option C — Require by absolute path using `path.join(__dirname, ...)`**: Keep the file at `tests/excitation/current-schema.test.js` and use `require(path.join(__dirname, "../../lessons/unified_motor/config-schema.js"))` to make the path self-documenting and immune to working-directory assumptions.
    - Pros: Explicit, unambiguous, consistent with how Node test files in this repo already handle cross-directory requires (the bknee test uses relative paths so this would be novel but safe).
    - Cons: Adds a `const path = require("path");` preamble not present in any other test file in the repo. Introduces a style divergence.

---

#### D2 — `supplyValue` fallthrough comment update is factually inaccurate for `CURRENT` (major)

- **Location**: §Task 3.1.1 "Files to modify" — `lib/excitation.js`, last bullet of the `evalTerminal` changes
- **Problem**: The spec instructs: "Update the `supplyValue` fallthrough comment to read `// DC, PULSE, STEP, CURRENT — return raw amplitude; shape applied by sectorGate`." The existing comment is `// DC, PULSE, STEP — return raw amplitude; shape is applied by sectorGate`. Adding `CURRENT` to this comment is inaccurate: in modes `none`, `electronic-sine`, `electronic-trap`, and `sequencer`, CURRENT returns `{ kind: "current", I: supplyValue(...) }` **before** any `sectorGate` call — `sectorGate` is never applied to the CURRENT value in those modes. Only in `mechanical` mode does the spec gate the CURRENT value through `sectorGate` (Step 4). The proposed comment implies `sectorGate` always shapes CURRENT's output, which is false for three of the four mode families.
- **Why decision-required**: Two different approaches fix this, and the choice affects what the comment communicates going forward.
- **Options**:
  - **Option A — Add `CURRENT` to the type list but clarify the gating**: Change the comment to `// DC, PULSE, STEP, CURRENT — return raw amplitude; sectorGate applied by evalTerminal for PULSE/STEP/mechanical-CURRENT`. This is accurate but verbose.
    - Pros: Preserves the intent of enumerating which types reach the fallthrough, while not misleading about CURRENT gating.
    - Cons: The comment is now longer and more qualified than the original; it mixes documentation about two different functions.
  - **Option B — Keep `CURRENT` off the `sectorGate` comment; add a separate note**: Leave the `sectorGate` mention applying only to DC/PULSE/STEP: `// DC, PULSE, STEP, CURRENT — return raw amplitude` (drop "; shape applied by sectorGate" entirely, since that clause only holds for PULSE/STEP). The gating behaviour is already documented in `evalTerminal`'s JSDoc.
    - Pros: Accurate. Short. The gating detail belongs in `evalTerminal`'s comment, not `supplyValue`'s.
    - Cons: Removes the only inline mention that `sectorGate` does the shaping for PULSE/STEP, which may reduce discoverability.
  - **Option C — Do not update the `supplyValue` fallthrough comment at all**: `CURRENT` terminals never reach the `return amp` fallthrough in practice (they are intercepted by `if (type === "CURRENT") return ...` in `evalTerminal` before calling `supplyValue` in modes none/electronic/sequencer, and in mechanical mode they call `supplyValue` then gate via `sectorGate` exactly like DC). The comment is a documentation convenience and keeping it as-is (`// DC, PULSE, STEP`) is marginally less accurate but not misleading.
    - Pros: Eliminates the inaccuracy entirely. No comment change needed.
    - Cons: The comment omits `CURRENT` even though `supplyValue` does return `amp` for it when called from the mechanical-mode branch of `evalTerminal`. A future reader may wonder why CURRENT is absent.

---

#### D3 — T3.1.2 acceptance criterion "Loading the fixture throws no error" is unverifiable as specified (minor)

- **Location**: §Task 3.1.2 "Acceptance criteria" — third bullet
- **Problem**: The spec states: "Loading the fixture (`require` of the file) throws no error and registers the machine as before." `wound-field-synchronous.js` is an IIFE that assigns to `window.UnifiedMotor.MACHINES`. A plain `node -e "require('./...')"` would throw `ReferenceError: window is not defined` unless the `if (!globalThis.window) globalThis.window = globalThis;` shim is applied first. The spec does not state how the load check is to be performed — whether via a Node shim, a headless browser, or by inspection. This leaves the implementer to decide what "loading throws no error" means operationally.
- **Why decision-required**: Options differ in where the shim lives and whether a test file is created.
  - **Option A — Verify by inspection only**: Accept that "loading throws no error" is a code-review criterion (no runtime check), verified by human inspection of the IIFE structure after the edit. No test file required. The first real runtime exercise is Phase 7.
    - Pros: Consistent with the spec's statement that "This fixture-only edit has no Phase-3-runnable test of its own."
    - Cons: Acceptance criteria are supposed to be verifiable. Inspection-only criteria are weak.
  - **Option B — Specify the load check via a one-liner with a shim**: Amend the acceptance criterion to say: `node -e "globalThis.window = globalThis; require('./lessons/unified_motor/machines/wound-field-synchronous.js'); const m = window.UnifiedMotor.MACHINES.find(x => x.id === 'wound-field-synchronous'); if (!m || m.config.circuits[0].terminal.type !== 'CURRENT') process.exit(1);"` exits 0. This makes the criterion runnable from a shell.
    - Pros: Verifiable without a test file. Does not contradict the "no Phase-3 test" statement.
    - Cons: Inline shell one-liners are fragile on Windows (path quoting). Adds a criterion that the spec says it deliberately avoids.

---

#### D4 — `Iimp` undefined guard not specified in `stepCurrents` (info)

- **Location**: §Task 3.1.1 "Files to modify" — `lib/motor-circuit.js`, `stepCurrents` spec
- **Problem**: The spec says `advance` passes `Iimp` as `default undefined when absent, preserving existing callers`. If `stepCurrents` receives `Iimp: undefined` and encounters a circuit with `terminalStates[k] === "CURRENT"`, the line `iNext[k] = Iimp[k]` would throw `TypeError: Cannot read properties of undefined`. The spec relies on the invariant that `CURRENT` terminal states are only ever produced by `motor-run.js`, which always constructs a real `Float64Array(m)` before calling `advance`. However, this invariant is not stated in the spec, leaving an implementer uncertain whether `stepCurrents` must guard against `Iimp === undefined` when CURRENT states are present.
- **Why decision-required**: Whether to add a guard is a design choice.
  - **Option A — State the invariant explicitly in the spec**: Add a note to the `stepCurrents` description: "Callers that never produce `terminalStates[k] === 'CURRENT'` may omit `Iimp`; `stepCurrents` does not guard against a missing `Iimp` when CURRENT states are present — the caller (motor-run.js) is responsible for always providing one."
    - Pros: Documents the contract without adding defensive code. Matches the existing codebase style (no defensive wrappers per `rules.md`).
    - Cons: Any future caller that forgets `Iimp` will get a cryptic TypeError at runtime.
  - **Option B — Add a guard in `stepCurrents`**: Add `if (terminalStates[k] === "CURRENT" && Iimp == null) throw new Error("Iimp required when CURRENT terminal states are present")` before the pinning line.
    - Pros: Fail-fast with a clear message.
    - Cons: Adds a runtime check that `rules.md` cautions against ("No fallbacks. No backwards compatibility shims. No safety wrappers.").
