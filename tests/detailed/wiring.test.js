"use strict";

// =============================================================================
//  tests/detailed/wiring.test.js
//
//  Asserts that lessons/unified_motor/index.html correctly loads
//  detailed-toggle.js inside the marked module-extension region.
// =============================================================================

const assert = require("node:assert/strict");
const test   = require("node:test");
const fs     = require("node:fs");
const path   = require("node:path");

// Load fixtures (installs window shim + engine libs)
require("./_fixtures.js");

// ---------------------------------------------------------------------------
//  index.html loads detailed-toggle.js inside the marked region
// ---------------------------------------------------------------------------

test("index.html loads detailed-toggle.js inside the marked region", function () {
  const htmlPath = path.join(__dirname, "../../lessons/unified_motor/index.html");
  const html     = fs.readFileSync(htmlPath, "utf8");

  // Both marker comments must be present exactly once
  const openMarker  = "<!-- unified-motor modules:";
  const closeMarker = "<!-- /unified-motor modules -->";

  const openCount  = html.split(openMarker).length - 1;
  const closeCount = html.split(closeMarker).length - 1;

  assert.strictEqual(openCount, 1,
    "Opening marker '" + openMarker + "' must appear exactly once, found " + openCount);
  assert.strictEqual(closeCount, 1,
    "Closing marker '" + closeMarker + "' must appear exactly once, found " + closeCount);

  // Locate the region between the markers
  const openIdx  = html.indexOf(openMarker);
  const closeIdx = html.indexOf(closeMarker);

  assert.ok(openIdx < closeIdx,
    "Opening marker must appear before closing marker");

  const region = html.substring(openIdx, closeIdx + closeMarker.length);

  // The region must contain a <script src> for ./detailed-toggle.js
  assert.ok(
    region.includes('src="./detailed-toggle.js"') ||
    region.includes("src='./detailed-toggle.js'"),
    "The marked region must contain a <script src> for ./detailed-toggle.js. " +
    "Region found:\n" + region
  );
});
