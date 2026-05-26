# Phase 8: Legacy Reference Review + agnosticism guard

## Overview

The final audit phase. After the FEA engine + render + live UI + validation phases
have landed (Phases 0–7), Phase 8 produces a single repo-wide audit artifact —
`scripts/agnosticism-audit.js` — that runs five mechanical checks and exits 0 iff
the codebase carries **zero stale grid references**, the engine + runtime-UI
layer has **zero machine-identity dependencies**, `MotorStack`/`MotorRun` honor
the `N=1`-is-not-special invariant, and the frozen EM-physics file set is
byte-identical to `motor-baseline`. The same script is wrapped by a node-test
file so the audit runs on every `node --test` invocation, not just on demand.

`scripts/agnosticism-audit.js` has never existed in git history — the old plan's
agnosticism script was wiped along with the rest of the deleted-old-work. Phase
8 **creates** it from scratch (the plan's "extend" language is a holdover from
the previous build).

## Files Owned

### Created
- `scripts/agnosticism-audit.js` — plain CommonJS Node CLI. Walks the repo,
  applies the five checks below, prints a per-check pass/fail summary to
  stdout, exits `0` on all-pass / `1` on any failure. No third-party
  dependencies; stdlib only (`fs`, `path`, `child_process`). Excludes itself
  from its own sweep.
- `tests/audit/agnosticism.test.js` — single node-test that spawns the script
  via `child_process.spawnSync("node", ["scripts/agnosticism-audit.js"])`,
  asserts exit code 0 and that stderr is empty. Provides the `node --test`
  integration point.

### Modified
(none)

## Wave 8.1: Repo-wide audit script + test wrapper

### Task 8.1.1: Create `scripts/agnosticism-audit.js` + `tests/audit/agnosticism.test.js`

- **Description**: Author the audit script that implements the five checks
  below, plus the test wrapper that runs it under `node --test`. The script
  must be deterministic (no time-dependent or filesystem-order-dependent
  output), produce a stable summary so a regression is obvious, and exit 0
  iff every check passes. The five checks are non-negotiable specifications:
  the implementer encodes them exactly as written here.

- **Files to create**:
  - `scripts/agnosticism-audit.js` — the audit CLI.
  - `tests/audit/agnosticism.test.js` — the `node --test` wrapper.

- **Script structure (`scripts/agnosticism-audit.js`)**:
  - Plain CommonJS. No `import`. No third-party packages. Node stdlib only:
    `require("fs")`, `require("path")`, `require("child_process")`.
  - Module-level constants encode every list below (denylist tokens, scope
    file lists, machine slugs, frozen-set paths). No discovery — the lists
    are literal in source.
  - Runs the five checks in order A → B → C → D → E. Each check returns a
    `{name, ok, hits: [{file, line, snippet, pattern}]}` record. The script
    accumulates records, prints a one-line summary per check (`PASS`/`FAIL`
    + hit count) plus an enumerated per-hit dump on failure, and exits with
    code `0` if every `ok` is true, else `1`.
  - Recursive file walk via `fs.readdirSync(dir, { withFileTypes: true })`;
    skips directory names `.git`, `node_modules`, and the path
    `lessons/_solver_bench` (if present). Reads each file as UTF-8 text;
    binary files (detected by NUL byte in first 8 KB) are skipped silently.
  - The script reads itself to compute self-exclusion (Check A only —
    other checks have file-path allow/denylists that don't include the
    script).
  - No CLI arguments; the script is parameter-free. Future override needs
    are out of scope.

- **Check A — Stale grid references (repo-wide)**:
  - **In-scope files**: every file under the repo root EXCEPT:
    - `spec/**/*.md`
    - `.git/**`
    - `node_modules/**`
    - `lessons/_solver_bench/**`
    - `scripts/agnosticism-audit.js` (the script itself)
  - **Denylist (any hit fails)**:
    - Substring matches (case-sensitive): `airgap-grid`, `airgap-solve`,
      `airgap-torque`, `airgap-refine`, `airgap-worker`, `motor-compile`,
      `detailed-toggle`.
    - Word-boundary regex matches: `\bLIB\.AirgapGrid\b`,
      `\bLIB\.AirgapSolve\b`, `\bLIB\.AirgapTorque\b`,
      `\bLIB\.AirgapRefine\b`, `\bLIB\.AirgapWorker\b`,
      `\bLIB\.MotorCompile\b`, `\bdrawGapField\b`.
  - **NOT on the denylist** (deliberately allowed because they name new
    Phase 1–6 files / globals): `airgap-harmonic`, `motor-slice`,
    `LIB.MotorSlice`, `motor-mesh`, `motor-mesh-view`, `fea-solver`,
    `LIB.FeaSolver`, `gap-eval`, `LIB.GapEval`, `render3d`.
  - **Failure mode**: any in-scope file containing any denylist token =
    Check A FAIL. The dump lists every `(file, line, matched token)`.

- **Check B — Zero machine-name references in engine + runtime-UI layer**:
  - **In-scope files** (exact list, exhaustive):
    - `lib/airgap-harmonic.js`
    - `lib/app.js`
    - `lib/belt-render.js`
    - `lib/canvas-type.js`
    - `lib/cart-render.js`
    - `lib/coil-render.js`
    - `lib/contact.js`
    - `lib/control-block.js`
    - `lib/drag-smoother.js`
    - `lib/drag.js`
    - `lib/draw.js`
    - `lib/em-physics.js`
    - `lib/end-stop.js`
    - `lib/excitation.js`
    - `lib/fea-solver.js`
    - `lib/field-render.js`
    - `lib/gap-eval.js`
    - `lib/gear-pair.js`
    - `lib/gear-render.js`
    - `lib/header-buttons.js`
    - `lib/hold-detector.js`
    - `lib/integrate.js`
    - `lib/lash.js`
    - `lib/layout.js`
    - `lib/layout3d.js`
    - `lib/match-hint.js`
    - `lib/motor-circuit.js`
    - `lib/motor-mesh.js`
    - `lib/motor-mesh-view.js`
    - `lib/motor-run.js`
    - `lib/motor-slice.js`
    - `lib/motor-stack.js`
    - `lib/noise.js`
    - `lib/pid.js`
    - `lib/plot.js`
    - `lib/position-torque.js`
    - `lib/registry.js`
    - `lib/rigid-coupling.js`
    - `lib/saturate.js`
    - `lib/screw-physics.js`
    - `lib/screw-render.js`
    - `lib/stepper-drive.js`
    - `lib/thermal.js`
    - `lib/three-phase.js`
    - `lib/util.js`
    - `lib/vehicle-render.js`
    - `lib/wheel-chain.js`
    - `lib/wheel-chain-view.js`
    - `lib/winding-model.js`
    - `lessons/unified_motor/config-schema.js`
    - `lessons/unified_motor/cross-section-render.js`
    - `lessons/unified_motor/machine-picker.js`
    - `lessons/unified_motor/matrix-panel.js`
    - `lessons/unified_motor/mount.js`
    - `lessons/unified_motor/render3d.js`
    - `lessons/unified_motor/schematic-panel.js`
    - `lessons/unified_motor/winding-editor.js`
  - The script encodes this list explicitly as `BSCOPE_FILES`. Files
    missing on disk are reported as `SKIP <path> (not found)` on
    **stdout** before the summary block (one line per missing file). The
    test wrapper's `r.stderr === ""` assertion stays satisfied; the verbatim
    PASS-summary format below admits an optional prefix region of `SKIP`
    lines. The script must not crash if any in-scope file is missing —
    Phase 8 runs after Phase 7 so all should be present, but a sparse
    checkout would otherwise abort the audit.
  - **Denylist (any hit fails)** — the 15 machine-fixture name slugs as
    whole-word case-insensitive regex matches:
    - `\bbldc\b`
    - `\bbrushed-dc-pm\b`
    - `\bbrushed-dc-wound\b`
    - `\bhybrid-stepper\b`
    - `\binduction-1ph\b`
    - `\binduction-3ph\b`
    - `\bpm-stepper\b`
    - `\bpmsm\b`
    - `\bpole-mismatch-demo\b`
    - `\bskew-demo\b`
    - `\bswitched-reluctance\b`
    - `\bsynchronous-reluctance\b`
    - `\buniversal\b`
    - `\bvr-stepper\b`
    - `\bwound-field-synchronous\b`
  - **Out of scope (explicitly excluded)**:
    `lessons/unified_motor/machines/*.js`, `lessons/unified_motor/index.html`,
    all other lessons (`lessons/linear_transmission/**`,
    `lessons/rotational_transmission/**`, `lessons/ac_motor/**`,
    `lessons/pid/**`, `lessons/control/**`), `pidapp/**`, `controlapp/**`,
    `tests/**`, `spec/**`, `scripts/**`.
  - **Failure mode**: any in-scope file containing any machine-slug match =
    Check B FAIL.

- **Check C — No machine-type field read in engine + runtime-UI layer**:
  - **In-scope files**: same `BSCOPE_FILES` list as Check B.
  - **Denylist (any hit fails)** — regex matches looking for property
    reads of forbidden field names. Hits anywhere on a line (not just RHS)
    are failures, because mere presence of these field names in this layer
    is the regression the check guards against:
    - `\.machineType\b`
    - `\.machineName\b`
    - `\.machineKind\b`
  - `config.label`, `ctx.config.label`, and any other `.label` read is
    **allowed** — `label` is human-display string used by the picker; it
    never gates behavior.
  - **Failure mode**: any in-scope file containing any of the three field
    references = Check C FAIL.

- **Check D — No single-slice fast path in `motor-stack.js` / `motor-run.js`**:
  - **In-scope files** (exact list):
    - `lib/motor-stack.js`
    - `lib/motor-run.js`
  - **Denylist (any hit fails)** — regex patterns:
    - `N\s*===\s*1\b`
    - `N\s*==\s*1\b`
    - `\bslices\.length\s*===\s*1\b`
    - `\bslices\.length\s*==\s*1\b`
    - `\bnSlices\s*===\s*1\b`
    - `\bnSlices\s*==\s*1\b`
  - **Failure mode**: any pattern match in either file = Check D FAIL.

- **Check E — Frozen EM set byte-identical to `motor-baseline`**:
  - **Frozen set** (exact list):
    - `lib/em-physics.js`
    - `lib/field-render.js`
    - `lib/coil-render.js`
    - `lib/layout3d.js`
  - The script runs `git diff --exit-code motor-baseline --` followed by
    the four paths, via `child_process.execFileSync("git", […], { stdio:
    ["ignore", "pipe", "pipe"] })`, catching the throw on non-zero exit.
  - **Failure mode**: `git diff --exit-code` exits non-zero (any byte
    difference in any of the four files) = Check E FAIL. The dump
    includes the captured stdout (the diff itself, truncated to the
    first 200 lines if longer).
  - The script assumes `motor-baseline` is resolvable as a git tag in the
    current repo (verified to exist on the project's git tree). If the
    tag is missing, Check E FAILs with the explicit message
    `motor-baseline tag not found — run \`git fetch --tags\` or restore
    the tag`.

- **Script summary output**:
  - On success, prints (optionally preceded by zero or more
    `SKIP <path> (not found)` lines from Check B's missing-file handling):
    ```
    Agnosticism audit: PASS
      A stale-grid-refs        : PASS (0 hits)
      B machine-name-refs      : PASS (0 hits)
      C machine-type-field     : PASS (0 hits)
      D single-slice-fast-path : PASS (0 hits)
      E frozen-em-diff         : PASS
    ```
    The PASS summary block itself is verbatim as shown; any
    `SKIP <path> (not found)` lines (zero or more) precede the summary on
    stdout and are emitted by Check B as it walks `BSCOPE_FILES`. The
    trailing blank line + per-failure section described below for FAIL
    output is unchanged.
  - On any failure, prints `Agnosticism audit: FAIL` as the first line,
    the same five-row per-check summary (with `FAIL (<n> hits)` on the
    failed rows), then a blank line, then one section per failed check
    enumerating every hit as `<file>:<line>: <snippet> [matched: <token>]`
    (or for Check E, the captured `git diff` body).
  - Exit code: `0` on PASS, `1` on FAIL. The script uses `process.exit`
    only after fully writing summary to stdout.

- **Test wrapper (`tests/audit/agnosticism.test.js`)**:
  - Single `test("agnosticism audit exits 0", …)` using the node:test
    runner (matches the rest of the repo's test style).
  - Body: `const r = require("child_process").spawnSync("node",
    ["scripts/agnosticism-audit.js"], { encoding: "utf8", timeout: 10000 });`
    — the `timeout: 10000` ms makes the 10-second termination criterion
    machine-enforceable: a runaway recursive walk does not hang CI
    indefinitely; it is killed at 10 s and the assertion below catches it.
  - Asserts (four, in order):
    - `r.status === 0` (using `assert.strictEqual`), with assertion
      message that includes `r.stdout` so a failure surfaces the audit
      summary directly in the test output.
    - `r.stderr === ""` (script should never write to stderr on success
      or failure — diagnostics live on stdout).
    - `r.signal === null` (no signal kill — a `spawnSync` timeout kill
      sets `r.signal` to `"SIGTERM"`; this assertion catches it with the
      message `"script must complete within 10s"`).
    - `r.status !== null` (defense-in-depth: a kill produces `r.status
      === null`; the explicit assertion makes the failure mode
      unambiguous).
  - No mocks, no fixtures, no extra setup. The test is a thin process
    boundary.

- **Tests**:
  - `tests/audit/agnosticism.test.js` — the wrapper described above. The
    `node --test` runner picks it up automatically (no glob registration
    needed). Assertions are exactly the four listed (`r.status === 0`,
    `r.stderr === ""`, `r.signal === null`, `r.status !== null`).

- **Acceptance criteria**:
  - `node scripts/agnosticism-audit.js` exits `0` and prints the
    five-row PASS summary verbatim as shown above.
  - `node --test tests/audit/agnosticism.test.js` reports the single
    test green.
  - `node --test` (whole suite) includes the new test and runs green.
  - The script source contains every denylist token / scope file path
    listed in this spec, encoded as module-level constants.
  - The script never writes to stderr (verified by the wrapper's
    `r.stderr === ""` assertion).
  - The script terminates in under 10 seconds on every test run. The
    wrapper enforces this via `spawnSync({ timeout: 10000 })` plus the
    `r.signal === null` assertion: a runaway walk fails CI with the
    signal assertion's `"script must complete within 10s"` message
    instead of hanging the test runner.

## Phase-exit verification (whole-phase)

- `node scripts/agnosticism-audit.js` exits `0` with the five-row PASS
  summary.
- `node --test` runs the whole suite green, with
  `tests/audit/agnosticism.test.js` reporting one passing test.
- Manual cross-check (one-time, by the implementer): run the same five
  greps by hand against the in-scope file lists and confirm zero hits, so
  any future false-negative in the script is caught at write time rather
  than after a regression slips in. Specifically:
  - `Grep` for each denylist token in Check A across the in-scope set →
    0 hits.
  - `Grep` for each of the 15 machine-name slugs across
    `BSCOPE_FILES` → 0 hits.
  - `Grep` for `\.machineType|\.machineName|\.machineKind` across
    `BSCOPE_FILES` → 0 hits.
  - `Grep` for the Check D regex set in `motor-stack.js` and
    `motor-run.js` → 0 hits.
  - `git diff --exit-code motor-baseline -- lib/em-physics.js
    lib/field-render.js lib/coil-render.js lib/layout3d.js` → exits 0.

  **On any hit found in the in-scope files (not in the audit script
  itself):** take a **Clarification Exit** with a full hit listing
  (`file:line: <snippet> [matched: <pattern>]`). Phase 8 owns only the
  audit script; the offending reference lives in a file owned by an
  earlier phase (Phase 0 / 5 / 6 / etc.) and remediating it is that
  phase's scope, not Phase 8's. The Clarification Exit reports which
  phase the hit-bearing file belongs to so the user can decide whether
  to reopen that phase or carve out the reference in the audit's
  allow-list.
