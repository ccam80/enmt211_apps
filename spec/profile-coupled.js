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
  function wrap(obj, name, label) {
    if (!obj || typeof obj[name] !== 'function') { out.push(`  (skip ${label || name}: not a function)`); return; }
    const key = label || name; const orig = obj[name].bind(obj); T[key] = { n: 0, t: 0n };
    obj[name] = function () { const a = NS(); const r = orig.apply(null, arguments); T[key].t += NS() - a; T[key].n++; return r; };
  }
  ['coupledAssemble', 'coupledThetaPreEval', 'coupledThetaPostDiff', 'coupledSolveAgainst',
   'coupledDTdAInto', 'coupledUnitRhsInto', 'coupledFluxInto', 'buildFieldBundle'].forEach(n => wrap(slice, n));
  wrap(intl.solverSat, 'setValues', 'solver.setValues');
  wrap(intl.solverSat, 'factorize', 'solver.factorize');
  wrap(intl.solverSat, 'solveInto', 'solver.solveInto');
  wrap(intl.solverSat, 'analyze', 'solver.analyze');
  wrap(intl.solverSat, 'setPattern', 'solver.setPattern');
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

  out.push('PUBLIC BORDER METHODS (per Newton iter):');
  ['coupledAssemble', 'coupledThetaPreEval', 'coupledThetaPostDiff', 'coupledSolveAgainst', 'coupledDTdAInto', 'coupledUnitRhsInto', 'coupledFluxInto', 'buildFieldBundle'].forEach(row);
  out.push('');
  out.push('PRIMITIVES (shared; gap.torque spans assemble+postDiff+bundle):');
  ['solver.factorize', 'solver.analyze', 'solver.setPattern', 'solver.setValues', 'solver.solveInto', 'gap.torque', 'gap.torqueGrad', 'gap.stampInto', 'gap.projectInto'].forEach(row);
  out.push('');
  // coupledAssemble internal decomposition: it calls setValues + factorize + 1 gap.torque;
  // the remainder is prepareSolve + buildInto (recover+ν, tangent triplets, residual) + gapNodal.
  const asmTotal = ms('coupledAssemble');
  const fac = ms('solver.factorize'), setv = ms('solver.setValues');
  const torquePerCall = ms('gap.torque') / Math.max(1, T['gap.torque'].n);
  const torqueInAsm = torquePerCall * T['coupledAssemble'].n;
  out.push('coupledAssemble INTERNAL split:');
  out.push(`  factorize        ${fac.toFixed(0)}ms (${(100 * fac / asmTotal).toFixed(0)}%)`);
  out.push(`  setValues        ${setv.toFixed(0)}ms (${(100 * setv / asmTotal).toFixed(0)}%)`);
  out.push(`  gap.torque (×1)  ${torqueInAsm.toFixed(0)}ms (${(100 * torqueInAsm / asmTotal).toFixed(0)}%)`);
  out.push(`  assemble-work    ${(asmTotal - fac - setv - torqueInAsm).toFixed(0)}ms (${(100 * (asmTotal - fac - setv - torqueInAsm) / asmTotal).toFixed(0)}%)  ← prepareSolve + buildInto(recover+ν, tangent triplets, residual) + gapNodal`);

  fs.writeFileSync('spec/profile-coupled.out', out.join('\n') + '\n');
})().catch(e => fs.writeFileSync('spec/profile-coupled.out', 'FATAL ' + e.stack + '\n'));
