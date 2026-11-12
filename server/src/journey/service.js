import { callProvider } from '../integrations/providerClient.js';
import { evaluate } from '../rules/engine.js';
import { rulesetAt } from '../rules/defaultRules.js';
import { buildKfs } from '../rules/kfs.js';

export class HttpError extends Error {
  /** @param details optional list of reasons, returned to the client as `errors` */
  constructor(status, message, details) { super(message); this.status = status; if (details) this.details = details; }
}

// Steps for one application run one at a time. Without this, three parallel "get offer" requests each saw "no offer yet", called the
// bureau three times and wrote three offer_viewed events (a double-click or a retrying client does exactly that). The lock lives in this
// process; running several API processes against one database would need a database advisory lock instead.
const chains = new Map();
export async function withApplication(id, fn) {
  const prev = chains.get(id) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  chains.set(id, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (chains.get(id) === tail) chains.delete(id);
  }
}

export async function logEvent(pool, applicationId, type, props = {}, ts = new Date()) {
  await pool.query('insert into events(application_id, event_type, ts, props) values ($1,$2,$3,$4)', [applicationId, type, ts, props]);
}

async function recordCall(pool, applicationId, provider, result) {
  await pool.query('insert into api_calls(application_id, provider, ts, latency_ms, status) values ($1,$2,now(),$3,$4)', [
    applicationId, provider, Math.round(result.latency_ms), result.status,
  ]);
}

export async function getApplication(pool, id) {
  const { rows } = await pool.query('select * from applications where id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'application not found');
  return rows[0];
}

async function eventTypes(pool, id) {
  const { rows } = await pool.query('select event_type from events where application_id = $1', [id]);
  return new Set(rows.map((r) => r.event_type));
}

const num = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
};

export async function createApplication(pool, b = {}) {
  const age = num(b.age, 'age', 18, 100);
  const income = num(b.monthly_income, 'monthly_income', 1, 10_000_000);
  const emiNow = num(b.existing_emi ?? 0, 'existing_emi', 0, 10_000_000);
  const amount = num(b.requested_amount, 'requested_amount', 10_000, 2_000_000);
  const tenure = num(b.tenure_months, 'tenure_months', 6, 84);
  const { rows } = await pool.query(
    `insert into applications(channel, device, app_version, age, employment, monthly_income, existing_emi, new_to_credit, requested_amount, tenure_months, variant, is_synthetic)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true) returning id`, // applicants entered through the demo are always fabricated
    [b.channel ?? 'direct', b.device ?? 'web', b.app_version ?? 'web', age, b.employment ?? 'salaried', income, emiNow, !!b.new_to_credit, amount, tenure, b.variant ?? null],
  );
  const id = rows[0].id;
  await logEvent(pool, id, 'application_started', { device: b.device ?? 'web', channel: b.channel ?? 'direct' });
  return { id, next: 'kyc' };
}

export async function runKyc(pool, id) {
  await getApplication(pool, id);
  const seen = await eventTypes(pool, id);
  if (seen.has('kyc_completed')) return { status: 'verified', repeat: true };
  const r = await callProvider('kyc', { applicant_ref: `app-${id}` }, { idempotencyKey: `kyc-${id}` });
  await recordCall(pool, id, 'kyc', r);
  if (r.ok && r.data.verified) {
    await logEvent(pool, id, 'kyc_completed');
    return { status: 'verified', next: 'eligibility' };
  }
  await logEvent(pool, id, 'kyc_failed', { provider_status: r.status });
  return { status: 'failed', reason: r.ok ? 'identity_not_verified' : 'provider_unavailable' };
}

export async function runEligibility(pool, id) {
  const app = await getApplication(pool, id);
  const seen = await eventTypes(pool, id);
  if (!seen.has('kyc_completed')) throw new HttpError(409, 'complete KYC first');
  if (seen.has('eligibility_passed')) return { decision: 'pass', repeat: true };
  const rs = await rulesetAt(pool);
  const result = evaluate(app, rs.config, { stage: 'prescreen' });
  await pool.query('update applications set rule_version = $2 where id = $1', [id, rs.version]);
  if (result.decision === 'reject') {
    await pool.query('update applications set decision = $2, reason_codes = $3 where id = $1', [id, 'reject', result.reasonCodes]);
    await logEvent(pool, id, 'application_rejected', { stage: 'prescreen', reasons: result.reasonCodes });
    return { decision: 'reject', reasons: result.triggered.map((t) => ({ code: t.reason, message: t.message })) };
  }
  await logEvent(pool, id, 'eligibility_passed', { rule_version: rs.version });
  return { decision: 'pass', next: 'offer' };
}

export async function generateOffer(pool, id) {
  const app = await getApplication(pool, id);
  const seen = await eventTypes(pool, id);
  if (!seen.has('eligibility_passed')) throw new HttpError(409, 'pass eligibility first');
  if (seen.has('offer_viewed')) return presentOffer(app);

  const r = await callProvider('bureau', {
    applicant_ref: `app-${id}`, age: app.age, monthly_income: app.monthly_income, existing_emi: app.existing_emi, new_to_credit: app.new_to_credit,
  }, { idempotencyKey: `bureau-${id}` });
  await recordCall(pool, id, 'bureau', r);

  const score = r.ok ? r.data.score : null;
  const withScore = { ...app, credit_score: score };
  const rs = await rulesetAt(pool);
  const result = evaluate(withScore, rs.config, { stage: 'credit' });
  const d = result.derived;
  await pool.query(
    `update applications set credit_score=$2, decision=$3, reason_codes=$4, rule_version=$5, offered_amount=$6, offered_rate=$7, offered_emi=$8 where id=$1`,
    [id, score, result.decision, result.reasonCodes, rs.version, result.decision === 'reject' ? null : d.offered_amount, result.decision === 'reject' ? null : d.rate, result.decision === 'reject' ? null : d.offered_emi],
  );

  if (result.decision === 'reject') {
    await logEvent(pool, id, 'application_rejected', { stage: 'credit', reasons: result.reasonCodes });
    return { decision: 'reject', reasons: result.triggered.map((t) => ({ code: t.reason, message: t.message })) };
  }
  if (result.decision === 'refer') {
    await logEvent(pool, id, 'manual_review_started', { reasons: result.reasonCodes });
    return { decision: 'refer', message: 'A credit officer will review your application and get back to you.', reasons: result.triggered.map((t) => ({ code: t.reason, message: t.message })) };
  }
  await logEvent(pool, id, 'offer_viewed', { rule_version: rs.version });
  return presentOffer({ ...withScore, offered_amount: d.offered_amount, offered_rate: d.rate, tenure_months: app.tenure_months });
}

function presentOffer(a) {
  return {
    decision: 'approve',
    offer: buildKfs({ amount: a.offered_amount, annualRate: a.offered_rate, months: a.tenure_months }),
  };
}

export async function acceptOffer(pool, id) {
  const app = await getApplication(pool, id);
  const seen = await eventTypes(pool, id);
  if (!seen.has('offer_viewed')) throw new HttpError(409, 'no offer to accept');
  if (seen.has('offer_accepted')) return { status: 'already_accepted' };
  await logEvent(pool, id, 'offer_accepted');
  await logEvent(pool, id, 'loan_disbursed', { simulated: true, amount: app.offered_amount });
  return { status: 'disbursed', amount: app.offered_amount, cooling_off_days: 3 };
}
