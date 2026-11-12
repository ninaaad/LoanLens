// What-if simulator: replay stored (synthetic) applications through a baseline and a candidate ruleset.
// Only the deterministic rules engine decides approve / refer / reject. Nothing here calls an LLM.
import { evaluate, validateRuleset } from '../rules/engine.js';
import { HttpError } from '../journey/service.js';
import { dataRange, dayStart, addDays } from './data.js';

export const SIM_NOTICE =
  'Synthetic data. Default probabilities are a synthetic ground truth that a real lender does not observe for rejected '
  + 'applicants, and no behavioural reaction to the new policy (applicant mix, pricing response, fraud adaptation) is modelled.';

const DISBURSAL_RATE = 0.93; // share of accepted offers that reach disbursal (same constant the generator uses)
const MIN_CELL = 30; // fewer offers than this in a rate/cut cell: borrow the nearest cell instead
const SEGMENTS = ['device', 'channel', 'employment', 'new_to_credit'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const clone = (o) => JSON.parse(JSON.stringify(o));
const round = (x, d = 4) => (x === null || x === undefined ? null : Number(x.toFixed(d)));

/** Turn { base, overrides } into a full ruleset config. A full config is returned unchanged (cloned). */
export async function resolveRuleset(pool, spec, label) {
  if (spec && typeof spec === 'object' && spec.base === undefined) return { version: spec.version ?? label, config: clone(spec) };
  const version = typeof spec === 'string' ? spec : spec?.base;
  if (!version) throw new HttpError(400, `${label}: give a ruleset config, a version name, or { base, overrides }`);
  const { rows } = await pool.query('select version, config from rule_versions where version = $1', [version]);
  if (!rows[0]) throw new HttpError(400, `${label}: unknown rule version "${version}"`);
  const config = clone(rows[0].config);
  const o = typeof spec === 'object' ? spec.overrides ?? {} : {};
  if (typeof o !== 'object' || Array.isArray(o)) throw new HttpError(400, `${label}: overrides must be an object`);
  for (const [id, patch] of Object.entries(o.rules ?? {})) {
    const rule = config.rules.find((r) => r.id === id);
    if (!rule) throw new HttpError(400, `${label}: overrides.rules refers to unknown rule "${id}"`);
    if (!patch || typeof patch !== 'object') throw new HttpError(400, `${label}: override for rule "${id}" must be an object`);
    for (const k of Object.keys(patch)) {
      if (!['value', 'op', 'onFail'].includes(k)) throw new HttpError(400, `${label}: rule "${id}" override may only change value, op or onFail`);
    }
    Object.assign(rule, patch);
  }
  if (o.pricing !== undefined) config.pricing = o.pricing;
  if (o.maxLoanIncomeMultiple !== undefined) config.maxLoanIncomeMultiple = o.maxLoanIncomeMultiple;
  const changed = Object.keys(o).length > 0;
  return { version: changed ? `${version}+overrides` : version, config };
}

function checked(resolved, label) {
  const errors = validateRuleset(resolved.config);
  if (errors.length) throw new HttpError(400, `${label} ruleset invalid: ${errors.join('; ')}`);
  // validateRuleset does not look at rule values or pricing entries; the engine would silently misbehave on them.
  for (const r of resolved.config.rules) {
    if (r.value === undefined || r.value === null || (typeof r.value === 'number' && !Number.isFinite(r.value))) {
      throw new HttpError(400, `${label} ruleset invalid: rule ${r.id} needs a finite value`);
    }
  }
  for (const p of resolved.config.pricing) {
    if (!Number.isFinite(p?.minScore) || !Number.isFinite(p?.rate) || p.rate < 0) {
      throw new HttpError(400, `${label} ruleset invalid: pricing entries need numeric minScore and rate`);
    }
  }
  if (!(resolved.config.maxLoanIncomeMultiple > 0)) throw new HttpError(400, `${label} ruleset invalid: maxLoanIncomeMultiple must be positive`);
  return resolved;
}

/**
 * P(accept | offered rate, amount was cut) estimated from offers actually shown in the stored data.
 * Returns a lookup function plus the table it was built from (so the UI and tests can inspect it).
 */
export async function acceptanceModel(pool) {
  const { rows } = await pool.query(
    `select a.offered_rate::float8 as rate, (a.offered_amount < a.requested_amount) as cut, count(*)::int as offers,
            count(*) filter (where exists (select 1 from events x where x.application_id = a.id and x.event_type = 'offer_accepted'))::int as accepted
       from applications a
      where a.offered_rate is not null
        and exists (select 1 from events v where v.application_id = a.id and v.event_type = 'offer_viewed')
      group by 1, 2`,
  );
  const cells = rows.map((r) => ({ rate: round(r.rate, 4), cut: r.cut, offers: r.offers, accepted: r.accepted, p_accept: r.offers ? r.accepted / r.offers : null }));
  const total = cells.reduce((a, c) => ({ offers: a.offers + c.offers, accepted: a.accepted + c.accepted }), { offers: 0, accepted: 0 });
  const overall = total.offers ? total.accepted / total.offers : 0;
  const solid = cells.filter((c) => c.offers >= MIN_CELL);
  const lookup = (rate, cut) => {
    const same = solid.filter((c) => c.cut === cut);
    const pool_ = same.length ? same : solid;
    if (!pool_.length) return overall;
    // exact rate if we have it, else the nearest observed rate with the same cut flag
    const best = pool_.reduce((b, c) => (Math.abs(c.rate - rate) < Math.abs(b.rate - rate) ? c : b));
    return best.p_accept;
  };
  return { lookup, cells, overall, offers: total.offers };
}

/** Run one application through prescreen then credit under a ruleset. */
function decide(app, cfg) {
  const base = {
    age: app.age, monthly_income: app.monthly_income, existing_emi: app.existing_emi, requested_amount: app.requested_amount,
    tenure_months: app.tenure_months, employment: app.employment, new_to_credit: app.new_to_credit,
  };
  const pre = evaluate({ ...base, credit_score: null }, cfg, { stage: 'prescreen' });
  if (pre.decision === 'reject') return { decision: 'reject', reasons: pre.reasonCodes, stage: 'prescreen', derived: null };
  const credit = evaluate({ ...base, credit_score: app.bureau_score_latent }, cfg, { stage: 'credit' });
  return { decision: credit.decision, reasons: credit.reasonCodes, stage: 'credit', derived: credit.derived };
}

function emptyAcc() {
  return { n: 0, approve: 0, refer: 0, reject: 0, reasons: new Map(), disb: 0, disbAmount: 0, defaultAmount: 0, approvedWouldDefault: 0, approvedDefaultExpected: 0 };
}

function addTo(acc, d, app, model) {
  acc.n += 1;
  acc[d.decision] += 1;
  for (const r of d.reasons) acc.reasons.set(r, (acc.reasons.get(r) ?? 0) + 1);
  if (d.decision !== 'approve') return;
  const cut = d.derived.offered_amount < app.requested_amount;
  const p = model.lookup(d.derived.rate, cut) * DISBURSAL_RATE;
  acc.disb += p;
  acc.disbAmount += p * d.derived.offered_amount;
  acc.defaultAmount += p * d.derived.offered_amount * app.default_prob;
  acc.approvedDefaultExpected += app.default_prob;
  if (app.would_default) acc.approvedWouldDefault += 1;
}

function summarise(acc) {
  const rate = (x) => (acc.n ? round(x / acc.n) : null);
  return {
    applications: acc.n,
    approve: acc.approve, refer: acc.refer, reject: acc.reject,
    approve_rate: rate(acc.approve), refer_rate: rate(acc.refer), reject_rate: rate(acc.reject),
    top_reasons: [...acc.reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([reason, count]) => ({ reason, count })),
    expected_disbursals: round(acc.disb, 2),
    expected_disbursed_amount: Math.round(acc.disbAmount),
    expected_npa: acc.disbAmount > 0 ? round(acc.defaultAmount / acc.disbAmount) : null,
    approved_would_default: acc.approvedWouldDefault,
    approved_expected_defaults: round(acc.approvedDefaultExpected, 2),
  };
}

const diff = (a, b) => (a === null || b === null ? null : round(b - a));

function delta(base, cand) {
  return {
    approve: cand.approve - base.approve,
    refer: cand.refer - base.refer,
    reject: cand.reject - base.reject,
    approve_rate: diff(base.approve_rate, cand.approve_rate),
    expected_disbursals: diff(base.expected_disbursals, cand.expected_disbursals),
    expected_disbursed_amount: cand.expected_disbursed_amount - base.expected_disbursed_amount,
    expected_npa: diff(base.expected_npa, cand.expected_npa),
    approved_would_default: cand.approved_would_default - base.approved_would_default,
  };
}

export async function simulate(pool, { candidate, baseline, from, to } = {}) {
  if (candidate === undefined || candidate === null) throw new HttpError(400, 'candidate is required');
  for (const [k, v] of Object.entries({ from, to })) {
    if (v !== undefined && !DAY.test(v)) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
  }
  const range = await dataRange(pool);
  if (!range) throw new HttpError(422, 'no applications in the database; seed the synthetic data first');
  const first = from ?? range.first;
  const last = to ?? range.last;
  if (Number.isNaN(dayStart(first).getTime()) || Number.isNaN(dayStart(last).getTime())) throw new HttpError(400, 'from/to are not valid dates');
  if (first > last) throw new HttpError(400, 'from must not be after to');

  let baselineSpec = baseline;
  if (baselineSpec === undefined || baselineSpec === null) {
    const { rows } = await pool.query('select version from rule_versions order by effective_from desc limit 1');
    baselineSpec = rows[0]?.version;
  }
  const base = checked(await resolveRuleset(pool, baselineSpec, 'baseline'), 'baseline');
  const cand = checked(await resolveRuleset(pool, candidate, 'candidate'), 'candidate');

  // Population: everyone who completed KYC in the window; they would proceed to eligibility and a bureau pull.
  const { rows: apps } = await pool.query(
    `select a.id, a.device, a.channel, a.employment, a.new_to_credit, a.age, a.monthly_income, a.existing_emi,
            a.requested_amount, a.tenure_months, a.bureau_score_latent, a.default_prob, a.would_default
       from applications a
      where a.created_at >= $1 and a.created_at < $2
        and exists (select 1 from events e where e.application_id = a.id and e.event_type = 'kyc_completed')
      order by a.id`,
    [dayStart(first), dayStart(addDays(last, 1))],
  );

  const model = await acceptanceModel(pool);
  const accBase = emptyAcc();
  const accCand = emptyAcc();
  const seg = {};
  for (const s of SEGMENTS) seg[s] = new Map();
  const flows = { approve: { approve: 0, refer: 0, reject: 0 }, refer: { approve: 0, refer: 0, reject: 0 }, reject: { approve: 0, refer: 0, reject: 0 } };

  for (const app of apps) {
    const b = decide(app, base.config);
    const c = decide(app, cand.config);
    addTo(accBase, b, app, model);
    addTo(accCand, c, app, model);
    flows[b.decision][c.decision] += 1;
    for (const s of SEGMENTS) {
      const key = String(app[s]);
      if (!seg[s].has(key)) seg[s].set(key, [emptyAcc(), emptyAcc()]);
      const [sb, sc] = seg[s].get(key);
      addTo(sb, b, app, model);
      addTo(sc, c, app, model);
    }
  }

  // Backtest: how many of these applicants really disbursed? Shown next to the baseline's expectation so a reader can see how far the
  // acceptance model is from what happened (the window may span policy v1 and v2, and real referrals can still convert).
  const ids = apps.map((a) => a.id);
  const { rows: actualRows } = await pool.query(
    `select count(distinct e.application_id)::int n,
            count(distinct e.application_id) filter (where a.decision = 'refer')::int from_referrals
       from events e join applications a on a.id = e.application_id
      where e.event_type = 'loan_disbursed' and e.application_id = any($1::bigint[])`,
    [ids],
  );
  const actualDisbursed = actualRows[0].n;
  const actualFromReferrals = actualRows[0].from_referrals;

  const baseSum = summarise(accBase);
  const candSum = summarise(accCand);
  const segments = {};
  for (const s of SEGMENTS) {
    segments[s] = [...seg[s]].sort(([a], [b]) => a.localeCompare(b)).map(([value, [sb, sc]]) => {
      const bs = summarise(sb);
      const cs = summarise(sc);
      return { value, applications: bs.applications, baseline: bs, candidate: cs, delta: delta(bs, cs) };
    });
  }

  return {
    synthetic: true,
    notice: SIM_NOTICE,
    window: { from: first, to: last },
    population: { definition: 'applications that completed KYC in the window', applications: apps.length },
    baseline: { version: base.version, config: base.config },
    candidate: { version: cand.version, config: cand.config },
    results: { baseline: baseSum, candidate: candSum, delta: delta(baseSum, candSum) },
    backtest: {
      actual_disbursed: actualDisbursed,
      actual_disbursed_from_referrals: actualFromReferrals,
      baseline_expected_disbursals: round(baseSum.expected_disbursals),
      ratio_expected_to_actual: actualDisbursed ? round(baseSum.expected_disbursals / actualDisbursed) : null,
      note: 'Expected disbursals under the baseline ruleset against the loans that actually disbursed in this window. Loans that disbursed after a manual review are in the actual figure but not in the expectation, because the simulator does not count referrals. A ratio far from 1 also means the window spans two rulesets or the acceptance model is rough.',
    },
    decision_flows: flows,
    segments,
    acceptance_model: {
      method: 'empirical share of shown offers that were accepted, by offered rate and whether the amount was cut; multiplied by the disbursal rate',
      disbursal_rate: DISBURSAL_RATE,
      offers_used: model.offers,
      overall: round(model.overall),
      cells: model.cells.map((c) => ({ ...c, p_accept: round(c.p_accept) })),
    },
    caveats: [
      'Referred applications are not counted as disbursals (they need manual review and most do not return).',
      'The candidate ruleset is applied to the latent bureau score, as if every applicant got a clean bureau response.',
    ],
  };
}
