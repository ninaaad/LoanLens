// How does the experiment decision rule behave over many repeats? Pure maths on simulated cohorts: no database, no server.
//
//   node scripts/evaluate-experiments.mjs          200 repeats per setting (about 1 minute)
//   node scripts/evaluate-experiments.mjs 50       fewer repeats
//
// For each true effect it draws many cohorts (different seeds, n = 40,000 users, 50/50) and counts ship / hold / stop, how often the
// 95% interval contains the true effect, and how often the sample-ratio check fires on a correct split. Nothing here is tuned: it
// reports what the rule does.
import { generateCohort, summariseUnits } from '../server/src/experiments/simulateExperiment.js';
import { analyseSummaries } from '../server/src/experiments/analyse.js';
import { DEMO } from '../server/src/experiments/routes.js';

const reps = Number(process.argv[2] ?? 200);
const def = { ...DEMO, variants: [{ name: 'control', weight: 50 }, { name: 'treatment', weight: 50 }] };
const n = 40000;

function run(trueEffect, extra = {}) {
  const tally = { ship: 0, hold: 0, stop: 0, covered: 0, srm: 0, mde: 0, uncertainGuardrail: 0 };
  for (let seed = 1; seed <= reps; seed++) {
    const units = generateCohort(def.key, def.variants, { n, seed, trueEffect, ...extra });
    const a = analyseSummaries(def, summariseUnits(units));
    tally[a.decision.action]++;
    if (a.primary.ci95[0] <= (trueEffect.acceptance ?? 0) && (trueEffect.acceptance ?? 0) <= a.primary.ci95[1]) tally.covered++;
    if (a.srm.flagged) tally.srm++;
    tally.mde += a.primary.mde80;
    if (a.guardrails.some((g) => g.status === 'uncertain')) tally.uncertainGuardrail++;
  }
  return tally;
}
const pct = (x) => `${((100 * x) / reps).toFixed(1)}%`;
console.log(`${reps} repeats per row, n = ${n} per experiment (50/50)\n`);
console.log('true acceptance effect | ship | hold | stop | interval covers truth | SRM fires | mean MDE (80%) | a guardrail "uncertain"');
for (const eff of [0, 0.005, 0.01, 0.02, 0.03, -0.02]) {
  const t = run({ acceptance: eff });
  console.log(`${(eff >= 0 ? '+' : '') + (eff * 100).toFixed(1)} pts | ${pct(t.ship)} | ${pct(t.hold)} | ${pct(t.stop)} | ${pct(t.covered)} | ${pct(t.srm)} | ${((t.mde / reps) * 100).toFixed(2)} pts | ${pct(t.uncertainGuardrail)}`);
}
const bad = run({ acceptance: 0.02, default: 0.03 });
console.log(`\n+2.0 pts acceptance but default rate +3 pts: ship ${pct(bad.ship)}, hold ${pct(bad.hold)}, stop ${pct(bad.stop)}`);
const lost = run({ acceptance: 0.02 }, { dropTreatmentRate: 0.1 });
console.log(`+2.0 pts acceptance but 10% of treatment users lost (logging bug): ship ${pct(lost.ship)}, hold ${pct(lost.hold)}, stop ${pct(lost.stop)}, SRM fires ${pct(lost.srm)}`);
