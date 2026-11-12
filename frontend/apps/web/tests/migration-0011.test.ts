import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { createTestDb } from "@/server/db/test-db";
import type { Db } from "@/server/db/pg";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft } from "@/server/drafts";

const DIR = path.join(process.cwd(), "..", "..", "..", "db", "migrations");
const file = (n: string) => fs.readFileSync(path.join(DIR, fs.readdirSync(DIR).find((f) => f.startsWith(n))!), "utf-8");

describe("db/migrations/0011_screener_app_full.sql", () => {
  it("creates every table the SQLite app had, under the code's names", async () => {
    const db = await createTestDb();
    const have = new Set((await db.all<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'screener_app'")).map((r) => r.t));
    const want = ["users", "prompts", "prompt_drafts", "prompt_conditions", "compilations", "runs", "run_results", "run_provenance",
      "run_condition_coverage", "run_unevaluated", "validations", "jobs", "entry_events", "watchlists", "watchlist_entries", "symbols",
      "symbol_fundamentals", "symbol_metrics", "user_defaults", "user_benchmarks", "user_view_prefs", "signup_allowlist", "auth_events",
      "interpreter_edit", "interpreter_example", "kb_alias_proposal"];
    expect(want.filter((t) => !have.has(t))).toEqual([]);
    expect(have.has("user_prompts")).toBe(false);
    expect(have.has("watchlist_items")).toBe(false);
  });

  it("re-points the warehouse foreign keys at the new prompts table", async () => {
    const db = await createTestDb();
    const fks = await db.all<{ child: string; parent: string }>(
      `SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'screener_app.prompts'::regclass`);
    expect(fks.map((f) => f.child)).toEqual(expect.arrayContaining(["prompt_history.prompt_executions", "forward_testing.strategy_arms", "prompt_conditions", "watchlists"]));
  });

  it("keeps the seeded index symbols", async () => {
    const db = await createTestDb();
    const n = (await db.get<{ n: number }>("SELECT count(*) AS n FROM symbols WHERE kind = 'index'"))!.n;
    expect(n).toBe(5);
  });

  it("keeps auth_events append-only", async () => {
    const db = await createTestDb();
    await db.run("INSERT INTO auth_events (event, ip) VALUES ('login', '1.2.3.4, 5.6.7.8')");
    await expect(db.run("DELETE FROM auth_events")).rejects.toThrow(/append-only/);
  });

  it("refuses to drop rows from the old warehouse prompt table", async () => {
    const pg = new PGlite({ extensions: { citext } });
    const files = fs.readdirSync(DIR).filter((f) => /^\d{4}_/.test(f)).sort();
    for (const f of files.filter((f) => f < "0011")) await pg.exec(fs.readFileSync(path.join(DIR, f), "utf-8"));
    await pg.exec("INSERT INTO screener_app.users (display_name) VALUES ('x'); INSERT INTO screener_app.user_prompts (user_id, raw_text) VALUES (1, 'old')");
    await expect(pg.exec(file("0011"))).rejects.toThrow(/user_prompts has rows/);
  });
});

describe("constraints carried over from the SQLite schema", () => {
  async function seedPrompt(db: Awaited<Db>) {
    await db.run("INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (1,'o','owner','active', now())");
    await db.run("INSERT INTO prompt_drafts (draft_id,user_id,prompt_text,status,created_at,updated_at) VALUES (1,1,'x','confirmed', now(), now())");
    await db.run("INSERT INTO prompts (prompt_id,owner_user_id,draft_id,title,prompt_text,structure,spec_json,spec_hash,status,version,hypothesis,kill_criterion,confirmed_at) VALUES (1,1,1,'t','x','literal','{}','h','confirmed',1,'h','k', now())");
  }

  it("rejects a jobs row with a status outside the enum", async () => {
    const db = await createTestDb();
    await expect(db.run("INSERT INTO jobs (type, status, created_at) VALUES ('select_entry', 'bogus', now())")).rejects.toThrow(/check constraint/i);
  });

  it("enforces UNIQUE(type, prompt_id, as_of) on jobs", async () => {
    const db = await createTestDb();
    await seedPrompt(db);
    await db.run("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'done', now())");
    await expect(db.run("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'queued', now())")).rejects.toThrow(/unique|duplicate/i);
  });

  it("rejects invalid JSON in compilations.raw_json", async () => {
    const db = await createTestDb();
    const userId = await ensureOwnerUser(db);
    const { draftId } = await createDraft(db, { userId });
    await expect(db.run("INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (?, 'm', 'not json', now())", [draftId])).rejects.toThrow(/json/i);
  });

  it("keeps runs.status separate from coverage_status and bounds scored", async () => {
    const db = await createTestDb();
    await seedPrompt(db);
    const ins = (day: number, cs: string | null, scored: number | null) =>
      db.run("INSERT INTO runs (prompt_id, as_of, kind, status, coverage_status, scored) VALUES (1, ?, 'dry_run', 'done', ?, ?)", [`2026-10-0${day}`, cs, scored]);
    await expect(ins(1, "complete", 1)).resolves.toBe(1);
    await expect(ins(2, "partial", 0)).resolves.toBe(1);
    await expect(ins(3, "low_coverage", 0)).resolves.toBe(1);
    await expect(ins(4, "bogus", 0)).rejects.toThrow();
    await expect(ins(5, "complete", 2)).rejects.toThrow();
  });

  it("the owner seed creates user 1 once and is idempotent", async () => {
    const db = await createTestDb();
    expect(await ensureOwnerUser(db)).toBe(1);
    expect(await ensureOwnerUser(db)).toBe(1);
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n).toBe(1);
    expect((await db.get<{ display_name: string; role: string }>("SELECT display_name, role FROM users WHERE user_id = 1"))).toEqual({ display_name: "Owner", role: "owner" });
  });
});
