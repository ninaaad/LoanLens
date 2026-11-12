// Small shared helpers: API client, formatting, hash routing. No UI here, so it is easy to unit-test.

export async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the LoanLens API. Is it running? (npm run dev:api)');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (!res.ok) {
    // a dev-server proxy or load balancer answers 5xx with plain text when the API behind it is not running
    if (data === null && res.status >= 500) {
      const err = new Error('The LoanLens API is not responding. If you started the website on its own, start the API as well (npm run dev starts both).');
      err.status = res.status;
      throw err;
    }
    const msg = data?.error ?? (Array.isArray(data?.errors) ? data.errors.join('; ') : null) ?? `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}
export const get = (url) => api('GET', url);
export const post = (url, body) => api('POST', url, body ?? {});

export const pct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);
export const pts = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)} pts`);
export const int = (x) => (x === null || x === undefined ? 'n/a' : Math.round(x).toLocaleString('en-IN'));
export const inr = (x) => (x === null || x === undefined ? 'n/a' : `₹${Math.round(x).toLocaleString('en-IN')}`);
export const ms = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x).toLocaleString('en-IN')} ms`);
// durations read best in the unit that keeps them above 1: 357 s is "6.0 min", not "0.1 h"
export const hours = (s) => {
  if (s === null || s === undefined) return 'n/a';
  const a = Math.abs(s);
  if (a < 90) return `${Math.round(s)} s`;
  if (a < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
};
export const signed = (x, d = 0) => (x === null || x === undefined ? 'n/a' : `${x > 0 ? '+' : ''}${Number(x).toFixed(d)}`);

/** Calendar day (YYYY-MM-DD) in IST for an ISO timestamp, matching the server's day buckets. */
export const istDay = (iso) => new Date(new Date(iso).getTime() + 19800000).toISOString().slice(0, 10);
export const shortDay = (day) => {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]}`;
};

/** "#/workbench/rca?day=2026-10-13&step=offer_viewed" -> { page, tab, params } */
export function parseRoute(hash) {
  const raw = (hash ?? '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { page: parts[0] ?? 'journey', tab: parts[1] ?? null, params: Object.fromEntries(new URLSearchParams(query)) };
}
export function routeHref(page, tab, params) {
  const q = params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '';
  return `#/${page}${tab ? `/${tab}` : ''}${q}`;
}

export const STEP_LABEL = {
  application_started: 'Application started',
  kyc_completed: 'KYC completed',
  eligibility_passed: 'Eligibility passed',
  offer_viewed: 'Offer viewed',
  offer_accepted: 'Offer accepted',
  loan_disbursed: 'Loan disbursed',
};

/** Build the simulate request: only the fields that differ from the baseline are sent as overrides. */
export function buildCandidate(baseVersion, baseConfig, form) {
  const rules = {};
  const rule = (id) => baseConfig.rules.find((r) => r.id === id);
  for (const [id, value] of Object.entries(form.rules)) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${id} must be a number`);
    if (rule(id) && rule(id).value !== n) rules[id] = { value: n };
  }
  const overrides = {};
  if (Object.keys(rules).length) overrides.rules = rules;
  const mult = Number(form.maxLoanIncomeMultiple);
  if (!Number.isFinite(mult) || mult <= 0) throw new Error('max loan multiple must be a positive number');
  if (mult !== baseConfig.maxLoanIncomeMultiple) overrides.maxLoanIncomeMultiple = mult;
  return { base: baseVersion, overrides };
}

/**
 * Insert an empty entry for every calendar day missing between the first and last day, so a chart shows a gap instead of a line
 * drawn straight across it (live journeys can land weeks after the seeded data).
 */
export function fillDays(days) {
  if (days.length < 2) return days;
  const out = [];
  const step = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (let d = days[0].day; d <= days[days.length - 1].day; d = step(d)) {
    out.push(byDay.get(d) ?? { day: d, counts: {}, conversion: {}, gap: true });
  }
  return out;
}
