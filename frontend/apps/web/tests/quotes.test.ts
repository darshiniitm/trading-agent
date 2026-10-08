import { describe, expect, it, vi, beforeEach } from "vitest";
import { getQuotes, _resetQuoteCacheForTests } from "@/server/quotes";
import { EngineError } from "@/server/engine/client";

beforeEach(() => _resetQuoteCacheForTests());

// Mirrors engine.quotes.fetch_quotes's actual shape (engine/quotes.py): a success
// entry is {price, source, source_ts}, a failure entry is only {error} — never
// {price: null, as_of: null, error: null} as earlier mocks wrongly assumed.
function fakeFetch(status: number, rawText: string) {
  let read = false;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => {
      if (read) throw new Error("Body is unusable: Body has already been read");
      read = true;
      return rawText;
    },
  });
}

describe("getQuotes", () => {
  it("fetches uncached symbols from the engine and maps source_ts -> asOf", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({ ABC: { price: 101.5, source: "yahoo", source_ts: "2026-10-02T09:15:00Z" } }));
    const result = await getQuotes(["ABC"], fetchFn as any, () => 0);
    expect(result.ABC).toEqual({ price: 101.5, asOf: "2026-10-02T09:15:00Z", error: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat request within 60 seconds from cache, without a second fetch", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({ ABC: { price: 101.5, source: "yahoo", source_ts: "t" } }));
    await getQuotes(["ABC"], fetchFn as any, () => 1000);
    await getQuotes(["ABC"], fetchFn as any, () => 1000 + 59_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache entry is older than 60 seconds", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ABC: { price: 101.5, source: "yahoo", source_ts: "t1" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ABC: { price: 102.0, source: "yahoo", source_ts: "t2" } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 0);
    const second = await getQuotes(["ABC"], fetchFn as any, () => 61_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(second.ABC.asOf).toBe("t2");
  });

  it("surfaces a per-symbol error (engine's {error} shape, no price/source) without failing the whole call", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({
      ABC: { price: 10, source: "yahoo", source_ts: "t" },
      XYZ: { error: "possibly delisted; no price data found" },
    }));
    const result = await getQuotes(["ABC", "XYZ"], fetchFn as any, () => 0);
    expect(result.XYZ).toEqual({ price: null, asOf: null, error: "possibly delisted; no price data found" });
    expect(result.ABC).toEqual({ price: 10, asOf: "t", error: null });
  });

  it("does not cache a symbol that errored, so the next call retries it immediately", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ABC: { error: "timeout" } }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ABC: { price: 50, source: "yahoo", source_ts: "t" } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 0);
    const second = await getQuotes(["ABC"], fetchFn as any, () => 1000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(second.ABC.price).toBe(50);
  });

  it("throws EngineError, reading the body only once, on a non-2xx response", async () => {
    const fetchFn = fakeFetch(500, "Internal Server Error");
    await expect(getQuotes(["ABC"], fetchFn as any, () => 0)).rejects.toBeInstanceOf(EngineError);
  });
});

describe("getQuotes day change", () => {
  it("computes chgPct from prev_close, and omits it when the engine sent none", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({
      UP: { price: 110, source: "yahoo", source_ts: "t", prev_close: 100 },
      NOPREV: { price: 50, source: "yahoo", source_ts: "t" },
    }));
    const result = await getQuotes(["UP", "NOPREV"], fetchFn as any, () => 0);
    expect(result.UP.chgPct).toBeCloseTo(10);
    expect(result.NOPREV.chgPct).toBeUndefined();
  });
});
