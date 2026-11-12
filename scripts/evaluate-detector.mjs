// How good are the anomaly detector and the RCA when the synthetic world is re-rolled?
//
//   node scripts/evaluate-detector.mjs            seeds 1 to 6 (about 2 minutes)
//   node scripts/evaluate-detector.mjs 11 12 13   chosen seeds
//
// The shipped dataset is one draw from the generator (one chance false alarm on 5 Oct). A single draw says little about the false-alarm
// rate, so this script generates several draws in throwaway databases, runs the same detector and RCA, and counts: planted incidents
// found, flags with no planted cause, and whether the RCA ranks the true cause first. It never touches your dev database.
import { createDb } from '../server/src/db/connection.js';
import { migrate } from '../server/src/db/migrate.js';
import { ensureDefaultRules } from '../server/src/rules/defaultRules.js';
import { seedDatabase } from '../server/src/data/seed.js';
import { loadApps } from '../server/src/analytics/data.js';
import { detectAnomalies, detectShifts } from '../server/src/analytics/anomaly.js';
import { rca } from '../server/src/analytics/rca.js';

// 'default' is the seed of the shipped dataset
const seeds = process.argv.slice(2).map((a) => (a === 'default' ? 'default' : Number(a))).filter((a) => a === 'default' || Number.isFinite(a));
if (!seeds.length) seeds.push('default', 1, 2, 3, 4, 5, 6);

// The planted incidents: day, step, and a test for the cause the RCA should rank first. The FOIR policy change (29 Sep) is a lasting
// shift, not a one-day dip, so the days after it sit below the pre-change baseline until the 14-day median catches up. Flags on
// offer_viewed from 29 Sep to 6 Oct are therefore "policy settling", not independent false alarms.
const POLICY_DAYS = new Set(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
const PLANTED = [
  { day: '2026-10-06', step: 'kyc_completed', cause: /android 2\.3/ },
  { day: '2026-10-07', step: 'kyc_completed', cause: /android 2\.3/ },
  { day: '2026-10-08', step: 'kyc_completed', cause: /android 2\.3/ },
  { day: '2026-10-13', step: 'offer_viewed', cause: /bureau API slowdown/ },
];

// sustained-shift detector: which (window, z) settings find the policy change without raising unexplained flags?
//   SHIFT_GRID="4:3.5,5:3" tries several settings on the same draws
const GRID = (process.env.SHIFT_GRID ?? '4:3.5').split(',').map((g) => g.split(':').map(Number));
const explained = (sh) => (sh.step === 'offer_viewed' && sh.first_flagged >= '2026-09-29' && sh.first_flagged <= '2026-10-12') // policy settling
  || (sh.step === 'kyc_completed' && sh.first_flagged >= '2026-10-06' && sh.first_flagged <= '2026-10-12') // Android regression
  || (sh.step === 'offer_viewed' && sh.first_flagged >= '2026-10-13' && sh.first_flagged <= '2026-10-16'); // bureau slowdown
const shiftStats = new Map(GRID.map((g) => [g.join(':'), { policy: 0, unexplained: 0, list: [] }]));
const rows = [];
for (const seed of seeds) {
  const db = await createDb({ ephemeral: true });
  try {
    await migrate(db.pool);
    await ensureDefaultRules(db.pool);
    await seedDatabase(db.pool, seed === 'default' ? {} : { seed });
    const apps = await loadApps(db.pool, '2026-09-10', '2026-10-20');
    const { anomalies } = detectAnomalies(apps);
    const has = (p) => anomalies.some((a) => a.day === p.day && a.step === p.step);
    const found = PLANTED.filter(has);
    const policyFlags = anomalies.filter((a) => a.step === 'offer_viewed' && POLICY_DAYS.has(a.day));
    const planted = new Set(PLANTED.map((p) => `${p.day} ${p.step}`));
    const extra = anomalies.filter((a) => !planted.has(`${a.day} ${a.step}`) && !(a.step === 'offer_viewed' && POLICY_DAYS.has(a.day)));
    for (const [k, z] of GRID) {
      const { shifts } = detectShifts(apps, { windowDays: k, zThreshold: z });
      const st = shiftStats.get(`${k}:${z}`);
      const policy = shifts.some((x) => x.step === 'offer_viewed' && x.first_flagged >= '2026-09-29' && x.first_flagged <= '2026-10-12');
      const unexplained = shifts.filter((x) => !explained(x));
      if (policy) st.policy++;
      st.unexplained += unexplained.length;
      st.list.push(...unexplained.map((x) => `seed ${seed}: ${x.step} ${x.first_flagged}`));
    }
    let rcaRight = 0;
    const wrong = [];
    for (const p of PLANTED) {
      const r = await rca(db.pool, { day: p.day, step: p.step });
      const top = r.hypotheses[0];
      if (r.observed.significant && p.cause.test(top.title) && top.score >= 0.5) rcaRight++;
      else wrong.push(`${p.day} ${p.step}: ${r.observed.significant ? `${top.title} ${top.score}` : 'not significant'}`);
    }
    // RCA on each policy-window flag: does it point at the policy change?
    let policyRight = 0;
    for (const a of policyFlags) {
      const r = await rca(db.pool, { day: a.day, step: a.step });
      if (/Credit policy/.test(r.hypotheses[0].title) && r.hypotheses[0].score >= 0.5) policyRight++;
    }
    // RCA on every extra flag: does it (rightly) not claim a likely cause?
    let overclaims = 0;
    for (const a of extra) {
      const r = await rca(db.pool, { day: a.day, step: a.step });
      if (r.hypotheses[0].score >= 0.5) overclaims++;
    }
    rows.push({ seed, flags: anomalies.length, found: found.length + (policyFlags.length ? 1 : 0), policyFlags: policyFlags.length, policyRight, extra: extra.length, extraList: extra.map((a) => `${a.day} ${a.step}`), rcaRight, overclaims, wrong });
    console.log(`seed ${seed}: ${anomalies.length} flags | planted incidents found ${found.length + (policyFlags.length ? 1 : 0)}/${PLANTED.length + 1} (policy-window flags ${policyFlags.length}, RCA says policy on ${policyRight}) | extra flags ${extra.length}${extra.length ? ` (${extra.map((a) => `${a.day} ${a.step}`).join(', ')})` : ''} | RCA top cause right ${rcaRight}/${PLANTED.length}${wrong.length ? ` | wrong: ${wrong.join('; ')}` : ''}${overclaims ? ` | likely cause claimed on ${overclaims} extra flag(s)` : ''}`);
  } finally {
    await db.close();
  }
}

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
for (const [k, z] of GRID) {
  const st = shiftStats.get(`${k}:${z}`);
  console.log(`shift detector window=${k}d z<=-${z}: policy change found in ${st.policy}/${rows.length} draws, unexplained shift episodes ${st.unexplained}${st.list.length ? ` (${st.list.join('; ')})` : ''}`);
}
const days = rows.length * 40;
console.log(`\n${rows.length} draws of 40 days:`);
console.log(`  planted incidents flagged: ${sum('found')}/${rows.length * (PLANTED.length + 1)} (the policy change counts as found if any day in its settling window is flagged)`);
console.log(`  policy-window flags where the RCA ranks the policy change first (>= 50%): ${sum('policyRight')}/${sum('policyFlags')}`);
console.log(`  unexplained flags (not a planted day, not policy settling): ${sum('extra')} in ${rows.length} draws, ${(sum('extra') / rows.length).toFixed(2)} per 40 days, ${((sum('extra') / days) * 100).toFixed(1)}% of days`);
console.log(`  RCA ranked the true cause first (>= 50%) on the Android and bureau days: ${sum('rcaRight')}/${rows.length * PLANTED.length}`);
console.log(`  extra flags where the RCA still claimed a likely cause: ${sum('overclaims')}/${sum('extra')}`);
