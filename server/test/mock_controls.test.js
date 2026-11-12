import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, applicant } from './helpers.js';
import { mockState, resetMock } from '../src/mock/state.js';
import { config } from '../src/config.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts', 'live-load.js');
let t;
before(async () => { t = await boot(); });
after(async () => t?.close());

const tallyOf = (stdout) => {
  const line = stdout.split('\n').find((l) => l.startsWith('[done]'));
  return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
};

test('config patches are validated, and a bad patch changes nothing', async () => {
  resetMock();
  const before_ = JSON.stringify(mockState);
  const bad = [
    [{ provider: 'bureau', multiplier: 0 }, /multiplier/],
    [{ provider: 'bureau', multiplier: 'fast' }, /multiplier/],
    [{ provider: 'bureau', errorRate: 1.5 }, /errorRate/],
    [{ provider: 'kyc', timeoutRate: -0.1 }, /timeoutRate/],
    [{ provider: 'bureau', forceScore: 950 }, /forceScore/],
    [{ provider: 'bureau', forceScore: 700.5 }, /forceScore/],
    [{ provider: 'kyc', forceScore: 700 }, /only applies to bureau/],
    [{ provider: 'bureau', forceVerified: true }, /only applies to kyc/],
    [{ provider: 'bureau', nonsense: 1 }, /unknown setting/],
    [{ provider: 'bureau' }, /at least one setting/],
    [{ provider: 'payments', multiplier: 2 }, /provider must be/],
    [{ provider: 'bureau', multiplier: 2, errorRate: 9 }, /errorRate/], // second field is bad: the first must not be applied either
  ];
  for (const url of ['/api/mock/config', '/mock/config']) {
    for (const [body, re] of bad) {
      const r = await t.call('POST', url, body);
      assert.equal(r.status, 400, `${url} ${JSON.stringify(body)}`);
      assert.match(r.body.error, re);
    }
  }
  assert.equal(JSON.stringify(mockState), before_);
  const ok = await t.call('POST', '/api/mock/config', { provider: 'bureau', multiplier: 3, errorRate: 0.1, timeoutRate: 0.2, forceScore: 640 });
  assert.equal(ok.status, 200);
  assert.deepEqual([mockState.bureau.multiplier, mockState.bureau.errorRate, mockState.bureau.timeoutRate, mockState.bureau.forceScore], [3, 0.1, 0.2, 640]);
  assert.equal((await t.call('POST', '/mock/config', { provider: 'kyc', forceVerified: false })).status, 200);
  assert.equal(mockState.kyc.forceVerified, false);
  assert.equal((await t.call('POST', '/api/mock/config', { provider: 'bureau', forceScore: null })).status, 200);
  resetMock();
});

test('scenarios: unknown name is 404, known ones set the config, normal resets', async () => {
  assert.equal((await t.call('POST', '/api/mock/scenarios/earthquake')).status, 404);
  const s = await t.call('POST', '/api/mock/scenarios/bureau_slowdown');
  assert.equal(s.status, 200);
  assert.equal(mockState.bureau.multiplier, 5);
  assert.equal(mockState.bureau.timeoutRate, 0.35);
  assert.equal(mockState.kyc.multiplier, 1, 'kyc untouched by a bureau scenario');
  await t.call('POST', '/api/mock/scenarios/kyc_outage');
  assert.equal(mockState.kyc.errorRate, 1);
  assert.equal(mockState.bureau.multiplier, 5, 'a kyc scenario leaves bureau as it was');
  await t.call('POST', '/api/mock/scenarios/normal');
  assert.equal(mockState.bureau.multiplier, 1);
  assert.equal(mockState.kyc.errorRate, 0.003);
  const st = await t.call('GET', '/api/mock/status?minutes=5');
  assert.equal(st.status, 200);
  assert.ok(st.body.scenarios.bureau_outage);
  assert.equal((await t.call('GET', '/api/mock/status?minutes=0')).status, 400);
});

async function journeys(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const a = await t.call('POST', '/api/applications', applicant);
    const id = a.body.id;
    ids.push(id);
    await t.call('POST', `/api/applications/${id}/kyc`);
    await t.call('POST', `/api/applications/${id}/eligibility`);
    await t.call('POST', `/api/applications/${id}/offer`);
  }
  return ids;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fallbackCount = async (ids) => (await t.pool.query("select count(*)::int n from applications where id = any($1) and 'BUREAU_UNAVAILABLE' = any(reason_codes)", [ids])).rows[0].n;
const bureauCalls = async (ids) => (await t.pool.query("select latency_ms, status from api_calls where provider = 'bureau' and application_id = any($1)", [ids])).rows;
const steady = () => {
  mockState.kyc.forceVerified = true; mockState.kyc.errorRate = 0; mockState.kyc.timeoutRate = 0;
  Object.assign(mockState.bureau, { forceScore: 780, errorRate: 0, timeoutRate: 0 });
};

test('a live-injected bureau slowdown raises recorded latency and produces BUREAU_UNAVAILABLE referrals', async () => {
  const savedScale = config.latencyScale;
  config.latencyScale = 0.02; // closer to the demo setting: scaled latency must be able to exceed the scaled client timeout
  try {
    resetMock();
    steady();
    const N = 15;

    const normalIds = await journeys(N);
    const normal = await bureauCalls(normalIds);
    const normalRef = await fallbackCount(normalIds);
    assert.equal(normalRef, 0, 'no fallback referrals while the bureau is healthy');
    assert.ok(normal.every((r) => r.status === 'ok'));

    // inject the incident through the API, as the workbench would
    assert.equal((await t.call('POST', '/api/mock/scenarios/bureau_slowdown')).status, 200);
    mockState.bureau.forceScore = 780; // keep the score fixed so only the incident can cause a referral
    const slowIds = await journeys(N);
    const slow = await bureauCalls(slowIds);
    const slowRef = await fallbackCount(slowIds);

    const mNormal = median(normal.map((r) => r.latency_ms));
    const mSlow = median(slow.map((r) => r.latency_ms));
    console.log(`# live injection: bureau median recorded latency ${mNormal} ms -> ${mSlow} ms; BUREAU_UNAVAILABLE referrals ${normalRef}/${N} -> ${slowRef}/${N}; failed calls ${slow.filter((r) => r.status !== 'ok').length}/${slow.length}`);
    assert.ok(mSlow > mNormal * 1.5, `median latency ${mNormal} -> ${mSlow}`);
    assert.ok(slow.some((r) => r.status === 'timeout'), 'timeouts are recorded');
    assert.ok(slowRef >= 5, `fallback referrals under the slowdown: ${slowRef}/${N}`);

    // the status view reports what was recorded
    const st = (await t.call('GET', '/api/mock/status?minutes=15')).body.recorded;
    const b = st.providers.find((p) => p.provider === 'bureau');
    assert.ok(b.p95_ms >= b.p50_ms && b.timeouts >= 1);
    assert.equal(st.bureau_unavailable_referrals, slowRef);

    // recovery: back to normal removes the fallback
    await t.call('POST', '/api/mock/scenarios/normal');
    steady();
    assert.equal(await fallbackCount(await journeys(5)), 0);
  } finally {
    config.latencyScale = savedScale;
    resetMock();
  }
});

test('live-load script: runs journeys through the real API and reports the tally', async () => {
  resetMock();
  const { stdout } = await run('node', [script, '--base', t.base, '--n', '12', '--concurrency', '3', '--seed', '7'], { timeout: 120000 });
  assert.match(stdout, /synthetic/i);
  const tally = tallyOf(stdout);
  assert.equal(tally.started, 12);
  assert.equal(tally.errors, 0);
  assert.ok((await t.pool.query('select count(*)::int n from applications')).rows[0].n >= 12);
});

test('live-load script: injects a scenario mid-run and switches it off again', async () => {
  resetMock();
  const { stdout } = await run('node', [script, '--base', t.base, '--n', '24', '--concurrency', '2', '--seed', '9', '--scenario', 'bureau_outage', '--from', '0', '--to', '24'], { timeout: 120000 });
  assert.match(stdout, /scenario "bureau_outage" ON/);
  const tally = tallyOf(stdout);
  assert.ok(tally.bureau_unavailable >= 3, `outage fallbacks: ${tally.bureau_unavailable}`);
  assert.equal(mockState.bureau.errorRate, 0.003, 'scenario is switched off at the end');
});

test('live-load script: clear failure when the API is not running or arguments are bad', async () => {
  await assert.rejects(
    run('node', [script, '--base', 'http://127.0.0.1:1', '--n', '1'], { timeout: 30000 }),
    (e) => e.code === 1 && /API not reachable/.test(e.stderr),
  );
  await assert.rejects(run('node', [script, '--n', '0']), (e) => e.code === 2);
});
