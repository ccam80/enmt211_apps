(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  const MU0 = 4 * Math.PI * 1e-7;
  const TWO_PI = 2 * Math.PI;

  // ---------------------------------------------------------------------------
  //  coveredCells(grid, rRange, thetaRange) → int[]
  //
  //  Returns flat indices of all cells (i,j) covered by the given feature extent.
  //  rRange  = [r0, r1]: cell centre r[i] must satisfy r0 <= r[i] < r1.
  //  thetaRange = [t0, t1]: handled with periodic wrap.
  //
  //  Normalization algorithm (spec §motor-compile coveredCells):
  //    Add the smallest non-negative multiple of 2π that makes t0 >= 0.
  //    If normalized t1 >= 2π (wrap-around): cell covered when theta[j] >= t0
  //      OR theta[j] < (t1 - 2π).
  //    Otherwise: covered when t0 <= theta[j] <= t1.
  // ---------------------------------------------------------------------------
  function coveredCells(grid, rRange, thetaRange) {
    const { Nr, Ntheta, rInner, rOuter } = grid;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = TWO_PI / Ntheta;

    const [r0, r1] = rRange;
    let [t0, t1] = thetaRange;

    // Normalize: shift both endpoints by the smallest non-negative multiple of
    // 2π that makes t0 >= 0.
    if (t0 < 0) {
      const shift = Math.ceil(-t0 / TWO_PI) * TWO_PI;
      t0 += shift;
      t1 += shift;
    }

    // Small tolerance to handle floating-point boundary cells.
    const EPS = 1e-10;

    const indices = [];
    for (let i = 0; i < Nr; i++) {
      const rCentre = rInner + (i + 0.5) * dr;
      if (rCentre < r0 || rCentre >= r1) continue;

      for (let j = 0; j < Ntheta; j++) {
        const theta = (j + 0.5) * dtheta;
        let covered;
        if (t1 >= TWO_PI) {
          covered = theta >= t0 - EPS || theta <= (t1 - TWO_PI) + EPS;
        } else {
          covered = theta >= t0 - EPS && theta <= t1 + EPS;
        }
        if (covered) indices.push(i * Ntheta + j);
      }
    }
    return indices;
  }

  // ---------------------------------------------------------------------------
  //  LIB.MotorCompile.compile(section) → compiled
  //
  //  Rasterizes a section feature list onto the polar grid, producing the arrays
  //  the Phase-1 GridOperator ingests.
  //
  //  section = {
  //    grid:    { Nr, Ntheta, rInner, rOuter, ell },
  //    gapBand: { iInner, iOuter },
  //    features: [ { kind, member, rRange, thetaRange, ... }, ... ]
  //  }
  //
  //  Dispatches only on feature.kind ∈ {"conductor","magnet","iron"}.
  //  Absent kinds yield zero arrays (zero-not-skip invariant).
  // ---------------------------------------------------------------------------
  function compile(section) {
    const { grid, gapBand, features } = section;
    const { Nr, Ntheta, rInner, rOuter } = grid;
    const totalCells = Nr * Ntheta;
    const dr = (rOuter - rInner) / Nr;
    const dtheta = TWO_PI / Ntheta;

    // Derived geometry arrays
    const r = new Float64Array(Nr);
    for (let i = 0; i < Nr; i++) {
      r[i] = rInner + (i + 0.5) * dr;
    }

    const dA = new Float64Array(totalCells);
    for (let i = 0; i < Nr; i++) {
      for (let j = 0; j < Ntheta; j++) {
        dA[i * Ntheta + j] = r[i] * dr * dtheta;
      }
    }

    // Initialize output arrays
    const nu = new Float64Array(totalCells).fill(1 / MU0);  // air everywhere
    const Mr = new Float64Array(totalCells);
    const Mtheta = new Float64Array(totalCells);
    const rotorMask = new Uint8Array(totalCells);
    const ironMask = new Uint8Array(totalCells);

    // Collect conductor features and track circuit indices
    const conductorFeatures = [];
    const circuitSet = new Set();

    for (const feature of features) {
      const cells = coveredCells(grid, feature.rRange, feature.thetaRange);

      // rotor membership — any feature with member==="rotor" marks rotor cells
      if (feature.member === "rotor") {
        for (const idx of cells) rotorMask[idx] = 1;
      }

      if (feature.kind === "iron") {
        const nuIron = 1 / (feature.muR * MU0);
        for (const idx of cells) {
          // Smallest ν wins (largest muR / most permeable iron wins)
          if (nuIron < nu[idx]) nu[idx] = nuIron;
          ironMask[idx] = 1;
        }
      } else if (feature.kind === "magnet") {
        for (const idx of cells) {
          Mr[idx] += feature.Mr;
          Mtheta[idx] += feature.Mtheta;
        }
      } else if (feature.kind === "conductor") {
        conductorFeatures.push({ feature, cells });
        circuitSet.add(feature.circuit);
      }
    }

    // Validate contiguous circuit indices
    let nCircuits = 0;
    if (circuitSet.size > 0) {
      const maxCircuit = Math.max(...circuitSet);
      nCircuits = maxCircuit + 1;
      for (let k = 0; k < nCircuits; k++) {
        if (!circuitSet.has(k)) {
          throw new Error(
            `motor-compile: conductor circuit indices are not contiguous — ` +
            `found circuits {${[...circuitSet].sort((a, b) => a - b).join(", ")}} ` +
            `but circuit ${k} is missing`
          );
        }
      }
    }

    // Build coil masks: turns-per-unit-area so Σ coilMasks[k]·dA = signed turns
    const coilMasks = [];
    for (let k = 0; k < nCircuits; k++) {
      coilMasks.push(new Float64Array(totalCells));
    }

    for (const { feature, cells } of conductorFeatures) {
      // Slot area = sum of dA over covered cells
      let Aslot = 0;
      for (const idx of cells) Aslot += dA[idx];

      if (Aslot === 0) continue;

      const mask = coilMasks[feature.circuit];
      const density = feature.turns / Aslot;
      for (const idx of cells) {
        mask[idx] += density;
      }
    }

    // assembleJz: currents[k] * coilMasks[k] summed over k
    function assembleJz(currents) {
      const Jz = new Float64Array(totalCells);
      for (let k = 0; k < nCircuits; k++) {
        const ik = currents[k];
        if (ik === 0) continue;
        const mask = coilMasks[k];
        for (let idx = 0; idx < totalCells; idx++) {
          Jz[idx] += ik * mask[idx];
        }
      }
      return Jz;
    }

    return {
      grid: Object.assign({}, grid, { dr, dtheta, r, dA }),
      nu,
      magnetization: { Mr, Mtheta },
      coilMasks,
      rotorMask,
      ironMask,
      gapBand,
      nCircuits,
      assembleJz,
    };
  }

  LIB.MotorCompile = { compile };
})();
