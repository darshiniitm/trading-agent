import { sqliteTable, integer, text, real } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  userId: integer("user_id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: text("role").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const promptDrafts = sqliteTable("prompt_drafts", {
  draftId: integer("draft_id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  parentPromptId: integer("parent_prompt_id"),
  title: text("title"),
  promptText: text("prompt_text").notNull(),
  structure: text("structure"),
  specJson: text("spec_json"),
  needsInputJson: text("needs_input_json"),
  answersJson: text("answers_json"),
  hypothesis: text("hypothesis"),
  killCriterion: text("kill_criterion"),
  status: text("status").notNull(),
  confirmedPromptId: integer("confirmed_prompt_id"),
  sourcePhrasesJson: text("source_phrases_json"),
  unsupportedJson: text("unsupported_json"),
  copiedFromPromptId: integer("copied_from_prompt_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  programJson: text("program_json"),
  programClausesJson: text("program_clauses_json"),
  programNormalised: text("program_normalised"),
});

export const prompts = sqliteTable("prompts", {
  promptId: integer("prompt_id").primaryKey({ autoIncrement: true }),
  ownerUserId: integer("owner_user_id").notNull(),
  draftId: integer("draft_id").notNull(),
  title: text("title").notNull(),
  promptText: text("prompt_text").notNull(),
  structure: text("structure").notNull(),
  specJson: text("spec_json").notNull(),
  specHash: text("spec_hash").notNull(),
  status: text("status").notNull(),
  parentPromptId: integer("parent_prompt_id"),
  version: integer("version").notNull(),
  hypothesis: text("hypothesis").notNull(),
  killCriterion: text("kill_criterion").notNull(),
  visibility: text("visibility").notNull(),
  copiedFromPromptId: integer("copied_from_prompt_id"),
  trackStockArm: text("tracks_stock_arm"),
  reviewWeek: integer("review_week"),
  confirmedAt: text("confirmed_at").notNull(),
  closedAt: text("closed_at"),
});

export const watchlists = sqliteTable("watchlists", {
  watchlistId: integer("watchlist_id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull(),
  promptId: integer("prompt_id").notNull(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  archivedAt: text("archived_at"),
});

export const runs = sqliteTable("runs", {
  runId: integer("run_id").primaryKey({ autoIncrement: true }),
  promptId: integer("prompt_id").notNull(),
  asOf: text("as_of").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  appliedStepsJson: text("applied_steps_json"),
  funnelJson: text("funnel_json"),
  dataSnapshotHash: text("data_snapshot_hash"),
  engineVersion: text("engine_version"),
  forwardRecordRef: text("forward_record_ref"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  error: text("error"),
  // data-resolution layer (migration 0010)
  coverageStatus: text("coverage_status"),
  coverage: real("coverage"),
  universeQuality: text("universe_quality"),
  scored: integer("scored"),
});

export const symbols = sqliteTable("symbols", {
  symbol: text("symbol").primaryKey(),
  name: text("name"),
  sector: text("sector"),
  isin: text("isin"),
  active: integer("active").notNull(),
});

export const runResults = sqliteTable("run_results", {
  runId: integer("run_id").notNull(),
  symbol: text("symbol").notNull(),
  membership: text("membership").notNull(),
  inForwardRecord: integer("in_forward_record").notNull(),
  failedCondsJson: text("failed_conds_json"),
  condJson: text("cond_json").notNull(),
  metricsJson: text("metrics_json"),
  ep: real("ep"),
  sl: real("sl"),
  refPrice: real("ref_price"),
  confidence: real("confidence"),
  windowOffset: integer("window_offset"),
  daysSinceFlip: integer("days_since_flip"),
  entryStatus: text("entry_status"),
  // The resolved selection-point fill (written by selectEntry.ts alongside
  // entryStatus, for 'entered'/'not_confirmed' outcomes only) — distinct from
  // `ep`, which stays the screen-time draft value. See migration
  // 0003_run_results_entry_price.sql.
  entryPrice: real("entry_price"),
  // data-resolution layer (migration 0010)
  outcome: text("outcome"),
  unknownCount: integer("unknown_count"),
  reasonsJson: text("reasons_json"),
});

export const watchlistEntries = sqliteTable("watchlist_entries", {
  entryId: integer("entry_id").primaryKey({ autoIncrement: true }),
  watchlistId: integer("watchlist_id").notNull(),
  symbol: text("symbol").notNull(),
  firstRunId: integer("first_run_id").notNull(),
  lastRunId: integer("last_run_id").notNull(),
  membership: text("membership").notNull(),
  status: text("status").notNull(),
  entryDate: text("entry_date"),
  entryPrice: real("entry_price"),
  stop: real("stop"),
  refPrice: real("ref_price"),
  userNote: text("user_note"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const entryEvents = sqliteTable("entry_events", {
  eventId: integer("event_id").primaryKey({ autoIncrement: true }),
  entryId: integer("entry_id").notNull(),
  runId: integer("run_id"),
  type: text("type").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  at: text("at").notNull(),
});

export const validations = sqliteTable("validations", {
  runId: integer("run_id").notNull(),
  horizonW: integer("horizon_w").notNull(),
  n: integer("n").notNull(),
  ewReturn: real("ew_return"),
  controlEwReturn: real("control_ew_return"),
  hitRate: real("hit_rate"),
  computedAt: text("computed_at").notNull(),
});

export const jobs = sqliteTable("jobs", {
  jobId: integer("job_id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  promptId: integer("prompt_id"),
  asOf: text("as_of"),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull(),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  finishedAt: text("finished_at"),
});

export const compilations = sqliteTable("compilations", {
  compilationId: integer("compilation_id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id").notNull(),
  model: text("model").notNull(),
  rawJson: text("raw_json").notNull(),
  errorsJson: text("errors_json"),
  attempt: integer("attempt"),
  createdAt: text("created_at").notNull(),
});
