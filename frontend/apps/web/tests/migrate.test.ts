import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createTestDb } from "@/server/db/test-db";
import { applyMigrations } from "@/server/db/migrate";

describe("createTestDb / applyMigrations", () => {
  it("applies both 0001 and 0002, and is idempotent on a second call", () => {
    const raw = createTestDb();
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("entry_events");
    expect(tables).toContain("validations");
    expect(tables).toContain("jobs");

    // Re-applying must not re-run 0001/0002 (which would try to CREATE TABLE
    // users again and throw) — applyMigrations is exported for this test to
    // call a second time directly against the same handle.
    expect(() => applyMigrations(raw)).not.toThrow();
  });

  it("rejects a jobs row with a status outside the enum", () => {
    const raw = createTestDb();
    expect(() =>
      raw.prepare("INSERT INTO jobs (type, status, created_at) VALUES ('select_entry', 'bogus', '2026-01-01')").run()
    ).toThrow();
  });

  it("enforces UNIQUE(type, prompt_id, as_of) on jobs", () => {
    const raw = createTestDb();
    // Create minimal test data: user, prompt_draft, prompt (to satisfy foreign key)
    raw.prepare("INSERT INTO users (display_name, role, status, created_at) VALUES (?, ?, ?, ?)").run("Test", "member", "active", "2026-01-01");
    raw.prepare("INSERT INTO prompt_drafts (user_id, title, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(1, "test", "test", "open", "2026-01-01", "2026-01-01");
    raw.prepare("INSERT INTO prompts (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, hypothesis, kill_criterion, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "test", "test", "literal", "{}", "hash", "hyp", "kill", "2026-01-01");
    // Now test the UNIQUE constraint
    raw.prepare("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'done', '2026-01-01')").run();
    expect(() =>
      raw.prepare("INSERT INTO jobs (type, prompt_id, as_of, status, created_at) VALUES ('select_entry', 1, '2026-10-02', 'queued', '2026-01-01')").run()
    ).toThrow();
  });

  it("backfills 0001_init.sql in _migrations if tables exist but tracking is missing (old DB upgrade path)", () => {
    // Simulate a pre-existing database created by the old client.ts logic:
    // 0001_init.sql was executed directly, but no _migrations table was created.
    const raw = new Database(":memory:");
    raw.pragma("foreign_keys = ON");

    // Execute 0001_init.sql directly (old behavior, no _migrations tracking)
    const migration0001Path = path.join(process.cwd(), "src", "server", "db", "migrations", "0001_init.sql");
    const sql0001 = fs.readFileSync(migration0001Path, "utf-8");
    raw.exec(sql0001);

    // Verify 0001 tables exist but _migrations doesn't
    const usersExists = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    expect(usersExists).toBeTruthy();
    const migrationsExists = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migrations'").get();
    expect(migrationsExists).toBeFalsy();

    // Now call applyMigrations: it should detect that users exists,
    // backfill 0001_init.sql into _migrations, then apply 0002.
    expect(() => applyMigrations(raw)).not.toThrow();

    // Verify both 0001 and 0002 tables now exist
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("users");
    expect(tables).toContain("entry_events");
    expect(tables).toContain("validations");
    expect(tables).toContain("jobs");

    // Verify all migrations are recorded (no duplicates)
    const migrations = (raw.prepare("SELECT filename FROM _migrations ORDER BY filename").all() as { filename: string }[]).map((r) => r.filename);
    expect(migrations).toEqual(["0001_init.sql", "0002_jobs_and_grading.sql", "0003_run_results_entry_price.sql", "0004_compiler.sql", "0005_sharing.sql", "0006_compilation_attempt.sql", "0007_program.sql", "0008_interpreter.sql", "0009_learning.sql", "0010_data_resolution.sql", "0011_auth.sql", "0012_watchlist_views.sql"]);
  });
});
