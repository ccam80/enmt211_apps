# Phase 0: Dead Code Removal

## Overview

Greenfield clean-slate audit plus baseline commit. `lessons/unified_motor/`
currently contains only `DESIGN.md`, so there is no app code, test, import, or
config to delete — the phase confirms this. The existing EM-ecosystem files are
deliberately retained (live dependencies of `lessons/ac_motor/` and the root
`index.html`; the DESIGN keeps them until the new engine is independently
tested), and they are currently **untracked** in git.

This phase commits the untracked EM-ecosystem baseline as one targeted commit
and tags it `motor-baseline`, so Phase 10's freeze guard reduces to a single
`git diff motor-baseline -- <frozen set>`. The phase writes no engine code and
runs no `npm test` (no `package.json` or `tests/` exists yet — Phase 1
introduces the first ones); its acceptance is git state.

### The EM-ecosystem (`LIB.EM`) consumer set (enumerated)

The plan originally named only `ac_motor/` + root `index.html`. The actual
`LIB.EM` consumers, confirmed by search, are:

- `index.html` (root) — loads `lib/em-physics.js` (line 87) plus
  `lib/field-render.js`, `lib/coil-render.js`, `lib/three-phase.js`,
  `lib/layout3d.js`.
- `lessons/ac_motor/index.html`, `lessons/ac_motor/coaxial-loops.html` — load
  `../../lib/em-physics.js`.
- `lessons/ac_motor/coaxial-loops.js`, `pole-pairs.js`, `rotating-field.js`,
  `squirrel-cage.js`, `three-phase-cage.js`, `three-phase-rotor.js` — call
  `LIB.EM.*`.
- `lib/coil-render.js` — hard dependency (`coil-render.js:69` throws
  `LIB.CoilRender requires lib/em-physics.js`).
- `lib/field-render.js` — hard dependency (`field-render.js:74` throws
  `LIB.FieldRender requires lib/em-physics.js`).

### Frozen set vs. baseline-only

| File | In baseline commit | Phase 10 asserts unchanged |
|------|--------------------|----------------------------|
| `index.html` (root) | yes | yes |
| `lib/em-physics.js` | yes | yes |
| `lib/coil-render.js` | yes | yes |
| `lib/three-phase.js` | yes | yes |
| `lib/layout3d.js` (reused, never modified, by Phases 5 & 9) | yes | yes |
| `lessons/ac_motor/` (9 files) | yes | yes |
| `lib/field-render.js` | yes | **no** — Phase 5 extends it with `drawGapField` |

`lib/field-render.js` is committed in the baseline so Phase 5's extension shows
as a clean tracked diff; it is the only EM file excluded from the frozen-set
assertion.

## Files Owned

This phase creates no source files and modifies no source files. It establishes
a git baseline by **committing** the following currently-untracked files (their
content is not edited — only their tracked status changes) and tagging the
commit `motor-baseline`:

- `index.html` — committed (untracked → tracked)
- `lib/em-physics.js` — committed (untracked → tracked)
- `lib/coil-render.js` — committed (untracked → tracked)
- `lib/three-phase.js` — committed (untracked → tracked)
- `lib/layout3d.js` — committed (untracked → tracked)
- `lib/field-render.js` — committed (untracked → tracked)
- `lessons/ac_motor/APPS_PLAN.md` — committed (untracked → tracked)
- `lessons/ac_motor/index.html` — committed (untracked → tracked)
- `lessons/ac_motor/coaxial-loops.html` — committed (untracked → tracked)
- `lessons/ac_motor/coaxial-loops.js` — committed (untracked → tracked)
- `lessons/ac_motor/pole-pairs.js` — committed (untracked → tracked)
- `lessons/ac_motor/rotating-field.js` — committed (untracked → tracked)
- `lessons/ac_motor/squirrel-cage.js` — committed (untracked → tracked)
- `lessons/ac_motor/three-phase-cage.js` — committed (untracked → tracked)
- `lessons/ac_motor/three-phase-rotor.js` — committed (untracked → tracked)

> No file content is modified by this phase.

## Wave 0.1: Confirm clean slate + commit baseline

### Task 0.1.1: Confirm clean slate and commit the EM-ecosystem baseline
- **Description**: Confirm the unified-motor lesson directory is still
  greenfield (only `DESIGN.md`), then stage **only** the enumerated
  EM-ecosystem files (all currently untracked), commit them as a single
  targeted commit, and tag that commit `motor-baseline`. This tag is the
  reference Phase 10 diffs the frozen set against. No file content is edited.
  The working tree contains unrelated in-progress changes — staging MUST use
  the explicit pathspecs below and MUST NOT use `git add -A`, `git add .`, or
  `git commit -a`.

- **Files to create**: none

- **Files to modify**: none (content unchanged; the enumerated files transition
  from untracked to tracked via commit — see Files Owned)

- **Implementation steps**:
  1. Verify clean slate: `git ls-files lessons/unified_motor/` and a directory
     listing both show `lessons/unified_motor/DESIGN.md` as the only entry.
  2. Verify the tag does not already exist: `git tag --list motor-baseline`
     returns empty. (If it exists, take the Clarification Exit — do not move or
     overwrite it.)
  3. Stage exactly the baseline files with explicit pathspecs (no wildcards
     beyond the `ac_motor/` directory, no `-A`/`.`):
     ```
     git add -- index.html lib/em-physics.js lib/coil-render.js \
       lib/three-phase.js lib/layout3d.js lib/field-render.js lessons/ac_motor/
     ```
  4. Verify the staged set is exactly the 15 enumerated paths and nothing else:
     `git diff --cached --name-only` lists precisely the Files Owned paths
     (15 files). If it lists more or fewer, unstage and take the Clarification
     Exit.
  5. Commit:
     ```
     git commit -m "Phase 0: commit EM-ecosystem baseline (motor-baseline)

     Track the existing LIB.EM ecosystem so the unified-motor build's
     byte-unchanged guard (Phase 10) is a git diff against this tag.
     Frozen set: index.html, em-physics.js, coil-render.js, three-phase.js,
     layout3d.js, ac_motor/. field-render.js is committed here too but is
     extended by Phase 5.

     Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
     ```
  6. Tag the commit: `git tag -a motor-baseline -m "EM-ecosystem freeze baseline for the unified-motor build"`.

- **Tests**: No automated test framework exists in this phase (`package.json`
  and `tests/` are introduced in Phase 1), so acceptance is verified by the
  git-state checks below rather than by `npm test`. The phase's durable test
  artifact is the `motor-baseline` tag, which Phase 10 consumes:
  - `git diff motor-baseline -- index.html lib/em-physics.js lib/coil-render.js lib/three-phase.js lib/layout3d.js lessons/ac_motor/`
    — empty immediately after this phase (and re-run as the Phase 10 freeze
    assertion).

- **Acceptance criteria**:
  - `git ls-files lessons/unified_motor/` lists exactly
    `lessons/unified_motor/DESIGN.md` (clean slate: no app code, test, or
    config exists to remove).
  - `git rev-parse --verify motor-baseline` resolves (the tag exists and points
    at a commit).
  - `git ls-files -- index.html lib/em-physics.js lib/coil-render.js lib/three-phase.js lib/layout3d.js lib/field-render.js lessons/ac_motor/`
    lists all 15 enumerated paths (every baseline file is now tracked).
  - The `motor-baseline` commit changed exactly those 15 paths and no others:
    `git show --stat --name-only motor-baseline` lists precisely the Files
    Owned set.
  - `git diff motor-baseline -- index.html lib/em-physics.js lib/coil-render.js lib/three-phase.js lib/layout3d.js lessons/ac_motor/`
    is empty (the frozen set is byte-identical to the tagged baseline).
  - No unrelated working-tree file was staged or committed by this phase
    (the in-progress modifications listed in `git status` for other lessons and
    `lib/` files remain unstaged).
