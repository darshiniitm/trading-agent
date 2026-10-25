import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { readyDraft } from "./helpers/program";

vi.mock("@/server/db/client", () => ({ db: () => (globalThis as any).__raw }));

import { feasibilityProgramDraft, screenProgramDraft, uploadForDraft } from "@/server/compileProgramDraft";

const reply = (body: unknown) => vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
const sent = (f: ReturnType<typeof vi.fn>) => ({ url: f.mock.calls[0][0] as string, body: JSON.parse((f.mock.calls[0][1] as any).body) });

describe("draft-level data resolution calls", () => {
  it("feasibility sends the resolved program, as_of and the upload keys (user id, draft id)", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw) as number; const userId = await ensureOwnerUser(raw);
    const f = reply({ feasibility: { universe: { status: "ready" }, conditions: {} } });
    const out = await feasibilityProgramDraft(raw, draftId, "2026-10-02", f as any);
    const { url, body } = sent(f);
    expect(url).toMatch(/\/feasibility$/);
    expect(body).toMatchObject({ as_of: "2026-10-02", user_id: userId, prompt_id: draftId });
    expect(body.program.conditions.map((c: any) => c.id)).toEqual(["C1", "C2"]);
    expect(out.feasibility.universe.status).toBe("ready");
  });

  it("the dry-run screen carries the same upload keys, so an uploaded universe is used", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw) as number; const userId = await ensureOwnerUser(raw);
    const f = reply({ sets: {} });
    await screenProgramDraft(raw, draftId, "2026-10-02", f as any);
    expect(sent(f).body).toMatchObject({ user_id: userId, prompt_id: draftId });
  });

  it("upload forwards a CSV for this draft and rejects anything else", async () => {
    const raw = await createTestDb();
    const draftId = await readyDraft(raw) as number; const userId = await ensureOwnerUser(raw);
    const f = reply({ saved: "u.csv", source: "user_upload", quality: "ok" });
    await uploadForDraft(raw, draftId, "u.csv", "symbol\nAAA\n", f as any);
    expect(sent(f).url).toMatch(/\/data\/upload$/);
    expect(sent(f).body).toEqual({ user_id: userId, prompt_id: draftId, name: "u.csv", text: "symbol\nAAA\n" });
    await expect(uploadForDraft(raw, draftId, "u.csv", "x".repeat(2_000_001), f as any)).rejects.toThrow(/too large/);
    await expect(uploadForDraft(raw, 9999, "u.csv", "symbol\nA\n", f as any)).rejects.toThrow(/draft/);
  });
});

describe("routes", () => {
  it("POST feasibility validates the body", async () => {
    const raw = await createTestDb(); (globalThis as any).__raw = raw;
    const draftId = String(await readyDraft(raw));
    const { POST } = await import("@/../app/api/drafts/[draftId]/program/feasibility/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ as_of: "nope" }) }), { params: { draftId } });
    expect(res.status).toBe(400);
  });
  it("POST upload validates the body", async () => {
    const raw = await createTestDb(); (globalThis as any).__raw = raw;
    const draftId = String(await readyDraft(raw));
    const { POST } = await import("@/../app/api/drafts/[draftId]/program/upload/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ name: 1 }) }), { params: { draftId } });
    expect(res.status).toBe(400);
  });
});
