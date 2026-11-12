create table rag_chunks (
  id serial primary key,
  doc_id text not null,
  doc_title text not null,
  chapter text,
  clause text not null,
  para text,
  heading text,
  content text not null,
  tsv tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || content)) stored
);
create index rag_chunks_tsv_idx on rag_chunks using gin (tsv);

create table experiments (
  id serial primary key,
  key text not null unique,
  name text not null,
  hypothesis text not null,
  primary_metric text not null,
  guardrails jsonb not null default '[]',
  variants jsonb not null default '["control","treatment"]',
  status text not null default 'draft',
  created_at timestamptz not null default now()
);
