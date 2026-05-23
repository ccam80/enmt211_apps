"use strict";

// =============================================================================
//  LIB.StepperDrive — physical-style stepper motor model.
//
//  The driver emits step pulses; each pulse jumps a discrete commanded
//  equilibrium θ_cmd by exactly one full step (`stepRad`). The rotor
//  experiences a sinusoidal holding-torque profile centred on θ_cmd:
//
//      τ_rotor = τ_max · sin(N · (θ_cmd − θ))  −  D · ω      (clipped at ±τ_max)
//
//  where N = 2π / (electricalCycleSteps · stepRad). The default
//  `electricalCycleSteps = 4` follows the standard hybrid (4-phase) stepper
//  convention: one electrical cycle spans four full steps; pull-out torque
//  sits at err = 1·stepRad, the rotor begins to slip past 2·stepRad of
//  cumulative lag, and the next stable equilibrium is 4 steps away. The
//  damping coefficient D auto-tunes to ζ ≈ `damping` (default 0.7) against
//  the live effective rotor inertia, so the rotor visibly settles between
//  pulses without ringing forever.
//
//  PULSE SOURCES (the driver doesn't jump θ_cmd by huge amounts at once;
//  every modification goes through a pulse queue):
//
//    • drive.buttons() ⇒ "+ Step" / "− Step" header buttons that queue
//      one ±1 pulse per click.
//    • drive.advance(state, rad, params) queues N = round(rad/stepRad)
//      pulses; the queue drains at most `pulsesPerSecond` pulses/sec so
//      the rotor sees one step at a time and never lands at an unstable
//      equilibrium of the sin curve.
//    • drive.advanceContinuous(state, params, dt, { driveOn, targetRate })
//      drives the rotor at `targetRate` rad/s OPEN-LOOP — it accumulates
//      pulses at the requested rate regardless of rotor position. Push
//      too fast and the rotor falls outside the pull-out window and
//      stalls (real lost-step phenomenon).
//
//  Saturation: rotor torque is hard-clipped at ±τ_max regardless of the
//  sinusoidal value.
//
//   create(opts) → drive
//     opts: {
//       cmdField  = "thetaCmd",       // commanded equilibrium θ (rad)
//       posField  = "theta",          // actual θ
//       velField  = "omega",          // ω
//       J         = (state, params) => Jeff,  // live rotor inertia (kg·m²)
//       damping   = 0.7,
//       deltaParam = "stepAngle",
//       deltaTransform = (deg) => deg·π/180,
//       electricalCycleSteps = 4,
//       pulsesPerSecond = 30,         // drain rate for the queued-pulse path
//     }
//
//   drive.torque(state, params, opts) → τ
//     opts: { driveOn, tauMax }.
//
//   drive.partials(state, params, opts) → { dTau_dpos, dTau_dvel } | null
//     Linearised partials for the lesson's Jacobian. Returns null when the
//     loop is off or saturated.
//
//   drive.advanceContinuous(state, params, dt, opts) — call once per
//     physics tick. Drains the pulse queue + accumulates targetRate.
//
//   drive.advance(state, rad, params?) — queue rad/stepRad pulses
//     (rounded). Without `params` falls back to a non-snapped bump.
//
//   drive.buttons(extra?) → [stepMinus, stepPlus]  (queue ±1 pulse/click)
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  const DEG2RAD = (deg) => (+deg || 0) * Math.PI / 180;

  function create(opts) {
    opts = opts || {};
    const cmdField  = opts.cmdField  || "thetaCmd";
    const posField  = opts.posField  || "theta";
    const velField  = opts.velField  || "omega";
    const damping   = (opts.damping != null) ? +opts.damping : 0.7;
    const Jget      = (typeof opts.J === "function") ? opts.J : (() => 1);
    const deltaParam     = opts.deltaParam     || "stepAngle";
    const deltaTransform = (typeof opts.deltaTransform === "function")
      ? opts.deltaTransform : DEG2RAD;
    const electricalCycleSteps = (opts.electricalCycleSteps != null)
      ? +opts.electricalCycleSteps : 4;
    const pulsesPerSecond = (opts.pulsesPerSecond != null)
      ? +opts.pulsesPerSecond : 30;
    const queuePulsePeriod = (pulsesPerSecond > 0) ? (1 / pulsesPerSecond) : 0;

    function stepRadOf(params) {
      if (!params) return 0;
      const raw = params[deltaParam];
      if (raw == null) return 0;
      const v = +deltaTransform(raw);
      return Number.isFinite(v) && v > 0 ? v : 0;
    }
    function nElec(stepRad) {
      return (2 * Math.PI) / (electricalCycleSteps * stepRad);
    }

    function rawTorquePieces(state, params, runOpts) {
      if (!runOpts || !runOpts.driveOn) return null;
      const stepRad = stepRadOf(params);
      if (stepRad <= 0) return null;
      const N      = nElec(stepRad);
      const tauMax = +runOpts.tauMax || 0;
      const err    = (+state[cmdField] || 0) - (+state[posField] || 0);
      const omg    = +state[velField] || 0;
      const J      = Math.max(1e-12, +Jget(state, params) || 0);
      const Kstiff = tauMax * N;
      const D      = 2 * damping * Math.sqrt(Math.max(0, Kstiff * J));
      const s      = Math.sin(N * err);
      const c      = Math.cos(N * err);
      const tau    = tauMax * s - D * omg;
      const sat    = (tauMax > 0)
        ? (tau >  tauMax) ? +1 : (tau < -tauMax) ? -1 : 0
        : 0;
      return { N, tauMax, J, D, s, c, omg, tau, sat };
    }

    function torque(state, params, runOpts) {
      const r = rawTorquePieces(state, params, runOpts);
      if (!r) return 0;
      if (r.sat > 0) return  r.tauMax;
      if (r.sat < 0) return -r.tauMax;
      return r.tau;
    }

    function partials(state, params, runOpts) {
      const r = rawTorquePieces(state, params, runOpts);
      if (!r || r.sat !== 0) return null;
      return {
        dTau_dpos: -r.tauMax * r.N * r.c,
        dTau_dvel: -r.D,
      };
    }

    function saturated(state, params, runOpts) {
      const r = rawTorquePieces(state, params, runOpts);
      if (!r) return true;
      return r.sat !== 0;
    }

    function ensure(state) {
      if (state[cmdField]      == null) state[cmdField]      = 0;
      if (state._stepAccum     == null) state._stepAccum     = 0;
      if (state._pendingSteps  == null) state._pendingSteps  = 0;
      if (state._pendingTimer  == null) state._pendingTimer  = 0;
    }

    function reset(state) {
      state[cmdField]     = 0;
      state._stepAccum    = 0;
      state._pendingSteps = 0;
      state._pendingTimer = 0;
    }

    function advance(state, rad, params) {
      const stepRad = stepRadOf(params);
      if (stepRad <= 0) {
        throw new Error("LIB.StepperDrive.advance: params with valid '"
                        + deltaParam + "' is required");
      }
      const steps = Math.round((+rad || 0) / stepRad);
      state._pendingSteps = (+state._pendingSteps || 0) + steps;
    }

    function advanceContinuous(state, params, dt, runOpts) {
      const stepRad = stepRadOf(params);
      if (stepRad <= 0) return;
      const dtSafe = +dt || 0;

      // (1) Continuous-rate accumulator — open-loop pulse train at
      //     `targetRate` rad/s. Drains pulses regardless of rotor position,
      //     so over-rev produces real lost-step behaviour.
      if (runOpts && runOpts.driveOn) {
        const wTgt = +runOpts.targetRate || 0;
        if (Math.abs(wTgt) > 1e-12) {
          state._stepAccum = (+state._stepAccum || 0) + wTgt * dtSafe;
          while (state._stepAccum >=  stepRad) {
            state[cmdField] = (+state[cmdField] || 0) + stepRad;
            state._stepAccum -= stepRad;
          }
          while (state._stepAccum <= -stepRad) {
            state[cmdField] = (+state[cmdField] || 0) - stepRad;
            state._stepAccum += stepRad;
          }
        }
      }

      // (2) Pulse queue from + Step / − Step / Advance — drained at a
      //     fixed `pulsesPerSecond` so the rotor sees one pulse at a time
      //     and never falls past the pull-out window from a queued bump.
      const pending = +state._pendingSteps || 0;
      if (pending !== 0 && queuePulsePeriod > 0) {
        state._pendingTimer = (+state._pendingTimer || 0) + dtSafe;
        while (state._pendingTimer >= queuePulsePeriod && (+state._pendingSteps || 0) !== 0) {
          const p = +state._pendingSteps;
          const dir = p > 0 ? +1 : -1;
          state[cmdField] = (+state[cmdField] || 0) + dir * stepRad;
          state._pendingSteps = p - dir;
          state._pendingTimer -= queuePulsePeriod;
        }
      } else {
        state._pendingTimer = 0;
      }
    }

    function buttons(extra) {
      extra = extra || {};
      // Each click queues one signed pulse. The queue drain in
      // advanceContinuous emits it at the configured pulse rate, so a
      // rapid burst of clicks doesn't overshoot the pull-out window.
      return [
        {
          id: extra.idMinus || "step-",
          label: extra.labelMinus || "− Step",
          onClick: (state) => {
            state._pendingSteps = (+state._pendingSteps || 0) - 1;
            if (typeof extra.onChange === "function") extra.onChange(state, -1);
          },
        },
        {
          id: extra.idPlus || "step+",
          label: extra.labelPlus || "+ Step",
          onClick: (state) => {
            state._pendingSteps = (+state._pendingSteps || 0) + 1;
            if (typeof extra.onChange === "function") extra.onChange(state, +1);
          },
        },
      ];
    }

    return {
      cmdField, posField, velField,
      damping, electricalCycleSteps, pulsesPerSecond,
      torque, partials, saturated,
      ensure, reset,
      advance, advanceContinuous,
      buttons,
    };
  }

  LIB.StepperDrive = { create, DEG2RAD };
})();
