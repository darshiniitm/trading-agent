import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { createDraft } from "@/server/drafts";

describe("0004_compiler migration", () => {
  it("creates compilations and the two new prompt_drafts columns", () => {
    const raw = createTestDb();
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("compilations");
    const columns = (raw.prepare("PRAGMA table_info(prompt_drafts)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toContain("source_phrases_json");
    expect(columns).toContain("unsupported_json");
  });

  it("rejects invalid JSON in compilations.raw_json", () => {
    const raw = createTestDb();
    const userId = ensureOwnerUser(raw);
    const { draftId } = createDraft(raw, { userId });
    expect(() =>
      raw.prepare(`INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (?, 'm', 'not json', '2026-01-01')`).run(draftId)
    ).toThrow();
  });
});
