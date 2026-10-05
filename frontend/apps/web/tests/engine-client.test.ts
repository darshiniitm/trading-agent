import { describe, expect, it, vi } from "vitest";
import { EngineError, getConditions, screen } from "@/server/engine/client";

// Mirrors the real Fetch API constraint that a Response body can only be
// read once: text() throws on a second call, and there is no separate
// json() at all (the real json() is just JSON.parse(await text()) under
// the hood) — this is what caught client.ts calling both json() and text()
// on the same response in the earlier version of this fix.
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

describe("getConditions", () => {
  it("returns the parsed catalog on 200", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify([{ kind: "indicator", name: "vstop" }]));
    const result = await getConditions(fetchFn as any);
    expect(result).toEqual([{ kind: "indicator", name: "vstop" }]);
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8001/conditions", expect.anything());
  });
});

describe("screen", () => {
  const spec = {
    spec_version: 4, structure: "literal" as const, timeframe: "1W" as const,
    selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null,
  };

  it("posts the spec and as_of, returns the parsed body on 200", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }));
    const result = await screen(spec, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ spec, as_of: "2026-10-02" });
  });

  it("throws EngineError with the status and body on 422", async () => {
    const fetchFn = fakeFetch(422, JSON.stringify({ errors: [{ condition_id: "C9", message: "unsupported" }] }));
    await expect(screen(spec, "2026-10-02", fetchFn as any)).rejects.toMatchObject({
      status: 422,
      body: { errors: [{ condition_id: "C9", message: "unsupported" }] },
    });
  });

  it("throws EngineError with the raw text when a non-2xx response body isn't JSON (e.g. a 500 with a plain-text error page), reading the body only once", async () => {
    const fetchFn = fakeFetch(500, "Internal Server Error");
    await expect(screen(spec, "2026-10-02", fetchFn as any)).rejects.toMatchObject({
      status: 500,
      body: "Internal Server Error",
    });
  });
});
