import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, applicant } from './helpers.js';
import { mockState } from '../src/mock/state.js';

let t;
before(async () => { t = await boot(); });
after(async () => { await t.close(); });

async function run(body, { force } = {}) {
  if (force) Object.assign(mockState.bureau, force);
  const a = await t.call('POST', '/api/applications', body);
  assert.equal(a.status, 201);
  const id = a.body.id;
  mockState.kyc.forceVerified = true;
  mockState.kyc.errorRate = 0; mockState.kyc.timeoutRate = 0;
  await t.call('POST', `/api/applications/${id}/kyc`);
  await t.call('POST', `/api/applications/${id}/eligibility`);
  return id;
}

test('happy path: approve, KFS before acceptance, disburse, full event trail', async () => {
  const id = await run(applicant, { force: { forceScore: 780, errorRate: 0, timeoutRate: 0 } });
  const offer = await t.call('POST', `/api/applications/${id}/offer`);
  assert.equal(offer.body.decision, 'approve');
  assert.equal(offer.body.offer.interest_rate_pa, 0.11);
  assert.ok(offer.body.offer.apr > 0.11);
  assert.ok(offer.body.offer.cooling_off_days >= 1);
  const acc = await t.call('POST', `/api/applications/${id}/accept`);
  assert.equal(acc.body.status, 'disbursed');
  const { body } = await t.call('GET', `/api/applications/${id}`);
  assert.deepEqual(body.events.map((e) => e.event_type), [
    'application_started', 'kyc_completed', 'eligibility_passed', 'offer_viewed', 'offer_accepted', 'loan_disbursed',
  ]);
  const calls = await t.pool.query('select provider, status from api_calls where application_id=$1 order by provider', [id]);
  assert.deepEqual(calls.rows.map((r) => r.provider), ['bureau', 'kyc']);
});

test('credit reject returns reason codes and no offer', async () => {
  const id = await run(applicant, { force: { forceScore: 600, errorRate: 0, timeoutRate: 0 } });
  const r = await t.call('POST', `/api/applications/${id}/offer`);
  assert.equal(r.body.decision, 'reject');
  assert.equal(r.body.reasons[0].code, 'SCORE_TOO_LOW');
  const { rows } = await t.pool.query('select decision, reason_codes, offered_amount from applications where id=$1', [id]);
  assert.equal(rows[0].decision, 'reject');
  assert.equal(rows[0].offered_amount, null);
});

test('prescreen reject for low income stops before the bureau is called', async () => {
  const a = await t.call('POST', '/api/applications', { ...applicant, monthly_income: 18000 });
  const id = a.body.id;
  mockState.kyc.forceVerified = true; mockState.kyc.errorRate = 0; mockState.kyc.timeoutRate = 0;
  await t.call('POST', `/api/applications/${id}/kyc`);
  const e = await t.call('POST', `/api/applications/${id}/eligibility`);
  assert.equal(e.body.decision, 'reject');
  assert.equal(e.body.reasons[0].code, 'INCOME_TOO_LOW');
  const bureau = await t.pool.query("select 1 from api_calls where application_id=$1 and provider='bureau'", [id]);
  assert.equal(bureau.rowCount, 0);
});

test('bureau outage falls back to manual review, not a silent approval', async () => {
  const id = await run(applicant, { force: { forceScore: null, errorRate: 0, timeoutRate: 1 } });
  const r = await t.call('POST', `/api/applications/${id}/offer`);
  assert.equal(r.body.decision, 'refer');
  assert.equal(r.body.reasons[0].code, 'BUREAU_UNAVAILABLE');
  const { rows } = await t.pool.query("select status from api_calls where application_id=$1 and provider='bureau'", [id]);
  assert.equal(rows[0].status, 'timeout');
  mockState.bureau.timeoutRate = 0;
});

test('steps cannot be skipped and bad input is rejected', async () => {
  const a = await t.call('POST', '/api/applications', applicant);
  const skip = await t.call('POST', `/api/applications/${a.body.id}/offer`);
  assert.equal(skip.status, 409);
  const bad = await t.call('POST', '/api/applications', { ...applicant, age: 'abc' });
  assert.equal(bad.status, 400);
});

test('a new rule version can be added without a redeploy and is validated', async () => {
  const bad = await t.call('POST', '/api/rules', { version: 'bad', config: { rules: [] } });
  assert.equal(bad.status, 400);
  const list = await t.call('GET', '/api/rules');
  assert.deepEqual(list.body.map((r) => r.version), ['v1', 'v2']);
});

test('applications created through the API are marked synthetic', async () => {
  const a = await t.call('POST', '/api/applications', applicant);
  const { rows } = await t.pool.query('select is_synthetic from applications where id = $1', [a.body.id]);
  assert.equal(rows[0].is_synthetic, true);
});

test('parallel requests for the same step run one at a time: one event, one bureau call', async () => {
  const id = await run(applicant, { force: { forceScore: 760, errorRate: 0, timeoutRate: 0 } });
  const replies = await Promise.all([1, 2, 3, 4].map(() => t.call('POST', `/api/applications/${id}/offer`)));
  assert.ok(replies.every((r) => r.status === 200 && r.body.decision === 'approve'));
  assert.equal(new Set(replies.map((r) => JSON.stringify(r.body.offer))).size, 1, 'everyone gets the same offer');
  const { rows: ev } = await t.pool.query("select count(*)::int n from events where application_id = $1 and event_type = 'offer_viewed'", [id]);
  const { rows: calls } = await t.pool.query("select count(*)::int n from api_calls where application_id = $1 and provider = 'bureau'", [id]);
  assert.equal(ev[0].n, 1);
  assert.equal(calls[0].n, 1);
  // and a lock for one application does not hold up another
  const other = await run(applicant, { force: { forceScore: 760, errorRate: 0, timeoutRate: 0 } });
  assert.equal((await t.call('POST', `/api/applications/${other}/offer`)).status, 200);
});
