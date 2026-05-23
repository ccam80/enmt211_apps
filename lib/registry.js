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
//   mkExprRow(parent, registry, key, onSubmit)  builds a labelled text-input
//     + button. Used by stepper lessons so the student can type angle
//     expressions like "pi", "2*pi", "3*pi/4" instead of being limited to a
//     numeric slider. cfg fields recognised:
//       label, value (string), tip, button (label, default "Advance"),
//       placeholder. The expression accepts numeric literals, +-*/(), and
//       the literal `pi` / `π` (case-insensitive). onSubmit receives the
//       evaluated number (radians) when the button is clicked or the input
//       is committed via Enter; invalid expressions are ignored.
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
      num.min = cfg.min; num.max = cfg.max; num.step = cfg.step;

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

      // Compact display: use exponential notation when the value would not
      // fit the fixed-width number box, otherwise plain decimal.
      const fmtNum = (v) => {
        if (!Number.isFinite(v)) return "";
        if (v === 0) return "0";
        const abs = Math.abs(v);
        if (abs < 1e-3 || abs >= 1e5) {
          return v.toExponential(2).replace(/\.?0+e/, "e").replace("e+", "e");
        }
        return String(logMode ? Number(v.toPrecision(4)) : v);
      };
      num.value = fmtNum(cfg.value);

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
        if (clamped || src !== "num") num.value = fmtNum(v);
        if (onChange) onChange(v);
      };
      rng.addEventListener("input", () => commit(rng.value, "rng"));
      num.addEventListener("input", () => commit(num.value, "num"));
      row.append(lab, rng, num);
      parent.appendChild(row);
      cfg._row = row; cfg._sFromV = sFromV; cfg._fmtNum = fmtNum;
    },
    syncSlider(registry, key) {
      const cfg = registry[key];
      if (!cfg || !cfg._row) return;
      const rng = cfg._row.querySelector('input[type=range]');
      const num = cfg._row.querySelector('input[type=number]');
      if (rng) rng.value = cfg._sFromV ? cfg._sFromV(cfg.value) : cfg.value;
      if (num) num.value = cfg._fmtNum ? cfg._fmtNum(cfg.value) : cfg.value;
    },

    mkExprRow(parent, registry, key, onSubmit) {
      const cfg = registry[key];
      const row = document.createElement("div");
      row.className = "row expr-row";
      const lab = document.createElement("label");
      lab.textContent = cfg.label || key;
      if (cfg.tip) lab.title = cfg.tip;
      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = (cfg.value != null) ? String(cfg.value) : "";
      inp.placeholder = cfg.placeholder || "e.g. pi or 2*pi/3";
      inp.spellcheck = false;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = cfg.button || "Advance";
      btn.className = "advance-btn";

      function evalExpr(s) {
        if (!s) return NaN;
        let cleaned = String(s)
          .replace(/π/g, "pi")
          .replace(/\bpi\b/gi, "(" + Math.PI + ")");
        // Allow only digits, whitespace, +-*/^(), decimal point, exponent
        // notation. Anything else → reject.
        if (!/^[\d\s+\-*/^().eE,]*$/.test(cleaned)) return NaN;
        // Replace ^ with ** so JS understands it.
        cleaned = cleaned.replace(/\^/g, "**");
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function("\"use strict\"; return (" + cleaned + ");");
          const v = +fn();
          return Number.isFinite(v) ? v : NaN;
        } catch (e) { return NaN; }
      }

      function commit() {
        const v = evalExpr(inp.value);
        cfg.value = inp.value;
        if (Number.isFinite(v) && typeof onSubmit === "function") {
          onSubmit(v);
        }
      }

      btn.addEventListener("click", commit);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      });
      inp.addEventListener("input", () => { cfg.value = inp.value; });

      row.append(lab, inp, btn);
      parent.appendChild(row);
      cfg._row = row;
    },
  };
})();
