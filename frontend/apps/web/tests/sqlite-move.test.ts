import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { moveSqliteToPostgres } from "@/server/db/sqliteMove";
import { prep } from "./helpers/prep";

const LEGACY = path.join(process.cwd(), "scripts", "sqlite-legacy", "migrations");

// A SQLite database exactly as the app had it (all 12 migrations), filled with a small but connected history:
// ids with gaps, a version chain (circular draft <-> prompt links), a follower, a run with results, a graded week.
function legacyDb() {
  const s = new Database(":memory:");
  s.pragma("foreign_keys = ON");
  s.exec("CREATE TABLE _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const f of fs.readdirSync(LEGACY).filter((f) => f.endsWith(".sql")).sort()) {
    s.exec(fs.readFileSync(path.join(LEGACY, f), "utf-8"));
    s.prepare("INSERT INTO _migrations VALUES (?, ?)").run(f, "2026-01-01");
  }
  const t = "2026-09-26T09:00:00.000Z";
  s.prepare("INSERT INTO users (user_id, display_name, email, role, status, created_at, auth_user_id) VALUES (1,'Owner','owner@example.com','owner','active',?, '11111111-1111-4111-8111-111111111111')").run(t);
  s.prepare("INSERT INTO users (user_id, display_name, email, role, status, created_at) VALUES (7,'Fol','f@example.com','member','active',?)").run(t);
  s.prepare("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at, program_json) VALUES (3,1,'v1','confirmed',?,?,'{\"a\": 1}')").run(t, t);
  s.prepare("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at, parent_prompt_id) VALUES (9,1,'v2','confirmed',?,?,NULL)").run(t, t);
  const p = s.prepare("INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, confirmed_at) VALUES (?,1,?,?, 'x','literal','{\"k\":[1,2]}',?,?,?,?, 'h','k',?)");
  p.run(4, 3, "v1", "h1", "superseded", null, 1, t);
  p.run(12, 9, "v2", "h2", "confirmed", 4, 2, t);
  s.prepare("UPDATE prompt_drafts SET parent_prompt_id = 4 WHERE draft_id = 9").run();
  s.prepare("UPDATE prompt_drafts SET confirmed_prompt_id = 4 WHERE draft_id = 3").run();
  s.prepare("UPDATE prompt_drafts SET confirmed_prompt_id = 12 WHERE draft_id = 9").run();
  s.prepare("INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (12,1,'filter','indicator','rsi','{\"length\":14}','between','[50,65]','prompt')").run();
  s.prepare("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (20,1,12,'W',?)").run(t);
  s.prepare("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (21,7,12,'W',?)").run(t);
  s.prepare("INSERT INTO symbols (symbol, name, sector) VALUES ('AAA.NS','Aaa','Tech')").run();
  s.prepare("INSERT INTO runs (run_id, prompt_id, as_of, kind, status, applied_steps_json, finished_at) VALUES (30,12,'2026-10-02','scheduled','done','[]',?)").run(t);
  s.prepare("INSERT INTO run_results (run_id, symbol, membership, cond_json, ep, sl, entry_status, entry_price, in_forward_record) VALUES (30,'AAA.NS','full_match','{\"C1\":1}',100,95,'entered',101,1)").run();
  s.prepare("INSERT INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_date, entry_price, stop, created_at, updated_at) VALUES (40,20,'AAA.NS',30,30,'full_match','entered','2026-10-05',101,95,?,?)").run(t, t);
  s.prepare("INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (40,30,'status_changed','pending_selection','entered',?)").run(t);
  s.prepare("INSERT INTO validations (run_id, horizon_w, n, ew_return, hit_rate, computed_at) VALUES (30,1,1,2.5,1,?)").run(t);
  s.prepare("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('catch_up',12,'2026-10-02','done',?)").run(t);
  s.prepare("INSERT INTO symbol_metrics (symbol, as_of, timeframe, rsi14, votes_json, engine_version, computed_at) VALUES ('AAA.NS','2026-10-02','1D',55.5,'{\"v\":1}','metrics-v1',?)").run(t);
  s.prepare("INSERT INTO user_benchmarks (user_id, symbol, position) VALUES (1,'^NSEI',0)").run();
  s.prepare("INSERT INTO user_view_prefs (user_id, watchlist_id, view, hidden_columns, compact) VALUES (1,20,'price','{\"price\":[\"a\"]}',1)").run();
  s.prepare("INSERT INTO signup_allowlist (email, invited_by, created_at) VALUES ('f@example.com',1,?)").run(t);
  s.prepare("INSERT INTO auth_events (user_id, email, event, ip, at) VALUES (1,'owner@example.com','login','1.2.3.4, 5.6.7.8',?)").run(t);
  return s;
}

describe("moveSqliteToPostgres", () => {
  it("copies every table keeping the numeric ids, and the data keeps its meaning", async () => {
    const pg = await createTestDb();
    const report = await moveSqliteToPostgres(legacyDb(), pg);
    expect(report.rows.users).toBe(2);
    expect(report.rows.prompts).toBe(2);
    expect(report.rows.run_results).toBe(1);

    expect((await prep(pg, "SELECT user_id FROM users ORDER BY user_id").all()).map((r: any) => r.user_id)).toEqual([1, 7]);
    expect((await prep(pg, "SELECT prompt_id FROM prompts ORDER BY prompt_id").all()).map((r: any) => r.prompt_id)).toEqual([4, 12]);
    const v2 = await prep(pg, "SELECT parent_prompt_id, version, status, spec_json FROM prompts WHERE prompt_id = 12").get();
    expect(v2).toMatchObject({ parent_prompt_id: 4, version: 2, status: "confirmed" });
    expect(JSON.parse(v2.spec_json)).toEqual({ k: [1, 2] });
    const d = await prep(pg, "SELECT parent_prompt_id, confirmed_prompt_id FROM prompt_drafts WHERE draft_id = 9").get();
    expect(d).toEqual({ parent_prompt_id: 4, confirmed_prompt_id: 12 });
    expect(await prep(pg, "SELECT entry_date, entry_price FROM watchlist_entries WHERE entry_id = 40").get()).toEqual({ entry_date: "2026-10-05", entry_price: 101 });
    expect((await prep(pg, "SELECT at FROM entry_events").get()).at).toBe("2026-09-26T09:00:00.000Z");
    expect(await prep(pg, "SELECT auth_user_id FROM users WHERE user_id = 1").get()).toEqual({ auth_user_id: "11111111-1111-4111-8111-111111111111" });
    expect((await prep(pg, "SELECT ip FROM auth_events").get()).ip).toBe("1.2.3.4, 5.6.7.8");
    expect((await prep(pg, "SELECT compact FROM user_view_prefs").get()).compact).toBe(1);
  });

  it("moves each identity sequence past the largest id so new rows cannot collide", async () => {
    const pg = await createTestDb();
    await moveSqliteToPostgres(legacyDb(), pg);
    const u = await pg.get<{ user_id: number }>("INSERT INTO users (display_name) VALUES ('New') RETURNING user_id");
    const p = await pg.get<{ draft_id: number }>("INSERT INTO prompt_drafts (user_id, prompt_text, created_at, updated_at) VALUES (1, 'n', now(), now()) RETURNING draft_id");
    expect(u!.user_id).toBe(8);
    expect(p!.draft_id).toBe(10);
  });

  it("refuses a target that already has app data, and changes nothing", async () => {
    const pg = await createTestDb();
    await pg.run("INSERT INTO users (display_name, created_at) VALUES ('Already here', now())");
    await expect(moveSqliteToPostgres(legacyDb(), pg)).rejects.toThrow(/not empty/i);
    expect((await pg.get<{ n: number }>("SELECT count(*) AS n FROM users"))!.n).toBe(1);
  });

  it("is all-or-nothing: a bad row rolls the whole move back", async () => {
    const pg = await createTestDb();
    const s = legacyDb();
    s.prepare("UPDATE watchlist_entries SET created_at = 'not a time'").run();
    await expect(moveSqliteToPostgres(s, pg)).rejects.toThrow(/watchlist_entries/);
    expect((await pg.get<{ n: number }>("SELECT count(*) AS n FROM users"))!.n).toBe(0);
  });

  it("rejects a SQLite file that is not at the last migration", async () => {
    const s = legacyDb();
    s.prepare("DELETE FROM _migrations WHERE filename LIKE '0012%'").run();
    await expect(moveSqliteToPostgres(s, await createTestDb())).rejects.toThrow(/0012/);
  });
});
