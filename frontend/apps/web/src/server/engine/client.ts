import type { ScreenSpec } from "spec";

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

export async function call(path: string, init: Parameters<FetchFn>[1], fetchFn: FetchFn) {
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

export function getConditions(fetchFn: FetchFn = fetch) {
  return call("/conditions", { method: "GET" }, fetchFn);
}

export function getStructures(fetchFn: FetchFn = fetch) {
  return call("/structures", { method: "GET" }, fetchFn);
}

export function getHealth(fetchFn: FetchFn = fetch) {
  return call("/health", { method: "GET" }, fetchFn);
}

// engine/quotes.py's fetch_quotes: a success entry is {price, source, source_ts};
// a failure entry is only {error} — there is no as_of/error:null on success.
type RawQuote = { price: number; source: string; source_ts: string } | { error: string };

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

export async function screen(spec: ScreenSpec, asOf: string, fetchFn: FetchFn = fetch) {
  return call(
    "/screen",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spec, as_of: asOf }),
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
  spec: ScreenSpec,
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
      body: JSON.stringify({ spec, as_of: asOf, prompt_id: promptId, run_kind: runKind }),
    },
    fetchFn
  ) as Promise<SelectResult>;
}

export async function registerArm(promptId: number, spec: ScreenSpec, fetchFn: FetchFn = fetch) {
  return call(
    "/arms/register",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt_id: promptId, spec }) },
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
  spec: ScreenSpec,
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
      body: JSON.stringify({ prompt_id: promptId, spec, as_of: asOf, picks, graded_weeks_so_far: gradedWeeksSoFar }),
    },
    fetchFn
  ) as Promise<ValidateResult>;
}
