import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from './helpers.js';
import { ingest, extractText, cleanText, chunkLines } from '../src/rag/ingest.js';
import { ask, NOTICE } from '../src/rag/answer.js';
import { evaluateRetrieval } from '../src/rag/evaluate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const evalSet = JSON.parse(fs.readFileSync(path.join(here, 'rag_eval.json'), 'utf8'));
const heldOut = JSON.parse(fs.readFileSync(path.join(here, 'rag_heldout.json'), 'utf8'));
let t;
let chunks;

before(async () => {
  t = await boot();
  chunks = chunkLines(cleanText((await extractText()).text));
  await ingest(t.pool);
});
after(async () => t?.close());

test('every clause 1-30 and the three annexes are present, in order, with no watermark residue', () => {
  const clauses = [...new Set(chunks.map((c) => c.clause))];
  assert.deepEqual(clauses, [...Array.from({ length: 30 }, (_, i) => `Clause ${i + 1}`), 'Annex I', 'Annex II', 'Annex III']);
  for (const c of chunks) {
    assert.ok(c.content.length > 20, `${c.clause} ${c.para} is too short`);
    assert.doesNotMatch(c.content, /\b(ithdr|ithd|ithdra|Withd)\b/, `${c.clause} ${c.para}`);
    assert.doesNotMatch(c.content, /�/);
  }
  assert.ok(chunks.every((c) => c.doc_id === 'RBI/2025-26/36'));
});

test('paragraphs are split on roman numerals, and the watermark does not glue paragraphs together', () => {
  const get = (clause, para) => chunks.find((c) => c.clause === clause && c.para === para);
  assert.match(get('Clause 10', '(i)').content, /cooling-off period/);
  assert.match(get('Clause 10', '(ii)').content, /one-time processing fee/);
  assert.match(get('Clause 26', '(i)').content, /120 days/);
  assert.match(get('Clause 26', '(ii)').content, /longest tenor/); // "With ii." in the raw text
  assert.doesNotMatch(get('Clause 26', '(i)').content, /longest tenor/);
  assert.equal(chunks.filter((c) => c.clause === 'Clause 17').length, 7);
});

test('footnotes and page numbers are not part of clause text', () => {
  const all = chunks.map((c) => c.content).join('\n');
  assert.doesNotMatch(all, /Notification CEPD\. PRD/); // footnote 10 under Clause 11
  assert.doesNotMatch(all, /Outsourcing of Financial Services - Responsibilities of regulated/); // footnote 2 under Clause 5
});

test('ingestion is idempotent', async () => {
  const count = async () => (await t.pool.query('select count(*)::int n from rag_chunks')).rows[0].n;
  const first = await count();
  const again = await ingest(t.pool);
  assert.equal(await count(), first);
  assert.equal(again.chunks, first);
  assert.equal(first, chunks.length);
});

test('the answer to a question is the retrieved text itself, with a citation and the mandatory notice', async () => {
  const a = await ask(t.pool, 'Can a borrower exit a digital loan during the cooling-off period without penalty?');
  assert.equal(a.found, true);
  assert.equal(a.mode, 'extractive');
  assert.equal(a.citations[0].label, 'Clause 10, para (i)');
  const chunk = chunks.find((c) => c.clause === 'Clause 10' && c.para === '(i)');
  assert.ok(a.answer.includes(chunk.content), 'answer quotes the stored text verbatim');
  assert.match(a.notice, /RBI\/2025-26\/36/);
  assert.match(a.notice, /Withdrawn/);
  assert.match(a.notice, /not legal advice/i);
});

test('out-of-scope questions get "Not found" and still carry the notice', async () => {
  for (const q of ['How do I bake sourdough bread at home?', 'What is the current repo rate set by the central bank?']) {
    const a = await ask(t.pool, q);
    assert.equal(a.found, false, q);
    assert.match(a.answer, /Not found in the Directions/);
    assert.deepEqual(a.citations, []);
    assert.equal(a.notice, NOTICE);
  }
});

test('API: ask, sources, and input validation', async () => {
  const ok = await t.call('POST', '/api/compliance/ask', { question: 'Into whose bank account must a loan be disbursed?' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.found, true);
  assert.ok(ok.body.notice);
  assert.equal((await t.call('POST', '/api/compliance/ask', {})).status, 400);
  assert.equal((await t.call('POST', '/api/compliance/ask', { question: 'x'.repeat(501) })).status, 400);
  assert.equal((await t.call('POST', '/api/compliance/ask', { question: 42 })).status, 400);
  const src = await t.call('GET', '/api/compliance/sources');
  assert.equal(src.status, 200);
  assert.equal(src.body.doc_id, 'RBI/2025-26/36');
  assert.equal(src.body.status_in_pdf, 'Withdrawn');
  assert.equal(src.body.chunks, chunks.length);
  assert.match(src.body.notice, /not legal advice/i);
});

test('retrieval eval: 20 labelled questions, hit@1 / hit@3 measured and written to docs/RAG_EVAL_RESULTS.json', async () => {
  assert.equal(evalSet.in_scope.length, 20);
  const bm25 = await evaluateRetrieval(t.pool, evalSet, { mode: 'bm25' });
  const baseline = await evaluateRetrieval(t.pool, evalSet, { mode: 'ts_rank_cd' });
  // the second set was written after the design was fixed and is not used for tuning: it says how the system does on unseen questions
  assert.equal(heldOut.in_scope.length, 20);
  const heldBm25 = await evaluateRetrieval(t.pool, heldOut, { mode: 'bm25' });
  const heldBaseline = await evaluateRetrieval(t.pool, heldOut, { mode: 'ts_rank_cd' });
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  for (const r of [bm25, baseline]) {
    console.log(`# RAG eval [${r.mode}] clause hit@1 ${pct(r.clause_hit_at_1)}, hit@3 ${pct(r.clause_hit_at_3)}; para hit@1 ${pct(r.para_hit_at_1)}, hit@3 ${pct(r.para_hit_at_3)}; out-of-scope refused ${r.out_of_scope_refused === null ? 'n/a' : pct(r.out_of_scope_refused)}`);
    for (const m of r.misses_at_3) console.log(`#   miss@3: "${m.q}" expected ${m.expected}, top was ${m.top}`);
  }
  fs.writeFileSync(
    path.join(here, '..', '..', 'docs', 'RAG_EVAL_RESULTS.json'),
    JSON.stringify({ generated_by: 'server/test/rag.test.js', note: 'bm25 and ts_rank_cd_baseline: the 20 tuning questions in server/test/rag_eval.json. held_out_*: a second set of 20 in rag_heldout.json, written after the design was fixed and never used for tuning. Regenerated on every test run.', bm25, ts_rank_cd_baseline: baseline, held_out_bm25: heldBm25, held_out_ts_rank_cd_baseline: heldBaseline }, null, 2),
  );
  // Regression guards (floors under the measured numbers), not claims of quality.
  assert.ok(bm25.clause_hit_at_3 >= 0.8, `clause hit@3 fell to ${pct(bm25.clause_hit_at_3)}`);
  assert.ok(bm25.clause_hit_at_1 >= 0.7, `clause hit@1 fell to ${pct(bm25.clause_hit_at_1)}`);
  assert.ok(bm25.out_of_scope_refused >= 0.8);
  assert.ok(bm25.clause_hit_at_1 >= baseline.clause_hit_at_1, 'BM25 should not be worse than the ts_rank_cd baseline');
  console.log(`# RAG held-out [bm25] clause hit@1 ${pct(heldBm25.clause_hit_at_1)}, hit@3 ${pct(heldBm25.clause_hit_at_3)}; in-scope answered ${pct(heldBm25.in_scope_answered)}; out-of-scope refused ${pct(heldBm25.out_of_scope_refused)}`);
  // floors for the unseen set (a measurement is 85% / 90% at the time of writing); refusal is reported, not asserted: it is the weak spot
  assert.ok(heldBm25.clause_hit_at_3 >= 0.75, `held-out clause hit@3 fell to ${pct(heldBm25.clause_hit_at_3)}`);
  assert.ok(heldBm25.clause_hit_at_1 >= 0.65, `held-out clause hit@1 fell to ${pct(heldBm25.clause_hit_at_1)}`);
  assert.ok(heldBm25.clause_hit_at_1 >= heldBaseline.clause_hit_at_1, 'BM25 should beat the baseline on unseen questions too');
});

test('a question made only of single letters and operators finds nothing', async () => {
  for (const q of ['a:* & b | !c', 'a b c', '(a) (b) (c)']) {
    const r = await ask(t.pool, q);
    assert.equal(r.found, false, q);
  }
  assert.equal((await ask(t.pool, 'cooling-off period')).found, true, 'real words still work');
});
