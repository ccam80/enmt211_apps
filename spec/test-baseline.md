# Test Baseline
- **Timestamp**: 2026-06-22T00:00:00Z (updated after batch-3 / tier-2 wave 1)
- **Command**: node --test
- **Result**: 352/356 passing, 4 failing, 0 errors, 0 skipped

## Failing Tests (pre-existing / expected)

All four remaining failures are in `tests/render/cross-section-render.test.js`, the
old Phase-2-era test that still drives the old `cross-section-render.js` against the
now-removed element-mesh API (`MMV.drawMaterial`, the old `drawModulusB` mesh
signature). **Resolved by Phase 3 Task 3.2.1 (batch-4)**, which rewrites BOTH
`lessons/unified_motor/cross-section-render.js` and this test file to the sprite +
overlays-only surface. NOT a batch-3 regression; do not mask/skip/delete.

| Test | Status | Summary |
|------|--------|---------|
| `cross-section-render.test.js › paint clears and draws the rotor + stator on each canvas` | KNOWN — until T3.2.1 | `cross-section-render.js:157` calls `MMV.drawMaterial`, deleted by T3.1.3. |
| `cross-section-render.test.js › paint dispatches each viz toggle (modulusB on, fluxLines off)` | KNOWN — until T3.2.1 | `cross-section-render.js:169` calls `MMV.drawModulusB(ctx, mesh, Belem, opts)` — old mesh signature; now requires a resampled grid. |
| `cross-section-render.test.js › paint paints content when lastSolve is null (no field overlay)` | KNOWN — until T3.2.1 | Same `MMV.drawMaterial` call at `cross-section-render.js:157`. |
| `cross-section-render.test.js › paint rotates the rotor mesh by gap.phi` | KNOWN — until T3.2.1 | Same `MMV.drawMaterial` call at `cross-section-render.js:157`. |

## Notes
- Batch-3 (T3.1.3) removed the element-mesh API from `lib/motor-mesh-view.js` per spec
  (phase-3 lines 263–265) and deleted the now-orphaned `tests/mesh/mesh-view.test.js`
  (it asserted the removed API; superseded by `tests/render/mesh-view-prod.test.js`).
  This was a coordinator-approved spec amendment recorded in the T3.1.3 "Files to
  delete" list.
