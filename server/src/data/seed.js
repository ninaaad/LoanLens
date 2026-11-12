// Loads the synthetic dataset into Postgres. Safe to re-run: it wipes the synthetic data first.
import { pathToFileURL } from 'node:url';
import { createDb } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { ensureDefaultRules } from '../rules/defaultRules.js';
import { generate, RELEASES } from './generate.js';
import { clearAnalyticsCache } from '../analytics/data.js';

const CHUNK = 5000;

function* chunks(arr, n = CHUNK) {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

export async function seedDatabase(pool, { seed, days, perDay, log = () => {} } = {}) {
  await ensureDefaultRules(pool);
  const { rows: rulesets } = await pool.query('select version, effective_from, config from rule_versions order by effective_from');
  const data = generate({ seed, days, perDay, rulesets });

  await pool.query('truncate events, api_calls, applications, releases restart identity cascade');
  clearAnalyticsCache(pool);

  for (const r of RELEASES) {
    await pool.query('insert into releases(version, deployed_at, description, affects_step, affects_platform) values ($1,$2,$3,$4,$5)', [
      r.version, r.deployed_at, r.description, r.affects_step, r.affects_platform,
    ]);
  }

  for (const c of chunks(data.apps)) {
    const col = (f) => c.map(f);
    await pool.query(
      `insert into applications (id, created_at, channel, device, app_version, age, employment, monthly_income, existing_emi,
         new_to_credit, requested_amount, tenure_months, credit_score, bureau_score_latent, decision, reason_codes, rule_version,
         offered_amount, offered_rate, offered_emi, variant, default_prob, would_default, is_synthetic)
       select id, created_at, channel, device, app_version, age, employment, monthly_income, existing_emi, new_to_credit,
         requested_amount, tenure_months, credit_score, bureau_score_latent, decision,
         case when rc = '' then '{}'::text[] else string_to_array(rc, ',') end,
         rule_version, offered_amount, offered_rate, offered_emi, variant, default_prob, would_default, is_synthetic
       from unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::int[], $7::text[], $8::numeric[], $9::numeric[],
         $10::boolean[], $11::numeric[], $12::int[], $13::int[], $14::int[], $15::text[], $16::text[], $17::text[],
         $18::numeric[], $19::numeric[], $20::numeric[], $21::text[], $22::numeric[], $23::boolean[], $24::boolean[])
         as t(id, created_at, channel, device, app_version, age, employment, monthly_income, existing_emi, new_to_credit,
         requested_amount, tenure_months, credit_score, bureau_score_latent, decision, rc, rule_version,
         offered_amount, offered_rate, offered_emi, variant, default_prob, would_default, is_synthetic)`,
      [
        col((a) => a.id), col((a) => a.created_at), col((a) => a.channel), col((a) => a.device), col((a) => a.app_version),
        col((a) => a.age), col((a) => a.employment), col((a) => a.monthly_income), col((a) => a.existing_emi),
        col((a) => a.new_to_credit), col((a) => a.requested_amount), col((a) => a.tenure_months), col((a) => a.credit_score),
        col((a) => a.bureau_score_latent), col((a) => a.decision), col((a) => a.reason_codes.join(',')), col((a) => a.rule_version),
        col((a) => a.offered_amount), col((a) => a.offered_rate), col((a) => a.offered_emi), col((a) => a.variant),
        col((a) => a.default_prob), col((a) => a.would_default), col((a) => a.is_synthetic),
      ],
    );
  }
  await pool.query("select setval(pg_get_serial_sequence('applications','id'), (select coalesce(max(id),1) from applications))");

  for (const c of chunks(data.events)) {
    await pool.query(
      `insert into events (application_id, event_type, ts, props)
       select a, e, t, p::jsonb from unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::text[]) as x(a, e, t, p)`,
      [c.map((e) => e.application_id), c.map((e) => e.event_type), c.map((e) => e.ts), c.map((e) => JSON.stringify(e.props))],
    );
  }
  for (const c of chunks(data.apiCalls)) {
    await pool.query(
      `insert into api_calls (application_id, provider, ts, latency_ms, status)
       select * from unnest($1::bigint[], $2::text[], $3::timestamptz[], $4::int[], $5::text[])`,
      [c.map((e) => e.application_id), c.map((e) => e.provider), c.map((e) => e.ts), c.map((e) => e.latency_ms), c.map((e) => e.status)],
    );
  }
  log(`seeded ${data.apps.length} applications, ${data.events.length} events, ${data.apiCalls.length} api calls`);
  clearAnalyticsCache(pool);
  return { applications: data.apps.length, events: data.events.length, apiCalls: data.apiCalls.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = await createDb();
  try {
    await migrate(db.pool);
    await seedDatabase(db.pool, { log: console.log });
    console.log('All data is synthetic (is_synthetic = true).');
  } finally {
    await db.close();
  }
}
