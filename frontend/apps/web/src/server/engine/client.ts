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

async function call(path: string, init: Parameters<FetchFn>[1], fetchFn: FetchFn) {
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
