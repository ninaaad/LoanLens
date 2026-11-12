// Root-cause analysis for a funnel drop.
// For one (day, step) it asks: how much of the drop would disappear if each suspected cause had not happened?
// Each hypothesis gets a counterfactual "share of the drop explained" (0..1) and the evidence behind it.
// Hypotheses are scored independently (they can overlap), then ranked. No LLM is involved in the numbers.
import { STEPS, STEP_LABEL, loadApps, istDay, addDays, dayStart } from './data.js';
import { evaluate } from '../rules/engine.js';
import { getLlm } from '../llm/index.js';

const WINDOW = 14;
const MIN_LOST = 3; // fewer lost conversions than this is not a drop worth explaining
const MIN_Z = 2; // and a drop this small relative to its noise is not either
const share = (rows, step) => (rows.length ? rows.filter((r) => r[step]).length / rows.length : null);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
function zTwo(p1, n1, p2, n2) {
  if (!n1 || !n2) return 0;
  const p = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : 0;
}
const verdict = (s) => (s >= 0.5 ? 'likely' : s >= 0.15 ? 'possible' : 'ruled out');

function decompose(rows, step) {
  const n = rows.length || 1;
  const conv = rows.filter((r) => r[step]).length;
  const rej = rows.filter((r) => !r[step] && r.rejected).length;
  const ref = rows.filter((r) => !r[step] && !r.rejected && r.referred).length;
  const gone = n - conv - rej - ref;
  return { converted: conv / n, rejected: rej / n, sent_to_manual_review: ref / n, abandoned: gone / n };
}

// ---------- hypothesis: provider API latency / errors ----------
async function apiHypothesis(pool, ctx) {
  const { step, day, today, base, lost } = ctx;
  const provider = step === 'kyc_completed' ? 'kyc' : step === 'offer_viewed' ? 'bureau' : null;
  const out = { id: 'api_latency', type: 'API latency', title: provider ? `${provider} API slowdown` : 'Provider API', score: 0, evidence: [] };
  if (!provider) {
    out.evidence.push('No provider call sits between these two steps.');
    return out;
  }
  const field = provider === 'bureau' ? 'bureau_wait' : 'kyc_wait';
  const baseWaits = base.map((r) => r[field]).filter((x) => x > 0);
  const thr = Math.max(quantile(baseWaits, 0.95) ?? 0, 1) * 1.2;
  const dayEnd = addDays(day, 1);
  const { rows: calls } = await pool.query(
    `select (ts at time zone 'Asia/Kolkata')::date::text d, extract(hour from ts at time zone 'Asia/Kolkata')::int h,
            count(*)::int n, percentile_cont(0.95) within group (order by latency_ms) p95, count(*) filter (where status <> 'ok')::int bad
       from api_calls where provider = $1 and ts >= $2 and ts < $3 group by 1, 2 order by 1, 2`,
    [provider, dayStart(addDays(day, -WINDOW)), dayStart(dayEnd)],
  );
  const baseCalls = calls.filter((c) => c.d < day);
  const dayCalls = calls.filter((c) => c.d === day);
  const baseP95 = quantile(baseCalls.map((c) => Number(c.p95)), 0.5);
  const badBase = baseCalls.reduce((a, c) => a + c.bad, 0) / Math.max(1, baseCalls.reduce((a, c) => a + c.n, 0));
  const degraded = dayCalls.filter((c) => c.n >= 15 && Number(c.p95) > 2 * baseP95);
  const hot = today.filter((r) => r[field] > thr);
  const cold = today.filter((r) => r[field] <= thr);
  out.timeline = dayCalls.map((c) => ({ hour: c.h, p95_ms: Math.round(Number(c.p95)), calls: c.n, failed: c.bad }));
  out.details = { provider, baseline_p95_ms: Math.round(baseP95 ?? 0), threshold_ms: Math.round(thr), degraded_hours: degraded.map((c) => c.h) };
  if (degraded.length) {
    const hs = degraded.map((c) => c.h);
    out.evidence.push(`${provider} p95 latency ran above 2x its ${Math.round(baseP95)} ms baseline in ${degraded.length} hour(s): ${Math.min(...hs)}:00 to ${Math.max(...hs) + 1}:00 IST (peak ${Math.round(Math.max(...degraded.map((c) => Number(c.p95))))} ms).`);
  } else {
    out.evidence.push(`${provider} p95 latency stayed within 2x of its ${Math.round(baseP95 ?? 0)} ms baseline all day.`);
  }
  const badToday = dayCalls.reduce((a, c) => a + c.bad, 0) / Math.max(1, dayCalls.reduce((a, c) => a + c.n, 0));
  out.evidence.push(`${provider} call failure rate ${pct(badToday)} today vs ${pct(badBase)} baseline.`);
  if (hot.length >= 20 && cold.length >= 20) {
    const pHot = share(hot, step), pCold = share(cold, step);
    const z = zTwo(pCold, cold.length, pHot, hot.length);
    out.evidence.push(`${hot.length} applications (${pct(hot.length / today.length, 0)}) waited longer than ${Math.round(thr)} ms; they converted at ${pct(pHot)} vs ${pct(pCold)} for the rest (dose-response check).`);
    if (z >= 2.5 && lost > 0) out.score = clamp01((hot.length * (pCold - pHot)) / lost);
  }
  return out;
}

// ---------- hypothesis: app release ----------
async function releaseHypotheses(pool, ctx) {
  const { day, step, today, base, lost } = ctx;
  const { rows: rels } = await pool.query('select * from releases where deployed_at >= $1 and deployed_at < $2 order by deployed_at', [dayStart(addDays(day, -WINDOW)), dayStart(addDays(day, 1))]);
  const { rows: allRels } = await pool.query('select * from releases order by deployed_at');
  const out = [];
  for (const rel of rels) {
    const dep = new Date(rel.deployed_at).getTime();
    const next = allRels.find((x) => x.affects_platform === rel.affects_platform && new Date(x.deployed_at).getTime() > dep);
    const end = next ? new Date(next.deployed_at).getTime() : Infinity;
    const plat = rel.affects_platform;
    const aff = today.filter((r) => r.device === plat && r.created_at.getTime() >= dep && r.created_at.getTime() < end);
    const hyp = { id: `release_${rel.version.replace(/\W+/g, '_')}`, type: 'Release', title: `Release ${rel.version}`, score: 0, evidence: [], release: rel };
    const declared = rel.affects_step ? `declared impact: ${STEP_LABEL[rel.affects_step] ?? rel.affects_step}${plat ? ` on ${plat}` : ''}` : 'release notes declare no funnel step';
    hyp.evidence.push(`${rel.version} deployed ${istDay(rel.deployed_at)} ${new Date(dep + 19800000).toISOString().slice(11, 16)} IST (${declared}).`);
    if (aff.length < 30) {
      hyp.evidence.push(`Only ${aff.length} applications on ${plat} were on this build today, too few to judge.`);
    } else {
      const pre = base.filter((r) => r.device === plat && r.created_at.getTime() < dep);
      const ctrlBase = base.filter((r) => r.device !== plat), ctrlToday = today.filter((r) => r.device !== plat);
      const pPre = share(pre, step), pAff = share(aff, step);
      const drift = (share(ctrlToday, step) ?? 0) - (share(ctrlBase, step) ?? 0); // what happened to platforms without the release
      const expected = pPre + drift;
      const z = zTwo(expected, aff.length, pAff, aff.length);
      hyp.evidence.push(`${plat} users on the new build converted at ${pct(pAff)}; expected ${pct(expected)} (their pre-release rate ${pct(pPre)}, adjusted by ${drift >= 0 ? '+' : ''}${pct(drift)} seen on other platforms).`);
      if (z >= 2.5 && lost > 0) hyp.score = clamp01((aff.length * (expected - pAff)) / lost);
      // A release that says it touches a different step is a weaker suspect for a drop at this one: platform differences can arise by
      // chance when a shared shock (a slow bureau) happens to hit one platform harder. Its score counts half.
      if (hyp.score > 0 && rel.affects_step && rel.affects_step !== step) {
        hyp.evidence.push(`Its notes declare an impact on ${STEP_LABEL[rel.affects_step] ?? rel.affects_step}, not on this step, so its score is halved.`);
        hyp.score /= 2;
      }
      if (hyp.score === 0) hyp.evidence.push('No significant difference vs expectation.');
    }
    out.push(hyp);
  }
  return out;
}

// ---------- hypothesis: credit policy (rules) change ----------
async function ruleHypotheses(pool, ctx) {
  const { day, step, today, base, lost } = ctx;
  const stage = step === 'offer_viewed' ? 'credit' : step === 'eligibility_passed' ? 'prescreen' : null;
  const { rows: all } = await pool.query('select version, effective_from, note, config from rule_versions order by effective_from');
  const out = [];
  for (let i = 1; i < all.length; i++) {
    const cur = all[i], prev = all[i - 1];
    const eff = new Date(cur.effective_from).getTime();
    if (eff < dayStart(addDays(day, -WINDOW)).getTime() || eff >= dayStart(addDays(day, 1)).getTime()) continue;
    const hyp = { id: `rule_${cur.version}`, type: 'Rule change', title: `Credit policy ${prev.version} -> ${cur.version}`, score: 0, evidence: [], ruleVersion: cur.version };
    hyp.evidence.push(`Policy ${cur.version} took effect ${istDay(cur.effective_from)}: ${cur.note}`);
    if (!stage) {
      hyp.evidence.push('Credit rules do not act between these two steps.');
      out.push(hyp);
      continue;
    }
    const asApp = (r) => ({ ...r, monthly_income: Number(r.monthly_income), existing_emi: Number(r.existing_emi), requested_amount: Number(r.requested_amount) });
    const blockedByNew = (rows) => {
      let k = 0;
      for (const r of rows) {
        if (stage === 'credit' && r.credit_score == null) continue;
        const a = asApp(r);
        const o = evaluate(a, prev.config, { stage }).decision;
        const n = evaluate(a, cur.config, { stage }).decision;
        if (o === 'approve' && n !== 'approve') k++;
      }
      return rows.length ? k / rows.length : 0;
    };
    const appliedShare = (rows) => (rows.length ? rows.filter((r) => new Date(r.created_at).getTime() >= eff).length / rows.length : 0);
    const effToday = appliedShare(today) * blockedByNew(today);
    const effBase = appliedShare(base) * blockedByNew(base);
    const delta = effToday - effBase;
    const approved = base.filter((r) => r.decision === 'approve');
    const cAppr = approved.length ? approved.filter((r) => r[step]).length / approved.length : 0.6;
    hyp.evidence.push(`Replaying today's applications under ${prev.version}: ${pct(effToday)} of them are blocked only because of ${cur.version} (the baseline period had ${pct(effBase)}).`);
    if (delta >= 0.01 && lost > 0) hyp.score = clamp01((delta * cAppr * today.length) / lost);
    else hyp.evidence.push('The policy change adds no new blocking compared with the baseline period.');
    out.push(hyp);
  }
  return out;
}

// ---------- hypothesis: traffic mix shift ----------
function mixHypothesis(ctx) {
  const { step, today, base, lost } = ctx;
  const hyp = { id: 'traffic_mix', type: 'Traffic mix', title: 'Shift in who is applying', score: 0, evidence: [] };
  const baseRate = share(base, step);
  let best = null;
  for (const dim of ['device', 'channel', 'employment', 'new_to_credit']) {
    const segs = new Set(base.map((r) => String(r[dim])));
    let expected = 0;
    for (const s of segs) {
      const b = base.filter((r) => String(r[dim]) === s);
      const t = today.filter((r) => String(r[dim]) === s);
      expected += (t.length / today.length) * (share(b, step) ?? baseRate);
    }
    const effect = baseRate - expected;
    if (!best || effect > best.effect) best = { dim, effect };
  }
  hyp.evidence.push(`Re-weighting baseline conversion by today's mix (best-fitting dimension: ${best.dim}) moves the expected rate by ${pct(-best.effect, 2)}.`);
  if (best.effect > 0.005 && lost > 0) hyp.score = clamp01((best.effect * today.length) / lost);
  return hyp;
}

export async function rca(pool, { day, step }) {
  const idx = STEPS.indexOf(step);
  if (idx < 1) throw new Error(`step must be one of ${STEPS.slice(1).join(', ')}`);
  const prev = STEPS[idx - 1];
  const rows = await loadApps(pool, addDays(day, -WINDOW), addDays(day, 1));
  const today = rows.filter((r) => r.day === day && r[prev]);
  const base = rows.filter((r) => r.day < day && r[prev]);
  if (today.length < 30 || base.length < 100) throw new Error('not enough data around that day');
  const rate = share(today, step), baseRate = share(base, step);
  const lost = (baseRate - rate) * today.length;
  const ctx = { pool, day, step, prev, today, base, lost };

  // Is there a drop worth explaining? Without this, a day that is 0.1 points below baseline gets "100% explained" by whichever
  // cause happens to be positive, because the score is a share of a tiny denominator.
  const zDrop = zTwo(baseRate, base.length, rate, today.length);
  const significant = lost >= MIN_LOST && zDrop >= MIN_Z;
  const hypotheses = [
    await apiHypothesis(pool, ctx),
    ...(await releaseHypotheses(pool, ctx)),
    ...(await ruleHypotheses(pool, ctx)),
    mixHypothesis(ctx),
  ];
  for (const h of hypotheses) {
    if (!significant) {
      if (h.score > 0) h.evidence.push(`Would have scored ${pct(h.score, 0)}, but the day's change is within normal variation, so it is not scored.`);
      h.score = 0;
    }
    h.score = Number(h.score.toFixed(3));
    h.verdict = verdict(h.score);
  }
  hypotheses.sort((a, b) => b.score - a.score);

  const result = {
    day, step, label: STEP_LABEL[step], from_step: STEP_LABEL[prev],
    observed: { rate, baseline_rate: baseRate, applications: today.length, lost_conversions: Math.round(lost), drop_z: Number(zDrop.toFixed(2)), significant },
    decomposition: { today: decompose(today, step), baseline: decompose(base, step) },
    hypotheses,
    caveat: 'Scores are counterfactual shares of the drop explained by each cause on its own; they can overlap, so they need not sum to 1. This is correlation under a modelled counterfactual, not proof of causation.',
  };
  const template = narrate(result);
  const top = hypotheses[0];
  const phrased = await getLlm().summarise(
    {
      facts: [template, ...hypotheses.filter((h) => h.score >= 0.15).flatMap((h) => h.evidence)].join('\n'),
      template,
      must: top && top.score >= 0.15 ? [top.title] : [],
    },
    'Rewrite this root-cause note for a product manager in at most 5 plain sentences. Keep the most likely cause, its share of the drop and what was ruled out.',
  );
  result.narrative = phrased.text;
  result.narrative_mode = phrased.mode;
  return result;
}

export function narrate(r) {
  const o = r.observed;
  if (o.significant === false) {
    return `On ${r.day}, conversion from "${r.from_step}" to "${r.label}" was ${pct(o.rate)} against a ${pct(o.baseline_rate)} baseline (about ${Math.abs(o.lost_conversions)} ${o.lost_conversions >= 0 ? 'fewer' : 'more'} conversions out of ${o.applications}). That is within normal day-to-day variation (z = ${o.drop_z}), so no cause is scored.`;
  }
  const dir = o.rate < o.baseline_rate ? 'fell' : 'rose';
  const top = r.hypotheses[0];
  const dTod = r.decomposition.today, dBase = r.decomposition.baseline;
  const biggest = ['abandoned', 'rejected', 'sent_to_manual_review']
    .map((k) => ({ k, d: dTod[k] - dBase[k] }))
    .sort((a, b) => b.d - a.d)[0];
  const lines = [
    `On ${r.day}, conversion from "${r.from_step}" to "${r.label}" ${dir} to ${pct(o.rate)} from a ${pct(o.baseline_rate)} baseline (about ${Math.abs(o.lost_conversions)} ${o.lost_conversions >= 0 ? 'fewer' : 'more'} conversions out of ${o.applications}).`,
  ];
  if (o.rate < o.baseline_rate) lines.push(`Most of the change is in ${biggest.k.replace(/_/g, ' ')} (${biggest.d >= 0 ? '+' : ''}${(biggest.d * 100).toFixed(1)} percentage points of applicants).`);
  if (top && top.score >= 0.15) {
    lines.push(`Most likely cause: ${top.title} (${top.type.toLowerCase()}), which on its own explains about ${pct(top.score, 0)} of the drop.`);
    lines.push(`Evidence: ${top.evidence.slice(0, 2).join(' ')}`);
    const others = r.hypotheses.slice(1).filter((h) => h.score >= 0.15);
    if (others.length) lines.push(`Also contributing: ${others.map((h) => `${h.title} (${pct(h.score, 0)})`).join('; ')}.`);
  } else {
    lines.push('No hypothesis explains a meaningful share of the change; treat it as noise unless it persists.');
  }
  const ruledOut = r.hypotheses.filter((h) => h.verdict === 'ruled out').map((h) => h.title);
  if (ruledOut.length) lines.push(`Checked and ruled out: ${ruledOut.join('; ')}.`);
  return lines.join(' ');
}
