import express from 'express';
import { wrap } from '../journey/routes.js';
import { HttpError } from '../journey/service.js';
import { funnel, SEGMENTS } from './funnel.js';
import { parseDay, queryValue, bodyObject, optionalInt } from '../http/validate.js';
import { loadApps, dataRange, addDays, STEPS } from './data.js';
import { detectAnomalies, detectShifts } from './anomaly.js';
import { rca } from './rca.js';
import { simulate } from './simulate.js';
import { seedDatabase } from '../data/seed.js';

export function analyticsRouter(pool) {
  const r = express.Router();

  r.get('/meta', wrap(async (_req, res) => {
    const range = await dataRange(pool);
    const { rows: releases } = await pool.query('select version, deployed_at, description, affects_step, affects_platform from releases order by deployed_at');
    const { rows: rules } = await pool.query('select version, effective_from, note from rule_versions order by effective_from');
    res.json({ range, releases, rules, steps: STEPS, synthetic: true, notice: 'All applicants, events and API calls are synthetic.' });
  }));

  r.get('/funnel', wrap(async (req, res) => {
    const from = parseDay(req.query.from, 'from');
    const to = parseDay(req.query.to, 'to');
    if (from && to && from > to) throw new HttpError(400, 'from must not be after to');
    const segment = queryValue(req.query.segment, 'segment');
    const value = queryValue(req.query.value, 'value');
    if (segment !== undefined && !SEGMENTS.includes(segment)) throw new HttpError(400, `segment must be one of ${SEGMENTS.join(', ')}`);
    if (value !== undefined && segment === undefined) throw new HttpError(400, 'value needs a segment');
    res.json(await funnel(pool, { from, to, segment, value }));
  }));

  r.get('/anomalies', wrap(async (_req, res) => {
    const range = await dataRange(pool);
    if (!range) return res.json({ anomalies: [], shifts: [], config: null });
    const rows = await loadApps(pool, range.first, addDays(range.last, 1));
    const { anomalies, config, series } = detectAnomalies(rows);
    const { shifts, config: shiftConfig } = detectShifts(rows);
    res.json({ anomalies, config, series, shifts, shift_config: shiftConfig });
  }));

  r.get('/rca', wrap(async (req, res) => {
    const day = parseDay(req.query.day, 'day', { required: true });
    const step = queryValue(req.query.step, 'step');
    if (!STEPS.slice(1).includes(step)) throw new HttpError(400, `step must be one of ${STEPS.slice(1).join(', ')}`);
    try {
      res.json(await rca(pool, { day, step }));
    } catch (e) {
      if (/not enough data/.test(e.message)) throw new HttpError(422, e.message);
      throw e;
    }
  }));

  // What-if: replay stored applications through a baseline and a candidate ruleset.
  r.post('/simulate', wrap(async (req, res) => {
    res.json(await simulate(pool, bodyObject(req.body)));
  }));

  // Re-generate the synthetic dataset (demo convenience).
  r.post('/admin/reseed', wrap(async (req, res) => {
    const b = bodyObject(req.body);
    const seed = optionalInt(b.seed, 'seed', 0, 2 ** 31 - 1);
    const perDay = optionalInt(b.perDay, 'perDay', 1, 3000);
    res.json(await seedDatabase(pool, { seed, perDay }));
  }));
  return r;
}
