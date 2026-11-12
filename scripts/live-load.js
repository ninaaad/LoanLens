#!/usr/bin/env node
// Sends fabricated journeys through the real LoanLens API so a PM can inject a provider incident live and watch
// new api_calls rows, latency and BUREAU_UNAVAILABLE referrals appear. All applicants are made up.
//
//   node scripts/live-load.js --n 200 --concurrency 4
//   node scripts/live-load.js --n 300 --scenario bureau_slowdown --from 100 --to 200     (inject, then recover)
//
// Options: --base URL (default http://localhost:4000)  --n journeys  --concurrency  --delay-ms between starts
//          --seed  --scenario NAME --from I --to J (journey indexes; scenario is switched on at I and back to normal at J)
import { mulberry32, gauss, clamp } from '../server/src/mock/random.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const base = (args.base ?? 'http://localhost:4000').replace(/\/$/, '');
const N = Number(args.n ?? 100);
const CONC = Number(args.concurrency ?? 4);
const DELAY = Number(args['delay-ms'] ?? 0);
const SEED = Number(args.seed ?? Date.now() % 1e9);
const SCENARIO = args.scenario;
const FROM = Number(args.from ?? 0);
const TO = args.to === undefined ? Infinity : Number(args.to);
if (![N, CONC, DELAY, SEED].every(Number.isFinite) || N < 1 || CONC < 1) {
  console.error('--n and --concurrency must be positive numbers');
  process.exit(2);
}

const rng = mulberry32(SEED);
const pick = (table) => { let r = rng(); for (const [v, w] of table) if ((r -= w) < 0) return v; return table.at(-1)[0]; };
function applicant() {
  const income = Math.round(clamp(Math.exp(Math.log(48000) + 0.55 * gauss(rng)), 15000, 400000) / 500) * 500;
  return {
    age: Math.round(clamp(34 + 7 * gauss(rng), 21, 60)),
    employment: rng() < 0.7 ? 'salaried' : 'self_employed',
    monthly_income: income,
    existing_emi: rng() < 0.55 ? Math.round((income * (0.03 + rng() * 0.2)) / 100) * 100 : 0,
    requested_amount: Math.round((income * (2.5 + rng() * 5)) / 5000) * 5000,
    tenure_months: pick([[12, 0.15], [24, 0.25], [36, 0.35], [48, 0.15], [60, 0.1]]),
    new_to_credit: rng() < 0.12,
    device: pick([['android', 0.6], ['ios', 0.25], ['web', 0.15]]),
    channel: pick([['organic', 0.45], ['paid', 0.3], ['partner', 0.25]]),
  };
}

async function api(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  return { status: res.status, body: json };
}

const tally = { started: 0, kyc_failed: 0, rejected: 0, referred: 0, bureau_unavailable: 0, approved: 0, accepted: 0, errors: 0 };

async function journey() {
  const a = await api('POST', '/api/applications', applicant());
  if (a.status !== 201) { tally.errors += 1; return; }
  tally.started += 1;
  const id = a.body.id;
  const kyc = await api('POST', `/api/applications/${id}/kyc`);
  if (kyc.body?.status !== 'verified') { tally.kyc_failed += 1; return; }
  const elig = await api('POST', `/api/applications/${id}/eligibility`);
  if (elig.body?.decision !== 'pass') { tally.rejected += 1; return; }
  const offer = await api('POST', `/api/applications/${id}/offer`);
  if (offer.body?.decision === 'reject') { tally.rejected += 1; return; }
  if (offer.body?.decision === 'refer') {
    tally.referred += 1;
    if ((offer.body.reasons ?? []).some((r) => r.code === 'BUREAU_UNAVAILABLE')) tally.bureau_unavailable += 1;
    return;
  }
  if (offer.body?.decision !== 'approve') { tally.errors += 1; return; }
  tally.approved += 1;
  if (rng() < 0.6) {
    const acc = await api('POST', `/api/applications/${id}/accept`);
    if (acc.body?.status === 'disbursed') tally.accepted += 1;
  }
}

async function report(label) {
  const s = await api('GET', '/api/mock/status?minutes=15');
  const recorded = s.body?.recorded;
  const prov = (recorded?.providers ?? []).map((p) => `${p.provider}: ${p.calls} calls, p50 ${p.p50_ms} ms, p95 ${p.p95_ms} ms, ${p.timeouts} timeouts, ${p.errors} errors`).join(' | ');
  console.log(`[${label}] ${JSON.stringify(tally)}${prov ? `\n    last 15 min recorded -> ${prov}` : ''}`);
}

async function main() {
  const health = await api('GET', '/api/health').catch(() => null);
  if (!health || health.status !== 200) { console.error(`API not reachable at ${base}. Start it with: npm run dev:api`); process.exit(1); }
  console.log(`LoanLens live load: ${N} fabricated journeys, concurrency ${CONC}, seed ${SEED}, ${base}`);
  console.log('All applicants are synthetic. Rows are written to the same database the workbench reads.');
  let next = 0;
  let scenarioOn = false;
  const worker = async () => {
    while (next < N) {
      const i = next++;
      if (SCENARIO && !scenarioOn && i >= FROM && i < TO) {
        const r = await api('POST', `/api/mock/scenarios/${SCENARIO}`);
        if (r.status !== 200) { console.error(`could not start scenario "${SCENARIO}": ${r.body?.error}`); process.exit(1); }
        scenarioOn = true;
        console.log(`>> journey ${i}: scenario "${SCENARIO}" ON`);
      }
      if (SCENARIO && scenarioOn && i >= TO) {
        scenarioOn = false;
        await api('POST', '/api/mock/scenarios/normal');
        console.log(`>> journey ${i}: back to normal`);
      }
      await journey();
      if ((i + 1) % 25 === 0) await report(`${i + 1}/${N}`);
      if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  if (SCENARIO && scenarioOn) { await api('POST', '/api/mock/scenarios/normal'); console.log('>> scenario switched off at the end'); }
  await report('done');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
