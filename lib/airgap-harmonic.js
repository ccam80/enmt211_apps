(function () {
  "use strict";

  const LIB = window.LIB || (window.LIB = {});

  const TWO_PI = 2 * Math.PI;
  const mu0_default = 4 * Math.PI * 1e-7;

  // ---------------------------------------------------------------------------
  //  defaultK(slots, poles) → number
  //
  //  Returns the recommended harmonic truncation order: 3·max(slots, poles).
  //  §11.4 / D5.
  // ---------------------------------------------------------------------------
  function defaultK(slots, poles) {
    return 3 * Math.max(slots, poles);
  }

  // ---------------------------------------------------------------------------
  //  project(gapTheta, Anodal, K) → { a: Float64Array(K+1), b: Float64Array(K+1) }
  //
  //  Real DFT projection onto the truncated cos/sin basis (D3):
  //    A(θ) = a[0] + Σ_{k=1..K} a[k]·cos(kθ) + b[k]·sin(kθ)
  //  b[0] === 0 always.
  //
  //  gapTheta is a uniform-Δθ Float64Array of length N.
  //  Anodal is sampled at those angles.
  // ---------------------------------------------------------------------------
  function project(gapTheta, Anodal, K) {
    const a = new Float64Array(K + 1);
    const b = new Float64Array(K + 1);
    projectInto(gapTheta, Anodal, K, a, b);
    return { a, b };
  }

  // Into variant: writes the projection into caller-provided a, b buffers
  // (both Float64Array(K+1)). No allocation.
  function projectInto(gapTheta, Anodal, K, a, b) {
    const N = gapTheta.length;

    // k=0: mean
    let sum = 0;
    for (let i = 0; i < N; i++) sum += Anodal[i];
    a[0] = sum / N;
    b[0] = 0;

    // k=1..K
    for (let k = 1; k <= K; k++) {
      let sc = 0, ss = 0;
      for (let i = 0; i < N; i++) {
        const th = gapTheta[i];
        sc += Anodal[i] * Math.cos(k * th);
        ss += Anodal[i] * Math.sin(k * th);
      }
      a[k] = (2 / N) * sc;
      b[k] = (2 / N) * ss;
    }
  }

  // ---------------------------------------------------------------------------
  //  reconstruct({ a, b }, gapTheta) → Float64Array
  //
  //  Evaluate the truncated cos/sin series at the supplied gapTheta nodes.
  //  Inverse of project.
  // ---------------------------------------------------------------------------
  function reconstruct(coeffs, gapTheta) {
    const { a, b } = coeffs;
    const K = a.length - 1;
    const N = gapTheta.length;
    const out = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      const th = gapTheta[i];
      let v = a[0];
      for (let k = 1; k <= K; k++) {
        v += a[k] * Math.cos(k * th) + b[k] * Math.sin(k * th);
      }
      out[i] = v;
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  //  Mk(r_mr, r_ms, k, mu0) → [[m00, m01], [m10, m11]]
  //
  //  Per-harmonic 2×2 admittance (DtN) matrix for the annular region [r_mr, r_ms]
  //  using the source-free r^{±k} Laplace solution.
  //
  //  For k ≥ 1:
  //    The two independent solutions are r^k and r^{-k}.
  //    On the inner circle r=r_mr: A_inner = α·r_mr^k + β·r_mr^{-k}
  //    On the outer circle r=r_ms: A_outer = α·r_ms^k + β·r_ms^{-k}
  //
  //    The normal derivative (∂A/∂r) at r_mr and r_ms:
  //      f_inner = (1/μ0)·(∂A/∂r)|_{r_mr} = (1/μ0)·(α·k·r_mr^{k-1} - β·k·r_mr^{-(k+1)})
  //      f_outer = (1/μ0)·(∂A/∂r)|_{r_ms} = (1/μ0)·(α·k·r_ms^{k-1} - β·k·r_ms^{-(k+1)})
  //
  //    Sign convention for the DtN map (outward normal):
  //      - Inner circle: outward normal points inward (-r direction), so flux_inner = -(1/μ0)·∂A/∂r
  //      - Outer circle: outward normal points outward (+r direction), so flux_outer = +(1/μ0)·∂A/∂r
  //
  //    Solving for [α, β] from [A_inner, A_outer] and substituting:
  //
  //    Let r1 = r_mr, r2 = r_ms, ρ = (r1/r2)^k
  //    D = r2^k · r1^k · (1 - ρ²) / ρ ... simplify with substitution
  //
  //    The admittance matrix M_k maps [A_inner, A_outer] → [flux_inner, flux_outer]
  //    where flux is the INWARD normal flux density (consistent with FEM convention:
  //    positive flux entering the domain).
  //
  //    After algebra:
  //      m00 = (k/μ0) · (r1^k·r2^k + r1^{2k}) / (r1·(r2^{2k} - r1^{2k}))
  //          = (k/μ0) · (r2^k/r1^k + 1) / (r2^{2k}/r1^{2k} - 1) / r1   ... normalised
  //
  //    Using a = r1^k, b = r2^k:
  //      D = b^2 - a^2 (denominator)
  //      m00 = +(k/μ0/r1) · (a^2 + ab) / (b^2 - a^2)  ... wrong sign, re-derive
  //
  //    Direct derivation:
  //    A = α·r^k + β·r^{-k}
  //    At r1: A1 = α·r1^k + β·r1^{-k}
  //    At r2: A2 = α·r2^k + β·r2^{-k}
  //
  //    Matrix form: [r1^k, r1^{-k}; r2^k, r2^{-k}] · [α; β] = [A1; A2]
  //    Det = r1^k·r2^{-k} - r2^k·r1^{-k} = (r1/r2)^k - (r2/r1)^k
  //    Let p = r1^k, q = r2^k, det_M = p/q - q/p = (p^2 - q^2)/(p·q)
  //
  //    [α; β] = (1/det_M) · [r2^{-k}, -r1^{-k}; -r2^k, r1^k] · [A1; A2]
  //           = (p·q/(p^2-q^2)) · [(A1/q - A2/p); (-A1·q + A2·p)]
  //           = ...
  //
  //    α = (p·q / (p^2 - q^2)) · (A1/q - A2/p)
  //      = (1/(p^2-q^2)) · (p·A1 - q·A2·p/p)  ... let's just use numbers
  //
  //    α = (p/(p^2-q^2)) · A1 - (q/(p^2-q^2)) · A2   [from Cramer's rule]
  //    β = (q·p^2/(q·(p^2-q^2))) ...
  //
  //    Let me redo this carefully with a = r1^k, b = r2^k (a < b since r1 < r2):
  //    det_AB = a·(1/b) - b·(1/a) = (a^2 - b^2)/(a·b)  (negative since a < b)
  //
  //    α = [A1·(1/b) - A2·(1/a)] / det_AB
  //      = [A1/b - A2/a] / [(a^2-b^2)/(a·b)]
  //      = [A1·a - A2·b] / (a^2 - b^2)   ... using a·b cancellation
  //      Actually: (A1/b - A2/a) * (a·b/(a^2-b^2)) = (A1·a - A2·b)/(a^2-b^2)
  //
  //    β = [-A1·b + A2·a] / det_AB·(a·b) ... second Cramer column:
  //      Numerator: a·A2 - b·A1 (from [a, 1/a; b, 1/b] → col2 replaced)
  //      Wait, re-check. System is: a·α + (1/a)·β = A1,  b·α + (1/b)·β = A2
  //      Cramer for β: det numerator = a·A2 - b·A1
  //      β = (a·A2 - b·A1) / det_AB = (a·A2 - b·A1) / [(a^2-b^2)/(a·b)]
  //        = (a·A2 - b·A1)·(a·b)/(a^2-b^2)
  //        = a·b·(a·A2 - b·A1)/(a^2-b^2)
  //
  //    ∂A/∂r = k·α·r^{k-1} - k·β·r^{-(k+1)}
  //
  //    At r1 (inner): ∂A/∂r|_r1 = k·α·r1^{k-1} - k·β·r1^{-(k+1)}
  //                               = k·(α·a/r1 - β/(a·r1))
  //                               = (k/(a·r1))·(α·a^2 - β)
  //
  //    At r2 (outer): ∂A/∂r|_r2 = k·α·r2^{k-1} - k·β·r2^{-(k+1)}
  //                               = (k/(b·r2))·(α·b^2 - β)
  //
  //    flux_inner (into domain from inner = outward from inner boundary = -∂A/∂r|_r1 / μ0):
  //    flux_outer (into domain from outer = -∂A/∂r|_r2 / μ0, outward = +∂A/∂r):
  //    Actually for FEM DtN: flux on boundary = (1/μ0)·∂A/∂n where n is outward from element.
  //    For the annular gap element:
  //      - Inner boundary: n points inward (toward r=0), so ∂A/∂n = -∂A/∂r
  //      - Outer boundary: n points outward (away from r=0), so ∂A/∂n = +∂A/∂r
  //    The DtN map: q = M · [A1; A2], where q_i = (1/μ0)·∂A/∂n_i (FEM convention)
  //
  //    q1 = -(1/μ0)·∂A/∂r|_r1  (inner outward normal = -r)
  //    q2 = +(1/μ0)·∂A/∂r|_r2  (outer outward normal = +r)
  //
  //    Substituting α, β:
  //    Let D = a^2 - b^2  (< 0 since a < b, r1 < r2)
  //
  //    α = (a·A1 - b·A2) / D
  //      Wait, let me redo Cramer for α:
  //      System: a·α + (1/a)·β = A1
  //              b·α + (1/b)·β = A2
  //      det = a/b - b/a = (a^2-b^2)/(a·b) = D/(a·b)
  //      α = (A1/b - A2/a) / (D/(a·b)) = (A1·a - A2·b)·(b/(D·... ))
  //        Numerator of α via Cramer: A1·(1/b) - A2·(1/a) = (A1·a - A2·b)/(a·b)
  //        α = [(A1·a - A2·b)/(a·b)] / [D/(a·b)] = (A1·a - A2·b)/D
  //
  //      β via Cramer: a·A2 - b·A1
  //        Numerator = a·A2 - b·A1
  //        β = (a·A2 - b·A1) / (D/(a·b)) = (a·A2 - b·A1)·(a·b)/D
  //
  //    α = (a·A1 - b·A2) / D  where D = a^2 - b^2
  //    β = a·b·(a·A2 - b·A1) / D
  //
  //    ∂A/∂r|_r1 = k·α·r1^{k-1} - k·β·r1^{-(k+1)}
  //              = k/(r1) · (α·r1^k - β·r1^{-k})
  //              = k/(r1) · (α·a - β/a)
  //
  //    Substitute:
  //    α·a = a·(a·A1 - b·A2)/D
  //    β/a = b·(a·A2 - b·A1)/D
  //
  //    α·a - β/a = [a·(a·A1 - b·A2) - b·(a·A2 - b·A1)] / D
  //              = [a^2·A1 - a·b·A2 - a·b·A2 + b^2·A1] / D
  //              = [(a^2+b^2)·A1 - 2ab·A2] / D
  //
  //    ∂A/∂r|_r1 = (k/r1) · [(a^2+b^2)·A1 - 2ab·A2] / D
  //
  //    Similarly, ∂A/∂r|_r2 = k/r2 · (α·b - β/b)
  //    α·b = b·(a·A1 - b·A2)/D
  //    β/b = a·(a·A2 - b·A1)/D
  //    α·b - β/b = [b·(a·A1 - b·A2) - a·(a·A2 - b·A1)] / D
  //              = [ab·A1 - b^2·A2 - a^2·A2 + ab·A1] / D
  //              = [2ab·A1 - (a^2+b^2)·A2] / D
  //
  //    ∂A/∂r|_r2 = (k/r2) · [2ab·A1 - (a^2+b^2)·A2] / D
  //
  //    DtN: q1 = -(1/μ0)·∂A/∂r|_r1
  //             = -(k/(μ0·r1·D)) · [(a^2+b^2)·A1 - 2ab·A2]
  //         q2 = +(1/μ0)·∂A/∂r|_r2
  //             = +(k/(μ0·r2·D)) · [2ab·A1 - (a^2+b^2)·A2]
  //
  //    With D = a^2 - b^2 < 0, let E = b^2 - a^2 > 0:
  //    D = -E
  //    q1 = +(k/(μ0·r1·E)) · [(a^2+b^2)·A1 - 2ab·A2]
  //    q2 = -(k/(μ0·r2·E)) · [2ab·A1 - (a^2+b^2)·A2]
  //       = +(k/(μ0·r2·E)) · [(a^2+b^2)·A2 - 2ab·A1]
  //
  //    So the 2×2 DtN matrix for harmonic k (k ≥ 1):
  //    M_k = (k/(μ0·E)) · [  (a^2+b^2)/r1,  -2ab/r1  ]
  //                        [ -2ab/r2,   (a^2+b^2)/r2  ]
  //    where a = r1^k, b = r2^k, E = b^2 - a^2
  //
  //  For k=0 (constant mode + log r mode):
  //    Solutions: A = α + β·ln(r)
  //    ∂A/∂r = β/r
  //    A1 = α + β·ln(r1),  A2 = α + β·ln(r2)
  //    β = (A2 - A1)/ln(r2/r1)
  //    q1 = -(β/r1)/μ0 = -(A2-A1)/(μ0·r1·ln(r2/r1))
  //    q2 = +(β/r2)/μ0 = +(A2-A1)/(μ0·r2·ln(r2/r1))
  //    M_0 = (1/(μ0·ln(r2/r1))) · [ -1/r1, +1/r1 ]  ... wait
  //          q1 = -β/(μ0·r1) = -(A2-A1)/(μ0·r1·lnr) where lnr = ln(r2/r1)
  //          q2 = +β/(μ0·r2) = +(A2-A1)/(μ0·r2·lnr)
  //    M_0 = (1/(μ0·lnr)) · [ -1/r1,  +1/r1 ] ... let me write correctly:
  //          [q1; q2] = M_0 · [A1; A2]
  //          q1 = (-1/(μ0·r1·lnr))·A1 + (1/(μ0·r1·lnr))·A2
  //          q2 = (+1/(μ0·r2·lnr))·(-A1) ... wait:
  //          q2 = +(A2-A1)/(μ0·r2·lnr) = -(A1)/(μ0·r2·lnr) + A2/(μ0·r2·lnr)
  //    M_0 = (1/(μ0·lnr)) · [ -1/r1,  1/r1 ]
  //                          [ -1/r2,  1/r2 ]
  //    Note M_0 is NOT positive-definite (it has a zero eigenvalue for uniform A1=A2).
  //    But k=0 carries no rotor↔stator torque (D spec note) and we include it in the
  //    stamp for completeness.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  //  computeMk uses the Galerkin (weak-form) DtN matrix which is SYMMETRIC and
  //  positive-semidefinite.  For k ≥ 1:
  //
  //    M_weak = (k / (μ0·E)) · [[a²+b², -2ab], [-2ab, a²+b²]]
  //
  //  where a = r1^k, b = r2^k, E = b² - a² > 0.
  //
  //  The Galerkin form differs from the pointwise DtN by a factor of the local
  //  radius in each row.  For r1 ≈ r2 (thin gap) the two are essentially equal.
  //  The Galerkin form is symmetric and positive-definite for k ≥ 1, making the
  //  bordered stamp unconditionally symmetric.
  //
  //  For k = 0 (log/constant Laplace modes) the weak-form matrix is also symmetric:
  //
  //    M_0_weak = (2π / (μ0 · ln(r2/r1))) · [[1, -1], [-1, 1]] · (1/(2π))
  //             = (1 / (μ0 · ln(r2/r1))) · [[1, -1], [-1, 1]]
  //
  //  This is positive-semidefinite (rank-1 in the zero-eigenvalue direction for
  //  uniform A1=A2).
  // ---------------------------------------------------------------------------
  function computeMk(r1, r2, k, mu0) {
    if (k === 0) {
      const lnr = Math.log(r2 / r1);
      const c = 1 / (mu0 * lnr);
      return [
        [ c, -c],
        [-c,  c],
      ];
    }
    const a = Math.pow(r1, k);
    const b = Math.pow(r2, k);
    const E = b * b - a * a;
    const s2ab = 2 * a * b;
    const a2b2 = a * a + b * b;
    const c = k / (mu0 * E);
    return [
      [ c * a2b2, -c * s2ab],
      [-c * s2ab,  c * a2b2],
    ];
  }

  // ---------------------------------------------------------------------------
  //  build(rotorGap, statorGap, opts) → HarmonicGap
  // ---------------------------------------------------------------------------
  function build(rotorGap, statorGap, opts) {
    if (!opts || typeof opts.K !== "number" || !Number.isInteger(opts.K) || opts.K < 1) {
      throw new Error("AirgapHarmonic.build: opts.K must be a positive integer");
    }
    if (!opts || typeof opts.ell !== "number" || opts.ell <= 0) {
      throw new Error("AirgapHarmonic.build: opts.ell must be a positive number");
    }

    const K = opts.K;
    const ell = opts.ell;
    const mu0 = (opts.mu0 != null) ? opts.mu0 : mu0_default;

    const r_mr = rotorGap.gapR;
    const r_ms = statorGap.gapR;

    if (r_mr >= r_ms) {
      throw new Error(
        `AirgapHarmonic.build: rotorGap.gapR (${r_mr}) must be < statorGap.gapR (${r_ms})`
      );
    }

    const Ngr = rotorGap.gapTheta.length;
    const Ngs = statorGap.gapTheta.length;

    if (Ngr < 4 * K) {
      throw new Error(
        `AirgapHarmonic.build: rotor N_gap (${Ngr}) < 4K (${4 * K}). ` +
        `Increase gapMinNodes to at least ${4 * K} for K=${K}.`
      );
    }
    if (Ngs < 4 * K) {
      throw new Error(
        `AirgapHarmonic.build: stator N_gap (${Ngs}) < 4K (${4 * K}). ` +
        `Increase gapMinNodes to at least ${4 * K} for K=${K}.`
      );
    }

    // Store copies of gapTheta
    const rotorTheta  = new Float64Array(rotorGap.gapTheta);
    const statorTheta = new Float64Array(statorGap.gapTheta);

    // Build all M_k matrices (k=0..K)
    const Mk_cache = new Array(K + 1);
    for (let k = 0; k <= K; k++) {
      Mk_cache[k] = computeMk(r_mr, r_ms, k, mu0);
    }

    // DOF layout (D3):
    //   [gapRotor (Ngr) | gapStator (Ngs) | harmRotor (2K+1) | harmStator (2K+1)]
    // harmonics layout per body: [a0, a1, b1, a2, b2, ..., aK, bK]
    const perBody = 2 * K + 1;       // number of harmonic DOFs per body
    const nHarmonicDofs = 2 * perBody;

    const layout = ["a0"];
    for (let k = 1; k <= K; k++) {
      layout.push("a" + k, "b" + k);
    }

    const dofMap = {
      gapRotor:  { base: 0,           count: Ngr },
      gapStator: { base: Ngr,         count: Ngs },
      harmonics: {
        base:    Ngr + Ngs,
        count:   nHarmonicDofs,
        perBody: perBody,
        layout:  layout,
        bodies:  ["rotor", "stator"],
      },
    };

    // -------------------------------------------------------------------------
    //  project / reconstruct (bound to the harmonic gap's K)
    // -------------------------------------------------------------------------
    function projectBound(gapTheta, Anodal) {
      return project(gapTheta, Anodal, K);
    }
    function projectIntoBound(gapTheta, Anodal, a, b) {
      projectInto(gapTheta, Anodal, K, a, b);
    }

    function reconstructBound(coeffs, gapTheta) {
      return reconstruct(coeffs, gapTheta);
    }

    // -------------------------------------------------------------------------
    //  surfaceFlux(ArotorGapNodal, AstatorGapNodal, phi) →
    //    { rotor: Float64Array(Ngr), stator: Float64Array(Ngs) }
    //
    //  Applies the DtN admittance map (with rotor phase φ) and returns the
    //  nodal radial surface flux on each circle.
    //
    //  For φ=0: project each circle, apply M_k per harmonic, reconstruct fluxes.
    //  For φ≠0: rotate rotor harmonics by e^{±ikφ} before applying M_k.
    //
    //  The DtN map acts per harmonic. For harmonic k:
    //    M_k · [a_r(k); a_s(k)] = [q_r(k); q_s(k)]   (scalar per cos or sin mode)
    //  where a_r, a_s are the rotor/stator cos/sin amplitudes and q_r, q_s are
    //  the corresponding flux amplitudes.
    //
    //  With phase φ: the rotor harmonic pair (a_r[k], b_r[k]) is rotated to
    //    (a_r[k]·cos(kφ) - b_r[k]·sin(kφ),  a_r[k]·sin(kφ) + b_r[k]·cos(kφ))
    //  then M_k is applied independently to the cosine channel and sine channel.
    // -------------------------------------------------------------------------
    function surfaceFlux(ArotorGapNodal, AstatorGapNodal, phi) {
      const R = project(rotorTheta,  ArotorGapNodal,  K);
      const S = project(statorTheta, AstatorGapNodal, K);

      // Harmonic flux amplitudes per mode
      // For each k=0..K we have cosine and sine channels.
      // k=0: only cosine channel (b[0]=0)
      // k≥1: both channels

      // flux_rotor and flux_stator coefficients
      const qRa = new Float64Array(K + 1); // cosine flux amplitude on rotor
      const qRb = new Float64Array(K + 1); // sine flux amplitude on rotor
      const qSa = new Float64Array(K + 1); // cosine flux amplitude on stator
      const qSb = new Float64Array(K + 1); // sine flux amplitude on stator

      // k=0
      {
        const M = Mk_cache[0];
        const ar = R.a[0];
        const as = S.a[0];
        qRa[0] = M[0][0] * ar + M[0][1] * as;
        qSa[0] = M[1][0] * ar + M[1][1] * as;
      }

      // k=1..K
      for (let k = 1; k <= K; k++) {
        const M = Mk_cache[k];

        // Apply rotor phase rotation
        let arkR = R.a[k];
        let brkR = R.b[k];
        if (phi !== 0) {
          const ck = Math.cos(k * phi);
          const sk = Math.sin(k * phi);
          const tmp_a = arkR * ck - brkR * sk;
          const tmp_b = arkR * sk + brkR * ck;
          arkR = tmp_a;
          brkR = tmp_b;
        }

        // Cosine channel: [arkR; S.a[k]] → [qRa[k]; qSa[k]]
        qRa[k] = M[0][0] * arkR + M[0][1] * S.a[k];
        qSa[k] = M[1][0] * arkR + M[1][1] * S.a[k];

        // Sine channel: [brkR; S.b[k]] → [qRb[k]; qSb[k]]
        qRb[k] = M[0][0] * brkR + M[0][1] * S.b[k];
        qSb[k] = M[1][0] * brkR + M[1][1] * S.b[k];
      }

      // Reconstruct nodal flux on each circle
      const fluxRotor  = reconstruct({ a: qRa, b: qRb }, rotorTheta);
      const fluxStator = reconstruct({ a: qSa, b: qSb }, statorTheta);

      return { rotor: fluxRotor, stator: fluxStator };
    }

    // -------------------------------------------------------------------------
    //  stamp(phi) → { n, I, J, V }
    //
    //  Full-symmetric triplets over the local DOF space [dofMap].
    //  n = Ngr + Ngs + 2·(2K+1)
    //
    //  DOF indexing:
    //    0       .. Ngr-1         : gap-rotor nodal A
    //    Ngr     .. Ngr+Ngs-1     : gap-stator nodal A
    //    Ngr+Ngs .. Ngr+Ngs+perBody-1       : rotor harmonic DOFs [a0,a1,b1,...,aK,bK]
    //    Ngr+Ngs+perBody .. Ngr+Ngs+2*perBody-1: stator harmonic DOFs
    //
    //  The stamp encodes the bordered system for the harmonic gap element.
    //  The harmonic DOFs are the Lagrange multipliers linking nodal A to the
    //  harmonic coefficients.
    //
    //  Block structure of the assembled local system:
    //
    //  The gap element couples rotor and stator through the harmonic expansion.
    //  The bordered augmented system (per-harmonic k) is:
    //
    //    For each harmonic k (treating cos and sin separately):
    //      [ 0,       0,  Pc_r^T  ] [A_r]   [0]
    //      [ 0,       0,  Pc_s^T  ] [A_s] = [0]
    //      [ Pc_r, Pc_s,  -M_k^{-1}] [h ]   [0]
    //
    //  But this doesn't produce the right FEM contribution. The correct bordered
    //  formulation (Schur complement of the harmonic DOFs gives the DtN map) is:
    //
    //    Contribution to global stiffness = P^T · M_k · P
    //  where P is the projection matrix from nodal DOFs to harmonic coefficients.
    //
    //  However, to keep the system SPD and the harmonic DOFs explicit (for Phase 5
    //  to condense later), we use the bordered form:
    //
    //    [ 0      0      B_r^T   0     ] [A_r]   [0]
    //    [ 0      0      0       B_s^T ] [A_s] = [0]
    //    [ B_r    0     -G_rr   -G_rs  ] [h_r]   [0]
    //    [ 0      B_s   -G_sr   -G_ss  ] [h_s]   [0]
    //
    //  where B_r = projection from gap-rotor nodal DOFs to harmonic coefficients,
    //        B_s = projection from gap-stator nodal DOFs to harmonic coefficients,
    //        G = M_k^{-1} (the "compliance" of the harmonic coupling).
    //
    //  The Schur complement of [h_r; h_s]:
    //    K_reduced · [A_r; A_s] = 0
    //  gives: B_r^T·G^{-1}·B_r + ... = B^T · M_k · B  (the DtN map),
    //  which is exactly what surfaceFlux computes.
    //
    //  For the stamp, per D4 the (I,J) coordinate set is φ-invariant.
    //  The blocks B_r (gap-nodal ↔ harmonic-rotor) and B_s (gap-nodal ↔
    //  harmonic-stator) are computed from the DFT basis functions evaluated
    //  at the gap-circle nodes. The harmonic-harmonic block G = M_k^{-1} for
    //  each k.
    //
    //  Detailed stamp layout:
    //
    //  1. B_r: Ngr rows (gap-rotor nodal) × perBody cols (rotor harmonic DOFs)
    //     B_r[i, 0] = 1/Ngr (for k=0 cosine)
    //     B_r[i, 2k-1] = (2/Ngr)·cos(k·θ_i) (for k=1..K cosine)
    //     B_r[i, 2k]   = (2/Ngr)·sin(k·θ_i) (for k=1..K sine)
    //
    //  2. B_s: Ngs rows × perBody cols
    //     Same as B_r but using stator angles.
    //
    //  3. G_rr, G_rs, G_sr, G_ss: perBody × perBody blocks from M_k^{-1}
    //     For each k separately (block diagonal in k).
    //     M_k^{-1} = (1/det_k) · [[M[1][1], -M[0][1]], [-M[1][0], M[0][0]]]
    //     The G block:
    //       G_rr[hIdx(k), hIdx(k)] = M_k_inv[0][0] (rotor-rotor admittance inverse)
    //       G_rs[hIdx(k), hIdx(k)] = M_k_inv[0][1] (rotor-stator)
    //       G_sr[hIdx(k), hIdx(k)] = M_k_inv[1][0]
    //       G_ss[hIdx(k), hIdx(k)] = M_k_inv[1][1]
    //
    //  The full local system size n = Ngr + Ngs + 2*perBody.
    //
    //  The triplets encode:
    //    (A_r[i], h_r[hIdx]) and (h_r[hIdx], A_r[i])  ← B_r coupling
    //    (A_s[i], h_s[hIdx]) and (h_s[hIdx], A_s[i])  ← B_s coupling
    //    (h_r[hIdx], h_r[hIdx']), (h_r[hIdx], h_s[hIdx']), etc. ← G block
    //
    //  The sign of the G block is negative (−G in the bordered system).
    //
    //  With φ≠0: the rotor harmonic DOFs are transformed by the rotation
    //    R_k(φ) = [[cos kφ, -sin kφ], [sin kφ, cos kφ]]
    //  acting on the (a_k, b_k) pair of the rotor.
    //  This rotates the rotor↔stator cross-blocks of G and the B_r coupling.
    //  Per D4, the (I,J) coordinate set is unchanged; only V changes.
    // -------------------------------------------------------------------------
    // Worst-case triplet count for stampInto's output buffers. Caller can pre-
    // allocate I/J/V of this length once at create-time and reuse them every
    // call. Formula derivation (see stampInto for the per-block contributions):
    //   B_r:  Ngr * (2 + 4K)    (k=0 adds 2 via addSym; each k≥1 adds 4)
    //   B_s:  Ngs * (2 + 4K)
    //   G k=0: 4                (3 addSym calls: two i==j → 1 each, one i!=j → 2)
    //   G k≥1: 12 per k         (4 diagonal addSym (i==j) + 8 cross-direction raw)
    // Total: 2(Ngr+Ngs)(1+2K) + 4 + 12K
    const tripletCapacity = 2 * (Ngr + Ngs) * (1 + 2 * K) + 4 + 12 * K;

    // stampInto(phi, outI, outJ, outV) — writes the full-symmetric stamp at
    // angle `phi` into caller-provided typed-array buffers, returns the actual
    // triplet count written. outI/outJ must be Int32Array, outV Float64Array,
    // all of length ≥ tripletCapacity. No allocations.
    function stampInto(phi, outI, outJ, outV) {
      const baseHR = Ngr + Ngs;          // base index for rotor harmonics
      const baseHS = Ngr + Ngs + perBody; // base index for stator harmonics
      let p = 0;
      //   For k=1..K: two DOFs on each body (a_k, b_k), total 4 DOFs in G block
      //   But the cosine DOFs only interact with cosine DOFs (and sine with sine),
      //   because the DFT is orthogonal. So M_k applied to (a_r[k], a_s[k]) gives
      //   (q_r_cos[k], q_s_cos[k]), and independently M_k applied to (b_r[k], b_s[k])
      //   gives (q_r_sin[k], q_s_sin[k]).
      //
      // Therefore the G block (M_k^{-1} entries) for harmonic k is block-diagonal in cos/sin:
      //   [a_r_cos] → G_rr scalar (same for cos and sin)
      //   [b_r_cos] → G_rr scalar
      //   etc.
      //
      // The rotor↔stator cross-blocks in G (G_rs, G_sr) ARE where the φ phase
      // rotation enters. For φ≠0, the rotor harmonic pair (a_k, b_k) is rotated by
      //   R_k(φ) = [[cos kφ, -sin kφ], [sin kφ, cos kφ]]
      // This mixes the cos/sin channels within one k order.
      // At φ=0: R_k(0) = I, so cos/sin channels are decoupled.
      // At φ≠0: the rotor-stator coupling entry G_rs mixes cos and sin DOFs
      //   of the same harmonic order.
      //
      // For the stamp we need the FULL 2×2 cross-blocks (D4: all 4 entries present,
      // even if 2 of them are 0 at φ=0).
      //
      // So for each k=1..K, the cross-block G_rs is a 2×2 matrix in (a_k, b_k) space:
      //   At φ=0: G_rs = M_k^{-1}[0][1] · I_{2×2}
      //   At φ≠0: G_rs = R_k(φ)·(M_k^{-1}[0][1] · I_{2×2})  ... need to think more.
      //
      // Let's define the transformation more carefully.
      //
      // The bordered system with phase φ and harmonic k (k≥1):
      //   Harmonic DOFs: h_r = [a_rk, b_rk] (rotor), h_s = [a_sk, b_sk] (stator)
      //   Nodal DOFs: A_r (rotor gap nodes), A_s (stator gap nodes)
      //
      //   The projection B_r maps A_r → [a_rk, b_rk]:
      //     a_rk = (2/Ngr) Σ_i A_r[i]·cos(k·θ_i)
      //     b_rk = (2/Ngr) Σ_i A_r[i]·sin(k·θ_i)
      //
      //   The phase rotation: â_rk = a_rk·cos(kφ) - b_rk·sin(kφ)
      //                       b̂_rk = a_rk·sin(kφ) + b_rk·cos(kφ)
      //
      //   The coupling energy (per harmonic k) is:
      //     W_k = (1/2) · [â_rk; a_sk]^T · M_k · [â_rk; a_sk]  (cosine channel)
      //         + (1/2) · [b̂_rk; b_sk]^T · M_k · [b̂_rk; b_sk]  (sine channel)
      //
      //   In the bordered (Lagrange) form, the coupling between nodal and harmonic DOFs
      //   is stored as the B matrices, and the G (= M^{-1}) block stores the inverse
      //   admittance. With the phase rotation, the effective B_r in the bordered system
      //   is R_k(φ)^T · B_r_nominal (the rotation is absorbed into the B_r coupling).
      //
      //   Actually the standard bordered approach is: we introduce harmonic DOFs h_r
      //   and h_s that store the *un-rotated* projections, then the coupling block
      //   between h_r and h_s gets rotated by R_k(φ).
      //
      //   For the stamp, the clearest φ-invariant (I,J) approach is:
      //   We define h_r = [a_rk, b_rk] (raw projection, no rotation) and
      //   h_s = [a_sk, b_sk] (raw projection).
      //   Then the coupling energy is:
      //     W = (1/2) · [(R·h_r); h_s]^T · M_k · [(R·h_r); h_s]
      //   where R = R_k(φ).
      //
      //   The G block (M_k^{-1}) in the system:
      //   For the bordered system (energy stationarity), the contribution is:
      //     Stiffness block for [h_r; h_s]:
      //       K_hh = [[R^T·M_k_rr·R, R^T·M_k_rs], [M_k_sr·R, M_k_ss]]
      //     where M_k = [[M_k_rr, M_k_rs], [M_k_sr, M_k_ss]] with M_k_rr = m00·I,
      //     M_k_rs = m01·I, M_k_sr = m10·I, M_k_ss = m11·I (since M_k is scalar per channel).
      //
      //   So K_hh = [[m00·I, m01·R^{-T}], [m10·R, m11·I]]
      //           = [[m00·I, m01·R^T],     [m10·R, m11·I]]   (since R is orthogonal)
      //
      //   Wait, let me be careful. If we define the energy as:
      //     2W = [h_r^T, h_s^T] · [[m00·I, m01·R_k(φ)], [m10·R_k(φ)^T, m11·I]] · [h_r; h_s]
      //   Then ∂W/∂h_r = m00·h_r + m01·R_k(φ)·h_s
      //        ∂W/∂h_s = m10·R_k(φ)^T·h_r + m11·h_s
      //   And the coupling to nodal DOFs via B:
      //     ∂W/∂A_r[i] = B_r[i,h]·(∂W/∂h_r)[h]  -- these are the B_r^T entries
      //
      //   Actually for the bordered system the natural representation is:
      //   The system K·x = f where x = [A_r, A_s, h_r, h_s] and K is:
      //   [[0, 0, B_r^T,         0    ],
      //    [0, 0, 0,             B_s^T],
      //    [B_r, 0, -C_rr,      -C_rs ],
      //    [0, B_s, -C_sr,      -C_ss ]]
      //
      //   where C = M_k^{-1} but with the cross-blocks incorporating φ:
      //   C_rr = m11/det · I,  C_ss = m00/det · I
      //   C_rs = -m01/det · R_k(φ)^T,  C_sr = -m10/det · R_k(φ)
      //   (The sign of C_rs corresponds to -M_k^{-1}[0][1]·R)
      //
      //   Actually let me just verify what the Schur complement gives.
      //   Schur complement of the harmonic block:
      //   S = [[B_r^T·C^{-1}·B_r, B_r^T·C^{-1}·B_s],
      //        [B_s^T·C^{-1}·B_r, B_s^T·C^{-1}·B_s]]
      //   but with the minus signs and the rotation.
      //
      //   It's getting complex. Let me use a direct, implementation-friendly approach:
      //
      //   The B coupling matrices are fixed (φ-independent):
      //     B_r[i,h]: projection from rotor nodal DOF i to rotor harmonic h
      //     B_s[j,h]: projection from stator nodal DOF j to stator harmonic h
      //
      //   The G block is M_k^{-1} with phase rotation in the off-diagonal:
      //
      //   For k=0 (scalar):
      //     G = inv(M_0): 2×2 scalar (no φ dependence since k=0)
      //
      //   For k≥1 (each k acts on a 2D (cos,sin) space for rotor and stator):
      //     Full 4×4 block (h_r_cos, h_r_sin, h_s_cos, h_s_sin):
      //
      //   The bordered system (what Schur-eliminates to give surfaceFlux):
      //   Bordered contribution = B^T · M_eff · B
      //   where M_eff for rotor-stator is M_k[0][1]·R_k(φ) and for stator-rotor is M_k[1][0]·R_k(φ)^T.
      //
      //   This is the key structural insight: the cross-block in the bordered system
      //   must give the correct Schur complement equal to surfaceFlux.
      //
      //   For the stamp I'll use the following structure that matches surfaceFlux:
      //
      //   The bordered system for harmonic k (k≥1) with the 4 DOFs
      //   [a_rk, b_rk, a_sk, b_sk] contributes to the local system.
      //
      //   The coupling B_r contributes:  (gap-rotor node i) ↔ (a_rk, b_rk)
      //   The coupling B_s contributes:  (gap-stator node i) ↔ (a_sk, b_sk)
      //
      //   The G (compliance) block in the bordered system (with negative sign):
      //
      //   For φ=0:
      //     G_rr = -m11_inv · I_{2×2}  (decoupled: cos with cos, sin with sin)
      //     G_ss = -m00_inv · I_{2×2}
      //     G_rs = G_sr = +m01_inv · I_{2×2}  (cross coupling)
      //
      //   For φ≠0: the rotor DOFs a_rk, b_rk represent the un-rotated projections.
      //   The phase rotation enters the coupling between h_r and h_s:
      //     G_rs for (a_rk row, a_sk col): +m01_inv · cos(kφ)
      //     G_rs for (a_rk row, b_sk col): -m01_inv · sin(kφ) ... wait, no.
      //
      //   Let me think about this from the energy perspective.
      //   The energy contribution from harmonic k is (sum over cos and sin channels):
      //
      //   W_k = (1/2)[â_rk, a_sk] M_k [â_rk; a_sk] + (1/2)[b̂_rk, b_sk] M_k [b̂_rk; b_sk]
      //   where â_rk = a_rk·ckφ - b_rk·skφ, b̂_rk = a_rk·skφ + b_rk·ckφ
      //   (ckφ = cos kφ, skφ = sin kφ)
      //
      //   Expanding the cos-channel:
      //   (1/2)[â_rk, a_sk] M_k [â_rk; a_sk]
      //   = (1/2)(m00·â_rk^2 + 2m01·â_rk·a_sk + m11·a_sk^2)
      //
      //   And â_rk in terms of h_r:
      //   â_rk = ckφ·a_rk - skφ·b_rk
      //
      //   Full energy W_k as quadratic form in [a_rk, b_rk, a_sk, b_sk]:
      //
      //   Let's compute ∂²W_k/∂x_i∂x_j for the 4 DOFs:
      //
      //   cos channel:
      //   â = ckφ·a_rk - skφ·b_rk
      //   ∂â/∂a_rk = ckφ, ∂â/∂b_rk = -skφ, ∂â/∂a_sk = 0, ∂â/∂b_sk = 0
      //   For the (a_rk, a_rk) entry from cos channel: m00·ckφ²
      //   For the (b_rk, b_rk) entry from cos channel: m00·skφ²
      //   For the (a_rk, b_rk) entry from cos channel: -m00·ckφ·skφ (and sym.)
      //   For the (a_sk, a_sk) entry from cos channel: m11·1²... wait
      //   ∂W_cos/∂a_sk = m01·â_rk + m11·a_sk  ... linearize
      //   K[a_sk,a_sk] from cos = m11
      //   K[a_rk,a_sk] from cos = m01·ckφ
      //   K[b_rk,a_sk] from cos = m01·(-skφ)  ... actually -m01·skφ
      //
      //   sin channel:
      //   b̂ = skφ·a_rk + ckφ·b_rk
      //   K[a_rk,a_rk] from sin = m00·skφ²
      //   K[b_rk,b_rk] from sin = m00·ckφ²
      //   K[a_rk,b_rk] from sin = m00·skφ·ckφ (and sym.)
      //   K[b_sk,b_sk] from sin = m11
      //   K[a_rk,b_sk] from sin = m01·skφ
      //   K[b_rk,b_sk] from sin = m01·ckφ
      //   K[a_sk,b_sk] from sin = 0 (no coupling)
      //
      //   Combining cos + sin channels:
      //   K[a_rk,a_rk] = m00·(ckφ² + skφ²) = m00
      //   K[b_rk,b_rk] = m00·(skφ² + ckφ²) = m00
      //   K[a_rk,b_rk] = m00·(-ckφ·skφ + skφ·ckφ) = 0
      //   K[a_sk,a_sk] = m11  (from cos channel, no sin contribution)
      //   K[b_sk,b_sk] = m11  (from sin channel, no cos contribution)
      //   K[a_sk,b_sk] = 0
      //   K[a_rk,a_sk] = m01·ckφ  (from cos channel)
      //   K[b_rk,a_sk] = -m01·skφ (from cos channel, b̂ doesn't involve a_sk)
      //   K[a_rk,b_sk] = m01·skφ  (from sin channel)
      //   K[b_rk,b_sk] = m01·ckφ  (from sin channel)
      //
      //   So the 4×4 stiffness matrix for [a_rk, b_rk, a_sk, b_sk] is:
      //   [[m00,    0,      m01·ckφ,   m01·skφ  ],
      //    [0,      m00,   -m01·skφ,   m01·ckφ  ],
      //    [m01·ckφ,-m01·skφ, m11,     0        ],
      //    [m01·skφ, m01·ckφ, 0,       m11      ]]
      //
      //   where m00=M_k[0][0], m01=M_k[0][1], m11=M_k[1][1].
      //   (Note m01 = M_k[0][1] = M_k[1][0] by symmetry.)
      //
      //   This is the stiffness contribution to the harmonic DOFs.
      //   This is POSITIVE (from the energy), but in the bordered system it appears
      //   with a NEGATIVE sign (standard Lagrange bordered form):
      //   the bordered system is K·x = f where the harmonic block has -G = -M_k^{-1}...
      //   wait, actually for the DtN stamp the harmonic block IS the admittance (M_k),
      //   not its inverse, because we're treating h_r, h_s as the harmonic COEFFICIENT
      //   DOFs and the bordered system is:
      //
      //   [0,   0,   B_r^T, 0    ] [A_r]   [0]
      //   [0,   0,   0,     B_s^T] [A_s] = [0]
      //   [B_r, 0,   -K_rr, -K_rs] [h_r]   [0]
      //   [0,   B_s, -K_sr, -K_ss] [h_s]   [0]
      //
      //   where the K_hh block is the STIFFNESS (= admittance M_k) of the coupling,
      //   and it appears with negative sign because the static condensation of h gives:
      //   K_rr · h_r + K_rs · h_s = B_r · A_r (coupling constraint)
      //   K_sr · h_r + K_ss · h_s = B_s · A_s
      //   Solving for h and substituting gives the DtN map.
      //
      //   The bordered system has the structure above with the MINUS signs on K_hh.
      //   These minus signs appear in the V values of the stamp triplets.
      //
      //   So in the stamp, the harmonic-harmonic block entries have negative sign:
      //   -(the 4×4 matrix computed above).
      //
      //   The B coupling blocks (B_r and B_s) appear with positive sign (off-diagonal
      //   of the bordered matrix).

      // Now implement:
      // (I,J) pattern is φ-invariant. For each k and each DOF pair, we always
      // emit the same (I,J) regardless of φ.

      // Count triplets:
      // B_r: for each hIdx in 0..perBody-1: Ngr pairs (A_r[i] ↔ h_r[hIdx])
      //   → 2 * Ngr * perBody (both directions, symmetric)
      // B_s: 2 * Ngs * perBody
      // G (harmonic-harmonic):
      //   k=0: 4 entries (2x2 block for rotor-stator), but h_r[0]↔h_r[0], h_r[0]↔h_s[0], etc.
      //     Since it's a 2x2 block with diagonal + off-diagonal:
      //     diag: (h_r[0],h_r[0]) and (h_s[0],h_s[0]) → 2 entries
      //     off-diag: (h_r[0],h_s[0]) and (h_s[0],h_r[0]) → 2 entries
      //     Total: 4 for k=0
      //   k=1..K: 4×4 block but the pattern is:
      //     h_r has 2 DOFs (cos, sin), h_s has 2 DOFs
      //     All 4 pairs within h_r: (hrc,hrc), (hrc,hrs), (hrs,hrc), (hrs,hrs) → 4
      //     All 4 pairs within h_s: 4
      //     All 4 cross pairs h_r ↔ h_s (full 2×2): 4 × 2 (both directions) = 8
      //     Wait, the matrix is 4×4, and the full-symmetric condition means we emit
      //     both (i,j,v) and (j,i,v). For diagonal we emit once.
      //     From the 4×4 matrix (for k≥1):
      //       [[m00, 0, m01·ck, m01·sk],
      //        [0, m00, -m01·sk, m01·ck],
      //        [m01·ck, -m01·sk, m11, 0],
      //        [m01·sk, m01·ck, 0, m11]]
      //     Non-zero unique entries (upper triangle + diag):
      //       (0,0)=m00, (1,1)=m00, (2,2)=m11, (3,3)=m11
      //       (0,2)=m01·ck, (0,3)=m01·sk, (1,2)=-m01·sk, (1,3)=m01·ck
      //     Lower triangle = symmetric.
      //     Even at φ=0 (ck=1,sk=0): (0,2)=m01≠0, (0,3)=0, (1,2)=0, (1,3)=m01≠0
      //     Per D4: structural zeros (0,3) and (1,2) at φ=0 must still appear.
      //     Total per k: 4 diag + 4 off-diag (upper) + 4 (lower) = 12 entries
      //     But (0,1) and (2,3) are always 0 (from the 4×4 matrix) — are they needed?
      //     D4 says the full 2×2 rotor↔stator cross-blocks are present. The rotor↔rotor
      //     and stator↔stator diagonal blocks are m00·I and m11·I which have no off-diagonal
      //     within the block (since (0,1)=0 always). Those are structural zeros that do
      //     NOT change with φ, so they don't need to be in the triplets (they'd be zero-value
      //     duplicates). We only need the off-diagonal entries that VARY with φ.
      //     But D4 says structural zeros are never pruned from the triplet list...
      //     This applies to the rotor↔stator 2×2 block (D4 explicitly). The rotor↔rotor
      //     off-diagonal (0,1) is always zero (φ-invariant structural zero too, but this
      //     is not a "cross-block" — it's within-body). We include only what the spec
      //     mandates: the full 2×2 rotor↔stator cross-block (per D4).
      //     The within-body (h_r↔h_r) off-diagonal (a_rk, b_rk) is always 0 because
      //     m00 multiplies the unit matrix for both channels. We exclude it (it's not
      //     a "cross-block" and it's a genuine structural zero that doesn't change with φ).
      //
      //   Final count per k≥1:
      //     Diagonal (h_r×h_r): 2 entries (one for a_rk, one for b_rk)
      //     Diagonal (h_s×h_s): 2 entries
      //     Cross 2×2 (h_r↔h_s): 4 entries × 2 (sym) = 8 entries
      //     Total: 12 per k
      //
      //   k=0: 2×2 block:
      //     Diagonal: (h_r[0],h_r[0]) and (h_s[0],h_s[0]) → 2
      //     Off-diagonal: (h_r[0],h_s[0]) and (h_s[0],h_r[0]) → 2
      //     Total: 4 for k=0

      // Total G entries: 4 + K*12
      // Total B entries: 2*Ngr*perBody + 2*Ngs*perBody (both directions)

      function addSym(i, j, v) {
        outI[p] = i; outJ[p] = j; outV[p] = v; p++;
        if (i !== j) {
          outI[p] = j; outJ[p] = i; outV[p] = v; p++;
        }
      }
      function addRaw(i, j, v) {
        outI[p] = i; outJ[p] = j; outV[p] = v; p++;
      }

      // B_r: coupling between gap-rotor nodal DOFs and rotor harmonic DOFs
      // B_r[i, hIdx] = DFT basis function evaluated at gapTheta[i]
      for (let i = 0; i < Ngr; i++) {
        const th = rotorTheta[i];
        // hIdx=0: k=0 cosine mode
        {
          const hAbs = baseHR + 0;
          const val = 1.0 / Ngr;  // B_r[i,0] = 1/N (projection coefficient)
          addSym(i, hAbs, val);
        }
        // hIdx=2k-1 (cosine) and 2k (sine) for k=1..K
        for (let k = 1; k <= K; k++) {
          const hCos = baseHR + (2 * k - 1);
          const hSin = baseHR + (2 * k);
          const cosVal = (2.0 / Ngr) * Math.cos(k * th);
          const sinVal = (2.0 / Ngr) * Math.sin(k * th);
          addSym(i, hCos, cosVal);
          addSym(i, hSin, sinVal);
        }
      }

      // B_s: coupling between gap-stator nodal DOFs and stator harmonic DOFs
      for (let i = 0; i < Ngs; i++) {
        const th = statorTheta[i];
        const iAbs = Ngr + i;
        // hIdx=0: k=0 cosine mode
        {
          const hAbs = baseHS + 0;
          const val = 1.0 / Ngs;
          addSym(iAbs, hAbs, val);
        }
        for (let k = 1; k <= K; k++) {
          const hCos = baseHS + (2 * k - 1);
          const hSin = baseHS + (2 * k);
          const cosVal = (2.0 / Ngs) * Math.cos(k * th);
          const sinVal = (2.0 / Ngs) * Math.sin(k * th);
          addSym(iAbs, hCos, cosVal);
          addSym(iAbs, hSin, sinVal);
        }
      }

      // G (harmonic-harmonic) block: -M_k^{-1} (compliance, negated in bordered system).
      //
      // The harmonic DOFs h_r[k], h_s[k] are defined so that after solving the bordered
      // system, h = M_k * proj(A) = surfaceFlux amplitudes.  This requires the bordered
      // system harmonic block to be -M_k^{-1} (not -M_k), so that the static condensation
      // recovers h = M_k * proj(A):
      //   -M_k^{-1} * h + proj(A) = 0  →  h = M_k * proj(A)  ✓
      //
      // For k≥1: M_weak has m00=m11 (both equal (a²+b²)·k/(μ0·E)), so
      //   det_k = m00² - m01²
      //   Minv[0][0] = Minv[1][1] = m00/det_k
      //   Minv[0][1] = Minv[1][0] = -m01/det_k
      //
      // For k=0: M_0 = c·[[1,-1],[-1,1]] (rank-1, singular).  Use the Moore–Penrose
      //   pseudoinverse: M_0^+ = (1/(4c))·[[1,-1],[-1,1]].
      //   Physical k=0 flux satisfies h_r[0] = -h_s[0] (conservation), so the system
      //   is consistent and M_0^+ recovers the unique minimum-norm solution.
      //
      // The 4×4 block structure for k≥1 with phase φ is the same as for M_k (same
      // rotation pattern) — just use Minv coefficients instead of M coefficients.

      // k=0: 2×2 (h_r[0], h_s[0]).
      //
      // M_0 = c·[[1,-1],[-1,1]] is rank-1 (uniform-mode null space [1;1]).
      // The bordered system needs -M_0^{-1} in the harmonic block so that
      // solving with pinned gap nodes yields h = M_0 · a_proj (the k=0 flux
      // Fourier coefficients), but M_0^{-1} doesn't exist.
      //
      // Adding ε·I to M_0 lifts the null eigenvalue to ε. The inverse is then
      //   (M_0 + εI)^{-1} = (1/D)·[[c+ε, c], [c, c+ε]],   D = 2cε + ε²
      // and -(M_0 + εI)^{-1} stamped into the bordered block gives, after the
      // pinned-gap solve,
      //   h = (M_0 + εI) · a_proj = M_0·a_proj + ε·a_proj.
      // The valid (a_r ≠ a_s) direction recovers M_0·a_proj exactly to O(ε/c);
      // the null direction contributes O(ε·|a_proj|), which the 1e-9 stamp-
      // consistency assertion tolerates with the chosen ε.
      {
        const M = Mk_cache[0];
        const c0 = M[0][0];                       // M_0 = c0·[[1,-1],[-1,1]]
        const eps = 1e-10 * c0;
        const D = 2 * c0 * eps + eps * eps;
        const inv_dd = (c0 + eps) / D;            // (M_0+εI)^{-1}[0][0] = [1][1]
        const inv_od = c0 / D;                    // (M_0+εI)^{-1}[0][1] = [1][0]
        const hr0 = baseHR + 0;
        const hs0 = baseHS + 0;
        addSym(hr0, hr0, -inv_dd);
        addSym(hs0, hs0, -inv_dd);
        addSym(hr0, hs0, -inv_od);
      }

      // k=1..K: 4×4 block with φ-dependent cross terms, using M_k^{-1}
      for (let k = 1; k <= K; k++) {
        const M = Mk_cache[k];
        const m00 = M[0][0];   // = m11 for M_weak (a²+b² diagonal)
        const m01 = M[0][1];   // = M[1][0] by symmetry (off-diagonal)
        // Invert the symmetric 2×2 M_k (m00=m11 case):
        const det_k = m00 * m00 - m01 * m01;
        const minv00 = m00 / det_k;   // = Minv[1][1] too
        const minv01 = -m01 / det_k;  // = Minv[0][1] = Minv[1][0]

        const ck = Math.cos(k * phi);
        const sk = Math.sin(k * phi);

        const hrC = baseHR + (2 * k - 1);  // rotor cosine DOF for harmonic k
        const hrS = baseHR + (2 * k);       // rotor sine DOF
        const hsC = baseHS + (2 * k - 1);   // stator cosine DOF
        const hsS = baseHS + (2 * k);        // stator sine DOF

        // Diagonal rotor-rotor: -Minv[0][0]·I (φ-independent)
        addSym(hrC, hrC, -minv00);
        addSym(hrS, hrS, -minv00);

        // Diagonal stator-stator: -Minv[1][1]·I = -minv00·I (φ-independent)
        addSym(hsC, hsC, -minv00);
        addSym(hsS, hsS, -minv00);

        // Cross 2×2 rotor↔stator (φ-dependent, D4: all 4 entries present)
        // Same rotation pattern as the M_k block, using minv01:
        // K[a_rk, a_sk] = minv01·ck  → negated: -minv01·ck
        // K[a_rk, b_sk] = minv01·sk  → negated: -minv01·sk
        // K[b_rk, a_sk] = -minv01·sk → negated: +minv01·sk
        // K[b_rk, b_sk] = minv01·ck  → negated: -minv01·ck
        addRaw(hrC, hsC, -minv01 * ck);
        addRaw(hsC, hrC, -minv01 * ck);

        addRaw(hrC, hsS, -minv01 * sk);
        addRaw(hsS, hrC, -minv01 * sk);

        addRaw(hrS, hsC,  minv01 * sk);
        addRaw(hsC, hrS,  minv01 * sk);

        addRaw(hrS, hsS, -minv01 * ck);
        addRaw(hsS, hrS, -minv01 * ck);
      }

      return p;
    }

    // stamp(phi) — allocating wrapper preserved for callers that still want a
    // fresh { n, I, J, V } object. The hot path (motor-slice's solveStaticRotor
    // and the linear Schur path) uses stampInto into pre-allocated scratch.
    function stamp(phi) {
      const n = Ngr + Ngs + 2 * perBody;
      const I = new Int32Array(tripletCapacity);
      const J = new Int32Array(tripletCapacity);
      const V = new Float64Array(tripletCapacity);
      const nt = stampInto(phi, I, J, V);
      if (nt === tripletCapacity) return { n, I, J, V };
      // Defensive: if stampInto ever writes fewer than the worst-case count
      // (would indicate a formula mismatch — should not happen), slice down.
      return {
        n,
        I: I.subarray(0, nt),
        J: J.subarray(0, nt),
        V: V.subarray(0, nt),
      };
    }

    // -------------------------------------------------------------------------
    //  torque(ArotorGapNodal, AstatorGapNodal, phi) → number
    //
    //  Maxwell-stress torque about the rotor axis per the formula in the spec.
    // -------------------------------------------------------------------------
    function torque(ArotorGapNodal, AstatorGapNodal, phi) {
      const R = project(rotorTheta,  ArotorGapNodal,  K);
      const S = project(statorTheta, AstatorGapNodal, K);

      let T = 0;
      for (let k = 1; k <= K; k++) {
        // Apply rotor phase rotation to R per spec step 2
        const ck = Math.cos(k * phi);
        const sk = Math.sin(k * phi);
        const Rrot_a = R.a[k] * ck - R.b[k] * sk;
        const Rrot_b = R.a[k] * sk + R.b[k] * ck;

        // Geometric denominator: (r_ms/r_mr)^k - (r_mr/r_ms)^k. Non-zero for any
        // physical gap (r_mr < r_ms enforced by build).
        const ratio = r_ms / r_mr;
        const ratioK = Math.pow(ratio, k);
        const denom = ratioK - 1 / ratioK;

        const dT = (2 * Math.PI * k * k * ell / mu0) *
                   (Rrot_a * S.b[k] - Rrot_b * S.a[k]) / denom;
        T += dT;
      }

      return T;
    }

    // -------------------------------------------------------------------------
    //  _internals — test-only hatch
    // -------------------------------------------------------------------------
    const _internals = {
      Mk: function (k) {
        if (k < 0 || k > K) throw new Error("Mk: k out of range [0," + K + "]");
        return Mk_cache[k];
      },
    };

    return {
      K,
      nGapRotor:     Ngr,
      nGapStator:    Ngs,
      nHarmonicDofs: nHarmonicDofs,
      dofMap,
      project:       projectBound,
      projectInto:   projectIntoBound,
      reconstruct:   reconstructBound,
      surfaceFlux,
      stamp,
      stampInto,
      tripletCapacity,
      torque,
      _internals,
    };
  }

  LIB.AirgapHarmonic = { defaultK, build };
})();
