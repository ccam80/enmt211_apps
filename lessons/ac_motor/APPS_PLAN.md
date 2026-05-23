# AC-motor apps plan

Maps the lesson apps in `lessons/ac_motor/` to the sections of
`enmt211_notes/notes/ac_motors/ac_motors.tex`. Existing apps marked
*(exists)*; everything else is to-be-built. Sections 1–3 are the priority
since the prose is fleshed out through §3 (mid-section-3 = the rotating-
field derivation).

## §1 AC fundamentals

### 1. `ac-waveform` — sinusoid + RMS + phase
- Drive `v(t) = V_max·cos(ωt)`. Sliders: V_max, f. Plot v(t), the
  `V_rms = V_max/√2` band, period T.
- Sub-mode `phase`: two sinusoids on shared axes, slider φ. Annotate
  time offset φ/ω and lead/lag.
- Covers Eqs. 1–3 and the "phase between same-frequency sinusoids".

### 2. `rcl-on-ac` — R, C, L on a common sinusoidal supply
- One driving v(t); plots of `i_R`, `i_C`, `i_L` showing ±90° lead/lag.
- Sub-mode `series-RL`: V_R, V_L, V phasor diagram + φ = arctan(ωL/R)
  readout, `i(t)` lagging `v(t)`. Re-used as the explanatory anchor for
  §4.2 (phase offset for single-phase aux windings).

### 3. `three-phase-supply` — `v_a, v_b, v_c` + constant total power
- Top: three phase voltages on shared axes; readout `v_a+v_b+v_c = 0`.
- Bottom: three per-phase pulsating powers + their flat-line sum.
- Sub-mode `line-vs-phase`: animates `v_a - v_b = √3·V_max·cos(ωt + π/6)`.

## §2 single-loop induction

### 4. `coaxial-loops` *(exists)*
Keep as the no-sustained-torque punchline that motivates the rest.

## §3 three-phase induction motor

### 5. `rotating-field` — vector sum of three winding fields
- Cavity end view. Three winding-axis vectors at 0°/120°/240°, each
  pulsing per `i_a`/`i_b`/`i_c`. Their sum drawn as the resultant; a
  faint trail shows it tracing a constant-magnitude circle.
- Slider `f`; button "swap phases b↔c" reverses rotation; toggle
  "freeze at ωt = 0, π/6, π/3, π/2" reproduces Fig. 8 exactly.
- No mechanical rotor — pure field-construction lesson.

### 6. `three-phase-rotor` — drop a rotor loop into the rotating field
- Same cavity, now with a closed loop on a free-spinning shaft.
- Plots: ω_rotor, slip, τ_rotor.
- Sliders: supply f (→ ω_syn), mechanical load, rotor R/L ratio (`φ_2`).
- Readouts: ω_syn, ω_rotor, s, ⟨τ⟩.
- Sub-mode `torque-speed`: τ-vs-ω curve marking locked-rotor torque,
  breakdown torque, operating region, zero at ω_syn.
- T ∝ (ω_syn − ω_rotor) lesson + eq. (28).

## §4 single-phase induction motor

### 7. `two-phase-windings` — perpendicular outer pair, slider φ
- Two stator coils at 90°. Slide φ 0→90° and watch the resultant B locus
  morph from fixed-axis pulsation → ellipse → circle. Starting-torque
  readout vs φ.
- Sub-mode `from-RL`: replace φ-slider with two RL pairs
  (R_main/L_main, R_aux/L_aux). Phase difference emerges from
  `arctan(ωL/R)`.

### 8. `single-phase-variants` — `spec.modes` per variant
- Modes: `split-phase`, `capacitor-start`, `psc`, `shaded-pole`. Each
  shows the circuit (main + aux + switch/cap), per-winding phase,
  starting torque, centrifugal-switch dropout.
- Common bottom panel: torque-speed curve overlaying aux + main, with
  switch-out discontinuity visible.

## §5 squirrel cage and pole pairs

### 9. `squirrel-cage` *(exists)*
Slider for # of rotor bars to make the "ripple shrinks with more loops"
point explicit; τ(θ) plot. (Verify current state before extending.)

### 10. `pole-pairs` *(exists)*
2D end-view: cavity + cage rotor + 3·p·L discrete stator coils. Slider
p ∈ 1..4 drives ω_syn = ω_AC/p; slider L ∈ 1..5 with offset δ controls
concentrated-vs-distributed winding so the 5th/7th-harmonic torque
ripple at 6·ω_AC is visible at L=1 and collapses as L·δ grows. Adds
the discrete-windings-cause-ripple side of §5 that prose-line 1014–1021
calls out. (Still to add if useful: VFD-ramp slider for the
"cannot exceed without VFD" caveat.)

## §7 Y vs Δ

### 11. `y-delta` — toggle between Y and Δ wiring
- Schematic on left; readouts V_line/V_phase, I_line/I_phase, P; √3
  relations highlighted. Sub-mode "start in Y, run in Δ" for §6's
  Y-Δ startup.

## §8 power factor

### 12. `power-factor` — v(t), i(t), p(t) = v·i, ⟨p⟩, S, cos φ
- Sliders: R, L (or directly φ). Inductive load → lagging p.f.;
  sub-mode `correction` adds a shunt capacitor slider and shows the
  supply-current magnitude drop while real power stays flat.

## Build order

1. **Through §3 (matches current prose front):** `ac-waveform`,
   `rcl-on-ac`, `three-phase-supply`, `rotating-field`,
   `three-phase-rotor`.
2. **§4–§8 as prose lands:** `two-phase-windings` → `single-phase-
   variants` → `pole-pairs` → `y-delta` → `power-factor`, with
   `squirrel-cage` extended in parallel.
