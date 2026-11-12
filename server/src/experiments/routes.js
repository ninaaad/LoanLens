import express from 'express';
import { wrap } from '../journey/routes.js';
import { HttpError } from '../journey/service.js';
import { validateVariants } from './assign.js';
import { generateCohort, NO_EFFECT } from './simulateExperiment.js';
import { analyse, PRIMARY_METRICS, GUARDRAIL_METRICS } from './analyse.js';
import { buildBrief } from './brief.js';
import { getLlm } from '../llm/index.js';

export const NOTICE = 'Synthetic experiment cohort with a seeded effect. Not real borrowers.';
const KEY = /^[a-z0-9][a-z0-9_-]{1,59}$/;
const MAX_N = 200000;

export const DEMO = {
  key: 'kfs_summary_above_accept',
  name: 'Show the KFS summary above the Accept button',
  hypothesis: 'Showing the key terms (amount, APR, EMI, total cost) right above the Accept button will raise offer acceptance without raising defaults, complaints or turnaround time.',
  primary_metric: 'acceptance_rate',
  guardrails: [
    { metric: 'default_rate', tolerance: { type: 'abs', value: 0.01 } },
    { metric: 'median_tat', tolerance: { type: 'rel', value: 0.1 } },
    { metric: 'complaint_rate', tolerance: { type: 'abs', value: 0.005 } },
  ],
  variants: [{ name: 'control', weight: 50 }, { name: 'treatment', weight: 50 }],
};

function normalise(b) {
  const errors = [];
  if (typeof b?.key !== 'string' || !KEY.test(b.key)) errors.push('key must be 2-60 chars of a-z, 0-9, _ or -, starting with a letter or digit');
  if (typeof b?.name !== 'string' || !b.name.trim()) errors.push('name is required');
  if (typeof b?.hypothesis !== 'string' || !b.hypothesis.trim()) errors.push('hypothesis is required');
  if (!PRIMARY_METRICS[b?.primary_metric]) errors.push(`primary_metric must be one of ${Object.keys(PRIMARY_METRICS).join(', ')}`);
  const variants = b?.variants ?? [{ name: 'control', weight: 50 }, { name: 'treatment', weight: 50 }];
  errors.push(...validateVariants(variants));
  const guardrails = b?.guardrails ?? DEMO.guardrails;
  if (!Array.isArray(guardrails)) errors.push('guardrails must be an array');
  else {
    for (const g of guardrails) {
      const spec = GUARDRAIL_METRICS[g?.metric];
      if (!spec) { errors.push(`unknown guardrail metric ${g?.metric}; use ${Object.keys(GUARDRAIL_METRICS).join(', ')}`); continue; }
      if (g.tolerance !== undefined && !(['abs', 'rel'].includes(g.tolerance?.type) && Number.isFinite(g.tolerance?.value) && g.tolerance.value >= 0)) {
        errors.push(`guardrail ${g.metric}: tolerance must be { type: "abs"|"rel", value: number >= 0 }`);
      }
    }
  }
  if (errors.length) throw new HttpError(400, errors.join('; '));
  return {
    key: b.key, name: b.name.trim(), hypothesis: b.hypothesis.trim(), primary_metric: b.primary_metric,
    guardrails: guardrails.map((g) => ({ metric: g.metric, tolerance: g.tolerance ?? GUARDRAIL_METRICS[g.metric].defaultTolerance })),
    variants,
  };
}

async function getDef(pool, key) {
  const { rows } = await pool.query('select key, name, hypothesis, primary_metric, guardrails, variants, status, created_at from experiments where key = $1', [key]);
  if (!rows[0]) throw new HttpError(404, `no experiment "${key}"`);
  return rows[0];
}

async function create(pool, def) {
  const { rowCount } = await pool.query(
    'insert into experiments(key, name, hypothesis, primary_metric, guardrails, variants) values ($1,$2,$3,$4,$5,$6) on conflict (key) do nothing',
    [def.key, def.name, def.hypothesis, def.primary_metric, JSON.stringify(def.guardrails), JSON.stringify(def.variants)],
  );
  return rowCount === 1;
}

const meta = (row) => ({ ...row, synthetic: true });

export function experimentsRouter(pool) {
  const r = express.Router();

  r.get('/', wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `select e.key, e.name, e.hypothesis, e.primary_metric, e.guardrails, e.variants, e.status, e.created_at,
              (select count(*)::int from experiment_units u where u.experiment_key = e.key) as units
         from experiments e order by e.created_at, e.key`,
    );
    res.json({ experiments: rows.map(meta), notice: NOTICE });
  }));

  r.post('/', wrap(async (req, res) => {
    const def = normalise(req.body);
    if (!(await create(pool, def))) throw new HttpError(409, `experiment "${def.key}" already exists`);
    res.status(201).json({ ...meta(await getDef(pool, def.key)), notice: NOTICE });
  }));

  // Create the worked example if it is not there yet (idempotent).
  r.post('/demo', wrap(async (_req, res) => {
    const created = await create(pool, normalise(DEMO));
    res.status(created ? 201 : 200).json({ ...meta(await getDef(pool, DEMO.key)), created, notice: NOTICE });
  }));

  // Generate (or regenerate) the synthetic cohort for an experiment, with a seeded known effect.
  r.post('/:key/run', wrap(async (req, res) => {
    const def = await getDef(pool, req.params.key);
    const b = req.body ?? {};
    const n = b.n ?? 40000; // large enough that the default-rate guardrail interval can fit inside its tolerance
    const seed = b.seed ?? 1;
    if (!Number.isInteger(n) || n < 100 || n > MAX_N) throw new HttpError(400, `n must be an integer from 100 to ${MAX_N}`);
    if (!Number.isInteger(seed)) throw new HttpError(400, 'seed must be an integer');
    const te = b.true_effect ?? { acceptance: 0.02 };
    if (typeof te !== 'object' || Array.isArray(te) || Object.keys(te).some((k) => !(k in NO_EFFECT) || !Number.isFinite(te[k]))) {
      throw new HttpError(400, `true_effect may only contain numeric ${Object.keys(NO_EFFECT).join(', ')}`);
    }
    // effects are probability points (0.02 = 2 points) or, for tatPct, a share of the median; anything bigger is a typo, not a scenario
    for (const [k, v] of Object.entries(te)) {
      const [lo, hi] = k === 'tatPct' ? [-0.9, 5] : [-0.5, 0.5];
      if (v < lo || v > hi) throw new HttpError(400, `true_effect.${k} must be between ${lo} and ${hi}`);
    }
    const drop = b.drop_treatment_rate ?? 0;
    if (!(drop >= 0 && drop < 1)) throw new HttpError(400, 'drop_treatment_rate must be in [0, 1)');

    const units = generateCohort(def.key, def.variants, { n, seed, trueEffect: te, dropTreatmentRate: drop });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from experiment_units where experiment_key = $1', [def.key]);
      for (let i = 0; i < units.length; i += 5000) {
        const c = units.slice(i, i + 5000);
        await client.query(
          `insert into experiment_units (experiment_key, unit_id, variant, accepted, disbursed, defaulted, tat_seconds, complained)
           select $1, * from unnest($2::text[], $3::text[], $4::boolean[], $5::boolean[], $6::boolean[], $7::numeric[], $8::boolean[])`,
          [def.key, c.map((u) => u.unit_id), c.map((u) => u.variant), c.map((u) => u.accepted), c.map((u) => u.disbursed), c.map((u) => u.defaulted), c.map((u) => u.tat_seconds), c.map((u) => u.complained)],
        );
      }
      await client.query("update experiments set status = 'running' where key = $1", [def.key]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw e;
    } finally {
      client.release();
    }
    res.json({ key: def.key, units: units.length, seed, true_effect: te, drop_treatment_rate: drop, synthetic: true, notice: NOTICE });
  }));

  const needUnits = async (key) => {
    const def = await getDef(pool, key);
    const { rows } = await pool.query('select count(*)::int n from experiment_units where experiment_key = $1', [key]);
    if (!rows[0].n) throw new HttpError(422, `experiment "${key}" has no data yet; POST /api/experiments/${key}/run first`);
    return def;
  };

  r.get('/:key/analysis', wrap(async (req, res) => {
    const def = await needUnits(req.params.key);
    res.json({ ...(await analyse(pool, def)), experiment: { key: def.key, name: def.name, hypothesis: def.hypothesis, status: def.status }, synthetic: true, notice: NOTICE });
  }));

  r.get('/:key/brief', wrap(async (req, res) => {
    const def = await needUnits(req.params.key);
    const a = await analyse(pool, def);
    const template = buildBrief(def, a);
    // The model may add a plain-language summary above the Hypothesis section. The tables, decision and caveats are never rewritten.
    const summary = await getLlm().summarise(
      { facts: template, template: '', must: [a.decision.action.toUpperCase()] },
      'Summarise this experiment brief in at most 4 plain sentences for a product manager. State the decision first, exactly as written.',
    );
    const markdown = summary.mode === 'llm'
      ? template.replace('\n## Hypothesis', `\n## Plain-language summary\n${summary.text}\n\n## Hypothesis`)
      : template;
    res.json({ key: def.key, decision: a.decision.action, markdown, summary_mode: summary.mode, synthetic: true, notice: NOTICE });
  }));

  return r;
}
