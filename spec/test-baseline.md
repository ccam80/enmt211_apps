# Test Baseline
- **Timestamp**: 2026-06-19T00:00:00Z (updated after batch-2 / tier-1)
- **Command**: node --test
- **Result**: 341/342 passing, 1 failing, 0 errors, 0 skipped

## Failing Tests (pre-existing / expected)
| Test | Status | Summary |
|------|--------|---------|
| `tests/render/cross-section-render.test.js › paint clears and draws the rotor + stator on each canvas` | KNOWN — expected until Phase 3 | `cross-section-render.js:185` (`drawAnalyticGap`) calls `LIB.GapEval.evalAOnGrid` with the stale descriptor shape, so `_validate` throws `gapInput must have rotor and stator fields`. Surfaces only now that `lib/gap-eval.js` (Phase 2 / group 2.1.a) loads real content. **Resolved by Phase 3 task 3.2.1**, which rewrites the call to the `{rotor, stator, phi}` descriptor. NOT a batch-2 regression; do not mask/skip/delete. |
