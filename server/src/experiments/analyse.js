// Experiment analysis: two-proportion z-test, sample-ratio-mismatch check, guardrails and a decision rule.
// The decision is a fixed rule over these numbers; no LLM is involved.

const Z95 = 1.959964;
const SRM_ALPHA = 0.001; // the usual threshold for sample ratio mismatch

export const PRIMARY_METRICS = {
  acceptance_rate: { label: 'Offer acceptance rate', num: (s) => s.accepted, den: (s) => s.n },
  disbursal_rate: { label: 'Disbursal rate (of exposed)', num: (s) => s.disbursed, den: (s) => s.n },
};

export const GUARDRAIL_METRICS = {
  default_rate: { label: 'Default rate on disbursed loans', kind: 'proportion', num: (s) => s.defaulted, den: (s) => s.disbursed, defaultTolerance: { type: 'abs', value: 0.01 } },
  complaint_rate: { label: 'Complaint rate (complaint proxy)', kind: 'proportion', num: (s) => s.complaints, den: (s) => s.n, defaultTolerance: { type: 'abs', value: 0.005 } },
  median_tat: { label: 'Median turnaround time (disbursed)', kind: 'median', defaultTolerance: { type: 'rel', value: 0.1 } },
};

// ---------- numerics ----------
export function normCdf(z) {
  // Abramowitz-Stegun 26.2.17, absolute error < 7.5e-8
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function lnGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised upper incomplete gamma Q(a, x). */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 500; n++) {
      del *= x / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

export const chiSquareP = (chi2, df) => gammaQ(df / 2, chi2 / 2);

/** Treatment minus control. Pooled standard error for the test, unpooled for the interval. */
export function twoProportion(x1, n1, x2, n2) {
  if (!n1 || !n2) return { p1: null, p2: null, diff: null, ci95: [null, null], z: null, p: null };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pool = (x1 + x2) / (n1 + n2);
  const sePool = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  const z = sePool > 0 ? (p2 - p1) / sePool : 0;
  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { p1, p2, diff: p2 - p1, ci95: [p2 - p1 - Z95 * se, p2 - p1 + Z95 * se], z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

/** Difference of medians (treatment minus control) with a normal-approximation interval. */
function medianDiff(c, t) {
  // se(median) ~= 1.2533 * sd / sqrt(n), with sd estimated from the IQR (sd ~= IQR / 1.349)
  const se = (s) => (1.2533 * ((s.tat_q3 - s.tat_q1) / 1.349)) / Math.sqrt(s.tat_n);
  const diff = t.tat_median - c.tat_median;
  const sd = Math.sqrt(se(c) ** 2 + se(t) ** 2);
  return { diff, ci95: [diff - Z95 * sd, diff + Z95 * sd] };
}

// ---------- analysis ----------
export function srmCheck(variants, summaries) {
  const observed = variants.map((v) => summaries[v.name]?.n ?? 0);
  const total = observed.reduce((a, b) => a + b, 0);
  const expected = variants.map((v) => (total * v.weight) / 100);
  const chi2 = total ? observed.reduce((a, o, i) => a + (o - expected[i]) ** 2 / expected[i], 0) : 0;
  const df = variants.length - 1;
  const p = total ? chiSquareP(chi2, df) : 1;
  return { observed, expected: expected.map((e) => Number(e.toFixed(1))), chi2: Number(chi2.toFixed(3)), df, p, alpha: SRM_ALPHA, flagged: p < SRM_ALPHA };
}

function guardrailResult(g, spec, c, t) {
  const tol = g.tolerance ?? spec.defaultTolerance;
  let control; let treatment; let delta; let ci;
  if (spec.kind === 'proportion') {
    const r = twoProportion(spec.num(c), spec.den(c), spec.num(t), spec.den(t));
    control = r.p1; treatment = r.p2; delta = r.diff; ci = r.ci95;
  } else {
    if (!c.tat_n || !t.tat_n) return { metric: g.metric, label: spec.label, status: 'no_data', tolerance: tol };
    const m = medianDiff(c, t);
    control = c.tat_median; treatment = t.tat_median; delta = m.diff; ci = m.ci95;
  }
  if (delta === null) return { metric: g.metric, label: spec.label, status: 'no_data', tolerance: tol };
  // tolerance is on the harmful direction (higher is worse for all three metrics)
  const scale = tol.type === 'rel' ? control : 1;
  const limit = tol.value * scale;
  const status = ci[0] > limit ? 'breach' : ci[1] <= limit ? 'ok' : 'uncertain';
  return {
    metric: g.metric, label: spec.label, control, treatment, delta,
    delta_relative: control ? delta / control : null,
    ci95: ci, tolerance: tol, limit, status,
  };
}

export function analyseSummaries(def, summaries) {
  const [ctrl, treat] = def.variants.map((v) => v.name);
  const c = summaries[ctrl] ?? { n: 0, accepted: 0, disbursed: 0, defaulted: 0, complaints: 0, tat_n: 0 };
  const t = summaries[treat] ?? { n: 0, accepted: 0, disbursed: 0, defaulted: 0, complaints: 0, tat_n: 0 };
  const pm = PRIMARY_METRICS[def.primary_metric];
  if (!pm) throw new Error(`unsupported primary metric ${def.primary_metric}`);

  const srm = srmCheck(def.variants, summaries);
  const pr = twoProportion(pm.num(c), pm.den(c), pm.num(t), pm.den(t));
  const primary = {
    metric: def.primary_metric, label: pm.label,
    control: pr.p1, treatment: pr.p2, diff: pr.diff,
    relative_lift: pr.p1 ? pr.diff / pr.p1 : null,
    ci95: pr.ci95, z: pr.z, p_value: pr.p,
    significant: pr.p !== null && pr.p < 0.05,
    // The smallest true difference this test would detect 80% of the time (two-sided 5%). A "hold" on a test that could not have seen
    // the effect you care about is not evidence that there is none.
    mde80: pr.p1 !== null && c.n && t.n ? (Z95 + 0.841621) * Math.sqrt(pr.p1 * (1 - pr.p1) * (1 / pm.den(c) + 1 / pm.den(t))) : null,
  };
  const guardrails = (def.guardrails ?? []).map((g) => guardrailResult(g, GUARDRAIL_METRICS[g.metric], c, t));

  // Decision rule (fixed, in this order):
  //   sample ratio mismatch                      -> hold  (the data cannot be trusted)
  //   any guardrail breached                     -> stop
  //   primary significantly worse                -> stop
  //   primary not significant                    -> hold  (inconclusive)
  //   otherwise (significantly better, no breach) -> ship; guardrails whose interval straddles the tolerance are listed as "watch"
  const reasons = [];
  let action;
  const breached = guardrails.filter((g) => g.status === 'breach');
  const uncertain = guardrails.filter((g) => g.status === 'uncertain' || g.status === 'no_data');
  if (srm.flagged) {
    action = 'hold';
    reasons.push(`Sample ratio mismatch (chi-square p = ${srm.p.toExponential(2)}): users were not split ${def.variants.map((v) => v.weight).join('/')} as designed, so the comparison is not trustworthy. Fix assignment or logging first.`);
  } else if (breached.length) {
    action = 'stop';
    for (const g of breached) reasons.push(`Guardrail breached: ${g.label} rose by ${fmtDelta(g)} (95% CI lower bound is above the tolerance).`);
  } else if (primary.significant && primary.diff < 0) {
    action = 'stop';
    reasons.push(`${primary.label} fell significantly (p = ${primary.p_value.toFixed(4)}).`);
  } else if (!primary.significant) {
    action = 'hold';
    reasons.push(`${primary.label} did not change significantly (p = ${primary.p_value === null ? 'n/a' : primary.p_value.toFixed(4)}); the result is inconclusive.${primary.mde80 ? ` With this many users the test would reliably (80% of the time) detect a difference of about ${(primary.mde80 * 100).toFixed(2)} points or more, so a smaller effect could still be there.` : ''}`);
  } else {
    action = 'ship';
    reasons.push(`${primary.label} rose significantly (p = ${primary.p_value.toFixed(4)}) and no guardrail is breached.`);
    for (const g of uncertain) reasons.push(`Watch: ${g.label} is not shown to be within tolerance either way (95% interval straddles the limit); monitor it after rollout.`);
  }

  return {
    key: def.key,
    primary,
    srm,
    guardrails,
    exposure: { [ctrl]: c.n, [treat]: t.n, total: c.n + t.n },
    decision: { action, reasons, rule: 'ship only if the primary metric is significantly better, the sample ratio is healthy and no guardrail is breached; a breach or a significant drop in the primary metric = stop; anything else = hold' },
  };
}

function fmtDelta(g) {
  return g.tolerance.type === 'rel'
    ? `${(g.delta_relative * 100).toFixed(1)}% (tolerance +${(g.tolerance.value * 100).toFixed(0)}%)`
    : `${(g.delta * 100).toFixed(2)} pts (tolerance +${(g.tolerance.value * 100).toFixed(2)} pts)`;
}

export async function loadSummaries(pool, key) {
  const { rows } = await pool.query(
    `select variant, count(*)::int as n,
            count(*) filter (where accepted)::int as accepted,
            count(*) filter (where disbursed)::int as disbursed,
            count(*) filter (where defaulted)::int as defaulted,
            count(*) filter (where complained)::int as complaints,
            count(tat_seconds)::int as tat_n,
            percentile_cont(0.25) within group (order by tat_seconds)::float8 as tat_q1,
            percentile_cont(0.5) within group (order by tat_seconds)::float8 as tat_median,
            percentile_cont(0.75) within group (order by tat_seconds)::float8 as tat_q3
       from experiment_units where experiment_key = $1 group by variant`,
    [key],
  );
  return Object.fromEntries(rows.map((r) => [r.variant, r]));
}

export async function analyse(pool, def) {
  return analyseSummaries(def, await loadSummaries(pool, def.key));
}
