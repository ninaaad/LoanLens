import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { seedDatabase } from '../src/data/seed.js';
import { loadApps } from '../src/analytics/data.js';
import { detectAnomalies } from '../src/analytics/anomaly.js';
import { funnel } from '../src/analytics/funnel.js';
import { rca } from '../src/analytics/rca.js';

let db, rows, det;
before(async () => {
  db = await createDb({ ephemeral: true });
  await migrate(db.pool);
  await seedDatabase(db.pool, {});
  rows = await loadApps(db.pool, '2026-09-10', '2026-10-20');
  det = detectAnomalies(rows);
});
after(async () => db?.close());

test('seeded data is synthetic and has the expected shape', async () => {
  const { rows: r } = await db.pool.query('select count(*)::int n, bool_and(is_synthetic) s from applications');
  assert.ok(r[0].n > 20000);
  assert.equal(r[0].s, true);
});

test('funnel: every step is a subset of the previous one', async () => {
  const f = await funnel(db.pool, {});
  const c = f.total.counts;
  assert.ok(c.application_started >= c.kyc_completed && c.kyc_completed >= c.eligibility_passed && c.eligibility_passed >= c.offer_viewed);
  assert.ok(c.offer_viewed >= c.offer_accepted && c.offer_accepted >= c.loan_disbursed);
  assert.equal(f.days.length, 40);
});

test('detector flags the seeded incidents', () => {
  const has = (day, step) => det.anomalies.some((a) => a.day === day && a.step === step);
  assert.ok(has('2026-10-06', 'kyc_completed'), 'android regression day 1');
  assert.ok(has('2026-10-07', 'kyc_completed'), 'android regression day 2');
  assert.ok(has('2026-10-13', 'offer_viewed'), 'bureau slowdown');
});

test('detector stays quiet on a run of normal days', () => {
  const quiet = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-10-10', '2026-10-11', '2026-10-12'];
  const bad = det.anomalies.filter((a) => quiet.includes(a.day));
  assert.deepEqual(bad, []);
});

test('RCA ranks the bureau slowdown first on 13 Oct and rules out the decoy release', async () => {
  const r = await rca(db.pool, { day: '2026-10-13', step: 'offer_viewed' });
  assert.equal(r.hypotheses[0].id, 'api_latency');
  assert.ok(r.hypotheses[0].score > 0.5);
  const decoy = r.hypotheses.find((h) => h.title.includes('ios 5.2'));
  assert.ok(decoy, 'decoy release is considered');
  assert.equal(decoy.verdict, 'ruled out');
  assert.match(r.narrative, /bureau/i);
});

test('RCA blames the android release for the KYC drop, not the KYC API', async () => {
  const r = await rca(db.pool, { day: '2026-10-07', step: 'kyc_completed' });
  assert.match(r.hypotheses[0].title, /android 2\.3/);
  assert.ok(r.hypotheses[0].score > 0.5);
  assert.equal(r.hypotheses.find((h) => h.id === 'api_latency').verdict, 'ruled out');
});

test('RCA attributes the 29-30 Sep dip to the FOIR policy change', async () => {
  const r = await rca(db.pool, { day: '2026-09-30', step: 'offer_viewed' });
  assert.equal(r.hypotheses[0].id, 'rule_v2');
  assert.ok(r.hypotheses[0].score > 0.3);
});

// These two pin the figures quoted in the README (the data is generated from a fixed seed, so they are reproducible).
// If the generator or detector changes on purpose, update the README together with this list.
test('measured detector behaviour: six flags, five planted and one chance false alarm (5 Oct)', () => {
  const flags = det.anomalies.map((a) => `${a.day} ${a.step}`);
  assert.deepEqual(flags, [
    '2026-09-29 offer_viewed', '2026-10-05 offer_viewed', '2026-10-06 kyc_completed',
    '2026-10-07 kyc_completed', '2026-10-08 kyc_completed', '2026-10-13 offer_viewed',
  ]);
  const planted = new Set(['2026-09-29', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-13']);
  assert.equal(det.anomalies.filter((a) => !planted.has(a.day)).length, 1);
});

test('known RCA artefact: on the 5 Oct chance flag the policy change shows a small "possible" score, never a "likely" one', async () => {
  const r = await rca(db.pool, { day: '2026-10-05', step: 'offer_viewed' });
  const policy = r.hypotheses.find((h) => h.id === 'rule_v2');
  assert.equal(policy.verdict, 'possible');
  assert.ok(policy.score > 0.15 && policy.score < 0.3, `policy score ${policy.score}`);
  assert.ok(r.hypotheses.filter((h) => h.verdict === 'likely').length === 0);
});

test('RCA does not score causes on a day whose change is within normal variation', async () => {
  // 12 Oct moved by about 0.1 points. It used to come back with "likely" causes at 100% because the score is a share of a tiny drop.
  const r = await rca(db.pool, { day: '2026-10-12', step: 'offer_viewed' });
  assert.equal(r.observed.significant, false);
  assert.ok(r.hypotheses.every((h) => h.score === 0 && h.verdict === 'ruled out'));
  assert.match(r.narrative, /within normal day-to-day variation/);
  // a real incident is still significant and scored
  const real = await rca(db.pool, { day: '2026-10-13', step: 'offer_viewed' });
  assert.equal(real.observed.significant, true);
  assert.ok(real.observed.drop_z >= 2);
});

// ---------- sustained shifts ----------
import { detectShifts, SHIFT } from '../src/analytics/anomaly.js';

/** 30 days, 300 applicants a day, KYC conversion p before and q from day `from` on; a seeded generator so the test is reproducible. */
function syntheticRows(p, q, from) {
  let x = 12345;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const rows = [];
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 8, 10 + d)).toISOString().slice(0, 10);
    for (let i = 0; i < 300; i++) {
      const kyc = rand() < (d >= from ? q : p);
      rows.push({ day, application_started: true, kyc_completed: kyc, eligibility_passed: false, offer_viewed: false, offer_accepted: false, loan_disbursed: false });
    }
  }
  return rows;
}

test('shift detector: a lasting 6-point drop is found as one episode; no drop, no flag', () => {
  const quiet = detectShifts(syntheticRows(0.8, 0.8, 99));
  assert.deepEqual(quiet.shifts, []);
  const dropped = detectShifts(syntheticRows(0.8, 0.74, 20)).shifts.filter((s) => s.step === 'kyc_completed');
  assert.equal(dropped.length, 1, JSON.stringify(dropped));
  const [s] = dropped;
  assert.ok(s.from >= '2026-09-26' && s.from <= '2026-09-30' && s.to <= '2026-10-09');
  assert.ok(s.z <= -SHIFT.zThreshold && s.drop >= SHIFT.minDrop);
  assert.ok(s.baseline > 0.77 && s.rate < 0.77);
});

test('shift detector on the seeded data: the FOIR policy change and the Android regression, nothing else', () => {
  const { shifts } = detectShifts(rows);
  assert.deepEqual(shifts.map((s) => `${s.step} from ${s.from}`), ['offer_viewed from 2026-09-29', 'kyc_completed from 2026-10-03']);
  assert.equal(det.anomalies.length, 6, 'the daily detector is unchanged by the shift detector');
});
