"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  syntheticPhysics,
  assertClose,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Section builders for each element kind
// ---------------------------------------------------------------------------

// I: salient iron rotor with N teeth; stator is a full-circle iron
function iSectionWithTeeth(nTeeth) {
  const toothSpan = (Math.PI / nTeeth) * 0.6; // 60% span
  const features = [];
  // I features: one per tooth
  for (let t = 0; t < nTeeth; t++) {
    const centre = t * TWO_PI / nTeeth;
    features.push({
      kind: "iron",
      member: "rotor",
      rRange: [0.038, 0.043],
      thetaRange: [centre - toothSpan / 2, centre + toothSpan / 2],
      muR: 1000,
    });
  }
  // Rotor back-iron (full circle)
  features.push({
    kind: "iron",
    member: "rotor",
    rRange: [0.030, 0.038],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  // Stator yoke (full circle)
  features.push({
    kind: "iron",
    member: "stator",
    rRange: [0.051, 0.060],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  return { features };
}

// M: alternating-pole magnet ring with N magnets; stator is full-circle iron
function mSection(nMagnets) {
  const features = [];
  const Mr = 9e5;
  for (let g = 0; g < nMagnets; g++) {
    features.push({
      kind: "magnet",
      member: "rotor",
      rRange: [0.038, 0.043],
      thetaRange: [g * TWO_PI / nMagnets, (g + 1) * TWO_PI / nMagnets],
      Mr: Mr * Math.pow(-1, g),
      Mtheta: 0,
    });
  }
  // Rotor back-iron
  features.push({
    kind: "iron",
    member: "rotor",
    rRange: [0.030, 0.038],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  // Stator yoke
  features.push({
    kind: "iron",
    member: "stator",
    rRange: [0.051, 0.060],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  return { features };
}

// W: wound stator with N conductor slots (half +turns, half -turns) + iron yoke
function wSection(nSlots) {
  const features = [];
  const slotSpan = (TWO_PI / nSlots) * 0.5; // 50% slot fill
  for (let s = 0; s < nSlots; s++) {
    const centre = s * TWO_PI / nSlots;
    features.push({
      kind: "conductor",
      member: "stator",
      rRange: [0.047, 0.051],
      thetaRange: [centre - slotSpan / 2, centre + slotSpan / 2],
      circuit: s % 2,
      turns: s % 2 === 0 ? 40 : -40,
    });
  }
  // Stator back-iron (full circle)
  features.push({
    kind: "iron",
    member: "stator",
    rRange: [0.051, 0.060],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  // Rotor back-iron
  features.push({
    kind: "iron",
    member: "rotor",
    rRange: [0.030, 0.043],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  return { features };
}

// C: concentrated-coil stator — salient teeth + conductor cells
function cSection(nSlots) {
  const features = [];
  const slotSpan = (TWO_PI / nSlots) * 0.5;
  const toothSpan = (TWO_PI / nSlots) * 0.3;
  for (let s = 0; s < nSlots; s++) {
    const centre = s * TWO_PI / nSlots;
    // Conductor slot
    features.push({
      kind: "conductor",
      member: "stator",
      rRange: [0.047, 0.051],
      thetaRange: [centre - slotSpan / 2, centre + slotSpan / 2],
      circuit: s % 3,
      turns: s % 2 === 0 ? 40 : -40,
    });
    // Salient tooth iron (narrower than slot span)
    features.push({
      kind: "iron",
      member: "stator",
      rRange: [0.047, 0.051],
      thetaRange: [centre + slotSpan / 2, centre + slotSpan / 2 + toothSpan],
      muR: 1000,
    });
  }
  // Back-iron yoke
  features.push({
    kind: "iron",
    member: "stator",
    rRange: [0.051, 0.060],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  // Rotor back-iron
  features.push({
    kind: "iron",
    member: "rotor",
    rRange: [0.030, 0.043],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  return { features };
}

// K: bar conductors in rotor (like W but on rotor); stator is W
function kSection(nSlots) {
  const features = [];
  const slotSpan = (TWO_PI / nSlots) * 0.5;
  // Rotor bars (K element = conductor on rotor)
  for (let s = 0; s < nSlots; s++) {
    const centre = s * TWO_PI / nSlots;
    features.push({
      kind: "conductor",
      member: "rotor",
      rRange: [0.038, 0.043],
      thetaRange: [centre - slotSpan / 2, centre + slotSpan / 2],
      circuit: s,
      turns: 1,
    });
  }
  // Rotor back-iron
  features.push({
    kind: "iron",
    member: "rotor",
    rRange: [0.030, 0.038],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  // Stator yoke
  features.push({
    kind: "iron",
    member: "stator",
    rRange: [0.051, 0.060],
    thetaRange: [0, TWO_PI],
    muR: 1000,
  });
  return { features };
}

// ---------------------------------------------------------------------------
//  Helper: element centroid (average of corner coords)
// ---------------------------------------------------------------------------
function elementCentroid(mesh, e) {
  const { nodes, elems } = mesh;
  const n0 = elems[4*e], n1 = elems[4*e+1], n2 = elems[4*e+2], n3 = elems[4*e+3];
  const isTri = n3 === -1;
  const cx = (nodes[2*n0] + nodes[2*n1] + nodes[2*n2] + (isTri ? 0 : nodes[2*n3])) / (isTri ? 3 : 4);
  const cy = (nodes[2*n0+1] + nodes[2*n1+1] + nodes[2*n2+1] + (isTri ? 0 : nodes[2*n3+1])) / (isTri ? 3 : 4);
  return { cx, cy };
}

// ---------------------------------------------------------------------------
//  Helper: signed element area
// ---------------------------------------------------------------------------
function elemArea(mesh, e) {
  const { nodes, elems } = mesh;
  const n0 = elems[4*e], n1 = elems[4*e+1], n2 = elems[4*e+2], n3 = elems[4*e+3];
  const x0 = nodes[2*n0], y0 = nodes[2*n0+1];
  const x1 = nodes[2*n1], y1 = nodes[2*n1+1];
  const x2 = nodes[2*n2], y2 = nodes[2*n2+1];
  if (n3 === -1) {
    return 0.5 * Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
  }
  const x3 = nodes[2*n3], y3 = nodes[2*n3+1];
  return 0.5 * Math.abs((x0*y1-x1*y0) + (x1*y2-x2*y1) + (x2*y3-x3*y2) + (x3*y0-x0*y3));
}

// ---------------------------------------------------------------------------
//  Helper: is point (r, theta) inside a feature footprint?
//  r and theta are polar coords; theta normalized to [0, 2pi).
// ---------------------------------------------------------------------------
function inFeatureFootprint(r, theta, feat) {
  const EPS = 1e-9;
  if (r < feat.rRange[0] || r >= feat.rRange[1]) return false;
  const rawSpan = feat.thetaRange[1] - feat.thetaRange[0];
  if (rawSpan >= TWO_PI - EPS) return true; // full circle
  let t0 = ((feat.thetaRange[0] % TWO_PI) + TWO_PI) % TWO_PI;
  let t1 = ((feat.thetaRange[1] % TWO_PI) + TWO_PI) % TWO_PI;
  const th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
  if (Math.abs(t1 - t0) < EPS) return false;
  if (t0 < t1) return th >= t0 && th < t1;
  return th >= t0 || th < t1; // wraps around 0
}

// ---------------------------------------------------------------------------
//  Helper: which feature does centroid (r, theta) belong to? (nearest-kind win)
// ---------------------------------------------------------------------------
function centroidFeature(r, theta, features, member) {
  let best = null;
  let bestSpan = Infinity;
  const EPS = 1e-9;
  for (const f of features) {
    if (f.member !== member) continue;
    if (!inFeatureFootprint(r, theta, f)) continue;
    const span = f.thetaRange[1] - f.thetaRange[0];
    if (span < bestSpan) { best = f; bestSpan = span; }
  }
  return best;
}

// ---------------------------------------------------------------------------
//  Helper: check that no element straddles an angular feature boundary.
//
//  An element straddles a boundary when its angular span crosses a
//  feature thetaRange edge within its radial band.  Radial band crossings
//  are expected (elements span radial node lines) and are NOT flagged.
//
//  Method: use the element centroid to locate the radial band and the
//  base angular feature.  Then check whether either angular node of the
//  element pair (j, jNext) maps to a DIFFERENT feature than the centroid.
//  Uses the theta-only classification (ignores rRange mismatch from the
//  adjacent radial row) — only angular straddling is a defect.
//
//  Returns array of element indices that cross an angular feature boundary.
// ---------------------------------------------------------------------------
function findStraddlingElements(mesh, features, member) {
  const { nodes, elems } = mesh;
  const Ne = elems.length / 4;
  const bad = [];

  // Collect body features for member, split into full-circle and angular-bounded
  const bodyFeatures = features.filter(f => f.member === member);

  // For a given (r, theta) return the best angular feature key (kind + thetaRange)
  // using only the theta-based classification at the centroid radius.
  // Uses half-open intervals [t0, t1) with no tolerance — points exactly on the
  // right edge of a feature are in the next region, matching the mesh column logic.
  function angularFeatureKey(r, theta) {
    const th = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
    let best = null, bestSpan = Infinity;
    for (const f of bodyFeatures) {
      // radial check with a small tolerance (centroid may be slightly outside rRange due to grading)
      if (r < f.rRange[0] - 1e-9 || r >= f.rRange[1] + 1e-9) continue;
      const rawSpan = f.thetaRange[1] - f.thetaRange[0];
      if (rawSpan >= TWO_PI - 1e-9) {
        // full-circle: any theta matches, lowest priority
        if (best === null) { best = f; bestSpan = TWO_PI; }
        continue;
      }
      let t0 = ((f.thetaRange[0] % TWO_PI) + TWO_PI) % TWO_PI;
      let t1 = ((f.thetaRange[1] % TWO_PI) + TWO_PI) % TWO_PI;
      let inside;
      if (Math.abs(t1 - t0) < 1e-12) { inside = false; }
      // Half-open [t0, t1): strict less-than on right edge, no tolerance
      else if (t0 < t1) { inside = th >= t0 && th < t1; }
      else { inside = th >= t0 || th < t1; } // wraps around 0
      if (inside && rawSpan < bestSpan) { best = f; bestSpan = rawSpan; }
    }
    return best ? `${best.kind}|${best.thetaRange[0].toFixed(9)}:${best.thetaRange[1].toFixed(9)}` : null;
  }

  for (let e = 0; e < Ne; e++) {
    // Use element centroid for angular feature classification.
    // An element straddles a boundary if the centroid's feature disagrees with
    // interior sample points at 1/4 and 3/4 of the angular span.
    const { cx, cy } = elementCentroid(mesh, e);
    const rCent = Math.hypot(cx, cy);
    const thCent = Math.atan2(cy, cx);

    const centKey = angularFeatureKey(rCent, thCent);

    // Angular boundary thetas from left (j) and right (jNext) column nodes
    const n0 = elems[4*e], n1 = elems[4*e+1], n2 = elems[4*e+2], n3 = elems[4*e+3];
    if (n3 < 0) continue; // skip triangles (none expected in quad mesh)

    const th_j     = Math.atan2(nodes[2*n0+1], nodes[2*n0]);
    const th_jNext = Math.atan2(nodes[2*n3+1], nodes[2*n3]);

    // Midpoints of each angular half: quarter-points of the element's angular span.
    // Handle wrap: if th_jNext < th_j (wrap around 0), add TWO_PI to jNext.
    let thL = th_j, thR = th_jNext;
    if (thR < thL - Math.PI) thR += TWO_PI;
    else if (thL < thR - Math.PI) thL += TWO_PI;

    // Quarter-point samples (interior to the element, not on the boundary)
    const thQ1 = thL + (thR - thL) * 0.25;
    const thQ3 = thL + (thR - thL) * 0.75;

    const keyQ1 = angularFeatureKey(rCent, thQ1);
    const keyQ3 = angularFeatureKey(rCent, thQ3);

    // Element straddles if any quarter-point disagrees with the centroid (midpoint)
    if (keyQ1 !== centKey || keyQ3 !== centKey) {
      bad.push(e);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
//  Helper: compute feature footprint area for one feature
// ---------------------------------------------------------------------------
function featureFootprintArea(feat) {
  const [r0, r1] = feat.rRange;
  const span = feat.thetaRange[1] - feat.thetaRange[0];
  const fullCircleArea = Math.PI * (r1*r1 - r0*r0);
  return fullCircleArea * (span / TWO_PI);
}

// ---------------------------------------------------------------------------
//  Tests
// ---------------------------------------------------------------------------

describe("no element straddles a feature boundary", () => {
  it("I salient teeth: no element spans two distinct feature regions", () => {
    const section = iSectionWithTeeth(4);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const bad = findStraddlingElements(rotor, section.features, "rotor");
    assert.strictEqual(bad.length, 0,
      `${bad.length} elements straddle feature boundaries (first: ${bad[0]})`);
  });

  it("M magnets: no element spans two distinct feature regions", () => {
    const section = mSection(4);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const bad = findStraddlingElements(rotor, section.features, "rotor");
    assert.strictEqual(bad.length, 0,
      `${bad.length} elements straddle feature boundaries (first: ${bad[0]})`);
  });

  it("W conductors: no element spans two distinct feature regions", () => {
    const section = wSection(4);
    const { stator } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const bad = findStraddlingElements(stator, section.features, "stator");
    assert.strictEqual(bad.length, 0,
      `${bad.length} elements straddle feature boundaries (first: ${bad[0]})`);
  });
});

describe("every feature region is tiled", () => {
  it("I kind: each tooth iron footprint covered by matching material elements within rel tol 1e-2", () => {
    const section = iSectionWithTeeth(4);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = rotor.elems.length / 4;

    for (const feat of section.features) {
      if (feat.member !== "rotor") continue;
      if (feat.kind !== "iron") continue;
      const rawSpan = feat.thetaRange[1] - feat.thetaRange[0];
      if (rawSpan >= TWO_PI - 1e-9) continue; // skip full-circle yoke in this check

      // Sum area of elements whose centroid is in this feature footprint and material matches
      let elemAreaSum = 0;
      for (let e = 0; e < Ne; e++) {
        const { cx, cy } = elementCentroid(rotor, e);
        const r = Math.hypot(cx, cy);
        const theta = Math.atan2(cy, cx);
        if (!inFeatureFootprint(r, theta, feat)) continue;
        const mat = rotor.materials[rotor.matId[e]];
        if (mat.kind === feat.kind) elemAreaSum += elemArea(rotor, e);
      }

      const expectedArea = featureFootprintArea(feat);
      const relErr = Math.abs(elemAreaSum - expectedArea) / expectedArea;
      assert.ok(relErr < 1e-2,
        `Feature (${feat.kind}, rRange=[${feat.rRange}], thetaRange=[${feat.thetaRange}]): ` +
        `coverage relErr ${relErr.toFixed(4)} >= 1e-2 (expected ${expectedArea.toFixed(6)}, got ${elemAreaSum.toFixed(6)})`);
    }
  });

  it("M kind: each magnet footprint covered by magnet elements within rel tol 1e-2", () => {
    const section = mSection(4);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = rotor.elems.length / 4;

    for (const feat of section.features) {
      if (feat.member !== "rotor" || feat.kind !== "magnet") continue;

      let elemAreaSum = 0;
      for (let e = 0; e < Ne; e++) {
        const { cx, cy } = elementCentroid(rotor, e);
        const r = Math.hypot(cx, cy);
        const theta = Math.atan2(cy, cx);
        if (!inFeatureFootprint(r, theta, feat)) continue;
        const mat = rotor.materials[rotor.matId[e]];
        if (mat.kind === "magnet") elemAreaSum += elemArea(rotor, e);
      }

      const expectedArea = featureFootprintArea(feat);
      const relErr = Math.abs(elemAreaSum - expectedArea) / expectedArea;
      assert.ok(relErr < 1e-2,
        `Magnet feature thetaRange=[${feat.thetaRange}]: coverage relErr ${relErr.toFixed(4)} >= 1e-2`);
    }
  });

  it("W kind: each conductor slot footprint covered by conductor elements within rel tol 1e-2", () => {
    const section = wSection(4);
    const { stator } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = stator.elems.length / 4;

    for (const feat of section.features) {
      if (feat.member !== "stator" || feat.kind !== "conductor") continue;

      let elemAreaSum = 0;
      for (let e = 0; e < Ne; e++) {
        const { cx, cy } = elementCentroid(stator, e);
        const r = Math.hypot(cx, cy);
        const theta = Math.atan2(cy, cx);
        if (!inFeatureFootprint(r, theta, feat)) continue;
        const mat = stator.materials[stator.matId[e]];
        if (mat.kind === "conductor") elemAreaSum += elemArea(stator, e);
      }

      const expectedArea = featureFootprintArea(feat);
      const relErr = Math.abs(elemAreaSum - expectedArea) / expectedArea;
      assert.ok(relErr < 1e-2,
        `Conductor slot thetaRange=[${feat.thetaRange}]: coverage relErr ${relErr.toFixed(4)} >= 1e-2`);
    }
  });
});

describe("I salient iron leaves air between teeth", () => {
  it("N teeth → exactly N iron→air transitions (2N total kind transitions)", () => {
    const nTeeth = 4;
    const section = iSectionWithTeeth(nTeeth);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = rotor.elems.length / 4;

    // Collect the radial band that is the salient tooth layer [0.038, 0.043]
    // Count elements in this band, ordered by angular position of centroid
    const toothBandElems = [];
    for (let e = 0; e < Ne; e++) {
      const { cx, cy } = elementCentroid(rotor, e);
      const r = Math.hypot(cx, cy);
      if (r >= 0.038 - 1e-9 && r <= 0.043 + 1e-9) {
        const theta = ((Math.atan2(cy, cx) % TWO_PI) + TWO_PI) % TWO_PI;
        toothBandElems.push({ e, theta, kind: rotor.materials[rotor.matId[e]].kind });
      }
    }

    // Sort by theta
    toothBandElems.sort((a, b) => a.theta - b.theta);

    const N = toothBandElems.length;
    assert.ok(N > 0, "tooth band should have elements");

    // Count iron→air or air→iron transitions around the ring (wrap-around included)
    let transitions = 0;
    for (let i = 0; i < N; i++) {
      const cur  = toothBandElems[i].kind;
      const next = toothBandElems[(i + 1) % N].kind;
      if (cur !== next) transitions++;
    }
    // 2*nTeeth transitions: iron→air × nTeeth + air→iron × nTeeth
    assert.strictEqual(transitions, 2 * nTeeth,
      `Expected ${2 * nTeeth} iron↔air transitions, got ${transitions}`);

    // Count iron angular spans: start from a known non-iron element to avoid
    // wrap-around double-counting. Find the first air element, then scan N steps.
    let startIdx = 0;
    for (let i = 0; i < N; i++) {
      if (toothBandElems[i].kind !== "iron") { startIdx = i; break; }
    }
    let ironSpans = 0;
    let inIron = false;
    for (let i = 0; i < N; i++) {
      const kind = toothBandElems[(startIdx + i) % N].kind;
      if (!inIron && kind === "iron") { ironSpans++; inIron = true; }
      else if (inIron && kind !== "iron") { inIron = false; }
    }
    assert.strictEqual(ironSpans, nTeeth,
      `Expected ${nTeeth} iron spans in tooth band, got ${ironSpans}`);
  });
});

describe("M alternating magnetization", () => {
  it("magnet elements exist, mrMag correct, magDir unit, adjacent poles opposite", () => {
    const nMagnets = 4;
    const Mr = 9e5;
    const section = mSection(nMagnets);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = rotor.elems.length / 4;

    // Find magnet elements
    const magnetElems = [];
    for (let e = 0; e < Ne; e++) {
      const mat = rotor.materials[rotor.matId[e]];
      if (mat.kind === "magnet") {
        const { cx, cy } = elementCentroid(rotor, e);
        const theta = ((Math.atan2(cy, cx) % TWO_PI) + TWO_PI) % TWO_PI;
        magnetElems.push({ e, theta, mat });
      }
    }

    assert.ok(magnetElems.length > 0, "should have magnet elements");

    // mrMag must equal hypot(Mr, 0) = Mr for all magnet materials
    const expectedMrMag = Math.hypot(Mr, 0);
    for (const mat of rotor.materials.filter(m => m.kind === "magnet")) {
      assertClose(mat.mrMag, expectedMrMag, 1e-6,
        `mrMag ${mat.mrMag} should be ${expectedMrMag}`);
    }

    // All magDir must be unit vectors
    for (const { e } of magnetElems) {
      const dx = rotor.magDir[2*e];
      const dy = rotor.magDir[2*e+1];
      const len = Math.hypot(dx, dy);
      assertClose(len, 1.0, 1e-9, `magDir[${e}] length ${len} should be 1.0`);
    }

    // Sort by theta to get angular order
    magnetElems.sort((a, b) => a.theta - b.theta);

    // For radially-magnetized magnets, the correct alternation check is:
    // the SIGN of the radial projection (magDir · radialUnit) alternates between
    // adjacent poles.  magDir · radialUnit = dx*cos(θ) + dy*sin(θ) at the element
    // centroid angle θ.  Pole with Mr>0 → projection > 0 (outward); Mr<0 → < 0 (inward).
    // Group elements by pole sector.
    const poleAngle = TWO_PI / nMagnets;
    const poles = Array.from({ length: nMagnets }, () => []);
    for (const { e, theta } of magnetElems) {
      const poleIdx = Math.floor(theta / poleAngle) % nMagnets;
      poles[poleIdx].push({ e, theta });
    }

    // Compute the average radial projection sign for each pole
    const poleSigns = poles.map(poleElems => {
      if (poleElems.length === 0) return null;
      let sum = 0;
      for (const { e, theta } of poleElems) {
        const dx = rotor.magDir[2*e], dy = rotor.magDir[2*e+1];
        const cosT = Math.cos(theta), sinT = Math.sin(theta);
        sum += dx * cosT + dy * sinT; // radial projection
      }
      return sum / poleElems.length; // average radial projection
    }).filter(v => v !== null);

    assert.ok(poleSigns.length >= 2, "need at least 2 poles to check alternation");

    // Adjacent poles must have opposite-sign radial projections
    for (let i = 0; i < poleSigns.length; i++) {
      const a = poleSigns[i];
      const b = poleSigns[(i + 1) % poleSigns.length];
      assert.ok(a * b < 0,
        `Adjacent poles ${i} and ${(i+1)%poleSigns.length}: radial projections ${a.toFixed(4)} and ${b.toFixed(4)} should have opposite signs`);
    }
  });
});

describe("W conductors carry circuit and turns", () => {
  it("every conductor element has srcId >= 0 and turns sum per srcId equals feature.turns", () => {
    const nSlots = 4;
    const section = wSection(nSlots);
    const { stator } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = stator.elems.length / 4;

    const conductorFeatures = section.features.filter(
      f => f.member === "stator" && f.kind === "conductor"
    );

    // All conductor elements must have srcId >= 0
    let conductorCount = 0;
    for (let e = 0; e < Ne; e++) {
      const mat = stator.materials[stator.matId[e]];
      if (mat.kind === "conductor") {
        conductorCount++;
        assert.ok(stator.srcId[e] >= 0,
          `Conductor element ${e} has srcId ${stator.srcId[e]}, should be >= 0`);
      }
    }
    assert.ok(conductorCount > 0, "should have conductor elements");

    // Per the 2026-05-28 Phase-2 amendment, turns[e] is the area-weighted share:
    // turns[e] = feature.turns * area_e / A_feature, where A_feature is the
    // total area of elements sharing the same srcId. Therefore Σ_{e : srcId[e]=k}
    // turns[e] == feature.turns (when all features sharing circuit k have the
    // same feature.turns value, which is the case in this fixture).
    const turnsSumPerSrc = new Map();
    const areaSumPerSrc  = new Map();
    for (let e = 0; e < Ne; e++) {
      const sid = stator.srcId[e];
      if (sid < 0) continue;
      const n0 = stator.elems[4*e], n1 = stator.elems[4*e+1];
      const n2 = stator.elems[4*e+2], n3 = stator.elems[4*e+3];
      const x0=stator.nodes[2*n0],y0=stator.nodes[2*n0+1];
      const x1=stator.nodes[2*n1],y1=stator.nodes[2*n1+1];
      const x2=stator.nodes[2*n2],y2=stator.nodes[2*n2+1];
      let a;
      if (n3 === -1) {
        a = 0.5 * Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
      } else {
        const x3=stator.nodes[2*n3],y3=stator.nodes[2*n3+1];
        a = 0.5 * Math.abs((x0*y1-x1*y0)+(x1*y2-x2*y1)+(x2*y3-x3*y2)+(x3*y0-x0*y3));
      }
      turnsSumPerSrc.set(sid, (turnsSumPerSrc.get(sid) || 0) + stator.turns[e]);
      areaSumPerSrc.set(sid,  (areaSumPerSrc.get(sid)  || 0) + a);
    }

    // For each circuit, expected total turns is the matching feature.turns.
    // (In this fixture each circuit has one feature, but the assertion is
    // written to handle the general case where multiple same-turns features
    // share a circuit.)
    for (const [sid, turnsSum] of turnsSumPerSrc) {
      // Find any feature with this circuit
      const feat = conductorFeatures.find(f => f.circuit === sid);
      assert.ok(feat !== undefined,
        `srcId ${sid} has no matching conductor feature in section`);
      assert.ok(Math.abs(turnsSum - feat.turns) < 1e-9 * Math.abs(feat.turns + 1),
        `srcId ${sid}: Σ turns[e] = ${turnsSum} should equal feature.turns = ${feat.turns} ` +
        `(area-weighted share sums to feature turns)`);
    }

    // Additionally: turns[e] / area_e must be the same constant across all
    // elements sharing one srcId (uniform Jz density).
    for (const [sid, Atot] of areaSumPerSrc) {
      const feat = conductorFeatures.find(f => f.circuit === sid);
      const expectedDensity = feat.turns / Atot;
      for (let e = 0; e < Ne; e++) {
        if (stator.srcId[e] !== sid) continue;
        const n0 = stator.elems[4*e], n1 = stator.elems[4*e+1];
        const n2 = stator.elems[4*e+2], n3 = stator.elems[4*e+3];
        const x0=stator.nodes[2*n0],y0=stator.nodes[2*n0+1];
        const x1=stator.nodes[2*n1],y1=stator.nodes[2*n1+1];
        const x2=stator.nodes[2*n2],y2=stator.nodes[2*n2+1];
        let a;
        if (n3 === -1) {
          a = 0.5 * Math.abs((x1-x0)*(y2-y0) - (x2-x0)*(y1-y0));
        } else {
          const x3=stator.nodes[2*n3],y3=stator.nodes[2*n3+1];
          a = 0.5 * Math.abs((x0*y1-x1*y0)+(x1*y2-x2*y1)+(x2*y3-x3*y2)+(x3*y0-x0*y3));
        }
        const density = stator.turns[e] / a;
        assert.ok(Math.abs(density - expectedDensity) < 1e-9 * (Math.abs(expectedDensity) + 1),
          `srcId ${sid}, element ${e}: turns/area = ${density} should be ` +
          `feature.turns/A_feature = ${expectedDensity} (uniform density)`);
      }
    }

    // Back-iron elements must be iron kind
    const ironFeats = section.features.filter(f => f.member === "stator" && f.kind === "iron");
    assert.ok(ironFeats.length > 0, "W ring should have back-iron feature");

    let backIronCount = 0;
    for (let e = 0; e < Ne; e++) {
      const mat = stator.materials[stator.matId[e]];
      const { cx, cy } = elementCentroid(stator, e);
      const r = Math.hypot(cx, cy);
      const theta = Math.atan2(cy, cx);
      for (const feat of ironFeats) {
        if (inFeatureFootprint(r, theta, feat) && mat.kind === "iron") {
          backIronCount++;
          break;
        }
      }
    }
    assert.ok(backIronCount > 0, "W ring back-iron feature should have iron elements");
  });
});

describe("C salient teeth plus conductors", () => {
  it("C ring produces both salient tooth iron elements and conductor elements with srcId", () => {
    const nSlots = 6;
    const section = cSection(nSlots);
    const { stator } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = stator.elems.length / 4;

    let hasIron = false;
    let hasConductor = false;

    for (let e = 0; e < Ne; e++) {
      const mat = stator.materials[stator.matId[e]];
      if (mat.kind === "iron") hasIron = true;
      if (mat.kind === "conductor") {
        hasConductor = true;
        assert.ok(stator.srcId[e] >= 0,
          `Conductor element ${e} in C ring should have srcId >= 0, got ${stator.srcId[e]}`);
      }
    }

    assert.ok(hasIron, "C ring should produce iron (salient tooth) elements");
    assert.ok(hasConductor, "C ring should produce conductor elements");
  });
});

describe("K bar conductors present", () => {
  it("K ring produces conductor elements with srcId >= 0 (mesher treats K like W)", () => {
    const nSlots = 6;
    const section = kSection(nSlots);
    const { rotor } = MotorMesh.build(section, { gapLayers: 2, physics: syntheticPhysics() });
    const Ne = rotor.elems.length / 4;

    let conductorCount = 0;
    for (let e = 0; e < Ne; e++) {
      const mat = rotor.materials[rotor.matId[e]];
      if (mat.kind === "conductor") {
        conductorCount++;
        assert.ok(rotor.srcId[e] >= 0,
          `K-ring conductor element ${e} has srcId ${rotor.srcId[e]}, should be >= 0`);
      }
    }

    assert.ok(conductorCount > 0,
      `K ring (bar conductors) should produce conductor elements; got ${conductorCount}`);

    // Check that conductor elements are tiled around the rotor
    const conductorThetas = [];
    for (let e = 0; e < Ne; e++) {
      const mat = rotor.materials[rotor.matId[e]];
      if (mat.kind === "conductor") {
        const { cx, cy } = elementCentroid(rotor, e);
        const theta = ((Math.atan2(cy, cx) % TWO_PI) + TWO_PI) % TWO_PI;
        conductorThetas.push(theta);
      }
    }

    // With nSlots bars there should be angular spread > half the circle
    conductorThetas.sort((a, b) => a - b);
    const thetaSpread = conductorThetas[conductorThetas.length - 1] - conductorThetas[0];
    assert.ok(thetaSpread > Math.PI,
      `K bar conductors should span > π radians around rotor (spread ${thetaSpread.toFixed(3)})`);
  });
});
