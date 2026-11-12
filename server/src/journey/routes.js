import express from 'express';
import { createApplication, runKyc, runEligibility, generateOffer, acceptOffer, getApplication, withApplication, HttpError } from './service.js';
import { parseId, bodyObject, shortString, timestampOr, rulesetErrors, applicationInput } from '../http/validate.js';

// What an applicant may see of their own record. The generator also stores a latent bureau score, a default probability and a
// would_default flag (the synthetic ground truth a real lender never has); those stay on the server.
const HIDDEN = new Set(['bureau_score_latent', 'default_prob', 'would_default']);
export const publicApplication = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !HIDDEN.has(k)));

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function journeyRouter(pool) {
  const r = express.Router();
  r.post('/applications', wrap(async (req, res) => res.status(201).json(await createApplication(pool, applicationInput(req.body)))));
  r.post('/applications/:id/kyc', wrap(async (req, res) => { const id = parseId(req.params.id); res.json(await withApplication(id, () => runKyc(pool, id))); }));
  r.post('/applications/:id/eligibility', wrap(async (req, res) => { const id = parseId(req.params.id); res.json(await withApplication(id, () => runEligibility(pool, id))); }));
  r.post('/applications/:id/offer', wrap(async (req, res) => { const id = parseId(req.params.id); res.json(await withApplication(id, () => generateOffer(pool, id))); }));
  r.post('/applications/:id/accept', wrap(async (req, res) => { const id = parseId(req.params.id); res.json(await withApplication(id, () => acceptOffer(pool, id))); }));
  r.get('/applications/:id', wrap(async (req, res) => {
    const id = parseId(req.params.id);
    const application = await getApplication(pool, id);
    const { rows: events } = await pool.query('select event_type, ts, props from events where application_id = $1 order by ts, id', [id]);
    res.json({ application: publicApplication(application), events });
  }));

  r.get('/rules', wrap(async (_req, res) => {
    const { rows } = await pool.query('select version, effective_from, note, config from rule_versions order by effective_from');
    res.json(rows);
  }));
  r.post('/rules', wrap(async (req, res) => {
    const b = bodyObject(req.body, { allowEmpty: false });
    const version = shortString(b.version, 'version');
    const effectiveFrom = timestampOr(b.effective_from, 'effective_from', new Date());
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) throw new HttpError(400, 'note must be text of at most 500 characters');
    const errors = rulesetErrors(b.config);
    if (errors.length) throw new HttpError(400, 'ruleset is invalid', errors);
    await pool.query('insert into rule_versions(version, effective_from, note, config) values ($1,$2,$3,$4)', [version, effectiveFrom, b.note ?? null, b.config]);
    res.status(201).json({ ok: true });
  }));
  r.get('/releases', wrap(async (_req, res) => {
    const { rows } = await pool.query('select version, deployed_at, description, affects_step, affects_platform from releases order by deployed_at');
    res.json(rows);
  }));
  return r;
}
