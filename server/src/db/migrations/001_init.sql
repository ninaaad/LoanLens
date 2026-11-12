create table rule_versions (
  id serial primary key,
  version text not null unique,
  effective_from timestamptz not null,
  note text,
  config jsonb not null,
  created_at timestamptz not null default now()
);

create table applications (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  channel text not null default 'direct',
  device text not null default 'web',
  app_version text not null default 'web',
  age int not null,
  employment text not null default 'salaried',
  monthly_income numeric not null,
  existing_emi numeric not null default 0,
  new_to_credit boolean not null default false,
  requested_amount numeric not null,
  tenure_months int not null,
  credit_score int,
  bureau_score_latent int,
  decision text,
  reason_codes text[] not null default '{}',
  rule_version text,
  offered_amount numeric,
  offered_rate numeric,
  offered_emi numeric,
  variant text,
  -- Synthetic ground truth. Real lenders only observe this for loans they made.
  default_prob numeric,
  would_default boolean,
  is_synthetic boolean not null default false
);
create index applications_created_idx on applications (created_at);

create table events (
  id bigserial primary key,
  application_id bigint not null references applications(id) on delete cascade,
  event_type text not null,
  ts timestamptz not null default now(),
  props jsonb not null default '{}'
);
create index events_app_idx on events (application_id);
create index events_type_ts_idx on events (event_type, ts);

create table api_calls (
  id bigserial primary key,
  application_id bigint references applications(id) on delete cascade,
  provider text not null,
  ts timestamptz not null,
  latency_ms int not null,
  status text not null
);
create index api_calls_provider_ts_idx on api_calls (provider, ts);
create index api_calls_app_idx on api_calls (application_id);

create table releases (
  id serial primary key,
  version text not null,
  deployed_at timestamptz not null,
  description text not null,
  affects_step text,
  affects_platform text
);
