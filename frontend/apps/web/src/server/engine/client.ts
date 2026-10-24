import type { ScreenProgram } from "spec";
import { context, isSpanContextValid, trace } from "@opentelemetry/api";
import { currentRun, tool } from "@/server/telemetry";
import { runtime } from "@/server/telemetry/runtime";

// The interpreter's bookkeeping (assumption chips, greyed-out rows) is the app's own; the engine only ever
// sees the rules it has to run — plus one fact it must not lose: a condition the prompt named but nothing can
// evaluate ("P/E below 25") means no stock is a full match, so the engine reports its members as partial.
export function forEngine<T>(program: T): T {
  if (!program || typeof program !== "object") return program;
  const { assumptions: _a, not_evaluable, ...rest } = program as any;
  const unsupported = (Array.isArray(not_evaluable) ? not_evaluable : [])
    .filter((n: any) => n?.id === "unsupported")
    .map((n: any) => ({ text: String(n.text), reason: String(n.reason) }));
  return (unsupported.length ? { ...rest, unsupported } : rest) as T;
}

export const ENGINE_BASE_URL = process.env.ENGINE_BASE_URL ?? "http://127.0.0.1:8001";

export class EngineError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`engine request failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

type FetchFn = typeof fetch;

// Observability: engine calls made while a prompt run is active become tool spans (screen.filter, data.fetch, ...), and carry the
// W3C trace context plus the run id so the Python side joins the same trace. Outside a run (supervisor health polls) nothing is traced.
// `screen.filter` and `data.fetch` are the ENGINE's own spans (rows in/out, provider calls); these are the TS-side client calls, named apart so the two never double-count
const SEG_TOOL: Record<string, string> = { screen: "engine.screen", feasibility: "engine.feasibility", quotes: "engine.quotes", series: "engine.series", history: "engine.history", fundamentals: "engine.fundamentals", metrics: "engine.metrics", select: "engine.select", validate: "arms.validate" };
export function engineToolName(path: string): string {
  const [seg1 = "", seg2, seg3] = path.split("?")[0].split("/").filter(Boolean);
  if (seg1 === "arms") return `arms.${seg3 ?? seg2 ?? "register"}`.replace(/\.\d+$/, ".register");
  if (seg1 === "data") return `data.${seg2 ?? "health"}`;
  return SEG_TOOL[seg1] ?? `engine.${seg1 || "root"}`;
}

function withTraceHeaders(init: Parameters<FetchFn>[1]): Parameters<FetchFn>[1] {
  const sc = trace.getSpanContext(context.active());
  const run = currentRun();
  if (!sc || !isSpanContextValid(sc)) return init;
  const headers = new Headers((init as { headers?: HeadersInit } | undefined)?.headers);
  headers.set("traceparent", `00-${sc.traceId}-${sc.spanId}-0${sc.traceFlags & 1}`);
  if (run) { headers.set("x-run-id", run.runId); if (run.promptId !== undefined) headers.set("x-prompt-id", String(run.promptId)); }
  return { ...init, headers };
}

async function callImpl(path: string, init: Parameters<FetchFn>[1], fetchFn: FetchFn) {
  const res = await fetchFn(`${ENGINE_BASE_URL}${path}`, init);
  // A Response body can only be consumed once, so read it as text exactly
  // once and try to parse that — never call both res.json() and res.text()
  // on the same response (the second read throws "Body has already been
  // read" against a real fetch Response, even though a hand-rolled test
  // double with independent json()/text() stubs won't catch that).
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    if (!res.ok) throw new EngineError(res.status, text);
    throw new Error(`engine returned a non-JSON 2xx response: ${text}`);
  }
  if (!res.ok) throw new EngineError(res.status, body);
  return body;
}

export async function call(path: string, init: Parameters<FetchFn>[1], fetchFn: FetchFn) {
  if (!runtime().enabled || !currentRun()) return callImpl(path, init, fetchFn);
  return tool(engineToolName(path), (p: string, i: Parameters<FetchFn>[1], f: FetchFn) => callImpl(p, withTraceHeaders(i), f),
    { argsOf: (p) => ({ path: p, method: (init as { method?: string } | undefined)?.method ?? "GET" }) })(path, init, fetchFn);
}

export function getHealth(fetchFn: FetchFn = fetch) {
  return call("/health", { method: "GET" }, fetchFn);
}

// engine/quotes.py's fetch_quotes: a success entry is {price, source, source_ts};
// a failure entry is only {error} — there is no as_of/error:null on success.
type RawQuote = { price: number; source: string; source_ts: string; prev_close?: number; volume?: number } | { error: string };

export async function postQuotes(symbols: string[], fetchFn: FetchFn = fetch) {
  return call(
    "/quotes",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbols }),
    },
    fetchFn
  ) as Promise<Record<string, RawQuote>>;
}

// ---- data resolution & fallback layer (docs/data-fallback-spec.md) ----
export type DataQuality = "ok" | "fallback" | "stale" | "approx" | "missing";
export type RunCoverage = {
  universe_size: number; fully_evaluated: number; coverage: number;
  per_condition: Record<string, number>; universe_quality: string; unfeedable_conditions: string[];
  status: "complete" | "partial" | "low_coverage"; scored: boolean;
};
export type UnevaluatedRow = {
  ticker: string; name?: string | null; sector?: string | null; set?: string; reasons: string[];
  unknown_count: number; met_count: number; conditions?: Record<string, unknown>;
};
export type ProvenanceBlock = {
  summary: { data_type: string; source?: string | null; as_of?: string | null; quality?: string; reason?: string | null; counts?: Record<string, number> }[];
  rows: { data_type: string; symbol: string; source: string | null; as_of: string | null; quality: string; reason: string | null }[];
};
export type FeasibilityStatus = "ready" | "fallback" | "stale" | "approx" | "unavailable" | "unknown";
export type Feasibility = {
  universe: { status: FeasibilityStatus; source?: string | null; detail?: string | null; can_upload?: boolean };
  conditions: Record<string, { status: FeasibilityStatus; source: string | null; as_of: string | null; detail: string | null }>;
};

// Tier-0 upload keys (data-fallback spec §9.4); omitted entirely when unknown so the request stays as it was.
const uploadKeys = (ids: { userId?: number; promptId?: number }) =>
  ids.userId !== undefined && ids.promptId !== undefined ? { user_id: ids.userId, prompt_id: ids.promptId } : {};

export function feasibility(program: unknown, asOf: string, ids: { userId?: number; promptId?: number } = {}, fetchFn: FetchFn = fetch) {
  return call("/feasibility", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ program: forEngine(program), as_of: asOf, user_id: ids.userId ?? null, prompt_id: ids.promptId ?? null }),
  }, fetchFn) as Promise<{ feasibility: Feasibility }>;
}

export function getDataHealth(fetchFn: FetchFn = fetch) {
  return call("/data/health", { method: "GET" }, fetchFn) as Promise<DataHealth>;
}
export type DataHealth = {
  last_success: { provider: string; data_type: string; last_ok_at: string }[];
  stale_symbols: number; missing_symbols: number;
  approximated_indices: { index_name: string; last_used_at: string; rule: string | null }[];
  failures_by_provider: { provider: string; data_type: string; reason: string; n: number }[];
  recent_gaps: { id: number; logged_at: string; data_type: string; symbol: string | null; provider: string; reason: string; detail: string | null }[];
  gap_count: number;
};
export function startPrefetch(force = false, fetchFn: FetchFn = fetch) {
  return call("/data/prefetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force }) }, fetchFn);
}
export function uploadUniverse(userId: number, promptId: number, name: string, text: string, fetchFn: FetchFn = fetch) {
  return call("/data/upload", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_id: userId, prompt_id: promptId, name, text }) }, fetchFn) as Promise<{ saved: string; source: string; quality: string }>;
}

export async function screen(program: ScreenProgram, asOf: string, fetchFn: FetchFn = fetch, ids: { userId?: number; promptId?: number } = {}) {
  return call(
    "/screen",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ program: forEngine(program), as_of: asOf, ...uploadKeys(ids) }),
    },
    fetchFn
  ) as Promise<{
    funnel: unknown[];
    applied_steps: { step: string; applied: boolean; reason: string | null }[];
    candidates: {
      ticker: string;
      membership: "full_match" | "near_miss" | "rejected_risk_cap";
      values: Record<string, unknown>;
      failed_ids: string[];
      ep: number | null;
      sl: number | null;
      r: number | null;
    }[];
    sector_view: unknown[];
    // absent when talking to an engine from before the data-resolution layer
    run_coverage?: RunCoverage;
    unevaluated?: UnevaluatedRow[];
    provenance?: ProvenanceBlock;
  }>;
}

export type SelectCandidate = {
  ticker: string;
  membership: "full_match" | "near_miss" | "rejected_risk_cap";
  values: Record<string, unknown>;
  failed_ids: string[];
  ep: number | null;
  sl: number | null;
  r: number | null;
  entry_price?: number;
  ref_price?: number | null;
  reason?: string;
};

export type SelectResult = {
  entered: SelectCandidate[];
  not_confirmed: SelectCandidate[];
  no_point_data: SelectCandidate[];
  watching: SelectCandidate[];
};

export async function selectCandidates(
  program: ScreenProgram,
  asOf: string,
  promptId: number | null,
  runKind: "scheduled" | "catch_up" | "dry_run",
  fetchFn: FetchFn = fetch
): Promise<SelectResult> {
  return call(
    "/select",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ program: forEngine(program), as_of: asOf, prompt_id: promptId, run_kind: runKind }),
    },
    fetchFn
  ) as Promise<SelectResult>;
}

export async function registerArm(promptId: number, program: ScreenProgram, fetchFn: FetchFn = fetch) {
  return call(
    "/arms/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: promptId, program: forEngine(program) }) },
    fetchFn
  ) as Promise<{ prompt_id: number; status: string }>;
}

export async function retireArm(promptId: number, fetchFn: FetchFn = fetch) {
  return call(`/arms/${promptId}/retire`, { method: "POST" }, fetchFn) as Promise<{ prompt_id: number; status: string }>;
}

export type ValidatePick = { ticker: string; entry_price: number | null; sl: number | null };

// The engine (src/backtest/horizons.py:grade_horizons) emits TWO rows per
// (ticker, horizon): view "signal" (close-to-close, stop ignored) and view
// "trade" (trailing-stop exit, frozen once hit). Consumers must pick one view
// — averaging both mixes two different return definitions and double-counts
// n. `view` is optional only because engine/validation.py's
// not_gradable_weekly_downtrend rows (t1_literal picks with no resting weekly
// stop) carry no view key at all; graded/pending rows always have one.
export type ValidateView = "signal" | "trade";

export type ValidateRow = {
  ticker: string;
  signal_week_start: string;
  horizon_weeks: number;
  view?: ValidateView;
  status: "graded" | "pending" | "not_gradable_weekly_downtrend";
  buy_price: number | null;
  r_Nw: number | null;
};

export type ValidateResult = { graded_weeks: number; maturity: "not_first_look" | "first_look" | "real_read"; rows: ValidateRow[] };

export async function validateArm(
  promptId: number,
  program: ScreenProgram,
  asOf: string,
  picks: ValidatePick[],
  gradedWeeksSoFar: number,
  fetchFn: FetchFn = fetch
): Promise<ValidateResult> {
  return call(
    "/validate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt_id: promptId, program: forEngine(program), as_of: asOf, picks, graded_weeks_so_far: gradedWeeksSoFar }),
    },
    fetchFn
  ) as Promise<ValidateResult>;
}

export function getConditionsV5(fetchFn: FetchFn = fetch) {
  return call("/conditions/v5", { method: "GET" }, fetchFn);
}

// Dry-run a v5 program. The engine refuses (422) while any question is unanswered, so the app never
// screens a program that still has an unstated value.
// `table: true` also asks for the primary list: every stock in the universe with every condition's value (slower).
export function screenProgram(program: unknown, asOf: string, fetchFn: FetchFn = fetch, table = false, ids: { userId?: number; promptId?: number } = {}) {
  return call("/screen/v5", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ program: forEngine(program), as_of: asOf, ...uploadKeys(ids), ...(table ? { table: true } : {}) }) }, fetchFn);
}

// ---- price history for charts (engine GET /series/{symbol}) ----
export type SeriesBar = { date: string; close: number | null; vstop_line?: number | null; uptrend?: boolean | null; rsi?: number | null };
export type SeriesParams = { vstopLength?: number; vstopMult?: number; vstopSource?: string; rsiLength?: number };

export async function getSeries(symbol: string, params: SeriesParams = {}, fetchFn: FetchFn = fetch) {
  const q = new URLSearchParams();
  if (params.vstopLength !== undefined) q.set("vstop_length", String(params.vstopLength));
  if (params.vstopMult !== undefined) q.set("vstop_mult", String(params.vstopMult));
  if (params.vstopSource !== undefined) q.set("vstop_source", params.vstopSource);
  if (params.rsiLength !== undefined) q.set("rsi_length", String(params.rsiLength));
  const qs = q.toString();
  return call(`/series/${encodeURIComponent(symbol)}${qs ? `?${qs}` : ""}`, { method: "GET" }, fetchFn) as Promise<{ symbol: string; bars: SeriesBar[] }>;
}

// ---- P6 watchlist views (display only): engine/metrics_service.py and engine/fundamentals.py ----
export type RawMetrics = Record<string, any> & { error?: string };
export type RawFundamentals = { currency?: string; market_cap?: number | null; shares_out?: number | null; revenue_ttm?: number | null; eps_ttm?: number | null; dividend_ttm?: number | null; error?: string };

export function getMetrics(symbols: string[], tf: "1D" | "1W", fetchFn: FetchFn = fetch) {
  const q = new URLSearchParams({ symbols: symbols.join(","), tf });
  return call(`/metrics?${q}`, { method: "GET" }, fetchFn) as Promise<Record<string, RawMetrics>>;
}

export function getFundamentals(symbols: string[], fetchFn: FetchFn = fetch) {
  const q = new URLSearchParams({ symbols: symbols.join(",") });
  return call(`/fundamentals?${q}`, { method: "GET" }, fetchFn) as Promise<Record<string, RawFundamentals>>;
}

export function getHistory(symbol: string, weeks = 52, fetchFn: FetchFn = fetch) {
  return call(`/history/${encodeURIComponent(symbol)}?weeks=${weeks}`, { method: "GET" }, fetchFn) as Promise<{ symbol: string; dates: string[]; closes: number[] }>;
}

// ---- "Refresh data" (engine/refresh.py): when the weekly price cache was last fetched, and a way to rebuild it ----
export type RefreshStatus = {
  state: "idle" | "running" | "done" | "error"; done: number; total: number;
  started_at: number | null; finished_at: number | null; error: string | null;
  last_refreshed: { fetched_at: string | null; latest_bar_date: string | null };
  started?: boolean;
};
export function getRefreshStatus(fetchFn: FetchFn = fetch) {
  return call("/data/refresh", { method: "GET" }, fetchFn) as Promise<RefreshStatus>;
}
export function startRefresh(fetchFn: FetchFn = fetch) {
  return call("/data/refresh", { method: "POST" }, fetchFn) as Promise<RefreshStatus>;
}
