-- Run records for the prompt-screener observability stack (docs/production-llm-cloud-observability-plan.md, Part B).
-- A dedicated schema: forward_testing.weekly_runs and prompt_history.* describe the forward test / earlier prompt runs and
-- must not be confused with these. Rows are written asynchronously by the app (web/src/server/telemetry) and the engine
-- (src/telemetry); a failed write never fails a run. Every row carries trace_id so Grafana can link to Tempo/Loki.
-- Parent links are span ids, not FKs: children can arrive before their parent's row and a lost parent must not lose a child.
create schema observability;

create table observability.runs (
  run_id      uuid primary key default gen_random_uuid(),
  trace_id    text not null unique,
  kind        text not null check (kind in ('prompt_run','weekly_job')),
  draft_id    text,
  prompt_id   bigint,                         -- numeric prompt id, back-filled at confirm
  user_hash   text,                           -- HMAC of the user id; never the id or email
  provider    text,
  model       text,
  status      text not null default 'running' check (status in ('running','ok','error','partial')),
  outcome     text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  duration_ms integer,
  rows_in     integer,
  rows_out    integer,
  error_type  text,
  error_msg   text,
  code_version text,
  attrs       jsonb not null default '{}'
);
create index runs_prompt_idx  on observability.runs (prompt_id);
create index runs_started_idx on observability.runs (started_at);

create table observability.run_tasks (
  id             bigint generated always as identity primary key,
  run_id         uuid not null references observability.runs on delete cascade,
  trace_id       text not null,
  span_id        text not null,
  parent_span_id text,
  task_id        text not null,
  task_name      text not null,
  seq            integer not null,
  status         text not null check (status in ('ok','error','retried','fallback','skipped')),
  started_at     timestamptz not null,
  ended_at       timestamptz,
  duration_ms    integer,
  rows_in        integer,
  rows_out       integer,
  input          jsonb,
  output         jsonb,
  truncated      boolean not null default false,
  error_type     text,
  error_msg      text,
  unique (trace_id, span_id)
);
create index run_tasks_run_idx  on observability.run_tasks (run_id, started_at);
create index run_tasks_name_idx on observability.run_tasks (task_name, started_at);

create table observability.agent_calls (
  id             bigint generated always as identity primary key,
  run_id         uuid not null references observability.runs on delete cascade,
  trace_id       text not null,
  span_id        text not null,
  parent_span_id text,
  task_span_id   text,
  agent_name     text not null,
  agent_version  text,                        -- hash of the agent's system prompt
  model          text,
  provider       text,
  input_tokens   integer,
  output_tokens  integer,
  gpu_ms         integer,
  status         text not null check (status in ('ok','error','retried','fallback','skipped')),
  started_at     timestamptz not null,
  ended_at       timestamptz,
  duration_ms    integer,
  input          jsonb,
  output         jsonb,
  truncated      boolean not null default false,
  error_type     text,
  error_msg      text,
  unique (trace_id, span_id)
);
create index agent_calls_run_idx   on observability.agent_calls (run_id, started_at);
create index agent_calls_agent_idx on observability.agent_calls (agent_name, started_at);

-- Includes llm.chat calls (tool_name = 'llm.chat'); the llm-only columns are null for every other tool.
create table observability.tool_calls (
  id             bigint generated always as identity primary key,
  run_id         uuid not null references observability.runs on delete cascade,
  trace_id       text not null,
  span_id        text not null,
  parent_span_id text,
  agent_span_id  text,
  tool_name      text not null,
  tool_args      jsonb,
  rows_in        integer,
  rows_out       integer,
  model          text,
  provider       text,
  input_tokens   integer,
  output_tokens  integer,
  gpu_ms         integer,
  status         text not null check (status in ('ok','error','retried','fallback','skipped')),
  started_at     timestamptz not null,
  ended_at       timestamptz,
  duration_ms    integer,
  input          jsonb,
  output         jsonb,
  truncated      boolean not null default false,
  error_type     text,
  error_msg      text,
  unique (trace_id, span_id)
);
create index tool_calls_run_idx  on observability.tool_calls (run_id, started_at);
create index tool_calls_tool_idx on observability.tool_calls (tool_name, started_at);

-- Read-only role for the Grafana Postgres datasource. NOLOGIN here so no secret is committed: the operator runs
--   alter role grafana_ro login password '...';   out of band (Supabase SQL editor).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'grafana_ro') then
    create role grafana_ro nologin;
  end if;
end $$;
grant usage on schema observability to grafana_ro;
grant select on all tables in schema observability to grafana_ro;
alter default privileges in schema observability grant select on tables to grafana_ro;

-- Supabase exposes public-facing roles through PostgREST; these tables must not be reachable from the browser.
do $$ begin
  if to_regrole('anon') is not null then
    revoke all on schema observability from anon;
    revoke all on all tables in schema observability from anon;
  end if;
  if to_regrole('authenticated') is not null then
    revoke all on schema observability from authenticated;
    revoke all on all tables in schema observability from authenticated;
  end if;
end $$;
