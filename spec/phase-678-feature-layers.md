# Phase 6 (merged "feature-layers") — SPEC ROUTER

> **This file is a router, not a spec.** It exists only so `implement-hybrid`
> can hand one `spec_file` to implementers/verifiers for waves that bundle
> three independent origin phases (6, 7, 8) running concurrently. The
> authoritative task specifications live in the original, unchanged phase spec
> files. **Find your assigned task ID below and open the file it points to.**

This merged phase runs the three post-Phase-5 feature layers — machine config
fixtures + validation (origin Phase 6), the editors (origin Phase 7), and
Detailed mode / refined-grid + worker (origin Phase 8) — in parallel. The
three origin phases share no files except the append-only `index.html`
module-extension region, and the two `index.html` appenders (`7.5.a`, `8.3.a`)
are placed in different waves so no two implementers write that file in the
same wave.

## Task → authoritative spec

| Task ID | Open this file | Task heading there |
|---------|----------------|--------------------|
| `T6.1.1` | `spec/phase-6-machine-fixtures.md` | Task 6.1.1 |
| `T6.1.2` | `spec/phase-6-machine-fixtures.md` | Task 6.1.2 |
| `T6.1.3` | `spec/phase-6-machine-fixtures.md` | Task 6.1.3 |
| `T6.2.1` | `spec/phase-6-machine-fixtures.md` | Task 6.2.1 |
| `T6.3.1` | `spec/phase-6-machine-fixtures.md` | Task 6.3.1 |
| `T6.3.2` | `spec/phase-6-machine-fixtures.md` | Task 6.3.2 |
| `T7.1.1` | `spec/phase-7-editors.md` | Task 7.1.1 |
| `T7.2.1` | `spec/phase-7-editors.md` | Task 7.2.1 |
| `T7.3.1` | `spec/phase-7-editors.md` | Task 7.3.1 |
| `T7.4.1` | `spec/phase-7-editors.md` | Task 7.4.1 |
| `T7.5.1` | `spec/phase-7-editors.md` | Task 7.5.1 |
| `T8.1.1` | `spec/phase-8-detailed-mode.md` | Task 8.1.1 |
| `T8.2.1` | `spec/phase-8-detailed-mode.md` | Task 8.2.1 |
| `T8.2.2` | `spec/phase-8-detailed-mode.md` | Task 8.2.2 |
| `T8.3.1` | `spec/phase-8-detailed-mode.md` | Task 8.3.1 |

Read the **whole** origin phase spec's Overview / Conventions / Files-Owned /
Machine-agnosticism sections before implementing your task — those framing
sections still apply verbatim; only the wave/batch packaging changed.

## Wave packaging (for reference; the contract is `spec/manifest.json`)

- **Wave 6.1** (7 parallel groups): `6.1.a` T6.1.1 · `6.1.b` T6.1.2 ·
  `6.1.c` T6.1.3 (index.html append) · `7.1.a` T7.1.1 (cross-section-render) ·
  `7.3.a` T7.3.1 (schematic-panel) · `7.4.a` T7.4.1 (matrix-panel) ·
  `8.1.a` T8.1.1 (airgap-refine)
- **Wave 6.2** (4 parallel groups): `6.2.a` T6.2.1 (test loader) ·
  `7.2.a` T7.2.1 (winding-editor — consumes the realized cross-section-render
  from 7.1.a) · `8.2.a` T8.2.1 (airgap-worker) · `8.2.b` T8.2.2 (detailed-toggle)
- **Wave 6.3** (3 parallel groups): `6.3.a` T6.3.1 (rows 1–7 tests) ·
  `6.3.b` T6.3.2 (rows 8–13 + demos tests) · `8.3.a` T8.3.1 (detailed tests +
  index.html append)
- **Wave 6.4** (1 group): `7.5.a` T7.5.1 (editor tests + index.html append) —
  alone so its `index.html` append never races `8.3.a`'s

### Dependency notes preserved from the origin phases

- Phase 6 chain: fixtures (6.1.*) → loader (6.2.a) → validation tests (6.3.*).
- Phase 7 chain: `7.1` (cross-section-render) + `7.3` (schematic) + `7.4`
  (matrix) are mutually independent and run together in Wave 6.1; `7.2`
  (winding-editor) depends on `7.1` and runs in Wave 6.2; `7.5` (tests + wiring)
  depends on all four panels and runs last in Wave 6.4.
- Phase 8 chain: `8.1` (refined backend) → `8.2.*` (worker + toggle) → `8.3`
  (tests + wiring).

## User-required tasks (browser verification)

- `T8.3.1` (group `8.3.a`, Wave 6.3) — Detailed-mode browser verification.
- `T7.5.1` (group `7.5.a`, Wave 6.4) — editor live-behaviour browser verification.

Both follow the standard user-ack gate (`ack-user-gate.sh`), enumerated per
group in `spec/manifest.json`.
