// Loads per-application funnel rows. Funnel, anomaly and RCA code is pure JS over these rows,
// which keeps the maths easy to test and easy to explain in an interview.
export const STEPS = ['application_started', 'kyc_completed', 'eligibility_passed', 'offer_viewed', 'offer_accepted', 'loan_disbursed'];
export const STEP_LABEL = {
  application_started: 'Application started',
  kyc_completed: 'KYC completed',
  eligibility_passed: 'Eligibility passed',
  offer_viewed: 'Offer viewed',
  offer_accepted: 'Offer accepted',
  loan_disbursed: 'Loan disbursed',
};
const IST_MS = 19800000;
export const istDay = (d) => new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10);
export const istHour = (d) => new Date(new Date(d).getTime() + IST_MS).getUTCHours();
export const dayStart = (day) => new Date(`${day}T00:00:00+05:30`);
export const addDays = (day, n) => istDay(new Date(dayStart(day).getTime() + n * 86400000 + 3600000));

// loadApps takes about 0.8 s on the full dataset and the workbench asks for the same window several times (funnel, anomalies, RCA), so
// results are kept per database pool. An entry is valid while the data has not changed: the newest application, event and API-call ids
// change whenever a journey runs, and seedDatabase clears the cache. Callers must treat the returned rows as read-only (none mutates them).
// Identical requests that arrive together share one query.
const CACHE_MAX = 6;
const caches = new WeakMap();
export function clearAnalyticsCache(pool) { caches.delete(pool); }
async function dataVersion(pool) {
  const { rows } = await pool.query(
    'select (select coalesce(max(id), 0) from applications) a, (select coalesce(max(id), 0) from events) e, (select coalesce(max(id), 0) from api_calls) c, (select count(*) from applications) n',
  );
  return JSON.stringify(rows[0]);
}

export async function loadApps(pool, fromDay, toDayExclusive) {
  const version = await dataVersion(pool);
  let cache = caches.get(pool);
  if (!cache || cache.version !== version) { cache = { version, entries: new Map() }; caches.set(pool, cache); }
  const key = `${fromDay}|${toDayExclusive}`;
  if (cache.entries.has(key)) {
    const hit = cache.entries.get(key);
    cache.entries.delete(key); cache.entries.set(key, hit); // most recently used last
    return hit;
  }
  const pending = queryApps(pool, fromDay, toDayExclusive);
  cache.entries.set(key, pending);
  if (cache.entries.size > CACHE_MAX) cache.entries.delete(cache.entries.keys().next().value);
  try {
    return await pending;
  } catch (e) {
    if (cache.entries.get(key) === pending) cache.entries.delete(key); // never keep a failure
    throw e;
  }
}

async function queryApps(pool, fromDay, toDayExclusive) {
  // Events and API waits are aggregated once per application (a single pass each) and then joined; per-row
  // correlated subqueries on api_calls took about a minute for the 27k-application dataset.
  const { rows } = await pool.query(
    `with win as (select id from applications where created_at >= $1 and created_at < $2),
          ev as (
            select e.application_id,
                   bool_or(e.event_type = 'application_started') as application_started,
                   bool_or(e.event_type = 'kyc_completed') as kyc_completed,
                   bool_or(e.event_type = 'eligibility_passed') as eligibility_passed,
                   bool_or(e.event_type = 'offer_viewed') as offer_viewed,
                   bool_or(e.event_type = 'offer_accepted') as offer_accepted,
                   bool_or(e.event_type = 'loan_disbursed') as loan_disbursed,
                   bool_or(e.event_type = 'application_rejected') as rejected,
                   bool_or(e.event_type = 'manual_review_started') as referred,
                   bool_or(e.event_type = 'kyc_failed') as kyc_failed,
                   min(e.ts) filter (where e.event_type = 'loan_disbursed') as disbursed_at
              from events e where e.application_id in (select id from win) group by e.application_id),
          ac as (
            select c.application_id,
                   coalesce(sum(c.latency_ms) filter (where c.provider = 'bureau'), 0)::int as bureau_wait,
                   coalesce(sum(c.latency_ms) filter (where c.provider = 'kyc'), 0)::int as kyc_wait
              from api_calls c where c.application_id in (select id from win) group by c.application_id)
     select a.id, a.created_at, a.device, a.channel, a.employment, a.new_to_credit, a.app_version, a.rule_version, a.decision,
            a.reason_codes, a.credit_score, a.age, a.monthly_income, a.existing_emi, a.requested_amount, a.tenure_months,
            a.default_prob, a.would_default, a.offered_amount, a.variant,
            coalesce(ev.application_started, false) as application_started,
            coalesce(ev.kyc_completed, false) as kyc_completed,
            coalesce(ev.eligibility_passed, false) as eligibility_passed,
            coalesce(ev.offer_viewed, false) as offer_viewed,
            coalesce(ev.offer_accepted, false) as offer_accepted,
            coalesce(ev.loan_disbursed, false) as loan_disbursed,
            coalesce(ev.rejected, false) as rejected,
            coalesce(ev.referred, false) as referred,
            coalesce(ev.kyc_failed, false) as kyc_failed,
            extract(epoch from (ev.disbursed_at - a.created_at)) as tat_seconds,
            coalesce(ac.bureau_wait, 0) as bureau_wait,
            coalesce(ac.kyc_wait, 0) as kyc_wait
       from applications a
       join win on win.id = a.id
       left join ev on ev.application_id = a.id
       left join ac on ac.application_id = a.id
      order by a.id`,
    [dayStart(fromDay), dayStart(toDayExclusive)],
  );
  for (const r of rows) {
    r.day = istDay(r.created_at);
    r.hour = istHour(r.created_at);
  }
  return rows;
}

export async function dataRange(pool) {
  const { rows } = await pool.query('select min(created_at) a, max(created_at) b, count(*)::int n from applications');
  if (!rows[0].n) return null;
  return { first: istDay(rows[0].a), last: istDay(rows[0].b), count: rows[0].n };
}
