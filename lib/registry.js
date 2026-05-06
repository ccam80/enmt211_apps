"use strict";

// =============================================================================
//  LIB.Registry — parameterised slider builder.
//
//   mkRow(parent, registry, key, onChange?)  builds a labelled slider+number
//     for registry[key]. cfg fields recognised:
//       label, min, max, step, value          required
//       log: true                              log-scale slider
//       logMin                                 explicit log floor (default 1
//                                              when min ≤ 0, else min). When
//                                              min ≤ 0, the bottom 2 % of the
//                                              slider snaps to 0 and the rest
//                                              is logarithmic from logMin.
//       tip                                    hover help on the label
//       dynMin: () => number                   dynamic floor (canvas-clamp etc.)
//   syncSlider(registry, key)  forces the slider+number inputs back to the
//     current cfg.value (call after assigning cfg.value programmatically).
//
//  Zero dependencies.
// =============================================================================

(function () {
  const LIB = window.LIB || (window.LIB = {});

  LIB.Registry = {
    mkRow(parent, registry, key, onChange) {
      const cfg = registry[key];
      const row = document.createElement("div");
      row.className = "row";
      const lab = document.createElement("label");
      lab.textContent = cfg.label;
      if (cfg.tip) lab.title = cfg.tip;
      const rng = document.createElement("input"); rng.type = "range";
      const num = document.createElement("input"); num.type = "number";
      num.min = cfg.min; num.max = cfg.max; num.step = cfg.step; num.value = cfg.value;

      // log mode: simple log between cfg.min and cfg.max when min > 0;
      // when min ≤ 0 we allocate the bottom ZERO_FRAC of the slider to value
      // 0 and the rest to a log curve from logFloor (cfg.logMin || 1) to max.
      const logMode = !!cfg.log && cfg.max > 0 && cfg.max > Math.max(cfg.min, 0);
      const allowZero = logMode && cfg.min <= 0;
      const logFloor = logMode
        ? (cfg.logMin != null ? +cfg.logMin : (cfg.min > 0 ? cfg.min : 1))
        : 0;
      const ZERO_FRAC = 0.02;
      const lmin = logMode ? Math.log(logFloor) : 0;
      const lmax = logMode ? Math.log(cfg.max) : 0;
      const sFromV = (v) => {
        if (logMode) {
          if (allowZero && v <= 0) return 0;
          const c = Math.max(logFloor, Math.min(cfg.max, v));
          const ls = (Math.log(c) - lmin) / (lmax - lmin);
          return allowZero ? ZERO_FRAC + (1 - ZERO_FRAC) * ls : ls;
        }
        return Math.max(cfg.min, Math.min(cfg.max, v));
      };
      const vFromS = (s) => {
        if (!logMode) return s;
        if (allowZero) {
          if (s < ZERO_FRAC) return 0;
          const ls = (s - ZERO_FRAC) / (1 - ZERO_FRAC);
          return Math.exp(lmin + ls * (lmax - lmin));
        }
        return Math.exp(lmin + s * (lmax - lmin));
      };
      if (logMode) { rng.min = 0; rng.max = 1; rng.step = 0.0005; }
      else        { rng.min = cfg.min; rng.max = cfg.max; rng.step = cfg.step; }
      rng.value = sFromV(cfg.value);

      const commit = (raw, src) => {
        let v = (src === "rng") ? vFromS(Number(raw)) : Number(raw);
        if (!Number.isFinite(v)) return;
        let lo = cfg.min;
        if (typeof cfg.dynMin === "function") {
          const dm = cfg.dynMin();
          if (Number.isFinite(dm) && dm > lo && dm <= cfg.max) lo = dm;
        }
        const clamped = (v < lo) || (v > cfg.max);
        v = Math.max(lo, Math.min(cfg.max, v));
        if (cfg.step >= 1) v = Math.round(v);
        cfg.value = v;
        if (clamped || src !== "rng") rng.value = sFromV(v);
        if (clamped || src !== "num") num.value = logMode ? Number(v.toPrecision(4)) : v;
        if (onChange) onChange(v);
      };
      rng.addEventListener("input", () => commit(rng.value, "rng"));
      num.addEventListener("input", () => commit(num.value, "num"));
      row.append(lab, rng, num);
      parent.appendChild(row);
      cfg._row = row; cfg._sFromV = sFromV;
    },
    syncSlider(registry, key) {
      const cfg = registry[key];
      if (!cfg || !cfg._row) return;
      const rng = cfg._row.querySelector('input[type=range]');
      const num = cfg._row.querySelector('input[type=number]');
      if (rng) rng.value = cfg._sFromV ? cfg._sFromV(cfg.value) : cfg.value;
      if (num) num.value = cfg.value;
    },
  };
})();
