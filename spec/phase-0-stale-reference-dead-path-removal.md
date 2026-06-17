# Phase 0: Stale-reference + dead-path removal

## Overview

Remove every lingering reference to the deleted engine subsystems and the one
dead runtime path, so spec/implementation agents in later phases never see
legacy contracts. The engine is green (`node --test` → **330 pass / 0 fail / 0
skipped**, 102 suites); this is a reference-hygiene pass, not a physics change.

> **Code-comment hygiene (binding on every file this phase creates or modifies).**
> Comments must state what the code *is*, precisely — no narrative, historical,
> tombstone, or in-group language, and never a plan, phase, wave, or task-ID
> reference in code (e.g. not "delivered by Phase 2", "Wave 5.4 surface", "T6.1.1").
> Such references go stale the moment the work ships. Phase 6's plan-vocabulary
> sweep (`scanForPlanVocab`) enforces this repo-wide.

Discovery for this phase is complete and enumerated below. Implementers do not
re-search: they apply the listed edits and deletions exactly. The work splits
into two independent task_groups that share no files and run in parallel:

- **T0.1.1** — fix the five live-code stale-reference sites (one broken runtime
  path, one orphan file, three stale comments) and refresh the live test
  baseline doc.
- **T0.1.2** — delete the obsolete delivered-FEA-rebuild `spec/` artifacts (old
  plan, per-phase reviews, investigation logs). The old FEA job-control state at
  `spec/.hybrid-state.json` is purged out-of-band by the coordinator at run
  setup; the path is reused as live job-control state for the current run and is
  on the KEEP list below.

The two deleted guard tests (`tests/render/mount-2d-seam.test.js`,
`tests/pipeline/motor-stack.test.js`) that **assert** deleted symbols are absent
are kept — they enforce this phase's goal.

`spec/manifest.json` is rewritten by plan-spec (not by an implementer) for the
new engine→app integration plan; it is not part of any implementer's footprint.

## Files Owned

Modified:
- `lessons/unified_motor/mount.js` — modified (T0.1.1)
- `lib/winding-model.js` — modified (T0.1.1)
- `lib/motor-circuit.js` — modified (T0.1.1)
- `tests/pipeline/motor-stack.test.js` — modified (T0.1.1)
- `spec/test-baseline.md` — modified (T0.1.1)

Deleted:
- `lessons/unified_motor/winding-editor.js` — deleted (T0.1.1)
- `spec/fea-engine-rebuild.md` — deleted (T0.1.2)
- `spec/feature-brush-commutator.md` — deleted (T0.1.2)
- `spec/pi-measure-derivation.md` — deleted (T0.1.2)
- `spec/adaptive-stepper-design.md` — deleted (T0.1.2)
- `spec/profile-coupled.js` — deleted (T0.1.2)
- `spec/test-audit-2026-06-04.md` — deleted (T0.1.2)
- `spec/dldtheta-investigation-2026-06-04.md` — deleted (T0.1.2)
- `spec/correctness-sprint-2026-06-04.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-0.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-1.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-2.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-3.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-4.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-5.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-6.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-7.md` — deleted (T0.1.2)
- `spec/reviews/spec-phase-8.md` — deleted (T0.1.2)
- `spec/reviews/spec-review-combined.md` — deleted (T0.1.2)
- `spec/.context/review-spec.md` — deleted (T0.1.2)
- `spec/.context/T4.1.1-recovery-notes.md` — deleted (T0.1.2)

> **Explicitly KEPT** (not stale; live infrastructure or binding contracts):
> `spec/.context/rules.md` and `spec/.context/lock-protocol.md` (plan-agnostic
> implementer rules + the file-lock protocol `implement-hybrid` consumes),
> `spec/.hybrid-state.json` (the live job-control state `implement-hybrid`
> reads and writes throughout the current run — the old FEA state once at this
> path is purged out-of-band at run setup, and the path holds new live state),
> `spec/feature-axial-flux-coupling.md` (binding contract referenced by the new
> plan), `spec/plan.md`, and the engine's live `harmonic`-named DOF machinery in
> `lib/motor-slice.js` / `lib/airgap-mortar.js` (the mortar gap path, not the
> deleted `airgap-harmonic` engine), `lib/field-render.js` (the live AC-motor
> viz lib), and `lib/em-physics.js`'s generic `coenergyTorque` (used by the
> `lessons/ac_motor/*` lessons, out of scope per the plan's Non-Goals).

## Wave 0.1: Remove stale references and dead paths

### Task T0.1.1: Live-code stale-reference removal + comment reword + baseline refresh
- **Description**: Fix the five enumerated live-code sites that reference deleted
  engine subsystems, refresh the stale test-baseline doc, and run a repo-wide
  management-vocabulary comment strip (item 6). Sites 1–5 are enumerated with
  exact before/after text (not a search task); item 6 is a pattern-based sweep
  across the scan set.

- **Files to modify**:

  1. `lessons/unified_motor/mount.js` — source the readout's `solved` variable
     from the live `runtime.lastSolve` contract (the latest `fieldBundle`).
     `solved` is currently an **undeclared free variable** read at lines 687,
     696, 698, so the readout block throws `ReferenceError` when `frame()` runs.
     Insert one line after `const st = runtime.state;` (line 686):

     Before:
     ```js
           const st = runtime.state;
           const tau = solved ? solved.torque : 0;
     ```
     After:
     ```js
           const st = runtime.state;
           const solved = runtime.lastSolve;
           const tau = solved ? solved.torque : 0;
     ```
     The existing `solved ? … : 0` and `if (solved) { … }` guards already
     handle the pre-first-solve `null` case. Do **not** introduce any of the
     strings banned by `tests/render/mount-2d-seam.test.js` — in particular do
     not dereference `.perSliceField[`; the readouts use the `fieldBundle`
     scalars `.torque` and `.fluxLinkages[k]` only.

  2. `lib/winding-model.js` — reword the stale comment at line 11 that names the
     deleted `motor-compile`:

     Before:
     ```js
       //  that into the conductor-feature list that motor-compile rasterizes.
     ```
     After:
     ```js
       //  that into the conductor-feature list the mesher consumes.
     ```

  3. `lib/motor-circuit.js` — reword the comment block at lines 221–233 inside
     `backEmf`. It names the deleted `coenergyTorque` and carries a banned
     historical-provenance parenthetical ("Supersedes the 2026-05-29 …"),
     which `spec/.context/rules.md` Code-Hygiene prohibits. Preserve the
     `GAP_MEASURE = 1` physics rationale; drop the deleted-symbol name and the
     provenance.

     Before:
     ```js
         // Back-EMF is a CIRCUIT VOLTAGE, e = dλ/dt, and λ (the conductor loop integral
         // ∮A·dl) is physical webers with NO gap Parseval π (verified: λ ratio 1.0 to
         // the Stokes field-side reference). e = ∂_t/∂_θ of λ cannot manufacture a
         // measure λ lacks, so the motional back-EMF is measure-1 (GAP_MEASURE = 1).
         // The ∫₀^{2π}cos²=π Parseval measure is a property of the gap-ENERGY/stress
         // ring integral and lives ONLY in the torque (coenergyTorque ×π, validated
         // against the independent meshed-annulus Arkkio oracle); it is NOT a voltage.
         // Independently pinned by the rotor-cage synchronous speed: with a spurious
         // π on e the cage locks at ω_e/(2π) instead of the correct ω_e/2 = 157 rad/s.
         // (Supersedes the 2026-05-29 "π on back-EMF" attempt, which fixed the e·i-vs-
         // Arkkio power check numerically but broke the cage sync — the e·i balance must
         // be read against the co-energy torque T_arkkio/π, not Arkkio, since e·i and
         // co-energy share the measure-1 footing while Arkkio carries the gap π.)
     ```
     After:
     ```js
         // Back-EMF is a CIRCUIT VOLTAGE, e = dλ/dt, and λ (the conductor loop integral
         // ∮A·dl) is physical webers with NO gap Parseval π (λ ratio 1.0 to the Stokes
         // field-side reference). e = ∂_t/∂_θ of λ cannot manufacture a measure λ lacks,
         // so the motional back-EMF is measure-1 (GAP_MEASURE = 1). The ∫₀^{2π}cos²=π
         // Parseval measure is a property of the gap-energy/stress ring integral and
         // lives ONLY in the torque, not in a voltage. Pinned independently by the
         // rotor-cage synchronous speed: a spurious π on e would lock the cage at
         // ω_e/(2π) instead of the correct ω_e/2 = 157 rad/s.
     ```

  4. `tests/pipeline/motor-stack.test.js` — reword the tombstone comment at
     lines 7–10 that names the deleted `MotorCompile.compile`. State the test's
     contract positively rather than enumerating what it no longer uses.

     Before:
     ```js
     //  Drives LIB.MotorStack exclusively through CS.expand(woundConfig | pmConfig |
     //  salientConfig | skewN2Config) + feaOpts(); no grid-only tinySection /
     //  makeExpanded / MotorCompile.compile scaffold. Every slice construction goes
     //  through the real FEA path, so initSolver() must resolve before the first
     //  stack is built.
     ```
     After:
     ```js
     //  Drives LIB.MotorStack exclusively through CS.expand(woundConfig | pmConfig |
     //  salientConfig | skewN2Config) + feaOpts(). Every slice construction goes
     //  through the real FEA path, so initSolver() must resolve before the first
     //  stack is built.
     ```

  5. `spec/test-baseline.md` — replace the stale baseline (202/203, 1 skipped,
     dated 2026-05-27) with the current state. `spec/.context/rules.md` directs
     every implementer to read this file for pre-existing test state, so it must
     be accurate. New full content:
     ```markdown
     # Test Baseline
     - **Timestamp**: 2026-06-08T00:00:00Z
     - **Phase**: 0 (engine→app integration — stale-reference + dead-path removal)
     - **Command**: node --test
     - **Result**: 330/330 passing, 0 failing, 0 errors, 0 skipped

     ## Skipped Tests (pre-existing)
     None.
     ```

  6. **Repo-wide management-vocabulary comment strip** — reword or remove every
     code comment containing a plan/phase/wave/task reference across the full
     scan set. The patterns to match (case-insensitive) are:
     - `phase[\s-]\d`
     - `wave[\s-]?\d`
     - `T\d+\.\d+\.\d+`

     **Scan set** (identical to the file set Phase 6's `scanForPlanVocab` checks):
     `lib/**/*.js`, `lessons/**/*.js`, `lessons/**/*.html`, `tests/**/*.js`,
     `scripts/**/*.js`, and the repo-root `index.html`.

     **Carve-outs** (excluded from the scan set — do not touch):
     - `lib/em-physics.js`
     - `lessons/ac_motor/**`
     - `scripts/agnosticism-audit.js`
     - `tests/pipeline/agnosticism-audit.test.js`
     - `tests/render/mount-2d-seam.test.js`

     **Reword rules** — each comment must be reworded to state what the code
     *is*, not where it came from. Examples:
     - `// Phase 5 Wave 5.1 surface: …` → drop the label, or name the
       algorithmic stage directly
     - `// Phase 1a: assemble` / `// Phase 1b: factorize` (algorithmic stage
       labels in `motor-stack.js`) → `// Stage A: assemble` /
       `// Stage B: factorize`
     - `// Extended from Phase 2.6 …` → state what it extracts now

     **Constraints**: comment-only edits, no code-logic change. The 330/330
     suite stays green. After this strip, Phase 6's `scanForPlanVocab` is
     clean across the scan set.

     Phase 0 is plan-exempt from file-locality, so this broad footprint is
     sanctioned. Task complexity is **L** (manifest already updated).

- **Files to delete**:
  - `lessons/unified_motor/winding-editor.js` — orphan module. It is loaded by no
    HTML (`lessons/unified_motor/index.html` loads neither it nor
    `cross-section-render.js`), referenced by no test, and called by nothing
    (repo-wide search for `winding-editor` finds only its own `id`/comment at
    lines 219, 226). Its render path calls the deleted polar-grid-era
    cross-section API (`CSR.buildGeometry` line 464, `CSR.drawSemantic` line 470,
    `CSR.compileForOverlay` line 478, `CSR.drawCompiledOverlay` line 479) — none
    of which exist on the current `cross-section-render.js` (`{paint, register}`
    only). Delete the whole file.

- **Tests**:
  - `tests/render/mount-2d-seam.test.js::mount.js 2-D-render seam::mount.js no
    longer references the deleted built-in helpers` — must still pass: asserts
    `mount.js` contains none of the banned strings (`drawGapField`,
    `.perSliceField[`, `sliceGrid`, `field.Br`, `field.Bt`, …). The `solved =
    runtime.lastSolve` edit introduces no banned string, so this guard stays
    green.
  - `tests/pipeline/motor-stack.test.js::<top-level>::sliceGrid must no longer
    exist` (line 135) — must still pass: asserts `typeof stack.sliceGrid ===
    "undefined"`. The comment reword does not touch this assertion.
  - `tests/circuit/backemf.test.js` (whole suite) — must still pass unchanged:
    confirms `MotorCircuit.backEmf` behaviour is untouched by the comment reword
    (comment-only edit, no code change to `backEmf`).
  - Full suite: `node --test` reports **330 pass / 0 fail / 0 skipped** — the
    baseline is unchanged by any edit in this task.

- **Acceptance criteria**:
  - `lessons/unified_motor/mount.js` declares `solved` exactly once, as
    `const solved = runtime.lastSolve;`, and no longer reads `solved` as an
    undeclared free variable.
  - `lessons/unified_motor/winding-editor.js` does not exist.
  - Grep over `lib/`, `lessons/unified_motor/`, and `tests/` for
    `motor-compile|MotorCompile|compileForOverlay|drawCompiledOverlay` returns
    **zero** matches.
  - Grep over `lib/motor-circuit.js` for `coenergyTorque` returns **zero**
    matches (the only surviving `coenergyTorque` in `lib/` is the generic
    definition in `lib/em-physics.js`).
  - Grep over `lib/`, `lessons/unified_motor/`, and `tests/` for
    `extractCoeffs|evaluateAt|airgap-harmonic|AirgapHarmonic|harmonicSet|detailed-toggle`
    returns **zero** matches.
  - `spec/test-baseline.md` records `330/330 passing, 0 failing, 0 errors, 0
    skipped` and lists no skipped tests.
  - `node --test` reports 330 pass / 0 fail / 0 skipped; the two named guard
    tests pass.
  - No code comment in the scan set (`lib/**`, `lessons/**`, `tests/**`,
    `scripts/**`, repo-root `index.html`, minus the carve-outs) matches
    `phase[\s-]\d`, `wave[\s-]?\d`, or `T\d+\.\d+\.\d+`; Phase 6's
    `scanForPlanVocab` is clean across the scan set.
  - Grep over the scan set (`lib/**/*.js`, `lessons/**/*.js`,
    `lessons/**/*.html`, `tests/**/*.js`, `scripts/**/*.js`, repo-root
    `index.html`) excluding the five carve-outs for the patterns
    `phase[\s-]\d`, `wave[\s-]?\d`, and `T\d+\.\d+\.\d+` (case-insensitive)
    inside comments returns **zero** matches — Phase 6's `scanForPlanVocab`
    is clean across the scan set.

### Task T0.1.2: Obsolete `spec/` artifact removal (scripted, enumerated deletion)
- **Description**: Delete the obsolete delivered-FEA-rebuild `spec/` artifacts —
  the old plan document, the per-phase spec reviews, the dated investigation /
  sprint / audit logs, and the superseded physics-derivation docs. (The old FEA
  job-control state once at `spec/.hybrid-state.json` is purged out-of-band by
  the coordinator at run setup, not by this task; that path now holds live
  job-control state and is on the KEEP list.) These describe contracts that no
  longer exist (the harmonic
  gap engine, `extractCoeffs`, co-energy torque, the polar-grid engine) and are
  exactly the legacy contracts later-phase implementers must never read. This is
  a scripted, enumerated deletion — not a discovery task.

- **Affected references (authoritative — enumerated by author)**:
  The complete set of paths to delete (20 files):
  - `spec/fea-engine-rebuild.md`
  - `spec/feature-brush-commutator.md`
  - `spec/pi-measure-derivation.md`
  - `spec/adaptive-stepper-design.md`
  - `spec/profile-coupled.js`
  - `spec/test-audit-2026-06-04.md`
  - `spec/dldtheta-investigation-2026-06-04.md`
  - `spec/correctness-sprint-2026-06-04.md`
  - `spec/reviews/spec-phase-0.md`
  - `spec/reviews/spec-phase-1.md`
  - `spec/reviews/spec-phase-2.md`
  - `spec/reviews/spec-phase-3.md`
  - `spec/reviews/spec-phase-4.md`
  - `spec/reviews/spec-phase-5.md`
  - `spec/reviews/spec-phase-6.md`
  - `spec/reviews/spec-phase-7.md`
  - `spec/reviews/spec-phase-8.md`
  - `spec/reviews/spec-review-combined.md`
  - `spec/.context/review-spec.md`
  - `spec/.context/T4.1.1-recovery-notes.md`

  After deleting the nine `spec/reviews/spec-phase-*.md` files and
  `spec/reviews/spec-review-combined.md`, the `spec/reviews/` directory is empty
  — remove the empty directory too.

  **Must NOT be deleted** (verify present and untouched after the run):
  `spec/.context/rules.md`, `spec/.context/lock-protocol.md`,
  `spec/feature-axial-flux-coupling.md`, `spec/plan.md`, `spec/test-baseline.md`,
  `spec/manifest.json`, `spec/.hybrid-state.json` (live job-control state; the
  coordinator owns its contents — this task neither reads nor writes it).

- **Dry-run requirement (compulsory)**:
  The implementer's first step is a dry-run that lists every path it intends to
  delete and halts before deleting anything. The dry-run list is compared
  against the 20 paths above. If the dry-run finds a path that does not exist, or
  would delete any path not on the list (in particular any of the six
  must-not-delete files), the task FAILS and the implementer takes the
  Clarification Exit. No deletion is applied until the dry-run matches the
  enumerated list exactly.

- **Encoding controls**: not applicable — this task deletes files and writes no
  text. The implementer must not open, re-encode, or rewrite any file's content.

- **Implementation method (mandatory — script, not manual deletion)**:
  Execute via a small script the implementer writes and runs (a bash loop over a
  hard-coded path array, or a short Node script using `fs.rmSync`). The script
  must: (1) assert each of the 20 paths exists and print the full list (dry-run);
  (2) on a second pass, delete each path; (3) remove the now-empty
  `spec/reviews/` directory; (4) re-assert the six must-not-delete files still
  exist. Windows/Git-Bash safety per `spec/.context/rules.md`: double-quote all
  paths, forward slashes, `/dev/null` not `NUL`, `rm` not `del`.

- **Tests**:
  - `node --test` reports **330 pass / 0 fail / 0 skipped** after the deletion —
    none of the deleted `spec/` files is loaded by any test or runtime module, so
    the suite is unaffected. This is the task's regression check.
  - Post-condition assertion (run by the implementer's script, reported in the
    completion): all 20 enumerated paths are absent; `spec/reviews/` is absent;
    the seven must-not-delete files are present.

- **Acceptance criteria**:
  - All 20 enumerated paths no longer exist.
  - The `spec/reviews/` directory no longer exists.
  - `spec/.context/rules.md`, `spec/.context/lock-protocol.md`,
    `spec/feature-axial-flux-coupling.md`, `spec/plan.md`,
    `spec/test-baseline.md`, and `spec/manifest.json` still exist and are
    byte-unchanged by this task. `spec/.hybrid-state.json` still exists too (live
    job-control state the coordinator owns; this task neither reads nor writes
    it).
  - The dry-run list matched the 20 enumerated paths exactly (no extras, no
    misses).
  - `node --test` reports 330 pass / 0 fail / 0 skipped.
