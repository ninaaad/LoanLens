// Extractive answers: the answer is the retrieved text itself, quoted with citations. Nothing is invented.
import { search, citationLabel } from './search.js';

export const NOTICE =
  'Source: Reserve Bank of India (Digital Lending) Directions, 2025 (RBI/2025-26/36, 8 May 2025). The PDF is stamped '
  + '"Withdrawn", so verify the currently applicable instruction before relying on it. This is not legal advice.';

// Minimum BM25 score, normalised by the summed IDF of the query terms (see search.js), for the best chunk to count as an answer. Tuned on a labelled set of
// in-scope and out-of-scope questions; the procedure and the measured results are in docs/RAG_EVAL.md.
export const MIN_RANK = 0.35;
const MAX_CITATIONS = 3;
const RELATIVE_CUTOFF = 0.5; // extra chunks must score at least this share of the best one

/**
 * @param rewrite optional async (question, citations) => string that may rephrase the quoted text (see S6).
 *   It never decides whether something is found, and the citations are returned unchanged.
 */
export async function ask(pool, question, { rewrite } = {}) {
  const hits = await search(pool, question, { limit: 5 });
  if (!hits.length || hits[0].rank < MIN_RANK) {
    return {
      found: false,
      answer: 'Not found in the Directions. Try rephrasing the question with terms the Directions use, for example "KFS", "cooling-off period", "grievance redressal officer", "DLA" or "LSP".',
      citations: [],
      mode: 'extractive',
      notice: NOTICE,
    };
  }
  const best = hits[0].rank;
  const chosen = hits.filter((h, i) => i === 0 || h.rank >= best * RELATIVE_CUTOFF).slice(0, MAX_CITATIONS);
  const citations = chosen.map((h) => ({
    label: citationLabel(h),
    clause: h.clause,
    para: h.para,
    heading: h.heading,
    chapter: h.chapter,
    quote: h.content,
    rank: Number(h.rank.toFixed(4)),
  }));
  let answer = citations.map((c) => `${c.label} (${c.heading}): "${c.quote}"`).join('\n\n');
  let mode = 'extractive';
  if (rewrite) {
    try {
      const rewritten = await rewrite(question, citations);
      if (rewritten) { answer = rewritten; mode = 'llm-rewrite'; }
    } catch {
      /* fall back to the extractive answer */
    }
  }
  return { found: true, answer, citations, mode, notice: NOTICE };
}
