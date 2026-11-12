// Two real versions of the credit policy. v2 tightens the FOIR cap on 29 Sep 2026,
// which is the "rule change" the RCA has to tell apart from provider and release problems.

const pricing = [
  { minScore: 750, rate: 0.11 },
  { minScore: 700, rate: 0.13 },
  { minScore: 0, rate: 0.16 },
];

const base = (foirCap, foirSoft) => [
  { id: 'age_min', stage: 'prescreen', field: 'age', op: '>=', value: 21, onFail: 'reject', reason: 'AGE_BELOW_MIN', message: 'You must be at least 21 years old to apply.' },
  { id: 'age_max', stage: 'prescreen', field: 'age', op: '<=', value: 60, onFail: 'reject', reason: 'AGE_ABOVE_MAX', message: 'Applicants must be 60 or younger at the time of application.' },
  { id: 'income_min', stage: 'prescreen', field: 'monthly_income', op: '>=', value: 25000, onFail: 'reject', reason: 'INCOME_TOO_LOW', message: 'Monthly income must be at least ₹25,000.' },
  { id: 'score_hard', stage: 'credit', field: 'credit_score', op: '>=', value: 650, onFail: 'reject', reason: 'SCORE_TOO_LOW', message: 'Your credit score is below our minimum of 650.' },
  { id: 'score_soft', stage: 'credit', field: 'credit_score', op: '>=', value: 700, onFail: 'refer', reason: 'SCORE_BORDERLINE', message: 'Your credit score is close to our minimum, so a credit officer will review it.' },
  { id: 'foir_hard', stage: 'credit', field: 'foir', op: '<=', value: foirCap, onFail: 'reject', reason: 'FOIR_TOO_HIGH', message: `Your existing and new EMIs would use more than ${Math.round(foirCap * 100)}% of your income.` },
  { id: 'foir_soft', stage: 'credit', field: 'foir', op: '<=', value: foirSoft, onFail: 'refer', reason: 'FOIR_BORDERLINE', message: 'Your EMIs would use a large share of your income, so a credit officer will review it.' },
];

export const RULESET_V1 = {
  version: 'v1',
  effective_from: '2026-09-01T00:00:00Z',
  note: 'Launch policy: FOIR cap 55%.',
  config: { version: 'v1', rules: base(0.55, 0.45), pricing, maxLoanIncomeMultiple: 15 },
};

export const RULESET_V2 = {
  version: 'v2',
  effective_from: '2026-09-29T00:00:00Z',
  note: 'Risk team tightened the FOIR cap from 55% to 50% after early delinquencies.',
  config: { version: 'v2', rules: base(0.5, 0.4), pricing, maxLoanIncomeMultiple: 15 },
};

export async function ensureDefaultRules(pool) {
  const { rows } = await pool.query('select count(*)::int n from rule_versions');
  if (rows[0].n > 0) return false;
  for (const r of [RULESET_V1, RULESET_V2]) {
    await pool.query('insert into rule_versions(version, effective_from, note, config) values ($1,$2,$3,$4)', [r.version, r.effective_from, r.note, r.config]);
  }
  return true;
}

/** The ruleset in force at a point in time. */
export async function rulesetAt(pool, ts = new Date()) {
  const { rows } = await pool.query(
    'select version, effective_from, note, config from rule_versions where effective_from <= $1 order by effective_from desc limit 1',
    [ts],
  );
  return rows[0] ?? null;
}
