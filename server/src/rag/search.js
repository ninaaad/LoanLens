// Retrieval over rag_chunks with Postgres full-text search. No embeddings: an honest lexical approach.
//
// Two rankers over the same candidate set (chunks whose tsvector matches the OR-ed query):
//   'ts_rank_cd'  Postgres cover-density rank. The first baseline; it has no inverse-document-frequency weighting,
//                 so common words ("borrower", "digital", "lending") let long generic chunks win.
//   'bm25'        (default) BM25 over the same lexemes, with IDF computed from the stored corpus (ts_stat).
// docs/RAG_EVAL.md reports both, measured on the same labelled questions.

const K1 = 1.2;
const B = 0.75;

/**
 * Natural-language questions rarely contain every word of the answer, so the AND query that
 * websearch_to_tsquery builds finds nothing. We keep its parsing (stop words, stemming, quoted phrases,
 * "-negation") and join the terms with OR; ranking then decides what comes first.
 */
export async function buildQuery(pool, question) {
  const { rows } = await pool.query("select websearch_to_tsquery('english', $1)::text as q", [question]);
  const q = rows[0].q;
  return q ? q.replace(/ & /g, ' | ') : null;
}

// Single letters ("a", "b", "(c)") are list markers in the Directions, not content: a question made only of them must not match.
const lexemesOf = (query) => [...new Set([...query.matchAll(/(?<![!])'([^']+)'/g)].map((m) => m[1]))].filter((w) => !/^[a-z]$/i.test(w));

/** tsvector::text looks like  'borrow':3,17 'exit':9  ->  Map(lexeme -> occurrences) */
function termCounts(tsvText) {
  const m = new Map();
  for (const part of tsvText.matchAll(/'((?:[^']|'')+)'(?::([\d,A-D]+))?/g)) {
    m.set(part[1].replace(/''/g, "'"), part[2] ? part[2].split(',').length : 1);
  }
  return m;
}

export async function search(pool, question, { limit = 5, mode = 'bm25' } = {}) {
  const query = await buildQuery(pool, question);
  if (!query) return [];
  const cols = 'id, doc_id, doc_title, chapter, clause, para, heading, content';

  if (mode === 'ts_rank_cd') {
    // heading words weighted above body words; normalisation 32 puts the rank in 0..1 (rank / (rank + 1))
    const { rows } = await pool.query(
      `select ${cols},
              ts_rank_cd(setweight(to_tsvector('english', coalesce(heading, '')), 'B') || setweight(to_tsvector('english', content), 'C'),
                         to_tsquery('english', $1), 32)::float8 as rank
         from rag_chunks where tsv @@ to_tsquery('english', $1) order by rank desc, id limit $2`,
      [query, limit],
    );
    return rows;
  }

  const lex = lexemesOf(query);
  if (!lex.length) return [];
  // The corpus is ~100 chunks, so document frequency and lengths are computed in JS from one fetch.
  const { rows: all } = await pool.query(`select ${cols}, tsv::text as tsv_text from rag_chunks`);
  const docs = all.map((r) => {
    const counts = termCounts(r.tsv_text);
    return { row: r, counts, len: [...counts.values()].reduce((x, y) => x + y, 0) };
  });
  const N = docs.length;
  const avgLen = docs.reduce((x, d) => x + d.len, 0) / (N || 1);
  const idf = (w) => {
    const df = docs.filter((d) => d.counts.has(w)).length;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };
  const weights = new Map(lex.map((w) => [w, idf(w)]));
  const total = [...weights.values()].reduce((x, y) => x + y, 0) || 1;
  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const [w, wt] of weights) {
      const tf = d.counts.get(w) ?? 0;
      if (tf) s += wt * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (d.len / avgLen))));
    }
    if (s > 0) {
      const { tsv_text, ...row } = d.row;
      // divide by the summed IDF of the query terms: roughly "share of the question's informative words found", 0..~1
      scored.push({ ...row, rank: s / total });
    }
  }
  return scored.sort((x, y) => y.rank - x.rank || x.id - y.id).slice(0, limit);
}

export function citationLabel(c) {
  if (c.clause.startsWith('Annex')) return c.para ? `${c.clause}, ${c.para}` : c.clause;
  return c.para ? `${c.clause}, para ${c.para}` : c.clause;
}
