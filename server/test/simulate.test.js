import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { seedDatabase } from '../src/data/seed.js';
import { simulate, acceptanceModel } from '../src/analytics/simulate.js';

let t;
before(async () => {
  t = await boot();
  // smaller than the demo dataset so the suite stays fast; same generator, same scenarios
  await seedDatabase(t.pool, { perDay: 150 });
});
after(async () => t?.close());

const sim = (body) => t.call('POST', '/api/simulate', body);

test('identical ruleset gives zero deltas', async () => {
  for (const candidate of ['v2', { base: 'v2', overrides: {} }]) {
    const { status, body } = await sim({ candidate, baseline: 'v2' });
    assert.equal(status, 200);
    assert.ok(body.population.applications > 1000);
    const d = body.results.delta;
    assert.deepEqual([d.approve, d.refer, d.reject, d.expected_disbursed_amount, d.approved_would_default], [0, 0, 0, 0, 0]);
    assert.equal(d.approve_rate, 0);
    assert.equal(d.expected_disbursals, 0);
    assert.equal(d.expected_npa, 0);
  }
  // a full config copied from the stored ruleset behaves the same
  const meta = await t.pool.query("select config from rule_versions where version = 'v2'");
  const { body } = await sim({ candidate: meta.rows[0].config, baseline: 'v2' });
  assert.equal(body.results.delta.approve, 0);
});

test('rulesets are labelled by version, and "+overrides" only when something was overridden', async () => {
  const plain = (await sim({ baseline: 'v2', candidate: 'v1' })).body;
  assert.equal(plain.baseline.version, 'v2');
  assert.equal(plain.candidate.version, 'v1');
  const edited = (await sim({ baseline: 'v2', candidate: { base: 'v2', overrides: { rules: { foir_hard: { value: 0.45 } } } } })).body;
  assert.equal(edited.candidate.version, 'v2+overrides');
  assert.equal((await sim({ baseline: 'v2', candidate: { base: 'v2', overrides: {} } })).body.candidate.version, 'v2');
});

test('response is labelled synthetic and carries the caveat notice', async () => {
  const { body } = await sim({ candidate: 'v1' });
  assert.equal(body.synthetic, true);
  assert.match(body.notice, /synthetic ground truth/i);
  assert.match(body.notice, /no behavioural reaction/i);
});

test('tightening the FOIR cap lowers approvals and expected NPA', async () => {
  const { status, body } = await sim({
    baseline: 'v2',
    candidate: { base: 'v2', overrides: { rules: { foir_hard: { value: 0.35 }, foir_soft: { value: 0.3 } } } },
  });
  assert.equal(status, 200);
  const { baseline, candidate, delta } = body.results;
  assert.ok(candidate.approve < baseline.approve, 'approvals fall');
  assert.ok(candidate.expected_disbursals < baseline.expected_disbursals, 'expected disbursals fall');
  assert.ok(delta.expected_npa < 0, `NPA falls (${baseline.expected_npa} -> ${candidate.expected_npa})`);
  assert.ok(candidate.reject + candidate.refer > baseline.reject + baseline.refer);
});

test('loosening the score cut-offs raises approvals and expected NPA', async () => {
  const { status, body } = await sim({
    baseline: 'v2',
    candidate: { base: 'v2', overrides: { rules: { score_hard: { value: 600 }, score_soft: { value: 650 } } } },
  });
  assert.equal(status, 200);
  const { baseline, candidate, delta } = body.results;
  assert.ok(candidate.approve > baseline.approve, 'approvals rise');
  assert.ok(candidate.expected_disbursals > baseline.expected_disbursals);
  assert.ok(delta.expected_npa > 0, `NPA rises (${baseline.expected_npa} -> ${candidate.expected_npa})`);
  assert.ok(delta.approved_would_default > 0, 'more approved applicants would default');
});

test('decision counts add up, and segments partition the population', async () => {
  const { body } = await sim({ candidate: { base: 'v2', overrides: { rules: { foir_hard: { value: 0.45 } } } } });
  const n = body.population.applications;
  for (const side of ['baseline', 'candidate']) {
    const r = body.results[side];
    assert.equal(r.approve + r.refer + r.reject, n);
    assert.ok(Math.abs(r.approve_rate + r.refer_rate + r.reject_rate - 1) < 0.001);
  }
  const flowTotal = Object.values(body.decision_flows).flatMap((o) => Object.values(o)).reduce((a, b) => a + b, 0);
  assert.equal(flowTotal, n);
  for (const dim of ['device', 'channel', 'employment', 'new_to_credit']) {
    assert.equal(body.segments[dim].reduce((a, s) => a + s.applications, 0), n, dim);
  }
});

test('v1 vs v2 replay shows the FOIR change: v1 approves at least as many', async () => {
  const { body } = await sim({ baseline: 'v2', candidate: 'v1' });
  assert.ok(body.results.candidate.approve >= body.results.baseline.approve);
});

test('acceptance model is estimated from stored offers, not hard-coded', async () => {
  const m = await acceptanceModel(t.pool);
  assert.ok(m.offers > 500);
  assert.ok(m.cells.length >= 3);
  assert.ok(m.cells.every((c) => c.accepted <= c.offers));
  // the generator makes cheaper offers more attractive; the estimate should reflect that
  const p = (rate) => m.cells.filter((c) => c.rate === rate && !c.cut).reduce((a, c) => a + c.accepted, 0)
    / m.cells.filter((c) => c.rate === rate && !c.cut).reduce((a, c) => a + c.offers, 0);
  assert.ok(p(0.11) > p(0.16));
  assert.ok(m.lookup(0.11, false) > m.lookup(0.16, false));
  // a rate that was never offered borrows the nearest observed one
  assert.equal(m.lookup(0.1, false), m.lookup(0.11, false));
});

test('window filters the population', async () => {
  const all = (await sim({ candidate: 'v2' })).body.population.applications;
  const week = (await sim({ candidate: 'v2', from: '2026-10-05', to: '2026-10-11' })).body;
  assert.deepEqual(week.window, { from: '2026-10-05', to: '2026-10-11' });
  assert.ok(week.population.applications > 0 && week.population.applications < all);
});

test('invalid input returns 400 with a message', async () => {
  const bad = [
    [{}, /candidate is required/],
    [{ candidate: 'v9' }, /unknown rule version/],
    [{ candidate: { base: 'v2', overrides: { rules: { nope: { value: 1 } } } } }, /unknown rule/],
    [{ candidate: { base: 'v2', overrides: { rules: { foir_hard: { field: 'age' } } } } }, /may only change/],
    [{ candidate: { base: 'v2', overrides: { rules: { foir_hard: { op: '~~' } } } } }, /unknown operator/],
    [{ candidate: { base: 'v2', overrides: { rules: { foir_hard: { onFail: 'explode' } } } } }, /onFail/],
    [{ candidate: { base: 'v2', overrides: { rules: { foir_hard: { value: null } } } } }, /finite value/],
    [{ candidate: { base: 'v2', overrides: { pricing: [] } } }, /pricing/],
    [{ candidate: { base: 'v2', overrides: { pricing: [{ minScore: 0, rate: 'high' }] } } }, /pricing entries/],
    [{ candidate: { base: 'v2', overrides: { maxLoanIncomeMultiple: 'lots' } } }, /maxLoanIncomeMultiple/],
    [{ candidate: { rules: [], pricing: [], maxLoanIncomeMultiple: 1 } }, /invalid/],
    [{ candidate: 'v2', baseline: 'v9' }, /baseline/],
    [{ candidate: 'v2', from: '10/10/2026' }, /YYYY-MM-DD/],
    [{ candidate: 'v2', from: '2026-10-12', to: '2026-10-01' }, /after/],
    [{ candidate: 'v2', from: '2026-13-45' }, /not valid dates/],
  ];
  for (const [body, re] of bad) {
    const r = await sim(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re, JSON.stringify(body));
  }
});

test('the simulator does not change stored data', async () => {
  const before_ = (await t.pool.query('select count(*)::int n, sum(default_prob) s from applications')).rows[0];
  await simulate(t.pool, { candidate: 'v1' });
  const after_ = (await t.pool.query('select count(*)::int n, sum(default_prob) s from applications')).rows[0];
  assert.deepEqual(before_, after_);
});

test('result includes a backtest of the baseline against the loans that actually disbursed', async () => {
  const { body } = await sim({ candidate: 'v2', baseline: 'v2' });
  const bt = body.backtest;
  assert.ok(bt.actual_disbursed > 100, JSON.stringify(bt));
  assert.equal(bt.baseline_expected_disbursals, Number(body.results.baseline.expected_disbursals.toFixed(4)));
  assert.ok(bt.ratio_expected_to_actual > 0.4 && bt.ratio_expected_to_actual < 1.6, `ratio ${bt.ratio_expected_to_actual}`);
  assert.match(bt.note, /acceptance model/);
});
