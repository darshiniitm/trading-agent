-- Long-running draft requests as background jobs (docs/netlify-production-plan.md §6.2).
-- A Netlify function is cut off at 60 s; compile and screen can exceed that when the LLM is slow. The route then writes a
-- job row, a background function (15 min) runs it, and the page polls GET /api/jobs/:id. The existing jobs table (weekly
-- catch-up / grading, keyed by prompt) gains the columns a draft-level job needs. Draft jobs have no prompt_id / as_of, which
-- the unique (type, prompt_id, as_of) key allows (NULLs never collide).
alter table screener_app.jobs
  add column draft_id     bigint references screener_app.prompt_drafts on delete cascade,
  add column user_id      bigint references screener_app.users,
  add column payload      jsonb,
  add column result_json  jsonb,
  add column error_status integer,
  add column started_at   timestamptz;

create index ix_jobs_draft on screener_app.jobs (draft_id, type, job_id desc) where draft_id is not null;
