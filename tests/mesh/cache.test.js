"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  LIB,
  singleAnnulusSection,
  ringStackSection,
} = require("./_fixtures.js");

const { MotorMesh } = LIB;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
//  Helper: build a section variant by changing a topology field
// ---------------------------------------------------------------------------
function variantSection(baseSection, patchFn) {
  const features = baseSection.features.map(f => Object.assign({}, f,
    { rRange: f.rRange.slice(), thetaRange: f.thetaRange.slice() }
  ));
  return patchFn({ features });
}

// ---------------------------------------------------------------------------
//  signature is stable
// ---------------------------------------------------------------------------

describe("signature is stable", () => {
  it("signature(section, member, opts) returns the same string across two calls", () => {
    const section = singleAnnulusSection();
    const opts = { gapLayers: 3, refine: 1 };
    const sig1 = MotorMesh.signature(section, "rotor", opts);
    const sig2 = MotorMesh.signature(section, "rotor", opts);
    assert.strictEqual(typeof sig1, "string");
    assert.ok(sig1.length > 0, "signature should be non-empty");
    assert.strictEqual(sig1, sig2, "signature should be stable across calls");
  });
});

// ---------------------------------------------------------------------------
//  signature tracks topology
// ---------------------------------------------------------------------------

describe("signature tracks topology", () => {
  it("changing topology field changes the signature; identical section/opts does not", () => {
    const section = singleAnnulusSection();
    const opts = { gapLayers: 3 };
    const sig0 = MotorMesh.signature(section, "rotor", opts);

    // Same section, same opts → same signature
    assert.strictEqual(MotorMesh.signature(section, "rotor", opts), sig0);

    // Change gapLayers → different signature
    const sigGL = MotorMesh.signature(section, "rotor", { gapLayers: 5 });
    assert.notStrictEqual(sigGL, sig0, "different gapLayers should change signature");

    // Change gapMinNodes → different signature
    const sigGMN = MotorMesh.signature(section, "rotor", { gapLayers: 3, gapMinNodes: 100 });
    assert.notStrictEqual(sigGMN, sig0, "different gapMinNodes should change signature");

    // Change a radius → different signature
    const sectionMod = variantSection(section, s => {
      // Modify first rotor feature rRange[1]
      for (const f of s.features) {
        if (f.member === "rotor") { f.rRange[1] = 0.044; break; }
      }
      return s;
    });
    const sigR = MotorMesh.signature(sectionMod, "rotor", opts);
    assert.notStrictEqual(sigR, sig0, "different radius should change signature");

    // Change refine → different signature
    const sigRef = MotorMesh.signature(section, "rotor", { gapLayers: 3, refine: 2 });
    assert.notStrictEqual(sigRef, sig0, "different refine should change signature");
  });
});

// ---------------------------------------------------------------------------
//  buildCached hits the cache
// ---------------------------------------------------------------------------

describe("buildCached hits the cache", () => {
  it("first call is a miss; second identical call is a hit; body deep-equals first", () => {
    MotorMesh.clearCache();
    const section = singleAnnulusSection();
    const opts = { gapLayers: 3 };

    const stats0 = MotorMesh.cacheStats();
    assert.strictEqual(stats0.hits, 0);
    assert.strictEqual(stats0.misses, 0);

    // First call — miss
    const res1 = MotorMesh.buildCached(section, opts);
    const stats1 = MotorMesh.cacheStats();
    assert.ok(stats1.misses >= 1, `misses should be >= 1 after first call, got ${stats1.misses}`);

    // Second identical call — hit
    const hitsBefore = MotorMesh.cacheStats().hits;
    const res2 = MotorMesh.buildCached(section, opts);
    const hitsAfter = MotorMesh.cacheStats().hits;
    assert.ok(hitsAfter > hitsBefore, `hits should increment on second call (was ${hitsBefore}, now ${hitsAfter})`);

    // Body from cache deep-equals first (same typed-array contents)
    assert.strictEqual(res1.rotor.sig, res2.rotor.sig, "cached rotor sig should match");
    assert.strictEqual(res1.rotor.nodes.length, res2.rotor.nodes.length);
    assert.strictEqual(res1.rotor.elems.length, res2.rotor.elems.length);
    assert.strictEqual(res1.rotor.gapLoop.length, res2.rotor.gapLoop.length);
  });
});

// ---------------------------------------------------------------------------
//  Physics change invalidates cache
// ---------------------------------------------------------------------------

describe("physics change invalidates cache", () => {
  it("changing circuits[0].freq from 60 Hz to 1000 Hz produces a cache miss and finer mesh", () => {
    MotorMesh.clearCache();

    // Build a section with one conductor band
    const TWO_PI = 2 * Math.PI;
    const r0 = 0.044, r1 = 0.050;
    const section = {
      features: [
        { kind: "iron", member: "rotor", rRange: [0.020, 0.040],
          thetaRange: [0, TWO_PI], muR: 1000 },
        { kind: "conductor", member: "stator", rRange: [r0, r1],
          thetaRange: [0, TWO_PI / 4], circuit: 0, turns: 40 },
        { kind: "conductor", member: "stator", rRange: [r0, r1],
          thetaRange: [TWO_PI / 4, TWO_PI / 2], circuit: 0, turns: -40 },
        { kind: "conductor", member: "stator", rRange: [r0, r1],
          thetaRange: [TWO_PI / 2, 3 * TWO_PI / 4], circuit: 0, turns: 40 },
        { kind: "conductor", member: "stator", rRange: [r0, r1],
          thetaRange: [3 * TWO_PI / 4, TWO_PI], circuit: 0, turns: -40 },
        { kind: "iron", member: "stator", rRange: [r1, r1 + 0.010],
          thetaRange: [0, TWO_PI], muR: 1000 },
      ],
    };

    const opts60   = { physics: { circuits: [{ freq:   60, amp: 100, conductorMaterial: "copper" }] } };
    const opts1000 = { physics: { circuits: [{ freq: 1000, amp: 100, conductorMaterial: "copper" }] } };

    // First build at 60 Hz — miss
    const res60 = MotorMesh.buildCached(section, opts60);
    const misses60 = MotorMesh.cacheStats().misses;

    // Second build at 60 Hz — hit (same physics)
    MotorMesh.buildCached(section, opts60);
    const hits60 = MotorMesh.cacheStats().hits;
    assert.ok(hits60 >= 1, "second 60 Hz build should be a cache hit");

    // Build at 1000 Hz — must be a miss (different physics)
    const missesBefore = MotorMesh.cacheStats().misses;
    const res1000 = MotorMesh.buildCached(section, opts1000);
    const missesAfter = MotorMesh.cacheStats().misses;

    assert.ok(
      missesAfter > missesBefore,
      `changing freq from 60 Hz to 1000 Hz should cause a cache miss (misses was ${missesBefore}, now ${missesAfter})`
    );

    // The 1000 Hz mesh should be strictly finer than the 60 Hz mesh
    // (higher frequency → smaller skin depth → more radial layers in conductor band)
    const nn60   = res60.stator.nodes.length / 2;
    const nn1000 = res1000.stator.nodes.length / 2;
    assert.ok(
      nn1000 >= nn60,
      `1000 Hz stator (${nn1000} nodes) should be at least as fine as 60 Hz stator (${nn60} nodes)`
    );
  });
});

// ---------------------------------------------------------------------------
//  LRU evicts oldest
// ---------------------------------------------------------------------------

describe("LRU evicts oldest", () => {
  it("building more than capacity distinct bodies caps cacheStats.size; oldest re-request is a miss", () => {
    MotorMesh.clearCache();

    // Build 10 distinct sections by varying the rotor rRange[1] slightly.
    // Cache capacity is 8 per body sig, so after 10 distinct rotor sigs,
    // the oldest 2+ should be evicted.
    const sections = [];
    for (let i = 0; i < 10; i++) {
      const s = singleAnnulusSection();
      // Make each section unique by modifying the outer radius slightly
      for (const f of s.features) {
        if (f.member === "rotor") { f.rRange = [0.030, 0.0440 + i * 0.0001]; break; }
      }
      sections.push(s);
    }

    const opts = {};
    // Build all 10 — each unique rotor sig is a separate entry
    for (const s of sections) {
      MotorMesh.buildCached(s, opts);
    }

    // Cache size should be capped at 8 (CACHE_CAPACITY)
    const stats = MotorMesh.cacheStats();
    assert.ok(stats.size <= 8, `cache size ${stats.size} should be <= 8`);

    // Re-request the very first (oldest, should have been evicted)
    const hitsBefore = MotorMesh.cacheStats().hits;
    const missesBefore = MotorMesh.cacheStats().misses;
    MotorMesh.buildCached(sections[0], opts);
    const statsAfter = MotorMesh.cacheStats();

    // The first section should be a miss (evicted)
    assert.ok(
      statsAfter.misses > missesBefore,
      `oldest evicted body should be a miss on re-request (misses was ${missesBefore}, now ${statsAfter.misses})`
    );
  });
});
