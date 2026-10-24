import { describe, expect, it, vi } from "vitest";
import { createPgStore, createStoreFromEnv } from "@/server/telemetry/pgStore";
import { noopStore, type RunRow, type ToolRow } from "@/server/telemetry/store";

const run = (trace: string, over: Partial<RunRow> = {}): RunRow => ({ run_id: "11111111-1111-1111-1111-111111111111", trace_id: trace, kind: "prompt_run", status: "running", started_at: "2026-10-23T00:00:00.000Z", ...over });
const tool = (trace: string, span: string, over: Partial<ToolRow> = {}): ToolRow => ({ run_id: "11111111-1111-1111-1111-111111111111", trace_id: trace, span_id: span, tool_name: "screen", status: "ok", started_at: "2026-10-23T00:00:00.000Z", ended_at: "2026-10-23T00:00:01.000Z", duration_ms: 1000, truncated: false, input: { a: 1 }, ...over });
const fakePool = (impl?: (sql: string, params: unknown[]) => Promise<unknown>) => {
  const calls: { sql: string; params: unknown[] }[] = [];
  return { calls, query: vi.fn(async (sql: string, params: unknown[] = []) => { calls.push({ sql, params }); return impl ? impl(sql, params) : { rowCount: 1 }; }), end: vi.fn(async () => {}) };
};
const mk = (pool: ReturnType<typeof fakePool>, over: object = {}) => createPgStore({ poolFactory: () => pool, flushMs: 0, batchSize: 100, maxQueue: 5000, backoffBaseMs: 10, ...over });

describe("createPgStore", () => {
  it("writes a run first, then children, as idempotent multi-row inserts (one statement per table)", async () => {
    const pool = fakePool(); const s = mk(pool);
    s.insertTool(tool("t1", "s1")); s.insertTool(tool("t1", "s2")); s.upsertRun(run("t1"));
    await s.flush();
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].sql).toMatch(/insert into observability\.runs/i);
    expect(pool.calls[0].sql).toMatch(/on conflict \(trace_id\) do update/i);
    expect(pool.calls[1].sql).toMatch(/insert into observability\.tool_calls/i);
    expect(pool.calls[1].sql).toMatch(/on conflict \(trace_id, span_id\) do nothing/i);
    expect((pool.calls[1].sql.match(/\(\$/g) ?? []).length).toBe(2);          // two value tuples
    expect(pool.calls[1].params).toContain(JSON.stringify({ a: 1 }));          // jsonb passed as text
  });

  it("run upsert keeps earlier values when a later upsert omits them (coalesce) and never changes run_id", async () => {
    const pool = fakePool(); const s = mk(pool);
    s.upsertRun(run("t1")); await s.flush();
    expect(pool.calls[0].sql).toMatch(/coalesce\(excluded\.prompt_id, observability\.runs\.prompt_id\)/i);
    expect(pool.calls[0].sql).not.toMatch(/run_id = excluded\.run_id/i);
  });

  it("flushes automatically at batchSize", async () => {
    const pool = fakePool(); const s = mk(pool, { batchSize: 3 });
    for (let i = 0; i < 3; i++) s.insertTool(tool("t", `s${i}`));
    await vi.waitFor(() => expect(pool.calls.length).toBeGreaterThan(0));
    await s.close();
  });

  it("is bounded: drops the OLDEST rows when full and reports the drops", async () => {
    const pool = fakePool(); const onDrop = vi.fn(); const s = mk(pool, { maxQueue: 3, onDrop, batchSize: 1000 });
    for (let i = 0; i < 5; i++) s.insertTool(tool("t", `s${i}`));
    expect(onDrop).toHaveBeenCalledWith(1); expect(onDrop).toHaveBeenCalledTimes(2);
    await s.flush();
    const spans = pool.calls[0].params.filter((p) => typeof p === "string" && /^s\d$/.test(p as string));
    expect(spans).toEqual(["s2", "s3", "s4"]);
  });

  it("never throws when the database is down; backs off (circuit opens) instead of hammering it", async () => {
    const pool = fakePool(async () => { throw new Error("connect ECONNREFUSED postgres://u:pw@h/db"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = mk(pool, { backoffBaseMs: 60_000, failureThreshold: 2 });
    for (let i = 0; i < 4; i++) { s.insertTool(tool("t", `s${i}`)); await expect(s.flush()).resolves.toBeUndefined(); }
    const attemptsWhileOpen = pool.query.mock.calls.length;
    await s.flush(); await s.flush();
    expect(pool.query.mock.calls.length).toBe(attemptsWhileOpen);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("pw@");
    warn.mockRestore();
  });

  it("a poison row does not lose its batch neighbours: falls back to row-by-row and drops only the bad row", async () => {
    const pool = fakePool(async (_sql, params) => { if ((params as unknown[]).includes("BAD")) throw Object.assign(new Error("invalid input"), { code: "22P02" }); return { rowCount: 1 }; });
    const onDrop = vi.fn(); const s = mk(pool, { onDrop });
    s.insertTool(tool("t", "ok1")); s.insertTool(tool("t", "BAD")); s.insertTool(tool("t", "ok2"));
    await s.flush();
    const okSpans = pool.calls.filter((c) => !(c.params as unknown[]).includes("BAD")).flatMap((c) => c.params as string[]).filter((p) => p === "ok1" || p === "ok2");
    expect(okSpans).toEqual(expect.arrayContaining(["ok1", "ok2"]));
    expect(onDrop).toHaveBeenCalledWith(1);
  });

  it("close() flushes what is queued and ends the pool", async () => {
    const pool = fakePool(); const s = mk(pool);
    s.insertTool(tool("t", "s1")); await s.close();
    expect(pool.calls.length).toBe(1); expect(pool.end).toHaveBeenCalled();
  });
});

describe("createStoreFromEnv", () => {
  it("is a no-op store when no database URL is configured", () => {
    expect(createStoreFromEnv({} as NodeJS.ProcessEnv)).toBe(noopStore);
  });
  it("prefers TELEMETRY_DB_URL, falls back to SUPABASE_DB_URL; the pool is only opened on the first write", async () => {
    const factory = vi.fn(() => fakePool());
    const a = createStoreFromEnv({ SUPABASE_DB_URL: "postgresql://a" } as any, { poolFactory: factory });
    await a.flush();
    expect(factory).not.toHaveBeenCalled();
    a.insertTool(tool("t", "s")); await a.close();
    expect(factory).toHaveBeenCalledWith("postgresql://a", expect.anything());
    const f2 = vi.fn(() => fakePool());
    const b = createStoreFromEnv({ SUPABASE_DB_URL: "postgresql://a", TELEMETRY_DB_URL: "postgresql://b" } as any, { poolFactory: f2 });
    b.insertTool(tool("t", "s")); await b.close();
    expect(f2).toHaveBeenCalledWith("postgresql://b", expect.anything());
  });
});
