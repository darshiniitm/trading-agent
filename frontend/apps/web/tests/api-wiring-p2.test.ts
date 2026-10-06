import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

const raw = createTestDb();
const ownerId = ensureOwnerUser(raw);

vi.mock("@/server/db/client", () => ({ db: () => raw }));

import { GET as getPromptsRoute } from "@/../app/api/prompts/route";
import { POST as editRoute } from "@/../app/api/prompts/[promptId]/edit/route";
import { POST as retireRoute } from "@/../app/api/prompts/[promptId]/retire/route";

function seedConfirmedPrompt() {
  const promptId = 100 + Math.floor(Math.random() * 1000);
  const now = new Date().toISOString();
  raw.prepare(`INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
  raw.prepare(
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (?, ?, ?, 'Test Prompt', 'x', 'literal', '{}', ?, 'confirmed', 1, 'h', 'k', ?)`
  ).run(promptId, ownerId, promptId, `hash${promptId}`, now);
  return promptId;
}

describe("GET /api/prompts route wiring", () => {
  it("defaults to view=mine and returns listPrompts's shape", async () => {
    const res = await getPromptsRoute(new Request("http://localhost/api/prompts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe("POST /api/prompts/[promptId]/edit route wiring", () => {
  it("creates an edit draft and returns 201 with draft_id", async () => {
    const promptId = seedConfirmedPrompt();
    const res = await editRoute(new Request("http://localhost/api/prompts/100/edit", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("draft_id");
    expect(typeof body.draft_id).toBe("number");
  });

  it("returns 404 when prompt does not exist", async () => {
    const res = await editRoute(new Request("http://localhost/api/prompts/999999/edit", { method: "POST" }), { params: { promptId: "999999" } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});

describe("POST /api/prompts/[promptId]/retire route wiring", () => {
  it("retires a prompt and returns 200 with prompt_id and status", async () => {
    const promptId = seedConfirmedPrompt();
    const res = await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prompt_id: promptId, status: "retired" });
  });

  it("returns 409 when trying to retire an already-retired prompt", async () => {
    const promptId = seedConfirmedPrompt();
    // Retire once
    await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    // Try to retire again
    const res = await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
