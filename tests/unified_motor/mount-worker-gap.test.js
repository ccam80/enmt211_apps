"use strict";

// =============================================================================
//  Regression: the Worker delivers GEOMETRY and the first SNAPSHOT as separate
//  async messages, so a render frame can fire after the display proxy exists but
//  before any snapshot has filled its field arrays. Rendering then dereferenced
//  a null Anode (motor-mesh-view resampleField) and threw every frame. The mount
//  must gate rendering on "a snapshot has been interpolated" (dispReady), not on
//  the proxy merely existing.
//
//  Driven through the real mount + real renderers via an injected fake Worker
//  that runs the real engine in-process but HOLDS the first snapshot until the
//  test releases it.
// =============================================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { installShims, loadApp } = require("./_dom-harness.js");

test("no crash when a frame renders between geometry and the first snapshot", async () => {
  const shim = installShims();
  const held = [];          // snapshots the fake worker is holding back
  let workerInstance = null;

  try {
    const { LIB, UnifiedMotor } = loadApp();
    await LIB.FeaSolver.init();

    // A fake Worker: runs the real numeric engine in-process, forwards geometry
    // immediately, but HOLDS snapshots for manual release — mirroring the real
    // worker's separate-message delivery of geometry then snapshots.
    const RealFake = function (/* url */) {
      const w = this;
      w.onmessage = null;
      w.onerror = null;
      w.terminate = function () {};
      const engine = LIB.SimSource.createInline({
        MotorRun: LIB.MotorRun,
        expand: UnifiedMotor.ConfigSchema.expand.bind(UnifiedMotor.ConfigSchema),
      });
      engine.onGeometry(function (m) { if (w.onmessage) w.onmessage({ data: m }); });
      engine.onSnapshot(function (s) { held.push(s); });     // HELD, not delivered
      w.postMessage = function (cmd) {
        if (cmd.type === "pace") return;
        engine.post(cmd);
      };
      w.releaseSnapshot = function () {
        const s = held.shift();
        if (s && w.onmessage) w.onmessage({ data: s });
      };
      workerInstance = w;
    };

    globalThis.Worker = RealFake;
    globalThis.location = { protocol: "http:" };
    UnifiedMotor.SIM_WORKER_URL = "./sim-worker.js";
    UnifiedMotor.USE_SIM_WORKER = true;

    try {
      const host = shim.makeEl("div");
      let unmount;
      assert.doesNotThrow(function () { unmount = UnifiedMotor.mount(host); }, "mount must not throw");
      assert.ok(workerInstance, "fake worker constructed");

      // Signal ready → WorkerSimSource flushes init → geometry delivered, seed
      // snapshot HELD. dispRuntime now exists but no snapshot is interpolated.
      workerInstance.onmessage({ data: { type: "ready" } });

      // Frames here render the proxy with null field arrays UNLESS gated — this
      // is the regression. Must not throw.
      assert.doesNotThrow(function () { shim.flushFrames(3); },
        "frames after geometry but before first snapshot must not throw");

      // Release the held snapshot → buffer fills → interpolation runs.
      workerInstance.releaseSnapshot();
      assert.doesNotThrow(function () { shim.flushFrames(3); },
        "frames after the first snapshot must not throw");

      if (typeof unmount === "function") unmount();
    } finally {
      delete globalThis.Worker;
      delete globalThis.location;
      UnifiedMotor.USE_SIM_WORKER = false;
    }
  } finally {
    shim.uninstall();
  }
});
