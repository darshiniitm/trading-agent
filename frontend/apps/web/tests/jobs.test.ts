import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { withJob } from "@/server/jobs";

function setupTestPrompt(raw: ReturnType<typeof createTestDb>): number {
  // Create minimal test data: user, prompt_draft, prompt (to satisfy foreign keys)
  raw.prepare("INSERT INTO users (display_name, role, status, created_at) VALUES (?, ?, ?, ?)").run("Test", "member", "active", "2026-01-01");
  raw.prepare("INSERT INTO prompt_drafts (user_id, title, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(1, "test", "test", "open", "2026-01-01", "2026-01-01");
  raw.prepare("INSERT INTO prompts (owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, hypothesis, kill_criterion, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, "test", "test", "literal", "{}", "hash", "hyp", "kill", "2026-01-01");
  return 1;
}

describe("withJob", () => {
  it("runs fn once and marks the job done", async () => {
    const raw = createTestDb();
    const promptId = setupTestPrompt(raw);
    const fn = vi.fn().mockResolvedValue(42);
    const { result, skipped } = await withJob(raw, { type: "select_entry", promptId, asOf: "2026-10-02" }, fn);
    expect(result).toBe(42);
    expect(skipped).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    const row = raw.prepare("SELECT status FROM jobs WHERE type = 'select_entry' AND prompt_id = ? AND as_of = '2026-10-02'").get(promptId) as any;
    expect(row.status).toBe("done");
  });

  it("skips a second call for the same (type, prompt_id, as_of) once the first succeeded", async () => {
    const raw = createTestDb();
    const promptId = setupTestPrompt(raw);
    const fn = vi.fn().mockResolvedValue(1);
    await withJob(raw, { type: "select_entry", promptId, asOf: "2026-10-02" }, fn);
    const second = await withJob(raw, { type: "select_entry", promptId, asOf: "2026-10-02" }, fn);
    expect(second.skipped).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("marks the job failed and rethrows when fn throws, and allows a later retry", async () => {
    const raw = createTestDb();
    const promptId = setupTestPrompt(raw);
    const failing = vi.fn().mockRejectedValueOnce(new Error("engine down")).mockResolvedValueOnce(7);
    await expect(withJob(raw, { type: "validate_prior", promptId, asOf: "2026-10-02" }, failing)).rejects.toThrow("engine down");
    const row = raw.prepare("SELECT status, attempts, error FROM jobs WHERE type = 'validate_prior' AND prompt_id = ? AND as_of = '2026-10-02'").get(promptId) as any;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("engine down");

    const retry = await withJob(raw, { type: "validate_prior", promptId, asOf: "2026-10-02" }, failing);
    expect(retry.result).toBe(7);
    expect(retry.skipped).toBe(false);
    const after = raw.prepare("SELECT status, attempts FROM jobs WHERE type = 'validate_prior' AND prompt_id = ? AND as_of = '2026-10-02'").get(promptId) as any;
    expect(after.status).toBe("done");
    expect(after.attempts).toBe(2);
  });

  it("treats a null as_of (not week-scoped) as its own distinct key", async () => {
    const raw = createTestDb();
    const promptId = setupTestPrompt(raw);
    const fn = vi.fn().mockResolvedValue("ok");
    await withJob(raw, { type: "catch_up", promptId, asOf: null }, fn);
    const row = raw.prepare("SELECT status FROM jobs WHERE type = 'catch_up' AND prompt_id = ? AND as_of IS NULL").get(promptId) as any;
    expect(row.status).toBe("done");
  });

  it("leaves the job queued (not done) when isComplete says the work isn't finished, so the next call runs fn again", async () => {
    const raw = createTestDb();
    const promptId = setupTestPrompt(raw);
    const fn = vi.fn().mockResolvedValueOnce({ complete: false }).mockResolvedValueOnce({ complete: true });
    const key = { type: "validate_prior", promptId, asOf: "2026-10-02" };
    await withJob(raw, key, fn, { isComplete: (r) => r.complete });
    expect(raw.prepare("SELECT status, attempts FROM jobs WHERE type = 'validate_prior'").get()).toEqual({ status: "queued", attempts: 1 });
    const second = await withJob(raw, key, fn, { isComplete: (r) => r.complete });
    expect(second.skipped).toBe(false);
    expect(raw.prepare("SELECT status, attempts FROM jobs WHERE type = 'validate_prior'").get()).toEqual({ status: "done", attempts: 2 });
    const third = await withJob(raw, key, fn, { isComplete: (r) => r.complete });
    expect(third.skipped).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
