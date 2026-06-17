# Phase 6: Browser verification + legacy/agnosticism audit

## Overview

Final phase. Two independent pieces of work:

1. **`T6.1.1` (agent).** Create `scripts/agnosticism-audit.js` — a standalone,
   DOM-free Node hygiene gate (`node scripts/agnosticism-audit.js`, exit `0`
   clean / `1` on any violation) that runs three static checks over the engine +
   the render/UI files Phases 1–5 added, plus a unit test
   (`tests/pipeline/agnosticism-audit.test.js`) and an `"audit"` npm script. Run
   it and the full suite; both green.
2. **`T6.1.2` (user-required).** The browser walkthrough over the CLAUDE.md
   checklist, recorded in `spec/phase-6-browser-verification.md`. A human opens
   the app and signs off each item; the agent records the result.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. This phase's own
> plan-vocabulary sweep (`scanForPlanVocab`) enforces this repo-wide.

### Current-state facts this phase is built on

- **There is no `scripts/agnosticism-audit.js` today.** The only `scripts/` file
  is `scripts/gen-mesh-refs.mjs`. The repo-wide machine-agnosticism enforcement
  today is the test `tests/pipeline/agnostic-pipeline.test.js`, which scans
  `lib/*.js` (minus a `CARVE_OUTS` set) **+ `mount.js` only** for the 8
  `MACHINE_NAMES` type tokens, and additionally asserts (behaviorally) that all
  four reference configs run the identical `MotorRun` path and the rotor turns.
  That behavioral test is **unchanged** by this phase and is the behavioral half
  of the single-slice guarantee; Phase 6 adds the *static* backstop the plan,
  manifest, and Phases 3/4/5 specs refer to as `scripts/agnosticism-audit.js`.
- **The token sources are frozen and enumerable.** The 8 type tokens
  (`MACHINE_NAMES`, `tests/pipeline/_fixtures.js:56`) are `bldc, pmsm, srm,
  squirrel, stepper, brushed, universal-motor, wound-field` — physics terms
  (`reluctance, induction, synchronous, commutation`) are deliberately excluded
  (they name physics, not machine identity). The 15 fixture ids (`MACHINE_IDS`,
  `tests/machines/_fixtures.js:74`) are `pmsm, brushed-dc-pm, brushed-dc-wound,
  universal, bldc, induction-3ph, induction-1ph, vr-stepper, switched-reluctance,
  pm-stepper, hybrid-stepper, synchronous-reluctance, wound-field-synchronous,
  skew-demo, pole-mismatch-demo`. The audit script enumerates both lists itself
  (it does **not** `require` the test fixtures, which would load the WASM solver);
  drift if a 16th machine is added later is out of this plan's scope.
- **Each new render/UI file already carries its own per-file machine-name guard**
  (Phase 3 `cross-section-sprite.test.js` / `cross-section-render.test.js`,
  Phase 4 `machine-picker.test.js` / geometry-panel test, Phase 5
  `render3d.test.js`). The audit script is the single repo-wide backstop over the
  union; it does not replace those per-file guards.
- **`lib/gap-eval.js` (Phase 2) and `lib/cross-section-sprite.js` (Phase 3) are in
  `lib/`** and are therefore covered by the engine half of check 1 automatically;
  they are not named in the runtime-UI scan list.
- **The single-slice baseline is clean.** A repo scan for `slices/nSlices === 1`
  / `slices < 2` over `lib/**` + `lessons/unified_motor/*.js` finds exactly one
  match — a *comment* at `lib/motor-stack.js:86` (`// Unconditional loop — no if
  (nSlices === 1) fast path.`). Check 2 strips comments before scanning, so that
  prose is not a violation.
- **Legacy-term carve-outs are enumerable.** After Phases 0–5, the
  deleted-subsystem term set survives only at these legitimate sites, which the
  sweep excludes: `lib/em-physics.js` (the generic `coenergyTorque` definition)
  and `lessons/ac_motor/**` (its callers — out-of-scope AC lessons);
  `tests/render/mount-2d-seam.test.js` (banned-token guard literals incl.
  `drawGapField`); the audit script + its own test (which contain the term list
  as search patterns); and all of `spec/**` (docs that name deleted subsystems
  deliberately — e.g. `plan.md`'s divergence table). Bare `harmonic` is **not** a
  deleted term (it is the live mortar/slice DOF naming) and is not scanned for.
- **`package.json`** has only `{ "test": "node --test" }` and is owned by no other
  phase, so Phase 6 may add an `"audit"` script to it.

## Files Owned

Created:
- `scripts/agnosticism-audit.js` — created (T6.1.1)
- `tests/pipeline/agnosticism-audit.test.js` — created (T6.1.1)
- `spec/phase-6-browser-verification.md` — created (T6.1.2)

Modified:
- `package.json` — modified: add `"audit": "node scripts/agnosticism-audit.js"` to `scripts` (T6.1.1)

> No source file owned by another phase appears here. `tests/pipeline/agnostic-pipeline.test.js`
> is **not** modified — it stays as the behavioral agnosticism test.

## Wave 6.1: Repo audit (agent) + user browser pass

### Task 6.1.1: Create and run `scripts/agnosticism-audit.js` + its test

- **Description**:
  Create a standalone Node module `scripts/agnosticism-audit.js` that runs three
  static repo-hygiene checks and a unit test that exercises both its pure scan
  functions and its CLI exit code. Wire an `"audit"` npm script. The module:
  - Exports `{ scanForNames, scanForSingleSlice, scanForLegacyTerms,
    scanForPlanVocab, run, MACHINE_NAMES, MACHINE_IDS, NAME_SCAN_FILES,
    NAME_CARVE_OUTS, LEGACY_TERMS, LEGACY_CARVE_OUTS, PLAN_VOCAB_PATTERNS }`.
  - Self-executes only as a CLI: `if (require.main === module) { process.exit(run()); }`.
    When `require`d as a module it attaches nothing to globals, reads no files at
    import time, and touches no DOM (no `window`/`document` reference anywhere).
  - `run()` runs all three checks over the real repo (paths resolved relative to
    the script via `__dirname`), prints each violation as `«check»: «relPath»:«line» — «detail»`
    to `stderr`, prints `agnosticism audit: clean` to `stdout` when there are
    none, and returns `0` when clean / `1` when any check produced a violation.

  **Enumerated constants** (the script defines these literally):
  - `MACHINE_NAMES` — the 8 type tokens: `["bldc","pmsm","srm","squirrel","stepper","brushed","universal-motor","wound-field"]`.
  - `MACHINE_IDS` — the 15 fixture ids: `["pmsm","brushed-dc-pm","brushed-dc-wound","universal","bldc","induction-3ph","induction-1ph","vr-stepper","switched-reluctance","pm-stepper","hybrid-stepper","synchronous-reluctance","wound-field-synchronous","skew-demo","pole-mismatch-demo"]`.
  - `NAME_SCAN_FILES` — the runtime-UI files, relative to repo root:
    `["lessons/unified_motor/mount.js","lessons/unified_motor/cross-section-render.js","lessons/unified_motor/render3d.js","lessons/unified_motor/machine-picker.js","lessons/unified_motor/geometry-panel.js"]`,
    **plus** every `lib/*.js` not in `NAME_CARVE_OUTS` (enumerated at scan time
    by reading the `lib/` directory).
  - `NAME_CARVE_OUTS` — engine files excluded from the name scan (the allow-list):
    `["app.js","registry.js","header-buttons.js","stepper-drive.js","three-phase.js"]`
    (mirrors the existing `agnostic-pipeline.test.js` `CARVE_OUTS`).
  - `LEGACY_TERMS` — the deleted-subsystem regex sources:
    `["airgap-harmonic","harmonic-set","harmonicSet","extractCoeffs","coenergyTorque","evaluateAt","drawGapField","MotorCompile","compileForOverlay","drawCompiledOverlay","detailed-toggle","airgap-grid"]`.
  - `LEGACY_SCAN_GLOBS` — scan roots for the legacy sweep:
    `lib/**/*.js`, `lessons/**/*.js`, `lessons/**/*.html`, `tests/**/*.js`,
    `scripts/**/*.js`, and the repo-root `index.html` (resolved as
    `path.join(__dirname, '..', 'index.html')`, one directory up from `scripts/`;
    the `lessons/**/*.html` glob already covers per-lesson index files, so this
    entry is specifically the top-level hub file; all paths resolved by walking
    those directories with no external glob dependency).
  - `LEGACY_CARVE_OUTS` — paths excluded from the legacy sweep, relative to repo
    root: `["lib/em-physics.js","lessons/ac_motor/","tests/render/mount-2d-seam.test.js","scripts/agnosticism-audit.js","tests/pipeline/agnosticism-audit.test.js"]`
    (a path matches a carve-out when it equals the entry or, for the `ac_motor/`
    entry ending in `/`, is prefixed by it). `spec/**` is not a scan root and so
    is never scanned.
  - `PLAN_VOCAB_PATTERNS` — the management-vocabulary regex sources (the
    plan/phase/wave/task references that go stale once shipped): `phase[\s-]\d`
    (case-insensitive), `wave[\s-]?\d` (case-insensitive), and `T\d+\.\d+\.\d+`
    (case-sensitive task IDs). The digit-adjacent form deliberately spares physics
    usage — `per-phase`, `three-phase`, `phase A`, `phase current` do **not**
    match. Known sharp edge: a digit-adjacent physics comment like `phase 2
    winding` WOULD match and must be reworded (`winding phase B` / `phase index
    two`) or its file carve-listed.

  **`scanForNames(src, relPath) → violation[]`** (pure; `src` is file text,
  `relPath` is the file's repo-relative path used in messages):
  - Lower-case `src`; for each token in `MACHINE_NAMES`, if the lower-cased text
    contains it as a substring, emit a violation `{check:"name", relPath, line, detail}`
    (line = 1-based line of the first occurrence).
  - For each id in `MACHINE_IDS`, if `src` contains the **quoted** literal
    (`"<id>"` or `'<id>'`), emit a violation `{check:"name-id", relPath, line, detail}`.
    (Quoted-literal matching avoids false positives on bare substrings like
    `universal` inside an identifier; a machine-identity branch reads an id as a
    string literal.)

  **`scanForSingleSlice(src, relPath) → violation[]`** (pure):
  - Remove `//`-to-end-of-line comments and `/* … */` block comments from `src`
    (a minimal comment stripper; string-literal awareness is not required for the
    scan set — there are no slice-comparison patterns inside string literals in
    the scan set, and the comment strip is what removes the one known
    `motor-stack.js` prose false positive).
  - Match the stripped text against `/\b(?:n?slices(?:\.length)?)\s*===?\s*1\b/i`
    and `/\bn?slices\s*<\s*2\b/i`; emit one violation per match
    (`{check:"single-slice", relPath, line, detail}`), line numbered against the
    **original** `src`.

  **`scanForLegacyTerms(src, relPath) → violation[]`** (pure):
  - If `relPath` matches a `LEGACY_CARVE_OUTS` entry, return `[]`.
  - For each term in `LEGACY_TERMS`, emit a violation
    `{check:"legacy", relPath, line, detail}` for each occurrence (case-sensitive
    for the camelCase terms; `airgap-harmonic`/`harmonic-set`/`airgap-grid`/
    `detailed-toggle` matched literally).

  **`scanForPlanVocab(src, relPath) → violation[]`** (pure):
  - If `relPath` matches a `LEGACY_CARVE_OUTS` entry, return `[]` (same carve-out
    set — the audit script and its own test hold these patterns as data).
  - For each pattern in `PLAN_VOCAB_PATTERNS`, emit a violation
    `{check:"plan-vocab", relPath, line, detail}` per match, line-numbered against
    the original `src`.

  **`run() → 0|1`**: enumerate the name-scan files (the 5 runtime-UI files +
  `lib/*.js` minus carve-outs), read each as UTF-8, run `scanForNames` +
  `scanForSingleSlice`; enumerate the legacy-scan files (walk `LEGACY_SCAN_GLOBS`),
  read each as UTF-8, run `scanForLegacyTerms` **and** `scanForPlanVocab`; collect
  all violations, print, and return the exit code. A file path missing on disk is itself a violation
  (`{check:"missing", …}`) so a renamed/removed scan target fails loudly rather
  than silently skipping.

- **Files to create**:
  - `scripts/agnosticism-audit.js` — the module above. Pure scan functions +
    `run()` + `require.main` CLI guard. No `window`/`document`; no machine-name
    string literals **except** inside the enumerated `MACHINE_NAMES`/`MACHINE_IDS`
    arrays (which are the audit's own data, and this file is a `LEGACY_CARVE_OUTS`
    entry so it does not flag itself).
  - `tests/pipeline/agnosticism-audit.test.js` — headless `node --test`. Requires
    `../../scripts/agnosticism-audit.js` as a module (which must not run the CLI
    or read files at import). Uses `node:child_process` `execFileSync` for the
    exit-code test.

- **Files to modify**:
  - `package.json` — add `"audit": "node scripts/agnosticism-audit.js"` to the
    `scripts` object (keep the existing `"test": "node --test"`). Valid JSON, no
    other change.

- **Tests** (`tests/pipeline/agnosticism-audit.test.js`):
  - `tests/pipeline/agnosticism-audit.test.js::"module import is side-effect-free and DOM-free"` —
    set `globalThis.document = undefined`; `require` the script; assert the require
    does not throw and that `typeof audit.run === "function"` and
    `typeof audit.scanForNames === "function"`.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForNames flags a type token"` —
    `scanForNames("const k = makeStepper();", "x.js")` returns a non-empty array
    whose first entry has `check === "name"` and `detail` mentioning `stepper`.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForNames flags a quoted machine id"` —
    `scanForNames('if (id === "switched-reluctance") {}', "x.js")` returns ≥1
    violation with `check === "name-id"`; and `scanForNames('// switched-reluctance', "x.js")`
    returns `[]` (a bare, unquoted machine id in a comment is not a violation;
    only a quoted string literal in a code branch is — quoted-literal matching is
    deliberate to avoid physics-term false positives). Assert both.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForNames passes a registry iteration"` —
    `scanForNames("for (const m of UM.MACHINES) host.add(m.label);", "x.js")`
    returns `[]` (no token, no quoted id).
  - `tests/pipeline/agnosticism-audit.test.js::"scanForSingleSlice flags a fast-path branch"` —
    `scanForSingleSlice("if (nSlices === 1) return cheap();", "x.js")` returns ≥1
    with `check === "single-slice"`; `scanForSingleSlice("if (slices < 2) skip();", "x.js")`
    returns ≥1.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForSingleSlice ignores the comment prose"` —
    `scanForSingleSlice("// Unconditional loop — no if (nSlices === 1) fast path.\nfor (let k=0;k<nSlices;k++){}", "x.js")`
    returns `[]` (comment stripped; the loop bound `k<nSlices` is not a match).
  - `tests/pipeline/agnosticism-audit.test.js::"scanForLegacyTerms flags a deleted term"` —
    `scanForLegacyTerms("const t = coenergyTorque(dL, I);", "lib/motor-stack.js")`
    returns ≥1 with `check === "legacy"`.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForLegacyTerms honours the em-physics carve-out"` —
    `scanForLegacyTerms("function coenergyTorque(){}", "lib/em-physics.js")`
    returns `[]`; and the same input for `relPath` `"lessons/ac_motor/squirrel-cage.js"`
    returns `[]`.
  - `tests/pipeline/agnosticism-audit.test.js::"NAME_SCAN_FILES covers the new render/UI files and carve-outs exclude the shared shell"` —
    assert `NAME_SCAN_FILES` (or the resolved name-scan set returned by a helper)
    includes `lessons/unified_motor/render3d.js`,
    `lessons/unified_motor/machine-picker.js`,
    `lessons/unified_motor/geometry-panel.js`,
    `lessons/unified_motor/cross-section-render.js`, and
    `lessons/unified_motor/mount.js`; and assert `NAME_CARVE_OUTS` contains all of
    `app.js`, `registry.js`, `header-buttons.js`, `stepper-drive.js`,
    `three-phase.js`.
  - `tests/pipeline/agnosticism-audit.test.js::"a missing scan target is reported as a violation"` —
    drive the name scan over a list containing one nonexistent path (via the
    name-scan runner or a `run` variant) and assert a violation with
    `check === "missing"` is returned for that path. (Must not load the WASM solver.)
  - `tests/pipeline/agnosticism-audit.test.js::"scanForPlanVocab flags Phase/Wave/task tokens"` —
    assert `scanForPlanVocab("// Phase 2 / Phase 3 import", "lib/x.js")`,
    `scanForPlanVocab("// Wave 5.4 C: Schur", "lib/x.js")`, and
    `scanForPlanVocab("// production R1 surface (Phase 6, T6.1.1)", "lib/x.js")`
    each return ≥1 violation with `check === "plan-vocab"`.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForPlanVocab spares physics phase usage"` —
    assert `scanForPlanVocab("// per-phase three-phase winding, phase current", "lib/x.js")`
    returns `[]`.
  - `tests/pipeline/agnosticism-audit.test.js::"scanForPlanVocab honours carve-outs"` —
    assert `scanForPlanVocab("// Phase 2 stuff", "lib/em-physics.js")` returns `[]`.
  - `tests/pipeline/agnosticism-audit.test.js::"run() returns 0 on the clean repo"` —
    call `audit.run()` in-process; assert it returns `0`.
  - `tests/pipeline/agnosticism-audit.test.js::"CLI exits 0 on the clean repo"` —
    `execFileSync(process.execPath, [scriptPath], { stdio: "pipe" })` does not
    throw, and its stdout contains `agnosticism audit: clean`.

- **Acceptance criteria**:
  - `scripts/agnosticism-audit.js` exists, is `require`-able without side effects
    or DOM access, exports the four `scan*` functions + `run`, and self-executes
    `process.exit(run())` only under `require.main === module`.
  - The name scan covers the engine (`lib/*.js` minus the 5 carve-outs) **and**
    the 5 runtime-UI files; the single-slice scan covers the same set with
    comments stripped; the legacy sweep covers `lib`/`lessons`/`tests`/`scripts`/
    `index.html` minus the enumerated carve-out paths.
  - The plan-vocabulary sweep (`scanForPlanVocab`) covers the same legacy scan set
    minus the same carve-outs and is clean repo-wide (holds after Phase 0's
    management-comment strip); `spec/**` is never scanned.
  - `node scripts/agnosticism-audit.js` exits `0` and prints
    `agnosticism audit: clean`; `npm run audit` does the same.
  - `package.json` has an `"audit"` script and still has `"test": "node --test"`;
    it is valid JSON.
  - `node --test` is green across the whole suite (including the new test file and
    the unchanged `agnostic-pipeline.test.js`).

### Task 6.1.2: User-required browser verification pass

- **Description**:
  A human runs the unified-motor app in a browser against the CLAUDE.md
  verification checklist (specialized for this app below), confirming each item.
  The agent records the outcome — pass/fail per item plus any notes — in
  `spec/phase-6-browser-verification.md`. **This task requires a real-world user
  action** (opening and driving the browser); no agent can substitute for it. The
  agent's role is to (a) start the static server (`python -m http.server 8765`
  from the repo root, per CLAUDE.md), (b) present the checklist, and (c) write the
  report from the user's reported results. The task is complete only when every
  checklist item is recorded as passing (or a failure is recorded and escalated,
  not worked around).

- **Files to create**:
  - `spec/phase-6-browser-verification.md` — the filled checklist. One row per
    item: item description, result (`PASS`/`FAIL`), and notes. Header records the
    date, the browser/version used, and the served URL
    (`http://localhost:8765/lessons/unified_motor/index.html`).

- **Verification checklist** (each an explicit, user-observed item — the report
  has one row per item):
  1. App boots with **no console errors or warnings**.
  2. The machine **picker** lists all 15 fixtures; selecting **each** of the 15
     loads it into an editable config and the app continues to step (rotor
     present, readouts finite).
  3. **Geometry** edits (a radius, integer teeth/magnets/Q) mutate the config and
     the app rebuilds and remains stable.
  4. **Material** edits (`muR`; `Mr` on a magnet ring; `Bknee` on an iron ring)
     rebuild and remain stable.
  5. The global **gap-length `g`** slider rebuilds and the gap visibly changes.
  6. **"+ add slice"** raises the slice count; at slices > 1 the **axial-flux
     netlist editor** appears.
  7. A **hybrid / claw-pole** configuration (slices > 1 with an axial netlist)
     builds and **runs** (steps without NaN).
  8. The **rotor turns** under drive.
  9. **Each** `fieldViz` toggle paints its overlay independently — `fluxLines`,
     `modulusB`, `saturation`, `magnetization`, `currentDensity`, `gapLoop`.
  10. **Smooth cross-gap flux lines** bridge rotor↔stator (no break at the gap).
  11. The **3-D rig** extrudes the cross-section, rotates the rotor, and shows
      **each cup** of a multi-slice (axial) machine.
  12. The **Playback slider** and **slow-mo badge** behave as designed.
  13. **Reset** reinitializes cleanly (history clears, state zeroes, active mode
      preserved).

- **Tests**:
  - This task ships no automated test (it is a user-observed browser pass; the
    automated coverage lives in Phases 1–5's headless tests and Task 6.1.1's
    audit). Its verifiable artifact is `spec/phase-6-browser-verification.md` with
    every checklist item recorded `PASS`.

- **Acceptance criteria**:
  - `spec/phase-6-browser-verification.md` exists and records a result for **all
    13** checklist items, with header metadata (date, browser/version, URL).
  - Every item is recorded as `PASS`. Any `FAIL` is escalated to the user (not
    worked around) and the task is not complete until resolved.

## Notes / cross-phase dependencies

- **Depends on all of Phases 0–5.** The legacy sweep is clean only after Phase 0
  removes the live stale references; the name scan over `render3d.js` /
  `machine-picker.js` / `geometry-panel.js` / `cross-section-render.js` assumes
  their Phase 3/4/5 contents; the browser pass exercises the full integrated app.
- **`tests/pipeline/agnostic-pipeline.test.js` is unchanged** — it remains the
  behavioral agnosticism test (identical `MotorRun` path, rotor turns) and the
  behavioral half of the single-slice guarantee. The audit script is the static
  half.
- **Per-file guards are not duplicated away.** Each new file keeps its own
  machine-name/DOM guard from its phase; the audit is the repo-wide union backstop.
