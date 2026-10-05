import { describe, expect, it, vi, beforeEach } from "vitest";
import { getQuotes, _resetQuoteCacheForTests } from "@/server/quotes";

beforeEach(() => _resetQuoteCacheForTests());

describe("getQuotes", () => {
  it("fetches uncached symbols from the engine", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ABC: { price: 101.5, as_of: "2026-10-02T09:15:00Z", error: null } }),
    });
    const result = await getQuotes(["ABC"], fetchFn as any, () => 0);
    expect(result.ABC).toEqual({ price: 101.5, asOf: "2026-10-02T09:15:00Z", error: null });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("serves a repeat request within 60 seconds from cache, without a second fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ABC: { price: 101.5, as_of: "t", error: null } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 1000);
    await getQuotes(["ABC"], fetchFn as any, () => 1000 + 59_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("refetches once the cache entry is older than 60 seconds", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ABC: { price: 101.5, as_of: "t", error: null } }) });
    await getQuotes(["ABC"], fetchFn as any, () => 0);
    await getQuotes(["ABC"], fetchFn as any, () => 61_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("surfaces a per-symbol error without failing the whole call", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ABC: { price: 10, as_of: "t", error: null }, XYZ: { price: null, as_of: null, error: "no data" } }),
    });
    const result = await getQuotes(["ABC", "XYZ"], fetchFn as any, () => 0);
    expect(result.XYZ.error).toBe("no data");
    expect(result.ABC.error).toBeNull();
  });
});
