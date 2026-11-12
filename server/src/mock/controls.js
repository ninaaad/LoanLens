// Incident injection for the demo: validated patches to the mock bureau / KYC behaviour, named scenarios, and a
// status view of what the live journeys actually recorded (api_calls, BUREAU_UNAVAILABLE referrals).
import express from 'express';
import { mockState, defaults, resetMock } from './state.js';
import { wrap } from '../journey/routes.js';
import { HttpError } from '../journey/service.js';

const num = (min, max) => (v) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const RULES = {
  multiplier: { ok: num(0.1, 50), msg: 'a number from 0.1 to 50 (latency multiplier)' },
  errorRate: { ok: num(0, 1), msg: 'a number from 0 to 1' },
  timeoutRate: { ok: num(0, 1), msg: 'a number from 0 to 1' },
  baseMs: { ok: num(1, 60000), msg: 'a number of milliseconds from 1 to 60000' },
  forceScore: { ok: (v) => v === null || (Number.isInteger(v) && v >= 300 && v <= 900), msg: 'null or an integer from 300 to 900', only: 'bureau' },
  forceVerified: { ok: (v) => v === null || typeof v === 'boolean', msg: 'null, true or false', only: 'kyc' },
};

/** Validate and apply a patch to one provider. Throws HttpError(400) and changes nothing if any field is invalid. */
export function applyPatch(provider, patch) {
  if (!['bureau', 'kyc'].includes(provider)) throw new HttpError(400, 'provider must be bureau or kyc');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new HttpError(400, 'send at least one setting to change');
  for (const [k, v] of Object.entries(patch)) {
    const rule = RULES[k];
    if (!rule) throw new HttpError(400, `unknown setting "${k}"; allowed: ${Object.keys(RULES).join(', ')}`);
    if (rule.only && rule.only !== provider) throw new HttpError(400, `"${k}" only applies to ${rule.only}`);
    if (!rule.ok(v)) throw new HttpError(400, `${k} must be ${rule.msg}`);
  }
  Object.assign(mockState[provider], patch);
  return mockState;
}

// Each scenario resets the provider(s) it touches to nominal behaviour first, then applies its settings.
export const SCENARIOS = {
  normal: { description: 'Nominal behaviour for both providers.', apply: () => resetMock() },
  bureau_slowdown: {
    description: 'Bureau 5x slower with 35% timeouts and 3% errors (the seeded 13 Oct incident shape).',
    apply: () => { mockState.bureau = { ...defaults().bureau, multiplier: 5, timeoutRate: 0.35, errorRate: 0.03 }; },
  },
  bureau_outage: {
    description: 'Bureau returns an error on every call, so every journey falls back to manual review.',
    apply: () => { mockState.bureau = { ...defaults().bureau, errorRate: 1 }; },
  },
  kyc_slowdown: {
    description: 'KYC 4x slower with 20% timeouts.',
    apply: () => { mockState.kyc = { ...defaults().kyc, multiplier: 4, timeoutRate: 0.2 }; },
  },
  kyc_outage: {
    description: 'KYC returns an error on every call, so nobody can complete KYC.',
    apply: () => { mockState.kyc = { ...defaults().kyc, errorRate: 1 }; },
  },
};

export async function status(pool, minutes) {
  const { rows: calls } = await pool.query(
    `select provider, count(*)::int as calls,
            count(*) filter (where status = 'ok')::int as ok,
            count(*) filter (where status = 'timeout')::int as timeouts,
            count(*) filter (where status not in ('ok', 'timeout'))::int as errors,
            round(percentile_cont(0.5) within group (order by latency_ms)::numeric)::int as p50_ms,
            round(percentile_cont(0.95) within group (order by latency_ms)::numeric)::int as p95_ms
       from api_calls where ts >= now() - ($1 || ' minutes')::interval group by provider order by provider`,
    [String(minutes)],
  );
  const { rows: apps } = await pool.query(
    `select count(*)::int as applications,
            count(*) filter (where 'BUREAU_UNAVAILABLE' = any(reason_codes))::int as bureau_unavailable_referrals
       from applications where created_at >= now() - ($1 || ' minutes')::interval`,
    [String(minutes)],
  );
  return { window_minutes: minutes, providers: calls, ...apps[0] };
}

export function mockControlRouter(pool) {
  const r = express.Router();

  r.get('/status', wrap(async (req, res) => {
    const minutes = Number(req.query.minutes ?? 15);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, 'minutes must be a number from 1 to 1440');
    res.json({
      config: mockState,
      recorded: await status(pool, minutes),
      scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.description])),
      notice: 'Mock providers only. Recorded rows come from journeys run through the API; applicants are fabricated.',
    });
  }));

  r.post('/config', wrap(async (req, res) => {
    const { provider, ...patch } = req.body ?? {};
    res.json(applyPatch(provider, patch));
  }));

  r.post('/scenarios/:name', wrap(async (req, res) => {
    const s = SCENARIOS[req.params.name];
    if (!s) throw new HttpError(404, `unknown scenario "${req.params.name}"; use ${Object.keys(SCENARIOS).join(', ')}`);
    s.apply();
    res.json({ scenario: req.params.name, description: s.description, config: mockState });
  }));

  return r;
}
