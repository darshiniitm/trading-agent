import { describe, expect, it } from "vitest";
import { toPgPlaceholders } from "@/server/db/pg";
import { createTestDb } from "@/server/db/test-db";

describe("toPgPlaceholders", () => {
  it("numbers ? markers in order", () => {
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
  });
  it("leaves a ? inside a string literal alone", () => {
    expect(toPgPlaceholders("SELECT 'why?' AS q, ? AS v")).toBe("SELECT 'why?' AS q, $1 AS v");
    expect(toPgPlaceholders("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
  });
  it("keeps explicit $n markers", () => {
    expect(toPgPlaceholders("SELECT $1, $1")).toBe("SELECT $1, $1");
  });
});

describe("createTestDb (Postgres)", () => {
  it("applies the warehouse migrations and enforces foreign keys", async () => {
    const db = await createTestDb();
    await expect(
      db.run("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (999, 999, 'x', now())")
    ).rejects.toThrow(/foreign key/i);
  });

  it("hands bigint ids and counts to the code as numbers", async () => {
    const db = await createTestDb();
    const row = await db.get<{ id: unknown; n: unknown }>(
      "INSERT INTO users (display_name) VALUES ('A') RETURNING user_id AS id, (SELECT count(*) FROM users) AS n"
    );
    expect(typeof row!.id).toBe("number");
    expect(typeof row!.n).toBe("number");
  });

  it("hands jsonb back as the JSON text, instants as ISO strings and dates as YYYY-MM-DD", async () => {
    const db = await createTestDb();
    const u = (await db.get<{ id: number }>("INSERT INTO users (display_name) VALUES ('A') RETURNING user_id AS id"))!.id;
    await db.run(
      "INSERT INTO prompt_drafts (user_id, prompt_text, spec_json, created_at, updated_at) VALUES (?, 'p', ?, ?, ?)",
      [u, '{"a":1}', "2026-09-26T09:00:00.000Z", "2026-09-26T09:00:00.000Z"]
    );
    const d = await db.get<{ spec_json: unknown; created_at: unknown }>("SELECT spec_json, created_at FROM prompt_drafts");
    expect(typeof d!.spec_json).toBe("string");
    expect(JSON.parse(d!.spec_json as string)).toEqual({ a: 1 });
    expect(d!.created_at).toBe("2026-09-26T09:00:00.000Z");
    const day = await db.get<{ d: unknown }>("SELECT DATE '2026-10-02' AS d");
    expect(day!.d).toBe("2026-10-02");
  });

  it("run() reports the affected row count", async () => {
    const db = await createTestDb();
    await db.run("INSERT INTO users (display_name) VALUES ('A'), ('B')");
    expect(await db.run("UPDATE users SET status = 'disabled' WHERE display_name = ?", ["B"])).toBe(1);
  });

  it("tx() commits on success and rolls back when the callback throws", async () => {
    const db = await createTestDb();
    await db.tx(async (t) => { await t.run("INSERT INTO users (display_name) VALUES ('kept')"); });
    await expect(
      db.tx(async (t) => { await t.run("INSERT INTO users (display_name) VALUES ('lost')"); throw new Error("boom"); })
    ).rejects.toThrow("boom");
    const names = (await db.all<{ display_name: string }>("SELECT display_name FROM users ORDER BY user_id")).map((r) => r.display_name);
    expect(names).toEqual(["kept"]);
  });

  it("gives every test its own empty database", async () => {
    const db = await createTestDb();
    expect((await db.get<{ n: number }>("SELECT count(*) AS n FROM users"))!.n).toBe(0);
  });
});
