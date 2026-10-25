import { program } from "./helpers/program";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

const raw = await createTestDb();
const ownerId = await ensureOwnerUser(raw);

vi.mock("@/server/db/client", () => ({ db: () => raw }));

import { GET as getPromptsRoute } from "@/../app/api/prompts/route";
import { POST as editRoute } from "@/../app/api/prompts/[promptId]/edit/route";
import { POST as retireRoute } from "@/../app/api/prompts/[promptId]/retire/route";
import { GET as healthRoute } from "@/../app/api/health/route";
import { prep } from "./helpers/prep";

async function seedConfirmedPrompt() {
  const promptId = 100 + Math.floor(Math.random() * 1000);
  const now = new Date().toISOString();
  await prep(raw, `INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', 'confirmed', ?, ?)`).run(promptId, ownerId, now, now);
  await prep(raw, 
    `INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at)
     VALUES (?, ?, ?, 'Test Prompt', 'x', 'literal', ?, ?, 'confirmed', 1, 'h', 'k', ?)`
  ).run(promptId, ownerId, promptId, JSON.stringify(program()), `hash${promptId}`, now);
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
    const promptId = await seedConfirmedPrompt();
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
  // Never let these wiring tests reach a real engine on 127.0.0.1:8001 (they
  // used to: retirePrompt calls retireArm with the global fetch, which
  // retired real arm ids in a locally running engine's registry).
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: "retired" }) }));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("retires a prompt and returns 200 with prompt_id, status and a null warning", async () => {
    const promptId = await seedConfirmedPrompt();
    const res = await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ prompt_id: promptId, status: "retired", warning: null });
  });

  it("returns 200 with the warning (not 409) when the local retire succeeded but the engine call failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const promptId = await seedConfirmedPrompt();
    const res = await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("retired");
    expect(body.warning).toMatch(/notifying the engine failed: ECONNREFUSED/);
  });

  it("returns 409 when trying to retire an already-retired prompt", async () => {
    const promptId = await seedConfirmedPrompt();
    // Retire once
    await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    // Try to retire again
    const res = await retireRoute(new Request("http://localhost/api/prompts/100/retire", { method: "POST" }), { params: { promptId: String(promptId) } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});

describe("GET /api/health route wiring", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
  });

  it("returns the engine's /health body unchanged", async () => {
    const health = { status: "ok", engine_git_sha: "abc", last_bar_date: "2026-10-02", data_snapshot_hash: null };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(health) }));
    const res = await healthRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(health);
  });

  it("returns 502 with an error body when the engine is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const res = await healthRoute();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/engine unreachable/);
  });
});
