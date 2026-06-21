(function () {
  "use strict";

  const UM = window.UnifiedMotor || (window.UnifiedMotor = {});

  // Loads a fixture config identified by id into ctx.config in place,
  // preserving the object reference, then triggers a rebuild.
  function loadMachine(ctx, id) {
    const entry = UM.MACHINES.find(function (m) { return m.id === id; });
    if (!entry) {
      throw new Error("MachinePicker: unknown machine id \"" + id + "\"");
    }
    const copy = JSON.parse(JSON.stringify(entry.config));
    if (copy.label == null) {
      copy.label = entry.label;
    }
    // Replace ctx.config contents in place, preserving the object reference.
    const target = ctx.config;
    for (const k of Object.keys(target)) {
      delete target[k];
    }
    for (const k of Object.keys(copy)) {
      target[k] = copy[k];
    }
    ctx.requestRebuild();
  }

  UM.MachinePicker = { loadMachine: loadMachine };

  UM.registerHeaderControl({
    id: "machine-picker",
    build: function (host, ctx) {
      const select = document.createElement("select");
      const machines = UM.MACHINES;
      for (let i = 0; i < machines.length; i++) {
        const opt = document.createElement("option");
        opt.value = machines[i].id;
        opt.textContent = machines[i].label;
        select.appendChild(opt);
      }
      function onChange() {
        UM.MachinePicker.loadMachine(ctx, select.value);
      }
      select.addEventListener("change", onChange);
      host.appendChild(select);
      return function unmount() {
        select.removeEventListener("change", onChange);
        if (select.parentNode) select.parentNode.removeChild(select);
      };
    },
  });
})();
