import { STEPS, STEP_LABEL, loadApps, dataRange, addDays } from './data.js';

export const SEGMENTS = ['device', 'channel', 'employment', 'new_to_credit', 'app_version'];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Counts reached per step, plus exits, for a set of application rows. */
export function countSteps(rows) {
  const c = Object.fromEntries(STEPS.map((s) => [s, 0]));
  let rejected = 0, referred = 0;
  const tats = [];
  for (const r of rows) {
    for (const s of STEPS) if (r[s]) c[s]++;
    if (r.rejected) rejected++;
    if (r.referred) referred++;
    if (r.tat_seconds != null) tats.push(Number(r.tat_seconds));
  }
  return { counts: c, rejected, referred, median_tat_seconds: median(tats) };
}

/** Conditional conversion into each step (step / previous step). */
export function conversions(counts) {
  const out = {};
  for (let i = 1; i < STEPS.length; i++) {
    const prev = counts[STEPS[i - 1]];
    out[STEPS[i]] = prev > 0 ? counts[STEPS[i]] / prev : null;
  }
  out.overall = counts.application_started > 0 ? counts.loan_disbursed / counts.application_started : null;
  return out;
}

export function funnelByDay(rows) {
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  return [...byDay.keys()].sort().map((day) => {
    const f = countSteps(byDay.get(day));
    return { day, ...f, conversion: conversions(f.counts) };
  });
}

export function segmentBreakdown(rows, segment) {
  if (!SEGMENTS.includes(segment)) throw new Error(`unknown segment ${segment}`);
  const g = new Map();
  for (const r of rows) {
    const k = String(r[segment]);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(r);
  }
  return [...g.entries()].map(([value, rs]) => {
    const f = countSteps(rs);
    return { value, ...f, conversion: conversions(f.counts) };
  }).sort((a, b) => b.counts.application_started - a.counts.application_started);
}

/** Overall funnel for a date range [from, to] inclusive, optional segment filter. */
export async function funnel(pool, { from, to, segment, value } = {}) {
  const range = await dataRange(pool);
  if (!range) return { range: null, days: [], total: null, steps: STEPS.map((s) => ({ step: s, label: STEP_LABEL[s] })) };
  const f = from ?? range.first;
  const t = to ?? range.last;
  let rows = await loadApps(pool, f, addDays(t, 1));
  if (segment && value !== undefined) rows = rows.filter((r) => String(r[segment]) === String(value));
  const total = countSteps(rows);
  return {
    range, from: f, to: t,
    steps: STEPS.map((s) => ({ step: s, label: STEP_LABEL[s] })),
    days: funnelByDay(rows),
    total: { ...total, conversion: conversions(total.counts) },
    segments: segment ? undefined : Object.fromEntries(SEGMENTS.map((s) => [s, segmentBreakdown(rows, s)])),
  };
}
