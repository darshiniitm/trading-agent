import { describe, expect, it, vi } from "vitest";
import { registerArm, retireArm, selectCandidates, validateArm } from "@/server/engine/client";

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
}

import { program } from "./helpers/program";

const SPEC = program();

describe("selectCandidates", () => {
  it("posts program/as_of/prompt_id/run_kind and returns the four membership buckets", async () => {
    const fetchFn = fakeFetch(200, { entered: [{ ticker: "A", entry_price: 101 }], not_confirmed: [], no_point_data: [], watching: [] });
    const result = await selectCandidates(SPEC, "2026-10-02", 7, "scheduled", fetchFn as any);
    expect(result.entered).toHaveLength(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/select");
    expect(JSON.parse(init.body)).toEqual({ program: SPEC, as_of: "2026-10-02", prompt_id: 7, run_kind: "scheduled" });
  });
});

describe("registerArm / retireArm", () => {
  it("registerArm posts {prompt_id, program} to /arms/register", async () => {
    const fetchFn = fakeFetch(200, { prompt_id: 7, status: "active" });
    const result = await registerArm(7, SPEC, fetchFn as any);
    expect(result.status).toBe("active");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/arms/register");
    expect(JSON.parse(init.body)).toEqual({ prompt_id: 7, program: SPEC });
  });

  it("retireArm posts to /arms/{id}/retire with no body", async () => {
    const fetchFn = fakeFetch(200, { prompt_id: 7, status: "retired" });
    const result = await retireArm(7, fetchFn as any);
    expect(result.status).toBe("retired");
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8001/arms/7/retire");
  });
});

describe("validateArm", () => {
  it("posts prompt_id/program/as_of/picks/graded_weeks_so_far, returns graded_weeks/maturity/rows", async () => {
    const fetchFn = fakeFetch(200, { graded_weeks: 13, maturity: "first_look", rows: [{ ticker: "A", horizon_weeks: 1, status: "graded", r_Nw: 2.5 }] });
    const result = await validateArm(7, SPEC, "2026-10-02", [{ ticker: "A", entry_price: 100, sl: 95 }], 13, fetchFn as any);
    expect(result.maturity).toBe("first_look");
    expect(result.rows).toHaveLength(1);
    const [, init] = fetchFn.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      prompt_id: 7, program: SPEC, as_of: "2026-10-02",
      picks: [{ ticker: "A", entry_price: 100, sl: 95 }], graded_weeks_so_far: 13,
    });
  });
});
