"use strict";

const fs   = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
//  Root of the repo — one directory above this script.
// ---------------------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
//  MACHINE_NAMES — 8 type tokens scanned case-insensitively as substrings.
// ---------------------------------------------------------------------------
const MACHINE_NAMES = Object.freeze([
  "bldc",
  "pmsm",
  "srm",
  "squirrel",
  "stepper",
  "brushed",
  "universal-motor",
  "wound-field",
]);

// ---------------------------------------------------------------------------
//  MACHINE_IDS — 15 fixture ids scanned as quoted string literals.
// ---------------------------------------------------------------------------
const MACHINE_IDS = Object.freeze([
  "pmsm",
  "brushed-dc-pm",
  "brushed-dc-wound",
  "universal",
  "bldc",
  "induction-3ph",
  "induction-1ph",
  "vr-stepper",
  "switched-reluctance",
  "pm-stepper",
  "hybrid-stepper",
  "synchronous-reluctance",
  "wound-field-synchronous",
  "skew-demo",
  "pole-mismatch-demo",
]);

// ---------------------------------------------------------------------------
//  NAME_SCAN_FILES — the 5 runtime-UI files (repo-relative).
//  lib/*.js minus NAME_CARVE_OUTS is enumerated at scan time.
// ---------------------------------------------------------------------------
const NAME_SCAN_FILES = Object.freeze([
  "lessons/unified_motor/mount.js",
  "lessons/unified_motor/cross-section-render.js",
  "lessons/unified_motor/render3d.js",
  "lessons/unified_motor/machine-picker.js",
  "lessons/unified_motor/geometry-panel.js",
]);

// ---------------------------------------------------------------------------
//  NAME_CARVE_OUTS — lib/*.js files excluded from the name scan.
// ---------------------------------------------------------------------------
const NAME_CARVE_OUTS = Object.freeze([
  "app.js",
  "registry.js",
  "header-buttons.js",
  "stepper-drive.js",
  "three-phase.js",
]);

// ---------------------------------------------------------------------------
//  LEGACY_TERMS — deleted-subsystem identifiers searched literally.
// ---------------------------------------------------------------------------
const LEGACY_TERMS = Object.freeze([
  "airgap-harmonic",
  "harmonic-set",
  "harmonicSet",
  "extractCoeffs",
  "coenergyTorque",
  "evaluateAt",
  "drawGapField",
  "MotorCompile",
  "compileForOverlay",
  "drawCompiledOverlay",
  "detailed-toggle",
  "airgap-grid",
]);

// ---------------------------------------------------------------------------
//  LEGACY_CARVE_OUTS — repo-relative paths excluded from the legacy sweep.
//  A path matches when it equals the entry, or for entries ending in '/'
//  when the path starts with that prefix.
// ---------------------------------------------------------------------------
const LEGACY_CARVE_OUTS = Object.freeze([
  "lib/em-physics.js",
  "lessons/ac_motor/",
  "tests/render/mount-2d-seam.test.js",
  "scripts/agnosticism-audit.js",
  "tests/pipeline/agnosticism-audit.test.js",
]);

// ---------------------------------------------------------------------------
//  PLAN_VOCAB_PATTERNS — management-vocabulary regex sources.
//  Patterns must match references to plan phases/waves/task IDs in comments.
// ---------------------------------------------------------------------------
const PLAN_VOCAB_PATTERNS = Object.freeze([
  "phase[\\s\\-]\\d",
  "wave[\\s\\-]?\\d",
  "T\\d+\\.\\d+\\.\\d+",
]);

// ---------------------------------------------------------------------------
//  Internal helpers
// ---------------------------------------------------------------------------

function relPath(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, "/");
}

function matchesCarveOut(rel, carveOuts) {
  for (const entry of carveOuts) {
    if (entry.endsWith("/")) {
      if (rel.startsWith(entry)) return true;
    } else {
      if (rel === entry) return true;
    }
  }
  return false;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

// ---------------------------------------------------------------------------
//  scanForNames(src, relPath) → violation[]
//
//  Lower-cases src and checks for MACHINE_NAMES as substrings.
//  Checks for MACHINE_IDS as quoted string literals ("id" or 'id').
// ---------------------------------------------------------------------------
function scanForNames(src, relPath) {
  const violations = [];
  const lower = src.toLowerCase();

  for (const token of MACHINE_NAMES) {
    const idx = lower.indexOf(token.toLowerCase());
    if (idx !== -1) {
      violations.push({
        check:   "name",
        relPath: relPath,
        line:    lineOf(src, idx),
        detail:  "machine type token: " + token,
      });
    }
  }

  for (const id of MACHINE_IDS) {
    const dq = '"' + id + '"';
    const sq = "'" + id + "'";
    let idx = src.indexOf(dq);
    if (idx === -1) idx = src.indexOf(sq);
    if (idx !== -1) {
      violations.push({
        check:   "name-id",
        relPath: relPath,
        line:    lineOf(src, idx),
        detail:  "quoted machine id: " + id,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
//  stripComments(src) → string
//
//  Removes // line comments and /* block comments */ from src.
//  Not string-literal-aware; sufficient for the known scan set.
// ---------------------------------------------------------------------------
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, function (m) {
      return m.replace(/[^\n]/g, " ");
    })
    .replace(/\/\/[^\n]*/g, "");
}

// ---------------------------------------------------------------------------
//  scanForSingleSlice(src, relPath) → violation[]
//
//  Strips comments, then matches fast-path single-slice guard patterns.
//  Lines are numbered against the original src.
// ---------------------------------------------------------------------------
function scanForSingleSlice(src, relPath) {
  const stripped = stripComments(src);
  const lines    = src.split("\n");
  const violations = [];

  const patterns = [
    /\b(?:n?slices(?:\.length)?)\s*===?\s*1\b/i,
    /\bn?slices\s*<\s*2\b/i,
  ];

  for (const pat of patterns) {
    let match;
    const re = new RegExp(pat.source, pat.flags + "g");
    while ((match = re.exec(stripped)) !== null) {
      violations.push({
        check:   "single-slice",
        relPath: relPath,
        line:    lineOf(src, match.index),
        detail:  "single-slice guard: " + match[0].trim(),
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
//  scanForLegacyTerms(src, relPath) → violation[]
//
//  Searches for deleted-subsystem terms. Respects LEGACY_CARVE_OUTS.
// ---------------------------------------------------------------------------
function scanForLegacyTerms(src, relPath) {
  if (matchesCarveOut(relPath, LEGACY_CARVE_OUTS)) return [];

  const violations = [];

  for (const term of LEGACY_TERMS) {
    let searchFrom = 0;
    while (true) {
      const idx = src.indexOf(term, searchFrom);
      if (idx === -1) break;
      violations.push({
        check:   "legacy",
        relPath: relPath,
        line:    lineOf(src, idx),
        detail:  "legacy term: " + term,
      });
      searchFrom = idx + term.length;
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
//  scanForPlanVocab(src, relPath) → violation[]
//
//  Searches for management-vocabulary tokens (phase/wave/task refs).
//  Respects LEGACY_CARVE_OUTS (same set).
// ---------------------------------------------------------------------------
function scanForPlanVocab(src, relPath) {
  if (matchesCarveOut(relPath, LEGACY_CARVE_OUTS)) return [];

  const violations = [];
  const lines = src.split("\n");

  for (const patSrc of PLAN_VOCAB_PATTERNS) {
    const re = new RegExp(patSrc, patSrc === "T\\d+\\.\\d+\\.\\d+" ? "g" : "gi");
    let match;
    while ((match = re.exec(src)) !== null) {
      violations.push({
        check:   "plan-vocab",
        relPath: relPath,
        line:    lineOf(src, match.index),
        detail:  "plan vocabulary: " + match[0],
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
//  File enumeration helpers
// ---------------------------------------------------------------------------

function collectLibFiles() {
  const libDir = path.join(REPO_ROOT, "lib");
  return fs.readdirSync(libDir)
    .filter(function (f) { return f.endsWith(".js") && !NAME_CARVE_OUTS.includes(f); })
    .map(function (f) { return "lib/" + f; });
}

function walkDir(dir, ext, results) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, ext, results);
    } else if (!ext || entry.name.endsWith(ext)) {
      results.push(relPath(full));
    }
  }
}

function collectLegacyFiles() {
  const files = [];
  const roots = [
    { dir: path.join(REPO_ROOT, "lib"),     ext: ".js"   },
    { dir: path.join(REPO_ROOT, "lessons"), ext: ".js"   },
    { dir: path.join(REPO_ROOT, "lessons"), ext: ".html" },
    { dir: path.join(REPO_ROOT, "tests"),   ext: ".js"   },
    { dir: path.join(REPO_ROOT, "scripts"), ext: ".js"   },
  ];

  for (const { dir, ext } of roots) {
    walkDir(dir, ext, files);
  }

  const rootIndex = relPath(path.join(REPO_ROOT, "index.html"));
  if (!files.includes(rootIndex) && fs.existsSync(path.join(REPO_ROOT, "index.html"))) {
    files.push(rootIndex);
  }

  return files;
}

// ---------------------------------------------------------------------------
//  scanFileListForMissing(relPaths) → violation[]
//
//  Takes an array of repo-relative paths and returns a violation for each
//  path that does not exist on disk. Used by run() for both scan lists and
//  exported for testing without running the full audit.
// ---------------------------------------------------------------------------
function scanFileListForMissing(relPaths) {
  const violations = [];
  for (const rel of relPaths) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      violations.push({ check: "missing", relPath: rel, line: 0, detail: "file not found on disk" });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
//  run() → 0 | 1
//
//  Enumerates scan targets, runs all checks, prints violations to stderr,
//  prints clean message to stdout, returns exit code.
// ---------------------------------------------------------------------------
function run() {
  const allViolations = [];

  // --- Name + single-slice scan ---
  const nameScanRel = NAME_SCAN_FILES.concat(collectLibFiles());

  allViolations.push(...scanFileListForMissing(nameScanRel));

  for (const rel of nameScanRel) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const src = fs.readFileSync(abs, "utf8");
    allViolations.push(...scanForNames(src, rel));
    allViolations.push(...scanForSingleSlice(src, rel));
  }

  // --- Legacy + plan-vocab scan ---
  const legacyFiles = collectLegacyFiles();

  allViolations.push(...scanFileListForMissing(legacyFiles));

  for (const rel of legacyFiles) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const src = fs.readFileSync(abs, "utf8");
    allViolations.push(...scanForLegacyTerms(src, rel));
    allViolations.push(...scanForPlanVocab(src, rel));
  }

  if (allViolations.length === 0) {
    process.stdout.write("agnosticism audit: clean\n");
    return 0;
  }

  for (const v of allViolations) {
    process.stderr.write(v.check + ": " + v.relPath + ":" + v.line + " — " + v.detail + "\n");
  }
  return 1;
}

// ---------------------------------------------------------------------------
//  Exports
// ---------------------------------------------------------------------------
module.exports = {
  scanForNames,
  scanForSingleSlice,
  scanForLegacyTerms,
  scanForPlanVocab,
  scanFileListForMissing,
  run,
  MACHINE_NAMES,
  MACHINE_IDS,
  NAME_SCAN_FILES,
  NAME_CARVE_OUTS,
  LEGACY_TERMS,
  LEGACY_CARVE_OUTS,
  PLAN_VOCAB_PATTERNS,
};

// ---------------------------------------------------------------------------
//  CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  process.exit(run());
}
