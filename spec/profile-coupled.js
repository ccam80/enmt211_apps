// Detailed per-sub-step profile of the monolithic coupled-Newton solve.
//
// Wraps three layers (all reachable by dynamic dispatch, so the wrappers are seen
// by the internal calls):
//   1. public slice border methods (coupledAssemble, θ pre/post, solveAgainst, …)
//   2. solver primitives  (solverSat.setValues / factorize / solveInto)  via __internals
//   3. gap engine         (gap.torque / torqueGrad / projectInto)        via __internals
// so coupledAssemble decomposes into {assemble-work | setValues | factorize | torque}.
//
// Also dumps the fixture being solved (mesh sizes, DOF, circuits, gap rings).
global.window = global;
const F = require('../tests/machines/_fixtures.js');
const fs = require('fs'); const CS = F.UnifiedMotor.ConfigSchema, LIB = F.LIB;
const NS = () => process.hrtime.bigint();
const MACHINE = process.argv[2] || 'pmsm';

(async () => {
  await F.initSolver();
  const out = [];
  const exp = CS.expand(F.byId[MACHINE].config);
  const rt = LIB.MotorRun.create(exp);
  const slice = rt.stack.slices[0];
  const intl = slice.__internals;

  // ---------- fixture details ----------
  const gl = intl.globalLayout;
  const rb = intl.bodies.rotor, sb = intl.bodies.stator;
  const nodesOf = (b) => (b.nodes ? b.nodes.length / 2 : '?');
  const elemsOf = (b) => (b.elems ? b.elems.length / 4 : '?');
  out.push(`FIXTURE: ${MACHINE}`);
  out.push(`  poles=${intl.derivedPoles}  slots=${intl.derivedSlots}  nCircuits=${slice.nCircuits}  ell=${intl.ell}  nSlices=${rt.stack.nSlices}`);
  out.push(`  rotor : ${nodesOf(rb)} nodes, ${elemsOf(rb)} elems, gap ring ${intl._Ngr}`);
  out.push(`  stator: ${nodesOf(sb)} nodes, ${elemsOf(sb)} elems, gap ring ${intl._Ngs}`);
  out.push(`  free DOF: rotor ${gl.Nn_rotor_free} + stator ${gl.Nn_stator_free} + harmonic ${gl.nHarmonicDofs} = nGlobal ${gl.n}`);
  out.push(`  circuits: ${exp.circuits.map(c => `${c.terminal.type}/${c.commutation.mode}`).join(', ')}`);
  out.push('');

  // ---------- instrumentation ----------
  const T = {};
  let PHASE = 'other';   // attribution bucket for the event-driven analyze/setPattern
  function wrap(obj, name, label) {
    if (!obj || typeof obj[name] !== 'function') { out.push(`  (skip ${label || name}: not a function)`); return; }
    const key = label || name; const orig = obj[name].bind(obj); T[key] = { n: 0, t: 0n };
    obj[name] = function () { const a = NS(); const r = orig.apply(null, arguments); T[key].t += NS() - a; T[key].n++; return r; };
  }
  // analyze/setPattern fire INSIDE prepareSolve on band-crossings; attribute them
  // to whichever phase (preEval vs assemble) is running so we can strip them.
  function wrapPhased(obj, name, label) {
    const orig = obj[name].bind(obj);
    for (const ph of ['@pre', '@asm', '@other']) T[label + ph] = { n: 0, t: 0n };
    obj[name] = function () { const a = NS(); const r = orig.apply(null, arguments); const k = label + (PHASE === 'pre' ? '@pre' : PHASE === 'asm' ? '@asm' : '@other'); T[k].t += NS() - a; T[k].n++; return r; };
  }
  function wrapPhaseMarker(obj, name, phaseName) {
    const orig = obj[name].bind(obj); const key = name; T[key] = { n: 0, t: 0n };
    obj[name] = function () { const prev = PHASE; PHASE = phaseName; const a = NS(); const r = orig.apply(null, arguments); T[key].t += NS() - a; T[key].n++; PHASE = prev; return r; };
  }
  wrapPhaseMarker(slice, 'coupledThetaPreEval', 'pre');
  wrapPhaseMarker(slice, 'coupledAssembleNoFactor', 'asm');
  ['coupledFactorize', 'coupledThetaPostDiff', 'coupledSolveAgainst',
   'coupledDTdAInto', 'coupledUnitRhsInto', 'coupledFluxInto', 'buildFieldBundle'].forEach(n => wrap(slice, n));
  wrap(intl.solverSat, 'setValues', 'solver.setValues');
  wrap(intl.solverSat, 'factorize', 'solver.factorize');
  wrap(intl.solverSat, 'solveInto', 'solver.solveInto');
  wrapPhased(intl.solverSat, 'analyze', 'solver.analyze');
  wrapPhased(intl.solverSat, 'setPattern', 'solver.setPattern');
  wrap(intl._gap, 'torque', 'gap.torque');
  wrap(intl._gap, 'torqueGrad', 'gap.torqueGrad');
  wrap(intl._gap, 'stampInto', 'gap.stampInto');
  wrap(intl._gap, 'projectInto', 'gap.projectInto');

  let subSteps = 0, totalIters = 0;
  const origSC = rt.stack.solveCoupled.bind(rt.stack);
  rt.stack.solveCoupled = function (o) { const r = origSC(o); subSteps++; totalIters += r.iters; return r; };

  // ---------- run ----------
  const dt = 0.001, N = 10;
  const wall0 = NS();
  for (let n = 0; n < N; n++) rt.step(dt);
  const wallMs = Number(NS() - wall0) / 1e6;

  out.push(`RUN: ${N} steps, ${subSteps} sub-steps, ${totalIters} Newton iters, ${wallMs.toFixed(0)}ms wall`);
  out.push(`  ${(subSteps / N).toFixed(1)} sub-steps/step, ${(totalIters / subSteps).toFixed(2)} iters/sub-step, ${(wallMs / totalIters).toFixed(2)}ms/Newton-iter`);
  out.push('');

  const ms = (k) => Number(T[k] ? T[k].t : 0n) / 1e6;
  const row = (k) => { const r = T[k]; if (!r) return; out.push(`  ${k.padEnd(22)} n=${String(r.n).padStart(5)} (${(r.n / totalIters).toFixed(2)}/it)  total=${ms(k).toFixed(0).padStart(5)}ms  per-call=${(ms(k) / Math.max(1, r.n)).toFixed(3)}ms`); };

  const PUB = ['coupledThetaPreEval', 'coupledAssembleNoFactor', 'coupledFactorize', 'coupledThetaPostDiff',
               'coupledSolveAgainst', 'coupledDTdAInto', 'coupledUnitRhsInto', 'coupledFluxInto', 'buildFieldBundle'];
  out.push('PUBLIC SLICE METHODS (per Newton iter):');
  PUB.forEach(row);
  out.push('');
  out.push('PRIMITIVES (nested inside the above — not additive):');
  ['solver.factorize', 'solver.setValues', 'solver.solveInto',
   'solver.analyze@pre', 'solver.analyze@asm', 'solver.analyze@other',
   'solver.setPattern@pre', 'solver.setPattern@asm',
   'gap.torque', 'gap.torqueGrad', 'gap.stampInto', 'gap.projectInto'].forEach(row);
  out.push('');
  const evt = ms('solver.analyze@pre') + ms('solver.analyze@asm') + ms('solver.analyze@other') + ms('solver.setPattern@pre') + ms('solver.setPattern@asm');
  const pubSum = PUB.reduce((s, k) => s + ms(k), 0);
  const inlineSchur = wallMs - pubSum;   // residual/convergence + D-fill + the C·A⁻¹·B DOT PRODUCTS + denseSolve + back-sub + overhead
  out.push('CADENCE / WHERE-THE-TIME-IS:');
  out.push(`  per-band-crossing (analyze+setPattern, ${T['solver.analyze@pre'].n + T['solver.analyze@asm'].n + T['solver.analyze@other'].n} fires): ${evt.toFixed(0)}ms (${(100 * evt / wallMs).toFixed(0)}%)`);
  out.push(`  factorize (deferred; ${T['solver.factorize'].n} fires = non-final iters): ${ms('solver.factorize').toFixed(0)}ms (${(100 * ms('solver.factorize') / wallMs).toFixed(0)}%)`);
  out.push(`  back-solves (coupledSolveAgainst): ${ms('coupledSolveAgainst').toFixed(0)}ms (${(100 * ms('coupledSolveAgainst') / wallMs).toFixed(0)}%)`);
  out.push(`  Σ public slice methods: ${pubSum.toFixed(0)}ms`);
  out.push(`  INLINE solveCoupled (Schur DOTS + back-sub + denseSolve + residual + overhead): ${inlineSchur.toFixed(0)}ms (${(100 * inlineSchur / wallMs).toFixed(0)}%)  ← was the ~380ms sparse-uRHS target`);

  fs.writeFileSync('spec/profile-coupled.out', out.join('\n') + '\n');
})().catch(e => fs.writeFileSync('spec/profile-coupled.out', 'FATAL ' + e.stack + '\n'));
