// Every bad request gets a 4xx JSON error { error }, never a 500 and never a stack trace, SQL or file path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { boot, applicant } from './helpers.js';
import { wrap } from '../src/journey/routes.js';
import { seedDatabase } from '../src/data/seed.js';
import { parseId, parseDay, shortString, optionalInt, bodyObject, queryValue, rulesetErrors, applicationInput } from '../src/http/validate.js';
import { RULESET_V2 } from '../src/rules/defaultRules.js';

let t;
before(async () => {
  t = await boot({
    extraRoutes: (pool) => {
      const r = express.Router();
      r.get('/sync', () => { throw new Error('secret: SELECT * FROM applications at C:\\Users\\admin\\app.js:12'); });
      r.get('/async', wrap(async () => { throw new Error('secret async failure /home/app/db.js'); }));
      r.get('/pg-range', async (_q, _s, next) => { try { await pool.query("select 'abc'::int"); } catch (e) { next(e); } });
      r.get('/pg-dup', async (_q, _s, next) => { try { await pool.query("insert into rule_versions(version, effective_from, config) values ('v1', now(), '{}')"); } catch (e) { next(e); } });
      return [['/boom', r]];
    },
  });
  await seedDatabase(t.pool, { perDay: 60, days: 20 });
});
after(async () => t?.close());

const LEAKS = /\bstack\b|node_modules|\n\s*at |\sat [\w.$<>]+ \(|C:\\|\/home\/|select \*|SyntaxError|TypeError|invalid input syntax/i;
/** The response is a client error with the one JSON shape and nothing internal in it. */
function assertClientError(r, status, re, what = '') {
  assert.equal(r.status, status, `${what} -> ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(typeof r.body.error, 'string', what);
  assert.ok(!LEAKS.test(JSON.stringify(r.body)), `${what} leaks: ${JSON.stringify(r.body)}`);
  if (re) assert.match(r.body.error, re, what);
}
const raw = (method, url, body, headers = { 'content-type': 'application/json' }) => fetch(t.base + url, { method, headers, body });

// ---------- the error contract ----------

test('unknown API and mock paths return a JSON 404', async () => {
  for (const [m, u] of [['GET', '/api/nope'], ['POST', '/api/applications/1/nope'], ['GET', '/mock/nope'], ['DELETE', '/api/rules']]) {
    const res = await raw(m, u);
    assert.equal(res.status, 404, u);
    assert.match(res.headers.get('content-type'), /json/);
    assert.match((await res.json()).error, /no such endpoint/);
  }
});

test('malformed JSON and oversized bodies are client errors', async () => {
  const bad = await raw('POST', '/api/applications', '{"age": 34,');
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.error, 'request body is not valid JSON');
  assert.ok(!LEAKS.test(JSON.stringify(body)));
  const big = await raw('POST', '/api/simulate', JSON.stringify({ candidate: 'v2', pad: 'x'.repeat(1_100_000) }));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, 'request body is too large');
});

test('server faults return a generic 500 with nothing internal in it', async () => {
  const quiet = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    for (const path of ['/boom/sync', '/boom/async']) {
      const r = await t.call('GET', path);
      assert.equal(r.status, 500, path);
      assert.deepEqual(r.body, { error: 'internal server error' }, path);
    }
  } finally {
    console.error = quiet;
  }
  assert.equal(logged.length, 2, 'the real error is logged on the server');
  assert.match(String(logged[0][0].message), /secret/);
});

test('database data errors map to 400 and 409 without leaking SQL', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assertClientError(await t.call('GET', '/boom/pg-range'), 400, /malformed or out of range/);
    assertClientError(await t.call('GET', '/boom/pg-dup'), 409, /already exists/);
  } finally {
    console.error = quiet;
  }
});

test('responses do not advertise the framework, and health works', async () => {
  const res = await raw('GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.deepEqual(await res.json(), { ok: true });
});

// ---------- journey ----------

test('application ids that cannot exist are 404s, not 500s', async () => {
  for (const id of ['abc', '0', '-1', '1.5', '99999999999', '2147483648', '1e3', '%20', 'null', '999999']) {
    for (const [m, suffix] of [['GET', ''], ['POST', '/kyc'], ['POST', '/eligibility'], ['POST', '/offer'], ['POST', '/accept']]) {
      assertClientError(await t.call(m, `/api/applications/${encodeURIComponent(id)}${suffix}`), 404, /not found/, `${m} ${id}${suffix}`);
    }
  }
});

test('creating an application rejects wrong types, lengths and shapes', async () => {
  const bad = [
    [[], /number between|JSON object/],
    ['text', null],
    [{ ...applicant, age: 'abc' }, /age/],
    [{ ...applicant, age: 17 }, /age/],
    [{ ...applicant, monthly_income: null }, /monthly_income/],
    [{ ...applicant, requested_amount: 5 }, /requested_amount/],
    [{ ...applicant, tenure_months: 1000 }, /tenure_months/],
    [{ ...applicant, existing_emi: -1 }, /existing_emi/],
    [{ ...applicant, device: { evil: true } }, /device/],
    [{ ...applicant, channel: 'x'.repeat(41) }, /channel/],
    [{ ...applicant, employment: '' }, /employment/],
    [{ ...applicant, app_version: 'a\u0000b' }, /app_version/],
    [{ ...applicant, variant: 5 }, /variant/],
    [{ ...applicant, new_to_credit: 'yes' }, /new_to_credit/],
  ];
  for (const [body, re] of bad) {
    const r = await raw('POST', '/api/applications', JSON.stringify(body));
    const out = { status: r.status, body: await r.json() };
    assertClientError(out, 400, re ?? undefined, JSON.stringify(body));
  }
  const ok = await t.call('POST', '/api/applications', applicant);
  assert.equal(ok.status, 201);
  const minimal = await t.call('POST', '/api/applications', { age: 30, monthly_income: 50000, requested_amount: 100000, tenure_months: 12 });
  assert.equal(minimal.status, 201, 'optional fields keep their defaults');
});

test('POST /api/rules validates every field and refuses duplicates; nothing bad is stored', async () => {
  const good = { version: 'v3-test', effective_from: '2099-01-01T00:00:00Z', note: 'future ruleset', config: { ...RULESET_V2.config, version: 'v3-test' } };
  const bad = [
    [[], /JSON object/],
    [{ ...good, version: undefined }, /version/],
    [{ ...good, version: 'v'.repeat(41) }, /version/],
    [{ ...good, effective_from: 'next tuesday' }, /effective_from/],
    [{ ...good, effective_from: 20260101 }, /effective_from/],
    [{ ...good, note: 42 }, /note/],
    [{ ...good, note: 'n'.repeat(501) }, /note/],
    [{ ...good, config: undefined }, /ruleset is invalid/],
    [{ ...good, config: 'v2' }, /ruleset is invalid/],
    [{ ...good, config: { ...good.config, rules: [{ ...good.config.rules[0], value: null }] } }, /ruleset is invalid/],
    [{ ...good, config: { ...good.config, rules: [{ ...good.config.rules[0], field: 5 }] } }, /ruleset is invalid/],
    [{ ...good, config: { ...good.config, pricing: [{ minScore: 'high', rate: 0.1 }] } }, /ruleset is invalid/],
    [{ ...good, config: { ...good.config, maxLoanIncomeMultiple: 0 } }, /ruleset is invalid/],
  ];
  for (const [body, re] of bad) {
    const r = await raw('POST', '/api/rules', JSON.stringify(body));
    const out = { status: r.status, body: await r.json() };
    assertClientError(out, 400, re, JSON.stringify(body).slice(0, 80));
  }
  const detail = (await t.call('POST', '/api/rules', { ...good, config: { rules: [] } })).body;
  assert.ok(Array.isArray(detail.errors) && detail.errors.length, 'reasons are listed under "errors"');
  assert.deepEqual((await t.call('GET', '/api/rules')).body.map((r) => r.version), ['v1', 'v2']);

  assert.equal((await t.call('POST', '/api/rules', good)).status, 201);
  assertClientError(await t.call('POST', '/api/rules', good), 409, /already exists/);
  assert.deepEqual((await t.call('GET', '/api/rules')).body.map((r) => r.version), ['v1', 'v2', 'v3-test']);
});

// ---------- analytics ----------

test('funnel, rca, simulate and reseed reject bad query strings and bodies', async () => {
  const get = [
    ['/api/funnel?from=10/10/2026', /from/],
    ['/api/funnel?from=2026-02-30', /not a valid calendar date/],
    ['/api/funnel?to=tomorrow', /to/],
    ['/api/funnel?from=2026-10-12&to=2026-10-01', /after/],
    ['/api/funnel?segment=password', /segment must be one of/],
    ['/api/funnel?segment=__proto__&value=x', /segment must be one of/],
    ['/api/funnel?value=android', /needs a segment/],
    ['/api/funnel?segment=device&segment=channel', /once/],
    ['/api/funnel?from=2026-10-01&from=2026-10-02', /once|from/],
    [`/api/funnel?segment=device&value=${'x'.repeat(101)}`, /at most/],
    ['/api/rca', /day/],
    ['/api/rca?day=2026-13-45&step=offer_viewed', /day/],
    ['/api/rca?day=2026-10-13', /step must be one of/],
    ['/api/rca?day=2026-10-13&step=application_started', /step must be one of/],
    ['/api/rca?day=2026-10-13&step=offer_viewed&step=kyc_completed', /once/],
    ['/api/rca?day[]=2026-10-13&step=offer_viewed', /day/],
  ];
  for (const [url, re] of get) assertClientError(await t.call('GET', url), 400, re, url);

  for (const [body, re] of [
    [{ seed: 'abc' }, /seed/], [{ seed: -1 }, /seed/], [{ seed: 1.5 }, /seed/],
    [{ perDay: 0 }, /perDay/], [{ perDay: 1e9 }, /perDay/], [{ perDay: '100' }, /perDay/], [[1, 2], /JSON object/],
  ]) {
    const r = await raw('POST', '/api/admin/reseed', JSON.stringify(body));
    assertClientError({ status: r.status, body: await r.json() }, 400, re, JSON.stringify(body));
  }
  const arr = await raw('POST', '/api/simulate', '[]');
  assertClientError({ status: arr.status, body: await arr.json() }, 400, /JSON object/);
  // the data survived all of that
  assert.ok((await t.pool.query('select count(*)::int n from applications where id > 0')).rows[0].n > 500);
});

test('a missing-data day is a 422 with a message, not a 500', async () => {
  assertClientError(await t.call('GET', '/api/rca?day=2020-01-01&step=offer_viewed'), 422, /not enough data/);
});

// ---------- the other routers keep their contract ----------

test('compliance, experiments and mock controls return the same error shape', async () => {
  assertClientError(await t.call('POST', '/api/compliance/ask', { question: 'x' }), 400, /question/);
  assertClientError(await t.call('POST', '/api/compliance/ask', {}), 400, /question/);
  assertClientError(await t.call('GET', '/api/experiments/nope/analysis'), 404);
  assertClientError(await t.call('POST', '/api/experiments', { key: 'x' }), 400);
  assertClientError(await t.call('POST', '/api/mock/config', { provider: 'bureau', multiplier: -5 }), 400);
  assertClientError(await t.call('POST', '/api/mock/scenarios/nope'), 404);
  assertClientError(await t.call('POST', '/mock/config', { provider: 'nope' }), 400);
});

// ---------- the helpers ----------

test('validators: ids, days, strings, integers, bodies, query values', () => {
  assert.equal(parseId('42'), 42);
  for (const v of ['0', '-3', 'x', '1.5', '', '99999999999', undefined, ['1']]) assert.throws(() => parseId(v), (e) => e.status === 404, String(v));

  assert.equal(parseDay('2026-10-13', 'd'), '2026-10-13');
  assert.equal(parseDay('2024-02-29', 'd'), '2024-02-29');
  assert.equal(parseDay(undefined, 'd'), undefined);
  for (const v of ['2026-02-29', '2026-00-10', '2026-10-32', '26-10-13', '2026-10-13T00:00', 5, ['2026-10-13']]) assert.throws(() => parseDay(v, 'd'), (e) => e.status === 400, String(v));
  assert.throws(() => parseDay(undefined, 'd', { required: true }), /required/);

  assert.equal(shortString(' android ', 'device'), 'android');
  assert.equal(shortString(undefined, 'device', { fallback: 'web' }), 'web');
  assert.throws(() => shortString(undefined, 'device'), /required/);
  for (const v of ['', '   ', 'x'.repeat(41), 7, {}, 'a\nb']) assert.throws(() => shortString(v, 'device'), (e) => e.status === 400);

  assert.equal(optionalInt(undefined, 'n', 1, 5), undefined);
  assert.equal(optionalInt(3, 'n', 1, 5), 3);
  for (const v of [0, 6, 2.5, '3', NaN, Infinity]) assert.throws(() => optionalInt(v, 'n', 1, 5), /integer from 1 to 5/);

  assert.deepEqual(bodyObject(undefined), {});
  assert.throws(() => bodyObject(undefined, { allowEmpty: false }), /required/);
  for (const v of [[], 'x', 5]) assert.throws(() => bodyObject(v), /JSON object/);

  assert.equal(queryValue('a', 'q'), 'a');
  assert.throws(() => queryValue(['a', 'b'], 'q'), /once/);
  assert.throws(() => queryValue({ a: 1 }, 'q'), /once/);

  assert.deepEqual(rulesetErrors(RULESET_V2.config), []);
  assert.ok(rulesetErrors(null).length);
  assert.ok(rulesetErrors({ rules: 'x', pricing: [] }).length);
  assert.equal(applicationInput({}).device, 'web');
});

test('strandedPostgres picks only this project\'s postgres.exe processes whose parent is gone', async () => {
  const { strandedPostgres } = await import('../src/db/connection.js');
  const home = 'C:/Users/admin/Desktop/LoanLens'; // either slash style works
  const mine = `"C:/Users/admin/Desktop/LoanLens/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe" --forkchild="startup" 5876`;
  const procs = [
    { pid: 1, ppid: 0, name: 'System', cmd: '' },
    { pid: 10, ppid: 1, name: 'postgres.exe', cmd: mine },                                   // parent 1 is alive: a running server
    { pid: 11, ppid: 999, name: 'postgres.exe', cmd: mine },                                  // parent gone: stranded
    { pid: 12, ppid: 999, name: 'postgres.exe', cmd: 'C:/Program Files/PostgreSQL/16/bin/postgres.exe -D data' }, // someone else's postgres
    { pid: 13, ppid: 999, name: 'postgres.exe', cmd: mine.replace('LoanLens', 'OtherApp') },  // another project's embedded postgres
    { pid: 14, ppid: 999, name: 'node.exe', cmd: mine },                                      // not postgres
  ];
  assert.deepEqual(strandedPostgres(procs, home), [11]);
  assert.deepEqual(strandedPostgres([], home), []);
});

test('hardening headers are on every response, and framing and sniffing are refused', async () => {
  for (const path of ['/api/health', '/api/nope', '/api/funnel']) {
    const res = await raw('GET', path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path);
  }
});

test('the application resource never exposes the synthetic ground truth', async () => {
  const a = await t.call('POST', '/api/applications', applicant);
  const got = (await t.call('GET', `/api/applications/${a.body.id}`)).body;
  for (const k of ['bureau_score_latent', 'default_prob', 'would_default']) assert.ok(!(k in got.application), k);
  const seeded = (await t.call('GET', '/api/applications/1')).body;
  for (const k of ['bureau_score_latent', 'default_prob', 'would_default']) assert.ok(!(k in seeded.application), `seeded ${k}`);
  assert.equal(seeded.application.is_synthetic, true);
  assert.ok('requested_amount' in seeded.application, 'the applicant still sees their own inputs');
});

test('analytics results are cached but never stale: a new application shows up in the funnel at once', async () => {
  const before = (await t.call('GET', '/api/funnel')).body.total.counts.application_started;
  assert.equal((await t.call('GET', '/api/funnel')).body.total.counts.application_started, before, 'cached read is identical');
  await t.call('POST', '/api/applications', applicant);
  assert.equal((await t.call('GET', '/api/funnel')).body.total.counts.application_started, before + 1);
  // identical requests that arrive together share one query and agree
  const parallel = await Promise.all([1, 2, 3, 4, 5].map(() => t.call('GET', '/api/funnel')));
  assert.equal(new Set(parallel.map((r) => r.body.total.counts.application_started)).size, 1);
});

test('the built app shell is served for pages, and a missing file is a real 404', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { config } = await import('../src/config.js');
  if (!fs.existsSync(path.join(config.root, 'web', 'dist'))) return; // no build in this checkout: nothing to serve
  const page = await raw('GET', '/workbench/funnel');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  for (const missing of ['/assets/does-not-exist.js', '/.env', '/favicon-nope.ico']) {
    const res = await raw('GET', missing);
    assert.equal(res.status, 404, missing);
    assert.doesNotMatch(res.headers.get('content-type') ?? '', /text\/html/, missing);
  }
});
