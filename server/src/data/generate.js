// Synthetic data generator for LoanLens. EVERYTHING produced here is fake and is_synthetic = true.
//
// It plays the journey forward in time with a seeded PRNG (same seed -> same data) and bakes in
// four known stories the RCA has to untangle:
//   1. 06 Oct  Android app v2.3 regression: KYC completion collapses on android only. Hotfix v2.3.1 on 08 Oct.
//   2. 13 Oct  Bureau slowdown 11:00-19:00 IST: x5 latency + timeouts -> users abandon while waiting for the offer.
//   3. 13 Oct  A harmless iOS copy release lands the same morning (decoy: affects no funnel step).
//   4. 29 Sep  Credit policy v2 tightens the FOIR cap 55% -> 50% (a step change in rejections, not a dip).
//
// Because we invent the applicants we also know who WOULD default (default_prob / would_default).
// A real lender never sees that for rejected applicants - label it as a synthetic advantage in any write-up.

import { mulberry32, gauss, clamp } from '../mock/random.js';
import { evaluate } from '../rules/engine.js';

const IST_MS = 19800000;
export const START = { y: 2026, m: 8, d: 10 }; // 10 Sep 2026 (month is 0-based)
export const DEFAULT_DAYS = 40; // 10 Sep .. 19 Oct

export const SCENARIOS = {
  androidRegression: { from: '2026-10-06T10:00:00+05:30', to: '2026-10-08T15:00:00+05:30', version: '2.3' },
  bureauSlowdown: { from: '2026-10-13T11:00:00+05:30', to: '2026-10-13T19:00:00+05:30' },
  ruleChange: { at: '2026-09-29T00:00:00+05:30' },
};

export const RELEASES = [
  { version: 'web 1.9', deployed_at: '2026-09-17T11:00:00+05:30', description: 'Dashboard layout refresh on the web app.', affects_step: null, affects_platform: 'web' },
  { version: 'android 2.3', deployed_at: SCENARIOS.androidRegression.from, description: 'New document-capture SDK for KYC on android.', affects_step: 'kyc_completed', affects_platform: 'android' },
  { version: 'android 2.3.1', deployed_at: SCENARIOS.androidRegression.to, description: 'Hotfix: reverts document-capture SDK change.', affects_step: 'kyc_completed', affects_platform: 'android' },
  { version: 'ios 5.2', deployed_at: '2026-10-13T09:00:00+05:30', description: 'Copy changes on the offer screen. No flow or API change.', affects_step: null, affects_platform: 'ios' },
];

// share of daily traffic by IST hour (sums to ~1)
const HOUR_W = [0.6, 0.3, 0.2, 0.2, 0.3, 0.8, 1.8, 3.5, 5, 6, 6.5, 6.5, 6.5, 6, 5.5, 5.5, 6, 6.5, 7, 7.5, 7.5, 6, 3.5, 1.5];
const HOUR_SUM = HOUR_W.reduce((a, b) => a + b, 0);
const DOW_W = [0.8, 1.0, 1.05, 1.05, 1.05, 1.0, 0.85]; // Sun..Sat

const pick = (rng, table) => {
  let r = rng();
  for (const [v, w] of table) {
    if ((r -= w) < 0) return v;
  }
  return table.at(-1)[0];
};
const logistic = (x) => 1 / (1 + Math.exp(-x));
const ms = (s) => new Date(s).getTime();

function poisson(rng, mean) {
  // normal approximation is fine at these volumes
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss(rng)));
}

function inWindow(t, w) {
  return t >= ms(w.from) && t < ms(w.to);
}

function rulesetFor(rulesets, t) {
  let cur = rulesets[0];
  for (const r of rulesets) if (ms(r.effective_from) <= t) cur = r;
  return cur;
}

/** Bureau attempt: returns { latency, status }. Nominal latency is recorded (not scaled). */
function bureauCall(rng, t) {
  const slow = inWindow(t, SCENARIOS.bureauSlowdown);
  const timeoutRate = slow ? 0.35 : 0.004;
  const errorRate = slow ? 0.03 : 0.004;
  const mult = slow ? 5 : 1;
  const r = rng();
  if (r < timeoutRate) return { latency: 6000, status: 'timeout' };
  if (r < timeoutRate + errorRate) return { latency: Math.round(300 + rng() * 400), status: 'error' };
  const latency = Math.round(900 * mult * Math.exp(0.35 * gauss(rng)));
  return { latency: Math.min(latency, 5900), status: 'ok' };
}

function kycCall(rng) {
  const r = rng();
  if (r < 0.003) return { latency: 6000, status: 'timeout' };
  return { latency: Math.round(1500 * Math.exp(0.3 * gauss(rng))), status: 'ok' };
}

export function generate({ seed = 20261020, days = DEFAULT_DAYS, perDay = 700, rulesets } = {}) {
  if (!rulesets?.length) throw new Error('generate() needs the rulesets (v1, v2)');
  const sorted = [...rulesets].sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
  const rng = mulberry32(seed);
  const apps = [];
  const events = [];
  const apiCalls = [];
  let appId = 0;

  for (let d = 0; d < days; d++) {
    const dayStart = Date.UTC(START.y, START.m, START.d + d) - IST_MS;
    const dow = new Date(dayStart + IST_MS).getUTCDay();
    const dayCount = poisson(rng, perDay * DOW_W[dow]);
    for (let h = 0; h < 24; h++) {
      const n = poisson(rng, (dayCount * HOUR_W[h]) / HOUR_SUM);
      for (let i = 0; i < n; i++) {
        const t0 = dayStart + h * 3600000 + Math.floor(rng() * 3600000);
        simulateApplication(t0);
      }
    }
  }

  function addEvent(id, type, t, props = {}) {
    events.push({ application_id: id, event_type: type, ts: new Date(t), props });
  }

  function simulateApplication(t0) {
    const id = ++appId;
    const device = pick(rng, [['android', 0.6], ['ios', 0.25], ['web', 0.15]]);
    const channel = pick(rng, [['organic', 0.45], ['paid', 0.3], ['partner', 0.25]]);
    const inRegression = device === 'android' && t0 >= ms(SCENARIOS.androidRegression.from) && t0 < ms(SCENARIOS.androidRegression.to);
    let appVersion = 'web';
    if (device === 'android') appVersion = inRegression ? '2.3' : t0 >= ms(SCENARIOS.androidRegression.to) ? '2.3.1' : '2.2';
    if (device === 'ios') appVersion = t0 >= ms('2026-10-13T09:00:00+05:30') ? '5.2' : '5.1';
    const employment = rng() < 0.7 ? 'salaried' : 'self_employed';
    const newToCredit = rng() < 0.12;
    const age = Math.round(clamp(34 + 7 * gauss(rng), 19, 62));
    const income = Math.round(clamp(Math.exp(Math.log(48000) + 0.55 * gauss(rng)), 12000, 400000) / 500) * 500;
    const existingEmi = rng() < 0.55 ? Math.round((income * (0.03 + rng() * 0.27)) / 100) * 100 : 0;
    const requested = Math.round((income * (2.5 + rng() * 7)) / 5000) * 5000;
    const tenure = pick(rng, [[12, 0.15], [24, 0.25], [36, 0.35], [48, 0.15], [60, 0.1]]);
    const latent = Math.round(clamp((newToCredit ? 665 : 722) + (newToCredit ? 45 : 62) * gauss(rng), 450, 840));

    const rs = rulesetFor(sorted, t0);
    const cfg = rs.config;
    const base = {
      age, monthly_income: income, existing_emi: existingEmi, requested_amount: requested,
      tenure_months: tenure, employment, new_to_credit: newToCredit,
    };
    // synthetic ground truth: who would default, independent of what the rules decide
    const full = evaluate({ ...base, credit_score: latent }, cfg, { stage: 'credit' });
    const defaultProb = clamp(logistic(-3.4 + ((700 - latent) / 60) * 0.9 + (full.derived.foir - 0.35) * 3 + (employment === 'self_employed' ? 0.3 : 0) + (newToCredit ? 0.4 : 0)), 0.002, 0.9);
    const wouldDefault = rng() < defaultProb;

    const app = {
      id, created_at: new Date(t0), channel, device, app_version: appVersion, age, employment,
      monthly_income: income, existing_emi: existingEmi, new_to_credit: newToCredit,
      requested_amount: requested, tenure_months: tenure, credit_score: null, bureau_score_latent: latent,
      decision: null, reason_codes: [], rule_version: rs.version, offered_amount: null, offered_rate: null,
      offered_emi: null, variant: null, default_prob: Number(defaultProb.toFixed(4)), would_default: wouldDefault, is_synthetic: true,
    };
    apps.push(app);
    addEvent(id, 'application_started', t0, { channel, device, app_version: appVersion });

    // --- KYC ---
    const kyc = kycCall(rng);
    apiCalls.push({ application_id: id, provider: 'kyc', ts: new Date(t0 + 20000), latency_ms: kyc.latency, status: kyc.status });
    let pKyc = 0.84;
    if (inRegression) pKyc = 0.42;
    if (kyc.status === 'timeout') pKyc *= 0.6;
    if (channel === 'paid') pKyc -= 0.03;
    if (rng() >= pKyc) {
      const reason = inRegression ? (rng() < 0.7 ? 'document_capture_error' : 'abandoned') : pick(rng, [['abandoned', 0.8], ['document_mismatch', 0.2]]);
      if (reason !== 'abandoned') addEvent(id, 'kyc_failed', t0 + 60000 + rng() * 120000, { reason });
      return;
    }
    const tKyc = t0 + 40000 + kyc.latency + rng() * 150000;
    addEvent(id, 'kyc_completed', tKyc, {});

    // --- prescreen (age / income) ---
    const pre = evaluate({ ...base, credit_score: null }, cfg, { stage: 'prescreen' });
    const tElig = tKyc + 1500;
    if (pre.decision === 'reject') {
      app.decision = 'reject';
      app.reason_codes = pre.reasonCodes;
      addEvent(id, 'application_rejected', tElig, { stage: 'prescreen', reasons: pre.reasonCodes });
      return;
    }
    addEvent(id, 'eligibility_passed', tElig, {});

    // --- bureau pull (+ one retry), then the user waits for the offer ---
    let tCall = tElig + 800;
    let b = bureauCall(rng, tCall);
    apiCalls.push({ application_id: id, provider: 'bureau', ts: new Date(tCall), latency_ms: b.latency, status: b.status });
    let wait = b.latency;
    if (b.status !== 'ok') {
      tCall += b.latency;
      b = bureauCall(rng, tCall);
      apiCalls.push({ application_id: id, provider: 'bureau', ts: new Date(tCall), latency_ms: b.latency, status: b.status });
      wait += b.latency;
    }
    const pAbandonWait = clamp(0.03 + (wait - 2500) / 10000, 0.03, 0.75);
    if (rng() < pAbandonWait) return; // gave up waiting; no event is emitted for a silent exit
    const tOffer = tElig + 800 + wait;

    const score = b.status === 'ok' ? latent : null;
    app.credit_score = score;
    const credit = evaluate({ ...base, credit_score: score }, cfg, { stage: 'credit' });
    app.decision = credit.decision;
    app.reason_codes = credit.reasonCodes;
    if (credit.decision === 'reject') {
      addEvent(id, 'application_rejected', tOffer, { stage: 'credit', reasons: credit.reasonCodes });
      return;
    }
    let tView = tOffer;
    if (credit.decision === 'refer') {
      addEvent(id, 'manual_review_started', tOffer, { reasons: credit.reasonCodes });
      if (rng() >= 0.3) return; // most referred cases do not come back
      tView = tOffer + (2 + rng() * 22) * 3600000; // reviewed within a day
    }
    // For referred cases the offer is built from the observed (or fallback) score
    const d = credit.derived;
    app.offered_amount = d.offered_amount;
    app.offered_rate = d.rate;
    app.offered_emi = Math.round(d.offered_emi);
    addEvent(id, 'offer_viewed', tView, { offered_amount: d.offered_amount, rate: d.rate });

    // --- accept & disburse ---
    const pAccept = clamp(0.62 - (d.rate - 0.11) * 3 - (d.offered_amount < requested ? 0.08 : 0), 0.2, 0.8);
    if (rng() >= pAccept) return;
    const tAcc = tView + 20000 + rng() * 280000;
    addEvent(id, 'offer_accepted', tAcc, {});
    if (rng() < 0.93) addEvent(id, 'loan_disbursed', tAcc + 30000 + rng() * 60000, { amount: d.offered_amount });
  }

  return { apps, events, apiCalls, releases: RELEASES };
}
