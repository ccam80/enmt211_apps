# Spec Review: Phase 0 — dead-code-removal

## Verdict: needs-revision

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 1 | 2 | 3 |
| info     | 0 | 0 | 3 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 0.1.1 — Confirm `lessons/unified_motor/` holds only `DESIGN.md`; commit untracked EM-ecosystem baseline; tag `motor-baseline` | yes | Full scope covered. All plan verification measures (git-state confirmation, no `npm test`) are reflected in spec acceptance criteria. |

## Findings

### Mechanical Fixes

| ID | Severity | Location | Problem | Proposed Fix |
|----|----------|----------|---------|--------------|
| M1 | minor | phase-0 §Files Owned, blockquote note | The blockquote reads: "> No file content is modified by this phase. `spec/plan.md` was corrected by the spec-authoring step (consumer list + Phase 10 guard) and is not part of this phase's implementation footprint." The second sentence is historical-provenance prose describing what happened during spec authoring — not a current-state contract statement. Per rules.md, specs must not contain historical notes or changelog prose ("No `# previously this was...` comments"; "specs are current-state contracts"). | Delete the entire second sentence, leaving only: "> No file content is modified by this phase." |

### Decision-Required Items

#### D1 — Files Owned labels not `created` or `modified` (minor)
- **Location**: phase-0 §Files Owned
- **Problem**: The review spec requires each Files Owned entry to be labelled `created` or `modified`. The spec instead labels all 15 entries as "committed (untracked → tracked)", e.g.:
  > `index.html` — committed (untracked → tracked)

  This phase neither creates file content nor modifies it — it stages existing untracked files into git. The standard labels do not cleanly apply to a git-tracking operation.
- **Why decision-required**: Two reasonable approaches exist and neither is obviously superior; the choice affects how cross-phase file-ownership checks behave against this phase's entries.
- **Options**:
  - **Option A — Keep "committed (untracked → tracked)"**: Retain the current label as a third, self-explanatory category. Add a preamble sentence to Files Owned noting that this phase uses a non-standard label because it neither creates nor modifies file content.
    - Pros: Accurately describes the operation; avoids mislabelling files as `created` or `modified` when they are neither.
    - Cons: Deviates from the standard label vocabulary; cross-phase checking tools that expect `created`/`modified` will not recognize this phase's entries.
  - **Option B — Label all 15 as `created`**: Treat "this phase is the first to track the file in git" as equivalent to `created` from the perspective of the build graph.
    - Pros: Conforms to the standard two-label vocabulary; downstream tooling can classify without special-casing Phase 0.
    - Cons: Semantically inaccurate — the files exist and have content before this phase; an implementer could misinterpret `created` as meaning "write this file from scratch."
  - **Option C — Omit the label column entirely for this phase**: Document Files Owned as a prose paragraph instead of a labelled list, explaining that this phase only changes tracked status.
    - Pros: Prevents label misinterpretation; honest about the unusual nature of the phase.
    - Cons: Most divergent from the standard format; makes automated cross-phase diffing harder.

#### D2 — Multi-line commit message shell syntax unspecified (minor)
- **Location**: phase-0 §Task 0.1.1, Implementation step 5
- **Problem**: Step 5 presents the commit command as a single `-m "..."` argument spanning multiple lines in the spec:
  ```
  git commit -m "Phase 0: commit EM-ecosystem baseline (motor-baseline)

  Track the existing LIB.EM ecosystem so the unified-motor build's
  byte-unchanged guard (Phase 10) is a git diff against this tag.
  Frozen set: index.html, em-physics.js, coil-render.js, three-phase.js,
  layout3d.js, ac_motor/. field-render.js is committed here too but is
  extended by Phase 5.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```
  The spec does not state how an implementer should handle multi-line string quoting in Git Bash on Windows. A literal copy-paste of this block is not a valid shell command without additional quoting syntax. Different implementers could plausibly use `$'...'`, a here-string, `printf | git commit -F -`, or collapse to a single-line message — each producing a different commit message body.
- **Why decision-required**: The rules.md (Shell Compatibility) requires shell commands to be Windows/Git Bash safe, and the spec's convention for multi-line commit messages (used in at least one other phase: Phase 8 task 8.3.1) is not established here. A mechanical fix would be choosing one specific quoting form, but which form is correct is a judgement call about the project's shell conventions.
- **Options**:
  - **Option A — Use Git Bash `$'...\n...'` ANSI-C quoting**: Replace the multi-line `-m "..."` block with `git commit -m $'Phase 0: commit EM-ecosystem baseline (motor-baseline)\n\nTrack the existing LIB.EM ecosystem...\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>'`
    - Pros: Single unambiguous shell command; literal newlines embedded via `\n`; valid in Git Bash on Windows.
    - Cons: Less readable in the spec document; the `$'...'` syntax is Bash-specific and may not work in all shells.
  - **Option B — Use a Git `-F` pipe**: Replace the code block with `git commit -F - <<'EOF'` followed by the message body and `EOF`, instructing the implementer to use a here-document.
    - Pros: Preserves full multi-line readability; unambiguous quoting; robust on Windows Git Bash.
    - Cons: More verbose; implementers unfamiliar with here-docs may make errors.
  - **Option C — Add a prose note**: Keep the current display form (for readability) and add a sentence: "Execute this as a here-string or via `printf '%s' '...' | git commit -F -` — do not attempt to copy the multi-line `-m` block literally."
    - Pros: Minimal change; retains the readable display of the intended message.
    - Cons: Leaves the actual shell command unspecified; could still lead to divergent implementations.

---

## Info Observations

These do not require action but are surfaced for completeness.

**I1 — Discovery-provenance phrasing in Overview (info)**: The Overview's "EM-ecosystem consumer set" subsection states the list was "confirmed by search." This is rationale prose in the overview (not in task steps), and the search results are fully enumerated — no implementer action is implied. No fix required.

**I2 — Informational parenthetical in Frozen set table (info)**: The Files Owned table entry for `lib/layout3d.js` reads `lib/layout3d.js (reused, never modified, by Phases 5 & 9)`. This is non-standard column content (a forward-reference note) but is only in the overview context table, not in the task body. No implementer action is implied.

**I3 — Phase 10 absent from manifest.json (info)**: `spec/manifest.json` contains entries for phases 0–9 but no entry for Phase 10. Phase 10 is defined in `spec/plan.md`. This is outside Phase 0's scope to fix, but it means the implement-hybrid coordinator will have no wave/task_group data for Phase 10 when it runs. Worth flagging to the plan owner for resolution before Phase 10 implementation begins.
