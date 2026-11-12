-- Outcomes of simulated experiment cohorts. A separate table (not `applications`) so experiments never touch the
-- main funnel dataset that the detector and RCA run on. Every row is synthetic.
create table experiment_units (
  experiment_key text not null,
  unit_id text not null,
  variant text not null,
  accepted boolean not null,
  disbursed boolean not null,
  defaulted boolean,          -- only known for disbursed loans
  tat_seconds numeric,        -- only known for disbursed loans
  complained boolean not null,
  is_synthetic boolean not null default true,
  primary key (experiment_key, unit_id)
);
create index experiment_units_variant_idx on experiment_units (experiment_key, variant);
