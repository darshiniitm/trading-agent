import { describe, expect, it } from "vitest";
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
});
