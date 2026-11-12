import express from 'express';
import { wrap } from '../journey/routes.js';
import { HttpError } from '../journey/service.js';
import { ask, NOTICE, MIN_RANK } from './answer.js';
import { DOC } from './ingest.js';
import { getLlm } from '../llm/index.js';

export function ragRouter(pool) {
  const r = express.Router();

  r.post('/ask', wrap(async (req, res) => {
    const question = req.body?.question;
    if (typeof question !== 'string' || question.trim().length < 3) throw new HttpError(400, 'question (text, at least 3 characters) is required');
    if (question.length > 500) throw new HttpError(400, 'question must be 500 characters or fewer');
    const llm = getLlm();
    res.json(await ask(pool, question.trim(), llm.enabled ? { rewrite: llm.rewriteAnswer } : {}));
  }));

  r.get('/sources', wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select clause, heading, chapter, count(*)::int as chunks from rag_chunks where doc_id = $1
        group by clause, heading, chapter order by min(id)`,
      [DOC.id],
    );
    res.json({
      doc_id: DOC.id,
      title: DOC.title,
      status_in_pdf: 'Withdrawn',
      chunks: rows.reduce((a, c) => a + c.chunks, 0),
      min_rank: MIN_RANK,
      clauses: rows,
      notice: NOTICE,
    });
  }));
  return r;
}
