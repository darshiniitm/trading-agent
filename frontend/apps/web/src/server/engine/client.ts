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
  const body = await res.json();
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
