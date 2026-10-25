import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { appHealth, recordModelCheck, resetModelCheck } from "@/server/health";
import type { Db } from "@/server/db/pg";

beforeEach(() => resetModelCheck());

describe("appHealth", () => {
  it("is ok when the database answers and the screener_app tables resolve", async () => {
    const h = await appHealth(await createTestDb());
    expect(h.db).toEqual({ ok: true });
    expect(h.ok).toBe(true);
  });

  it("flags a database where the tables do not resolve (search_path / migrations missing)", async () => {
    const db = await createTestDb();
    await db.run("SET search_path = public");
    const h = await appHealth(db);
    expect(h.ok).toBe(false);
    expect(h.db).toMatchObject({ ok: false, error: expect.stringMatching(/screener_app/) });
  });

  it("reports an unreachable database without leaking the driver's message", async () => {
    const down = { get: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:6543 postgres://u:pw@h/db")) } as unknown as Db;
    const h = await appHealth(down);
    expect(h.ok).toBe(false);
    expect(h.db).toEqual({ ok: false, error: "database unreachable" });
  });

  it("surfaces the model check taken at start-up and does not fail the app for an unavailable model", async () => {
    recordModelCheck({ state: "unavailable", detail: "kimi-k2 is not in /api/tags" });
    const h = await appHealth(await createTestDb());
    expect(h.model).toEqual({ state: "unavailable", detail: "kimi-k2 is not in /api/tags" });
    expect(h.db.ok).toBe(true);
  });

  it("says the model has not been checked yet before start-up has run", async () => {
    expect((await appHealth(await createTestDb())).model.state).toBe("unchecked");
  });
});
