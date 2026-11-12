import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { getEntryDetail } from "@/server/entryDetail";
import { prep } from "./helpers/prep";

describe("getEntryDetail", () => {
  it("returns the entry and its event history in chronological order", async () => {
    const raw = await createTestDb();
    const ownerId = await ensureOwnerUser(raw);
    const now = new Date().toISOString();
    await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (1, ?, 'x', 'confirmed', ?, ?)`).run(ownerId, now, now);
    await prep(raw, 
      `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
       VALUES (1, ?, 1, 'T', 'x', 'literal', '{}', 'h', 'confirmed', 1, 'h', 'k', ?)`
    ).run(ownerId, now);
    await prep(raw, `INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 1, 'wl', ?)`).run(ownerId, now);
    await prep(raw, `INSERT INTO runs (run_id, prompt_id, as_of, kind, status, finished_at) VALUES (10, 1, '2026-10-02', 'scheduled', 'done', ?)`).run(now);
    await prep(raw, `INSERT OR IGNORE INTO symbols (symbol, active) VALUES ('FULL1', 1)`).run();
    const entryInfo = await prep(raw, 
      `INSERT INTO watchlist_entries (watchlist_id, symbol, first_run_id, last_run_id, membership, status, created_at, updated_at) VALUES (1, 'FULL1', 10, 10, 'full_match', 'entered', ?, ?)`
    ).run(now, now);
    const entryId = Number(entryInfo.lastInsertRowid);
    await prep(raw, `INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, 10, 'status_changed', 'pending_selection', 'entered', '2026-10-02T09:00:00Z')`).run(entryId);
    await prep(raw, `INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (?, 10, 'note_added', NULL, 'watching the gap', '2026-10-01T09:00:00Z')`).run(entryId);

    const detail = (await getEntryDetail(raw, entryId))!;
    expect(detail.symbol).toBe("FULL1");
    expect(detail.events.map((e) => e.type)).toEqual(["note_added", "status_changed"]);
  });

  it("returns null for an unknown entry id", async () => {
    const raw = await createTestDb();
    expect(await getEntryDetail(raw, 999)).toBeNull();
  });
});
