# Phase 3 (merged "core-rest") — SPEC ROUTER

> **This file is a router, not a spec.** It exists only so `implement-hybrid`
> can hand one `spec_file` to implementers/verifiers for a wave that bundles
> two independent origin phases (3 and 4) running concurrently. The
> authoritative task specifications live in the original, unchanged phase spec
> files. **Find your assigned task ID below and open the file it points to.**

This merged phase runs the remaining post-Phase-1 core layers — excitation +
commutation (origin Phase 3) and the circuit ODE (origin Phase 4) — in
parallel. The two origin phases share no files and have no cross-dependency, so
their task_groups are bundled by dependency-depth into two waves.

## Task → authoritative spec

| Task ID | Open this file | Task heading there |
|---------|----------------|--------------------|
| `T3.1.1` | `spec/phase-3-excitation-commutation.md` | Task 3.1.1 |
| `T3.1.2` | `spec/phase-3-excitation-commutation.md` | Task 3.1.2 |
| `T4.1.1` | `spec/phase-4-circuit-ode.md` | Task 4.1.1 |
| `T4.2.1` | `spec/phase-4-circuit-ode.md` | Task 4.2.1 |

Read the **whole** origin phase spec's Overview / Conventions / Files-Owned
sections before implementing your task — those framing sections still apply
verbatim; only the wave/batch packaging changed.

## Wave packaging (for reference; the contract is `spec/manifest.json`)

- **Wave 3.1** (parallel): `3.1.a` = T3.1.1 (excitation.js) · `4.1.a` = T4.1.1 (motor-circuit.js)
- **Wave 3.2** (parallel): `3.2.a` = T3.1.2 (excitation tests) · `4.2.a` = T4.2.1 (circuit tests)

Each origin phase's internal order is preserved (3.1.1 → 3.1.2; 4.1.1 → 4.2.1).
No two task_groups in any wave touch the same file.
