# Implementation Progress

Progress is recorded here by implementation agents. Each completed task appends its status below.
## Task T0.1.1: Confirm clean slate and commit the EM-ecosystem baseline
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: none (15 untracked files transitioned to tracked via commit)
- **Tests**: N/A (no test framework in Phase 0; acceptance is git-state verification)
- **Git state**:
  - Commit: 250064fd4833307411181bde6480f42b5629706e
  - Tag: motor-baseline
  - Frozen set byte-identical to baseline
  - All 6 acceptance criteria verified


---
## Phase 0 Complete
- **Batches**: 1
- **All verified**: yes

## Task T1.1.1: package.json + node:test runner + headless window shim
- **Status**: complete
- **Agent**: implementer
- **Files created**: package.json, tests/_shim.js, tests/smoke.test.js
- **Files modified**: (none)
- **Tests**: 2/2 passing

## Task T1.2.1: airgap-grid.js — polar FV operator, sliding band, field & flux
- **Status**: complete
- **Agent**: implementer
- **Files created**: lib/airgap-grid.js
- **Files modified**: (none)
- **Tests**: 2/2 passing (smoke suite; engine tests authored in T1.4.2)
- **Verified**:
  - All API members present: setMaterials, setRotorRegion, setRotorAngle, setIronScale, getReluctivity, setIronReluctivity, matvec, diagonal, assembleRHS, field, fluxLinkage, setGapBand, plus public properties ell/r/dr/dtheta/Nr/Ntheta/gapBand/dA
  - matvec(ones) max residual (off-pin) = 2.9e-10 < 1e-9 (constant annihilation)
  - diagonal() returns aP copy (identity at pin)
  - getReluctivity() returns a copy (mutations don't affect operator)
  - setIronReluctivity round-trip: doubles iron cells, leaves non-iron unchanged, matvec changes, restore returns entrywise to within 1e-12
  - setIronScale(2) doubles iron nu; setIronScale(1) restores
  - setRotorAngle(dtheta) shifts template by one cell (sub-machine-precision relative diff)
  - Non-rotor cells unchanged by setRotorAngle
  - setGapBand stores iInner/iOuter on op.gapBand
  - fluxLinkage agrees with analytic expectation
  - assembleRHS({Jz:null, magnetization:null}) returns zero vector (b[pin]=0 enforced)
  - Module loads under node:test require shim with no DOM access

## Task T1.3.1: airgap-solve.js — Jacobi-PCG, warm-start, global ceiling
- **Status**: complete
- **Agent**: implementer
- **Files created**: lib/airgap-solve.js
- **Files modified**: (none)
- **Tests**: 2/2 passing (smoke suite; engine tests authored in T1.4.2)
- **Verified**:
  - LIB.AirgapSolve.pcg and LIB.AirgapSolve.solveSaturated both present as functions
  - pcg converges to residual ≤ 1e-6 on a 6×32 polar grid with sinusoidal Jz source (206 iters, residual 8.2e-7)
  - Warm-start with exact solution x0 converges in 0 iters (residual identical)
  - solveSaturated with ironMask all-zeros returns satScale=1 (identity below knee)
  - solveSaturated with interior iron and strong source: satScale=245 (>>1), Bpeak in iron reduced from 25.07 to 22.14 (ceiling active)
  - setIronScale(1) restore confirmed (solveSaturated calls setIronScale(1) after corrective solve)
  - Module loads under node:test require shim with no DOM access
