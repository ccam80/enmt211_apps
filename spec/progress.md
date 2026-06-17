# Implementation Progress — engine→app integration finishing plan

Source of truth for per-task outcomes and file lists. Implementers append here.

Plan: 9 batches across phases 0–6 (manifest.json). Started 2026-06-17.

---

## Task T0.1.2: Obsolete spec artifact removal
- **Status**: complete
- **Agent**: implementer
- **Files deleted**: 21 enumerated spec artifacts (fea-engine-rebuild, feature-brush-commutator, pi-measure-derivation, adaptive-stepper-design, profile-coupled, test-audit-2026-06-04, dldtheta-investigation-2026-06-04, correctness-sprint-2026-06-04, .hybrid-state.json, spec/reviews/spec-phase-0 through spec-phase-8, spec-review-combined, spec/.context/review-spec, spec/.context/T4.1.1-recovery-notes)
- **Directory deleted**: spec/reviews/
- **Tests**: 330/330 passing (no regressions)
- **Dry-run verification**: All 21 paths confirmed present before deletion
- **Post-condition verification**: All 21 paths confirmed absent after deletion, spec/reviews/ directory absent, 6 must-not-delete files confirmed present

## Task T0.1.1: Live-code stale-reference removal + comment reword + baseline refresh
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: lessons/unified_motor/mount.js, lib/winding-model.js, lib/motor-circuit.js, tests/pipeline/motor-stack.test.js, spec/test-baseline.md, lib/motor-mesh-view.js, lib/motor-mesh.js, lib/motor-run.js, lib/motor-slice.js, lib/motor-stack.js, lessons/unified_motor/config-schema.js, lessons/unified_motor/cross-section-render.js, tests/mesh/auto-sizing.test.js, tests/slice/assembly.test.js, tests/slice/contract.test.js, tests/slice/convergence.test.js, tests/render/_fixtures.js, tests/pipeline/_fixtures.js, tests/circuit/_fixtures.js, tests/slice/perf.test.js, tests/machines/pm-stepper.test.js, tests/mesh/uniform-gap-band.test.js, tests/slice/newton.test.js
- **Files deleted**: lessons/unified_motor/winding-editor.js
- **Tests**: 330/330 passing

---

## Batch-1 (Phase 0) — VERIFIED PASS ✅
- **Groups**: 0.1.a (T0.1.1) → PASS, 0.1.b (T0.1.2) → PASS
- **Verifier**: wave-verifier, both groups PASS, 330/330 tests, no regressions vs baseline.
- **Committed**: `8f9e975` "Batch-1 (phase 0) implementation complete".
- **Spec amendment during this batch (user-approved)**: phase-0 spec T0.1.2 had
  `spec/.hybrid-state.json` moved from its delete list to the Explicitly-KEPT list,
  because under the *old* (state-file + hook) implement-hybrid runtime that path was
  the live coordinator state and collided with T0.1.2's enumerated deletion. This
  amendment is committed in `8f9e975`.

---

## ⚠️ RESUMPTION NOTES — read before continuing (session handoff 2026-06-17)

**The `implement-hybrid` skill was reloaded mid-run and is now a different, WORKFLOW-BASED
skill** (cache path `.../claude-orchestrator/1.0.0/skills/implement-hybrid/SKILL.md`). The
work above (batch-1 / phase 0) was executed under the OLD state-file+hook runtime, which no
longer exists. Carry-over facts for a fresh session:

1. **Phase 0 is DONE and committed** (`8f9e975`), both groups verified PASS, suite 330/330.
   The new skill resumes from `spec/progress.md` + git history, so it should treat phase 0 as
   complete and start at phase 1 (next in-scope work).

2. **The new skill uses NO state file, NO hooks, NO recording scripts.** It drives one
   `Workflow(workflows/implement.mjs)` per batch; the coordinator is only the human gateway
   (clarifications, user-required actions, commits). Therefore:
   - The reconstructed `spec/.hybrid-state.json` created under the old runtime is **vestigial**
     under the new skill. (It is NOT present in the committed tree — the working copy may carry
     it; verify and delete if so.) Under the new no-state-file regime, T0.1.2's *original*
     intent (delete the old FEA `.hybrid-state.json` with no live collision) is the correct one,
     so the phase-0 spec amendment in note (1) above is arguably worth reverting to the original
     21-path delete list. Decide this at resume.

3. **BLOCKER for the new skill — manifest is missing `depends_on`.** The new SKILL.md setup
   says: *"any phase lacking a `depends_on` array → STOP and surface it as a planning failure."*
   `spec/manifest.json` currently has no `depends_on` on any phase. The new tier-based scheduler
   cannot run until each phase declares `depends_on`. This is a planning edit (manifest is
   "rewritten by plan-spec, not by an implementer").

4. **BLOCKER for the new skill — workflow script not found.** A glob for
   `**/skills/implement-hybrid/workflows/*.mjs` under the plugin cache returned **no files**.
   The new skill references `${CLAUDE_PLUGIN_ROOT}/workflows/implement.mjs`, which must exist
   before any batch can run. Confirm the plugin is fully installed (the `workflows/` dir is
   present) before re-invoking `/claude-orchestrator:implement-hybrid`.

**Clean resumption point**: HEAD = `8f9e975`, working tree clean after the commit below.
Phase 0 complete. Resolve blockers (3) and (4), decide note (2), then run the new
workflow-based skill starting at phase 1.

