// Deterministic credit decisioning. Only this module approves, refers or rejects a loan.
// Rules are data (JSON), versioned in the rule_versions table, so they can change without a redeploy.

const OPS = {
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
};

export const OUTCOMES = ['reject', 'refer'];
export const STAGES = ['prescreen', 'credit'];

/** Equated monthly instalment. */
export function emi(principal, annualRate, months) {
  const r = annualRate / 12;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

export function rateFor(score, pricing) {
  const bands = [...pricing].sort((a, b) => b.minScore - a.minScore);
  if (score == null) return bands.at(-1).rate;
  return (bands.find((b) => score >= b.minScore) ?? bands.at(-1)).rate;
}

/** Fields derived from an application that rules may reference. */
export function deriveFields(app, cfg) {
  const rate = rateFor(app.credit_score, cfg.pricing);
  const requestedEmi = emi(Number(app.requested_amount), rate, Number(app.tenure_months));
  const income = Number(app.monthly_income);
  const foir = income > 0 ? (Number(app.existing_emi) + requestedEmi) / income : Infinity;
  const cap = Math.floor((income * cfg.maxLoanIncomeMultiple) / 1000) * 1000;
  const offeredAmount = Math.max(0, Math.min(Number(app.requested_amount), cap));
  const offeredEmi = emi(offeredAmount, rate, Number(app.tenure_months));
  return { rate, requested_emi: requestedEmi, foir, offered_amount: offeredAmount, offered_emi: offeredEmi };
}

export function validateRuleset(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return ['ruleset must be an object'];
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) errors.push('rules must be a non-empty array');
  if (!Array.isArray(cfg.pricing) || cfg.pricing.length === 0) errors.push('pricing must be a non-empty array');
  if (typeof cfg.maxLoanIncomeMultiple !== 'number') errors.push('maxLoanIncomeMultiple must be a number');
  const ids = new Set();
  for (const r of cfg.rules ?? []) {
    if (!r.id) errors.push('every rule needs an id');
    if (ids.has(r.id)) errors.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (!OPS[r.op]) errors.push(`rule ${r.id}: unknown operator ${r.op}`);
    if (!OUTCOMES.includes(r.onFail)) errors.push(`rule ${r.id}: onFail must be reject or refer`);
    if (!STAGES.includes(r.stage)) errors.push(`rule ${r.id}: stage must be prescreen or credit`);
    if (!r.reason) errors.push(`rule ${r.id}: reason code required`);
  }
  return errors;
}

/**
 * Evaluate one application against a ruleset.
 * A rule PASSES when `field op value` is true; otherwise its onFail outcome is triggered.
 * Decision precedence: reject > refer > approve.
 */
export function evaluate(app, cfg, { stage } = {}) {
  const derived = deriveFields(app, cfg);
  const fields = { ...app, ...derived };
  const triggered = [];
  for (const rule of cfg.rules) {
    if (stage && rule.stage !== stage) continue;
    const actual = fields[rule.field];
    if (actual === null || actual === undefined || Number.isNaN(actual)) {
      triggered.push({
        id: rule.id,
        reason: rule.field === 'credit_score' ? 'BUREAU_UNAVAILABLE' : `DATA_MISSING_${String(rule.field).toUpperCase()}`,
        outcome: 'refer',
        field: rule.field,
        actual: null,
        threshold: rule.value,
        message: 'We could not verify some of your information, so a credit officer will review your application.',
      });
      continue;
    }
    if (!OPS[rule.op](actual, rule.value)) {
      triggered.push({
        id: rule.id,
        reason: rule.reason,
        outcome: rule.onFail,
        field: rule.field,
        actual,
        threshold: rule.value,
        message: rule.message ?? rule.reason,
      });
    }
  }
  const decision = triggered.some((t) => t.outcome === 'reject')
    ? 'reject'
    : triggered.some((t) => t.outcome === 'refer')
      ? 'refer'
      : 'approve';
  return { decision, triggered, reasonCodes: [...new Set(triggered.map((t) => t.reason))], derived };
}
