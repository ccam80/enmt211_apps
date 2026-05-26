# Spec Review: Phase 8 — Legacy Reference Review + agnosticism guard

## Verdict: ready

## Tally
| Severity | Mechanical | Decision-Required | Total |
|----------|------------|-------------------|-------|
| critical | 0 | 0 | 0 |
| major    | 0 | 0 | 0 |
| minor    | 0 | 3 | 3 |
| info     | 1 | 0 | 1 |

## Plan Coverage
| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| 8.1.1 — Repo-wide sweep for stale grid references + extend/create agnosticism audit script + run four checks, exit 0 | yes | Spec correctly notes the plan's "extend" language is stale (script never existed); creates from scratch. All five checks (A–E) directly address the plan's four verification bullet points. Plan verification measure "git diff motor-baseline over the frozen set — now re-including field-render.js — is empty" maps to Check E. All plan verification measures reflected in acceptance criteria. |

## Findings

### Mechanical Fixes
None found.

### Decision-Required Items

#### D1 — Manual cross-check remediation path unspecified (minor)
- **Location**: phase-8 §Phase-exit verification, "Manual cross-check (one-time, by the implementer)" bullet
- **Problem**: The spec instructs the implementer to "run the same five greps by hand against the in-scope file lists and confirm zero hits, so any future false-negative in the script is caught at write time." It does not specify what the implementer must do if the manual greps surface hits. If hits are found in the codebase files (not in the audit script), the implementer has no remediation path — Phase 8 creates only the audit script, not the code under audit. An earlier phase would have failed to clean up correctly.
- **Why decision-required**: Two distinct remediation postures are possible — the choice between them affects what the implementer is required to do vs. escalate.
- **Options**:
  - **Option A — Escalate to coordinator on any hit**: Add to the manual cross-check bullet: "If any hit is found in the in-scope files (not in the audit script logic), take the Clarification Exit with a full hit listing — Phase 8 does not own remediation of earlier-phase violations." The implementer fixes only audit-script false-negatives; real violations are escalated.
    - Pros: Clear, matches the Clarification Exit protocol; no scope creep into earlier-phase files.
    - Cons: Slightly verbose addition.
  - **Option B — Implementer fixes any hit directly**: Add "If hits are found, fix the violation in the referenced file (remove the stale reference or machine-name read) before completing the task." Phase 8 becomes both the auditor and the remediation sweep.
    - Pros: Self-contained; no escalation needed.
    - Cons: Expands Phase 8's scope beyond what the spec currently describes (Files Owned lists no modifications); potentially modifies files owned by other phases, violating file-ownership invariants.

#### D2 — "log the missing path" destination ambiguous (minor)
- **Location**: phase-8 §Task 8.1.1 Check B, "Files missing on disk are skipped silently … log the missing path and continue"
- **Problem**: The spec says missing BSCOPE_FILES should be "log[ged]" but does not say where. The script's entire output contract sends diagnostics to stdout (the summary format is explicit stdout-only; the test wrapper asserts `r.stderr === ""`). If "log" means stderr, the test wrapper will fail on any missing file. If "log" means stdout, it must be incorporated into the summary format — but the success-path output format is specified verbatim and has no slot for missing-file notices.
- **Why decision-required**: "Log" could plausibly mean stdout (breaking the verbatim PASS output format), stderr (breaking the `r.stderr === ""` assertion), or simply be silently dropped (contradicting "log").
- **Options**:
  - **Option A — Silently skip, no log**: Change "log the missing path and continue" to "skip silently and continue." The missing-file notice is dropped entirely. The PASS output format stays verbatim; the stderr assertion stays clean.
    - Pros: Consistent with "skipped silently" already used in the same sentence; no output-format conflict.
    - Cons: A misconfigured Phase 8 run (e.g., Phase 6 not yet complete) would silently under-report scope.
  - **Option B — Include missing-file notices in stdout before the summary block**: Specify that any missing BSCOPE_FILE is printed as `SKIP <path> (not found)` on stdout before the five-row summary. The verbatim PASS format then applies only to the trailing summary block.
    - Pros: Visible; no stderr pollution; test wrapper passes.
    - Cons: Requires the verbatim output spec to be amended to acknowledge the optional prefix lines.
  - **Option C — Assert all BSCOPE_FILES present, fail if any missing**: Change "skipped silently" to "Check B FAILs if any listed file is absent, with message `BSCOPE missing: <path>`." Since Phase 8 runs after Phase 7 when all files must exist, a missing file is always an error.
    - Pros: Strictest; catches incomplete earlier phases.
    - Cons: Would cause Check B to fail in a legitimate sparse-checkout / early-phase test run.

#### D3 — 10-second termination criterion not asserted by any automated check (minor)
- **Location**: phase-8 §Task 8.1.1, Acceptance criteria: "The script terminates in under 10 seconds on a clean checkout (the wrapper does not assert this, but the implementer verifies it locally before completing the task)"
- **Problem**: The acceptance criterion explicitly acknowledges it is not enforced by the test wrapper. It relies on the implementer self-reporting compliance. There is no timeout in the `spawnSync` call spec'd for the test wrapper, so a slow script would hang tests indefinitely rather than fail at 10 s.
- **Why decision-required**: Whether to add a timeout assertion to the wrapper or leave this as an informal criterion is a design choice with different trade-offs.
- **Options**:
  - **Option A — Add `timeout: 10000` to `spawnSync`**: Amend the test wrapper spec: `spawnSync("node", ["scripts/agnosticism-audit.js"], { encoding: "utf8", timeout: 10000 })`. Add a fourth assertion: `assert.strictEqual(r.signal, null, "script must complete within 10 s")` (a timeout kill sets `r.signal` to `"SIGTERM"`).
    - Pros: Makes the criterion machine-enforceable; catches a runaway recursive walk at CI time.
    - Cons: Adds a fourth assertion the spec currently says has exactly three; CI speed variance could cause flaky timeouts on slow machines.
  - **Option B — Remove the 10-second criterion entirely**: Delete "The script terminates in under 10 seconds…" from acceptance criteria. A recursive walk of a repo with a few hundred files is sub-second by design; the criterion is redundant.
    - Pros: No flakiness risk; simplifies the spec.
    - Cons: Removes an explicit performance guard; a future badly-written walk would go undetected.

---

## Info

#### I1 — Plan's "extend" language vs spec's "create from scratch" clarification (info)
- **Location**: phase-8 §Overview, second paragraph: "Phase 8 **creates** it from scratch (the plan's 'extend' language is a holdover from the previous build)."
- **Observation**: The spec correctly explains the discrepancy between the plan ("extend the agnosticism audit script") and reality (script never existed). This is handled appropriately and does not require any fix. Surfaced for completeness so a future plan reader is not confused.
