import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { assign, bucket, validateVariants } from '../src/experiments/assign.js';
import { generateCohort, summariseUnits } from '../src/experiments/simulateExperiment.js';
import { analyseSummaries, normCdf, chiSquareP, twoProportion, srmCheck } from '../src/experiments/analyse.js';
import { buildBrief } from '../src/experiments/brief.js';
import { DEMO } from '../src/experiments/routes.js';

const V5050 = [{ name: 'control', weight: 50 }, { name: 'treatment', weight: 50 }];
const def = { ...DEMO, variants: V5050 };
const run = (opts, d = def) => analyseSummaries(d, summariseUnits(generateCohort(d.key, d.variants, { n: 40000, ...opts })));

let t;
before(async () => { t = await boot(); });
after(async () => t?.close());

// ---------- assignment ----------
test('assignment is deterministic', () => {
  for (let i = 0; i < 200; i++) assert.equal(assign(`app-${i}`, 'exp_a', V5050), assign(`app-${i}`, 'exp_a', V5050));
  assert.equal(bucket('app-1', 'exp_a'), bucket('app-1', 'exp_a'));
  assert.ok(bucket('app-1', 'exp_a') >= 0 && bucket('app-1', 'exp_a') < 100);
});

test('assignment is balanced for 50/50 and 90/10 splits', () => {
  for (const [w, share] of [[V5050, 0.5], [[{ name: 'control', weight: 90 }, { name: 'treatment', weight: 10 }], 0.9]]) {
    let control = 0;
    const N = 100000;
    for (let i = 0; i < N; i++) if (assign(`u${i}`, 'exp_bal', w) === 'control') control += 1;
    assert.ok(Math.abs(control / N - share) < 0.01, `control share ${control / N} vs ${share}`);
  }
});

test('different experiments split the same users independently', () => {
  let same = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (assign(`u${i}`, 'exp_one', V5050) === assign(`u${i}`, 'exp_two', V5050)) same += 1;
  assert.ok(Math.abs(same / N - 0.5) < 0.02, `agreement ${same / N}`);
});

test('variant definitions are validated', () => {
  assert.deepEqual(validateVariants(V5050), []);
  assert.ok(validateVariants([{ name: 'a', weight: 50 }]).length);
  assert.match(validateVariants([{ name: 'a', weight: 60 }, { name: 'b', weight: 60 }])[0], /sum to 100/);
  assert.ok(validateVariants([{ name: 'a', weight: 50 }, { name: 'a', weight: 50 }]).join().includes('duplicate'));
  assert.ok(validateVariants([{ name: 'a', weight: 0.5 }, { name: 'b', weight: 99.5 }]).length);
});

// ---------- statistics ----------
test('normal and chi-square tail functions match known values', () => {
  assert.ok(Math.abs(normCdf(1.959964) - 0.975) < 1e-5);
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(chiSquareP(3.841459, 1) - 0.05) < 1e-4);
  assert.ok(Math.abs(chiSquareP(10.827566, 1) - 0.001) < 1e-5);
  assert.ok(Math.abs(chiSquareP(5.991465, 2) - 0.05) < 1e-4);
});

test('two-proportion z-test on a textbook example', () => {
  // 200/1000 vs 250/1000: pooled p = 0.225, z = 0.05 / sqrt(0.225*0.775*0.002) = 2.677
  const r = twoProportion(200, 1000, 250, 1000);
  assert.ok(Math.abs(r.z - 2.677) < 0.005, `z ${r.z}`);
  assert.ok(Math.abs(r.p - 0.0074) < 0.0005, `p ${r.p}`);
  assert.ok(r.ci95[0] > 0 && r.ci95[1] > 0.05);
});

test('SRM check: healthy split passes, 45/55 on large n is flagged', () => {
  assert.equal(srmCheck(V5050, { control: { n: 5010 }, treatment: { n: 4990 } }).flagged, false);
  const bad = srmCheck(V5050, { control: { n: 5500 }, treatment: { n: 4500 } });
  assert.equal(bad.flagged, true);
  assert.ok(bad.p < 0.001);
});

// ---------- decisions ----------
test('no true effect gives "hold"', () => {
  const a = run({ seed: 11, trueEffect: {} });
  assert.equal(a.decision.action, 'hold');
  assert.equal(a.primary.significant, false);
  assert.equal(a.srm.flagged, false);
});

test('a real +2 point effect gives "ship", with the effect recovered inside the interval', () => {
  const a = run({ seed: 2, trueEffect: { acceptance: 0.02 } });
  assert.equal(a.decision.action, 'ship', a.decision.reasons.join(' | '));
  assert.ok(a.primary.significant && a.primary.diff > 0);
  assert.ok(a.primary.ci95[0] <= 0.02 && 0.02 <= a.primary.ci95[1], `CI ${a.primary.ci95} should cover the true +0.02`);
  assert.ok(a.guardrails.every((g) => g.status === 'ok'));
});

test('a guardrail breach blocks ship even when the primary metric wins', () => {
  const a = run({ seed: 2, trueEffect: { acceptance: 0.02, default: 0.03 } });
  assert.equal(a.primary.significant, true);
  assert.equal(a.decision.action, 'stop');
  assert.equal(a.guardrails.find((g) => g.metric === 'default_rate').status, 'breach');
  const slow = run({ seed: 2, trueEffect: { acceptance: 0.02, tatPct: 0.3 } });
  assert.equal(slow.decision.action, 'stop');
  assert.equal(slow.guardrails.find((g) => g.metric === 'median_tat').status, 'breach');
});

test('a significant drop in the primary metric means "stop"', () => {
  assert.equal(run({ seed: 5, trueEffect: { acceptance: -0.03 } }).decision.action, 'stop');
});

test('a skewed split is flagged as SRM and blocks the decision, even with a real effect', () => {
  const a = run({ seed: 2, trueEffect: { acceptance: 0.02 }, dropTreatmentRate: 0.1 });
  assert.equal(a.srm.flagged, true);
  assert.equal(a.decision.action, 'hold');
  assert.match(a.decision.reasons[0], /Sample ratio mismatch/);
});

test('false-positive rate of the primary test is near 5% on no-effect cohorts', () => {
  let sig = 0;
  const R = 60;
  for (let s = 1; s <= R; s++) {
    const a = analyseSummaries(def, summariseUnits(generateCohort(def.key, V5050, { n: 4000, seed: 1000 + s })));
    if (a.primary.significant) sig += 1;
  }
  assert.ok(sig / R <= 0.15, `${sig}/${R} false positives`);
});

test('power and false-ship rate over many seeds (n = 40,000)', () => {
  const R = 30;
  let shipReal = 0; let shipNull = 0; let covered = 0;
  for (let s = 1; s <= R; s++) {
    const real = run({ seed: 100 + s, trueEffect: { acceptance: 0.02 } });
    if (real.decision.action === 'ship') shipReal += 1;
    if (real.primary.ci95[0] <= 0.02 && real.primary.ci95[1] >= 0.02) covered += 1;
    if (run({ seed: 200 + s, trueEffect: {} }).decision.action === 'ship') shipNull += 1;
  }
  console.log(`# experiments: real +2pt effect shipped ${shipReal}/${R}; no effect shipped ${shipNull}/${R}; 95% CI covered the truth ${covered}/${R}`);
  assert.ok(shipReal / R >= 0.85, `power ${shipReal}/${R}`);
  assert.ok(shipNull / R <= 0.1, `false ships ${shipNull}/${R}`);
  assert.ok(covered / R >= 0.85, `coverage ${covered}/${R}`);
});

test('the brief states the decision, is labelled synthetic, and contains the tables', () => {
  const a = run({ seed: 2, trueEffect: { acceptance: 0.02 } });
  const md = buildBrief(def, a, { cohort: { seed: 2 } });
  assert.match(md, /\*\*Decision: SHIP\*\*/);
  assert.match(md, /Synthetic data/);
  assert.match(md, /## Primary result/);
  assert.match(md, /## Guardrails/);
  assert.match(md, /Sample ratio check/);
  assert.match(md, /Default rate on disbursed loans/);
});

// ---------- API ----------
test('API: create, validate, run, analyse, brief on stored data', async () => {
  const demo = await t.call('POST', '/api/experiments/demo');
  assert.equal(demo.status, 201);
  assert.equal(demo.body.key, DEMO.key);
  assert.equal((await t.call('POST', '/api/experiments/demo')).status, 200); // idempotent

  assert.equal((await t.call('GET', `/api/experiments/${DEMO.key}/analysis`)).status, 422); // no data yet
  assert.equal((await t.call('GET', '/api/experiments/nope/analysis')).status, 404);

  const ran = await t.call('POST', `/api/experiments/${DEMO.key}/run`, { seed: 2, true_effect: { acceptance: 0.02 } });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.units, 40000);
  assert.equal(ran.body.synthetic, true);

  const a = await t.call('GET', `/api/experiments/${DEMO.key}/analysis`);
  assert.equal(a.status, 200);
  assert.equal(a.body.synthetic, true);
  assert.equal(a.body.decision.action, 'ship', a.body.decision.reasons.join(' | '));
  assert.ok(a.body.primary.diff > 0);

  // the main funnel dataset is untouched by experiments
  assert.equal((await t.pool.query('select count(*)::int n from applications')).rows[0].n, 0);

  const b = await t.call('GET', `/api/experiments/${DEMO.key}/brief`);
  assert.equal(b.status, 200);
  assert.match(b.body.markdown, /Decision: SHIP/);

  // re-running replaces the cohort rather than adding to it
  await t.call('POST', `/api/experiments/${DEMO.key}/run`, { seed: 2, n: 1000, true_effect: {} });
  assert.equal((await t.pool.query('select count(*)::int n from experiment_units')).rows[0].n, 1000);

  const list = await t.call('GET', '/api/experiments');
  assert.equal(list.body.experiments[0].key, DEMO.key);
  assert.equal(list.body.experiments[0].status, 'running');
});

test('API: a skewed run is flagged in the analysis', async () => {
  const key = 'skewed_split';
  const c = await t.call('POST', '/api/experiments', { ...DEMO, key });
  assert.equal(c.status, 201);
  await t.call('POST', `/api/experiments/${key}/run`, { seed: 3, true_effect: { acceptance: 0.02 }, drop_treatment_rate: 0.1 });
  const a = await t.call('GET', `/api/experiments/${key}/analysis`);
  assert.equal(a.body.srm.flagged, true);
  assert.equal(a.body.decision.action, 'hold');
});

test('API: invalid input returns 400/409', async () => {
  const ok = { ...DEMO, key: 'valid_key' };
  const bad = [
    [{ ...ok, key: 'Bad Key!' }, /key must be/],
    [{ ...ok, name: '' }, /name is required/],
    [{ ...ok, hypothesis: undefined }, /hypothesis/],
    [{ ...ok, primary_metric: 'vibes' }, /primary_metric/],
    [{ ...ok, variants: [{ name: 'a', weight: 70 }, { name: 'b', weight: 20 }] }, /sum to 100/],
    [{ ...ok, variants: [{ name: 'a', weight: 100 }] }, /exactly two/],
    [{ ...ok, guardrails: [{ metric: 'happiness' }] }, /unknown guardrail/],
    [{ ...ok, guardrails: [{ metric: 'default_rate', tolerance: { type: 'abs', value: -1 } }] }, /tolerance/],
    [{ ...ok, guardrails: 'none' }, /guardrails must be an array/],
  ];
  for (const [body, re] of bad) {
    const r = await t.call('POST', '/api/experiments', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  }
  assert.equal((await t.call('POST', '/api/experiments', DEMO)).status, 409); // duplicate key
  for (const body of [{ n: 5 }, { n: 1e9 }, { seed: 1.5 }, { true_effect: { acceptance: 'big' } }, { true_effect: { nonsense: 1 } }, { drop_treatment_rate: 1 }]) {
    assert.equal((await t.call('POST', `/api/experiments/${DEMO.key}/run`, body)).status, 400, JSON.stringify(body));
  }
});

test('true_effect values outside a believable range are a 400', async () => {
  assert.ok([200, 201].includes((await t.call('POST', '/api/experiments/demo')).status));
  for (const te of [{ acceptance: 5 }, { acceptance: -0.6 }, { default: 0.9 }, { complaint: 1 }, { tatPct: -2 }, { tatPct: 50 }]) {
    const r = await t.call('POST', `/api/experiments/${DEMO.key}/run`, { n: 200, true_effect: te });
    assert.equal(r.status, 400, JSON.stringify(te));
    assert.match(r.body.error, /true_effect\.\w+ must be between/);
  }
  assert.equal((await t.call('POST', `/api/experiments/${DEMO.key}/run`, { n: 200, true_effect: { acceptance: 0.5, tatPct: 5 } })).status, 200, 'the limits themselves are allowed');
});

test('minimum detectable effect: shown in the analysis, the hold reason and the brief, and equal to the textbook formula', () => {
  const summ = (n, acc) => ({ n, accepted: acc, disbursed: 0, defaulted: 0, complaints: 0, tat_n: 0 });
  const d = { ...def, guardrails: [] };
  // 4,000 users per arm, 45% acceptance in both: no effect, so "hold"
  const a = analyseSummaries(d, { control: summ(4000, 1800), treatment: summ(4000, 1800) });
  const expected = (1.959964 + 0.841621) * Math.sqrt(0.45 * 0.55 * (2 / 4000));
  assert.ok(Math.abs(a.primary.mde80 - expected) < 1e-9, `${a.primary.mde80} vs ${expected}`);
  assert.equal(a.decision.action, 'hold');
  assert.match(a.decision.reasons[0], /80% of the time.*3\.\d\d points or more/);
  assert.match(buildBrief(d, a), /Sensitivity: with 4000 and 4000 users this test would detect a true difference of about 3\.\d\d points/);
  // ten times the users: the detectable effect shrinks by about sqrt(10)
  const big = analyseSummaries(d, { control: summ(40000, 18000), treatment: summ(40000, 18000) });
  assert.ok(Math.abs(a.primary.mde80 / big.primary.mde80 - Math.sqrt(10)) < 0.01);
  // an empty arm has no sensitivity to report, and does not crash
  assert.equal(analyseSummaries(d, { control: summ(0, 0), treatment: summ(0, 0) }).primary.mde80, null);
});
