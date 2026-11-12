// Retrieval evaluation against the labelled question set in test/rag_eval.json.
import { search } from './search.js';
import { MIN_RANK } from './answer.js';

export async function evaluateRetrieval(pool, evalSet, { mode = 'bm25' } = {}) {
  const rows = [];
  for (const e of evalSet.in_scope) {
    const hits = await search(pool, e.q, { limit: 5, mode });
    const clauseRank = hits.findIndex((h) => h.clause === e.clause) + 1; // 0 = not in top 5
    const paraRank = hits.findIndex((h) => h.clause === e.clause && h.para === e.para) + 1;
    rows.push({
      q: e.q, expected: `${e.clause} ${e.para ?? ''}`.trim(), clauseRank, paraRank,
      top: hits[0] ? `${hits[0].clause} ${hits[0].para ?? ''}`.trim() : null, topRank: hits[0]?.rank ?? null,
    });
  }
  const n = rows.length;
  const frac = (f) => rows.filter(f).length / n;
  const oos = [];
  for (const q of evalSet.out_of_scope) {
    const hits = await search(pool, q, { limit: 5, mode });
    oos.push({ q, topRank: hits[0]?.rank ?? null, refused: !hits.length || hits[0].rank < MIN_RANK });
  }
  return {
    mode,
    questions: n,
    clause_hit_at_1: frac((r) => r.clauseRank === 1),
    clause_hit_at_3: frac((r) => r.clauseRank >= 1 && r.clauseRank <= 3),
    para_hit_at_1: frac((r) => r.paraRank === 1),
    para_hit_at_3: frac((r) => r.paraRank >= 1 && r.paraRank <= 3),
    in_scope_answered: mode === 'bm25' ? frac((r) => r.topRank !== null && r.topRank >= MIN_RANK) : null,
    // the refusal threshold is calibrated for BM25 scores, so it is not meaningful for the ts_rank_cd baseline
    out_of_scope_refused: mode === 'bm25' ? oos.filter((o) => o.refused).length / (oos.length || 1) : null,
    out_of_scope_questions: oos.length,
    misses_at_3: rows.filter((r) => !(r.clauseRank >= 1 && r.clauseRank <= 3)),
    misses_at_1: rows.filter((r) => r.clauseRank !== 1),
    rows,
    out_of_scope: oos,
  };
}
