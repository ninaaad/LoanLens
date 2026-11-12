# Compliance RAG: evaluation

Corpus: Reserve Bank of India (Digital Lending) Directions, 2025 (RBI/2025-26/36, 8 May 2025). **The PDF is stamped "Withdrawn"**; answers are for demonstration, may not reflect the instruction currently in force, and are not legal advice.

Raw numbers are regenerated on every `npm test` into [`RAG_EVAL_RESULTS.json`](RAG_EVAL_RESULTS.json). The numbers below were copied from that file after the run on 24 Oct 2026.

## Method
- **Corpus:** 99 chunks (clauses 1 to 30 split on sub-paragraph (i), (ii), ...; paragraphs over 1,000 characters that contain lettered items are split per item; Annex I, II (per illustration) and III). Footnotes, page numbers and the "Withdrawn" watermark fragments are removed. Extraction used `pdftotext -layout`; the `pdf-parse` fallback produces the identical 99 chunk keys (checked).
- **Eval set:** 20 in-scope questions in `server/test/rag_eval.json`, each with the expected clause and sub-paragraph, written from a read of the Directions **before any retrieval was run**, plus 6 out-of-scope questions (repo rate, bread, cricket, cheques, demat account, weather) that should be refused.
- **Hit@k:** the expected clause (or clause and paragraph) appears in the top k of 5 retrieved chunks.

## Results (20 questions)

| Ranker | Clause hit@1 | Clause hit@3 | Para hit@1 | Para hit@3 |
|---|---|---|---|---|
| `ts_rank_cd` (Postgres cover density, first baseline) | 55% (11/20) | 85% (17/20) | 50% | 80% |
| **BM25 over the same FTS candidates (default)** | **85% (17/20)** | **90% (18/20)** | **80%** | **90%** |

Out-of-scope questions refused ("Not found in the Directions"): **6 of 6** with the BM25 threshold (0.35).

### Misses (BM25)
- *"What do regulated entities have to report to RBI about their digital lending apps, and on which portal?"* expected Clause 17 (i); top result was Clause 3 (Applicability). Clause 17 is not in the top 3. Generic words match the definition and applicability text more strongly than the specific "CIMS portal" paragraph, which the question does not name.
- *"What is the maximum cover allowed under a default loss guarantee arrangement?"* expected Clause 23 (i); top was Clause 4 (ii), the definition. Clauses 22 to 26 say "DLG", the definition spells out "Default Loss Guarantee", and lexical search does not connect the two. Not fixed (a synonym list would be tuning to this question set).
- Clause hit@1 also misses *"In what forms can a default loss guarantee be accepted"* (Clause 22 ranked 2nd, behind the same definition).

## What was tuned, and when (read before quoting these numbers)
1. First ranker: `ts_rank_cd`, as the spec says. Result: 55% hit@1, and the Preamble (Clause 1) and Annex II illustration text ranked first for many questions because the ranker has no inverse-document-frequency weighting.
2. **After seeing those results** I added the BM25 re-rank over the same candidates, and I set the refusal threshold (0.35) from this same set: the highest out-of-scope score was 0.341 and the lowest correct in-scope top score was 0.361. The questions were **not** edited after seeing results.
3. Consequences: the BM25 and threshold figures are **optimistic**, because the design was shaped by looking at this set, and the margin around the threshold is thin (0.341 vs 0.361). Twenty questions also give wide error bars: one question is 5 points. Treat the numbers as a regression guard, not as expected real-world accuracy.
4. `npm test` guards against regressions with floors under the measured numbers (clause hit@3 at least 80%, hit@1 at least 70%, out-of-scope refusal at least 80%, BM25 not worse than the baseline).

## Limits
- Lexical only, no embeddings; vocabulary mismatch (like DLG) will always miss.
- Extractive: the answer is the stored paragraph text. The optional LLM rewrite (S6) may only rephrase the retrieved text and cannot change what is found.
- Footnotes (which cite circulars) are dropped from the corpus.
- Annex II's numeric illustration table is garbled by text extraction; it should not be relied on.

## Held-out set (added 4 Nov 2026): how it does on questions it was not shaped around
`server/test/rag_heldout.json` holds 20 more in-scope questions and 6 more out-of-scope ones. I wrote them from a read of the Directions **after** the BM25 ranker and the 0.35 threshold were fixed, and did not run them before saving the file. They are not used for tuning, and misses are reported, not fixed by editing the questions. They are regenerated into [`RAG_EVAL_RESULTS.json`](RAG_EVAL_RESULTS.json) (`held_out_*`) on every test run.

| Ranker | Clause hit@1 | Clause hit@3 | Para hit@1 |
|---|---|---|---|
| `ts_rank_cd` (first baseline) | 25% (5/20) | 60% (12/20) | 20% |
| **BM25 (default)** | **85% (17/20)** | **90% (18/20)** | 70% |

In-scope questions answered (not refused): 95% (19/20). **Out-of-scope refused: 4 of 6 (67%)**, against 6 of 6 on the tuning set.

- The ranking numbers match the tuning set (85% and 90%), which is the evidence that the ranker was not just fitted to those 20 questions. The caveat on the first set's figures still applies to its refusal threshold.
- **Refusal is the weak spot.** "What is the maximum tenure of a home loan?" (score 0.37) and "What is the capital of France?" (0.64) were answered, because the Directions contain "tenure" and "capital" ("regulatory capital"), and a lexical search cannot see that the question is about something else. The scores of wrong answers (0.37, 0.64) overlap those of correct in-scope answers (as low as 0.30), so no threshold separates them.
- I tried requiring the top chunk to match at least two question terms. It refused "capital of France" but also refused one correct in-scope question and left the tenure question answered, so it was not adopted. Query expansion or a semantic model would be the next step; neither is built.
- Misses at rank 1: "What checks must a lender make on a lending service provider before signing an agreement with it?" (expected Clause 5(ii), top was Clause 6), "Which entities may provide a default loss guarantee..." (expected Clause 18(i), top was the Clause 4(ii) definition) and the credit-guarantee-scheme exclusions (Clause 28 ranked 2nd behind Clause 20(ii)).
- 20 questions is still a small sample: one question is 5 points.
