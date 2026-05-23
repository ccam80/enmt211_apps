# Phase 10: Legacy Reference Review + machine-agnosticism guard

## Overview

The final, repo-wide enforcement of the project's reason for existing: **one
unified physics, no per-machine code.** Every earlier phase verified the
invariants for its own files; this phase runs the cross-cutting audit that proves
no machine identity leaked into a behavioral code path anywhere in the
unified-motor build, and that the frozen EM-ecosystem baseline is byte-unchanged.

The audit is a **single one-shot script**, `scripts/agnosticism-audit.js`, run
once via `node scripts/agnosticism-audit.js` from the repo root. It is
deliberately **not** wired into `npm test` (it is an on-demand audit tool, not a
permanent unit test) and **does not** modify `package.json` (Phase-1-owned). It
performs four checks, prints a per-check report, and exits `0` when every
invariant holds or `1` (listing every violation with `file:line`) when any fails.

The four checks correspond one-to-one to the project verification list in
`spec/manifest.json`:

1. **Machine-name scan** — no machine-identity token appears in the 22
   unified-motor-owned `lib/` engine + runtime-UI source files (Machine-Agnosticism
   invariant #1).
2. **Machine-type-field scan** — no machine-type / machine-identity *field name*
   is referenced by those same 22 files (invariant #1: "there is no machine-type
   field that any behavioral code reads").
3. **Single-slice-bypass scan** — `lib/motor-stack.js` and `lib/motor-run.js`
   contain no slice-count fast-path branch (invariant #5: `N=1` is not special).
4. **Frozen-set freeze** — `git diff motor-baseline -- <frozen set>` is empty
   (the EM-ecosystem baseline committed and tagged in Phase 0 is byte-identical).

### Why a scoped allow-list, not "all of `lib/`"

`spec/plan.md`'s original Phase-10 wording said "zero machine-name references in
`lib/`." A literal repo-wide grep of `lib/` is **wrong**: the current tree already
contains machine-identity tokens in files that are **not** part of the
unified-motor build and are legitimately named:

| Pre-existing token site | Token | What it is (out of scope) |
|---|---|---|
| `lib/stepper-drive.js` (whole file) | `stepper` | Rotational-transmission stepper *kinematic* model — a different lesson family |
| `lib/app.js:363` | `stepper-driven lessons` | Comment in the shared shell |
| `lib/registry.js:21` | `stepper lessons` | Comment in the shared shell |
| `lib/header-buttons.js:38` | `stepper-driven lessons` | Comment in the shared shell |
| `lib/three-phase.js:45` | `squirrel-cage.js` | Comment in a **frozen-baseline** EM file (guarded by check 4 instead) |

The machine-name scan therefore runs over an **enumerated allow-list of the 22
files the unified-motor build owns** — the engine `lib/` modules plus the
unified-motor runtime-UI modules — not the whole `lib/` tree. `spec/plan.md` is
updated to match this scope. The frozen EM files are excluded from the
machine-name scan because check 4 already guards them as byte-unchanged.

### Why the Phase-0 "stale references" clause is vacuous

Phase 0 was greenfield: it **deleted no code** (it only committed the untracked
EM-ecosystem baseline). There is therefore no removed symbol, import, or path
that could be left dangling, so the plan's "no stale references to anything noted
in Phase 0" reduces entirely to check 4 (the frozen-set freeze). No separate
guard is needed; this is stated, not silently dropped.

## The enumerated scan set (frozen by this spec)

These lists are authoritative. The audit script hard-codes them; it performs **no
directory globbing or discovery** to build them.

### `SCANNED_FILES` — the 22 unified-motor-owned source files (checks 1 & 2)

Engine `lib/` modules (14):

```
lib/airgap-grid.js
lib/airgap-solve.js
lib/airgap-torque.js
lib/winding-model.js
lib/motor-compile.js
lib/excitation.js
lib/motor-circuit.js
lib/motor-slice.js
lib/motor-stack.js
lib/motor-run.js
lib/field-render.js
lib/airgap-refine.js
lib/airgap-worker.js
lib/airgap-nonlinear.js
```

Runtime-UI modules under `lessons/unified_motor/` (8):

```
lessons/unified_motor/config-schema.js
lessons/unified_motor/mount.js
lessons/unified_motor/cross-section-render.js
lessons/unified_motor/winding-editor.js
lessons/unified_motor/schematic-panel.js
lessons/unified_motor/matrix-panel.js
lessons/unified_motor/detailed-toggle.js
lessons/unified_motor/render3d.js
```

Excluded by design (not in `SCANNED_FILES`):
- `lessons/unified_motor/machines/*.js` — the sanctioned data location; machine
  ids/labels live here as data.
- `lessons/unified_motor/index.html` — the inclusion manifest; its
  `<script src="./machines/pmsm.js">` tags are machine names by necessity.
- `lessons/unified_motor/DESIGN.md` and all `tests/**` — docs and tests are
  allowed to name machines.
- Every pre-existing non-unified-motor `lib/` file (incl. `stepper-drive.js`,
  `app.js`, `registry.js`, `header-buttons.js`) — not part of this build.
- The frozen EM set (`em-physics.js`, `coil-render.js`, `three-phase.js`,
  `layout3d.js`) — covered by check 4.

### `MACHINE_IDS` — the 15 fixture ids, scanned as quoted string literals (check 1)

```
brushed-dc-pm   brushed-dc-wound   universal   bldc   pmsm
induction-3ph   induction-1ph   vr-stepper   switched-reluctance   pm-stepper
hybrid-stepper   synchronous-reluctance   wound-field-synchronous
skew-demo   pole-mismatch-demo
```

### `MACHINE_WORD_TOKENS` — abbreviations/short names, scanned word-boundaried, case-insensitive (check 1)

```
bldc   pmsm   srm   squirrel   brushed   stepper   wound-field
```

Deliberately **excluded** (named physics, not machine identity — invariant #1):
`reluctance`, `induction`, `synchronous`, `commutation`, and the bare adjective
`universal` (the engine legitimately calls `motor-stack.js` "the *universal*
spatial container"; the `universal` *machine* is still caught via its quoted-id
form `"universal"`).

### `MACHINE_TYPE_FIELDS` — forbidden field-name identifiers, word-boundaried, case-insensitive (check 2)

```
machineType   machine_type   machineKind   machineName   motorType   motorKind
```

`id` and `label` are **not** forbidden: reading them generically from the
`UnifiedMotor.MACHINES` registry is config-declared presentation (invariant #6),
not machine-identity dispatch.

### `STACK_FILES` + `STACK_BYPASS_PATTERNS` (check 3)

Files: `lib/motor-stack.js`, `lib/motor-run.js`.

Forbidden source patterns (flexible interior whitespace; `===?` matches `==` and
`===`):

```
nSlices === 1          →  /nSlices\s*===?\s*1\b/
nSlices == 1           →  (covered by the above)
nSlices < 2            →  /nSlices\s*<\s*2\b/
slices.length === 1    →  /slices\.length\s*===?\s*1\b/
slices.length < 2      →  /slices\.length\s*<\s*2\b/
```

The *behavioral* "`N=1` stack equals its single slice" equivalence is owned by
Phase 5's `tests/pipeline/motor-stack.test.js`; this phase adds only the
structural no-fast-path source assertion.

### `FROZEN_SET` + `BASELINE_TAG` (check 4)

```
BASELINE_TAG = motor-baseline
FROZEN_SET   = index.html
               lib/em-physics.js
               lib/coil-render.js
               lib/three-phase.js
               lib/layout3d.js
               lessons/ac_motor/
```

`lib/field-render.js` is **not** in `FROZEN_SET` — Phase 5 extends it with
`drawGapField`.

## Files Owned

- `scripts/agnosticism-audit.js` — created

This phase modifies no source file. It reads repo files but writes only the audit
script. It does **not** modify `package.json` (no `npm` script alias is added —
the audit is run by its explicit path, preserving its one-shot, non-CI nature).
The audit result is recorded in `spec/progress.md` (process log, not a source
artifact).

> No file in this phase's Files Owned appears in any other phase's Files Owned.

> **Task groups are not declared here.** They live in `spec/manifest.json`.

---

## Wave 10.1: Full audit

### Task 10.1.1: `scripts/agnosticism-audit.js` — repo-wide machine-agnosticism audit

- **Description**: Author a single self-contained Node script that performs the
  four checks above against the enumerated scan sets and exits `0` (all
  invariants hold) or `1` (violations found, each printed as `file:line —
  <reason>`). The script uses only Node built-ins (`node:fs`, `node:path`,
  `node:child_process`) — no dependencies, consistent with the repo's zero-dep
  `package.json`. It is run **once** at this phase; a clean (`exit 0`) run is the
  phase's acceptance. The script is **not** added to `npm test` or `package.json`
  scripts.

- **Files to create**:
  - `scripts/agnosticism-audit.js` — CommonJS module (the repo has no
    `"type":"module"`, so `.js` is CommonJS). Run as `node
    scripts/agnosticism-audit.js` from the repo root; resolves all paths relative
    to `path.join(__dirname, "..")`. Structure:
    - **Frozen constants** (hard-coded exactly as the lists in "The enumerated
      scan set" above): `SCANNED_FILES` (22), `MACHINE_IDS` (15),
      `MACHINE_WORD_TOKENS` (7), `MACHINE_TYPE_FIELDS` (6), `STACK_FILES` (2),
      `STACK_BYPASS_PATTERNS` (the 5 regexes), `FROZEN_SET` (6 pathspecs),
      `BASELINE_TAG` (`"motor-baseline"`).
    - **A `violations` array** accumulating `{ check, file, line, detail }`
      records, and a `readLines(relPath)` helper that reads a file UTF-8 and
      returns `{ lines, missing }` (`missing:true` if the file does not exist).
    - **Check 1 — machine names** (over `SCANNED_FILES`): for each file: if
      missing, push a violation `{ check:1, file, line:0, detail:"owned file
      absent — unified-motor build incomplete" }`; else, for each 1-based line:
      - For each id in `MACHINE_IDS`, test `new RegExp('["\'\\`]' + id + '["\'\\`]')`
        (the id enclosed in a single, double, or back quote); on match push
        `{ check:1, file, line, detail:'machine-id literal "' + id + '"' }`.
      - Test `/\b(bldc|pmsm|srm|squirrel|brushed|stepper|wound-field)\b/i`; on
        match push `{ check:1, file, line, detail:'machine token ' + match[0] }`.
    - **Check 2 — machine-type fields** (over `SCANNED_FILES`): for each present
      file and each 1-based line, test
      `/\b(machineType|machine_type|machineKind|machineName|motorType|motorKind)\b/i`;
      on match push `{ check:2, file, line, detail:'machine-type field ' +
      match[0] }`.
    - **Check 3 — single-slice bypass** (over `STACK_FILES`): for each file: if
      missing, push `{ check:3, file, line:0, detail:"stack/run module absent" }`;
      else for each 1-based line and each pattern in `STACK_BYPASS_PATTERNS`, on
      match push `{ check:3, file, line, detail:'single-slice fast path: ' +
      match[0] }`.
    - **Check 4 — frozen-set freeze** (via `child_process.execFileSync("git",
      …, { cwd: repoRoot })`):
      1. `git rev-parse --verify -q ${BASELINE_TAG}^{commit}` wrapped in
         try/catch; on throw push `{ check:4, file:"(git)", line:0, detail:"tag
         motor-baseline not found — Phase 0 baseline missing" }` and skip the
         diff.
      2. Else `git diff --quiet ${BASELINE_TAG} -- ${...FROZEN_SET}` in
         try/catch: success (exit 0) ⇒ clean; a thrown error with `status === 1`
         ⇒ capture `git diff --stat ${BASELINE_TAG} -- ${...FROZEN_SET}` and push
         one violation per changed path `{ check:4, file:<path>, line:0,
         detail:"differs from motor-baseline (frozen set must be byte-identical)"
         }`; any other thrown error ⇒ rethrow (real git failure, not a clean/dirty
         signal).
    - **Report + exit**: print each check's name with `PASS` (zero violations) or
      `FAIL` plus its violation records as `  <file>:<line> — <detail>`; print a
      final summary line `AGNOSTICISM AUDIT: PASS` / `FAIL (<n> violations)`;
      `process.exit(violations.length > 0 ? 1 : 0)`.

- **Files to modify**: none. (Explicitly: `package.json` is **not** modified —
  no `audit` npm-script alias is added.)

- **Implementation steps**:
  1. Author `scripts/agnosticism-audit.js` exactly to the structure above.
  2. Run it: `node scripts/agnosticism-audit.js` from the repo root.
  3. If it exits `0`, record `Phase 10 agnosticism audit: PASS` plus the
     script's summary output in `spec/progress.md`. The phase is complete.
  4. If it exits `1`, the audit found a real invariant violation in a file owned
     by an earlier phase. **Do not** edit another phase's file, and **do not**
     weaken, narrow, or special-case the audit to make it pass (that is a
     test-chasing fix and is banned). Take the Clarification Exit, reporting every
     `file:line — detail` the script printed so the owning phase can fix the leak.

- **Tests**: This phase's verification **is** the audit script's own run; there
  is no `*.test.js` file (the audit is deliberately one-shot and not collected by
  `node --test`). The script's four checks are the assertions, each verifiable by
  re-running `node scripts/agnosticism-audit.js`:
  - Machine-name check asserts **zero** matches of any `MACHINE_IDS` quoted
    literal or any `MACHINE_WORD_TOKENS` word across all 22 `SCANNED_FILES`, and
    that all 22 files are present.
  - Machine-type-field check asserts **zero** matches of any `MACHINE_TYPE_FIELDS`
    identifier across the 22 files.
  - Single-slice-bypass check asserts **zero** matches of any
    `STACK_BYPASS_PATTERNS` regex in `lib/motor-stack.js` and `lib/motor-run.js`.
  - Frozen-set check asserts `motor-baseline` resolves and `git diff --quiet
    motor-baseline -- index.html lib/em-physics.js lib/coil-render.js
    lib/three-phase.js lib/layout3d.js lessons/ac_motor/` reports **no**
    differences.

- **Acceptance criteria**:
  - `scripts/agnosticism-audit.js` exists, is a dependency-free CommonJS Node
    script, and runs via `node scripts/agnosticism-audit.js` from the repo root.
  - The script hard-codes the exact frozen constants enumerated in "The
    enumerated scan set" (22 scanned files; 15 ids; the 7 word tokens; the 6
    field tokens; the 5 bypass regexes; the 6 frozen pathspecs; tag
    `motor-baseline`) and performs **no** directory globbing to build them.
  - A clean run prints `AGNOSTICISM AUDIT: PASS` and exits `0`; any violation
    prints the offending `file:line — detail` records and exits `1`.
  - On the completed Phase-1–9 build, the run exits `0` (no machine-identity
    token, no machine-type field, no single-slice fast path, frozen set
    byte-identical to `motor-baseline`), and the PASS is recorded in
    `spec/progress.md`.
  - `package.json` is unchanged by this phase (no npm-script alias added); the
    audit is not collected by `node --test`.

---

## Phase acceptance (rolls up to the manifest verification)

- `node scripts/agnosticism-audit.js` exits `0` with `AGNOSTICISM AUDIT: PASS`.
- Check 1: none of the 15 machine ids (as quoted literals) and none of the 7
  machine word-tokens appear in any of the 22 unified-motor-owned `lib/`/UI
  files; all 22 are present.
- Check 2: none of the 6 machine-type field identifiers appear in those 22 files.
- Check 3: `lib/motor-stack.js` and `lib/motor-run.js` contain none of the 5
  single-slice fast-path patterns.
- Check 4: `motor-baseline` resolves and the frozen set (`index.html`,
  `lib/em-physics.js`, `lib/coil-render.js`, `lib/three-phase.js`,
  `lib/layout3d.js`, `lessons/ac_motor/`) is byte-identical to it
  (`lib/field-render.js` excluded — Phase 5 extends it).
- `npm test` (the Phase-1–9 suites) continues to exit `0`; this phase neither
  adds to nor edits that suite.
