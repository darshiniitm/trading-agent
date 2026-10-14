import { describe, expect, it, vi } from "vitest";
import { EngineError, getConditionsV5, screen } from "@/server/engine/client";
import { program } from "./helpers/program";

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

describe("getConditionsV5", () => {
  it("returns the parsed catalog on 200", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({ indicators: [{ kind: "indicator", name: "vstop" }] }));
    const result = await getConditionsV5(fetchFn as any);
    expect(result).toEqual({ indicators: [{ kind: "indicator", name: "vstop" }] });
    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:8001/conditions/v5", expect.anything());
  });
});

describe("screen", () => {
  const spec = program();

  it("posts the program and as_of, returns the parsed body on 200", async () => {
    const fetchFn = fakeFetch(200, JSON.stringify({ candidates: [], applied_steps: [], funnel: [], sector_view: [] }));
    const result = await screen(spec, "2026-10-02", fetchFn as any);
    expect(result.candidates).toEqual([]);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ program: spec, as_of: "2026-10-02" });
  });

  it("throws EngineError with the status and body on 422 (engine's own {detail: [...]} shape, from HTTPException)", async () => {
    const fetchFn = fakeFetch(422, JSON.stringify({ detail: [{ condition_id: "C9", message: "unsupported" }] }));
    await expect(screen(spec, "2026-10-02", fetchFn as any)).rejects.toMatchObject({
      status: 422,
      body: { detail: [{ condition_id: "C9", message: "unsupported" }] },
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
