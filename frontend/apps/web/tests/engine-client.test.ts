import { describe, expect, it, vi } from "vitest";
import { EngineError, getConditions, screen } from "@/server/engine/client";

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe("getConditions", () => {
  it("returns the parsed catalog on 200", async () => {
    const fetchFn = fakeFetch(200, [{ kind: "indicator", name: "vstop" }]);
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
    const fetchFn = fakeFetch(200, { candidates: [], applied_steps: [], funnel: [], sector_view: [] });
    const result = await screen(spec, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ spec, as_of: "2026-10-02" });
  });

  it("throws EngineError with the status and body on 422", async () => {
    const fetchFn = fakeFetch(422, { errors: [{ condition_id: "C9", message: "unsupported" }] });
    await expect(screen(spec, "2026-10-02", fetchFn as any)).rejects.toMatchObject({
      status: 422,
      body: { errors: [{ condition_id: "C9", message: "unsupported" }] },
    });
  });
});
