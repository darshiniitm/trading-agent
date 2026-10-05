import { describe, expect, it, vi, beforeEach } from "vitest";

const mockDb = { marker: "db" };
vi.mock("@/server/db/client", () => ({ db: () => mockDb }));
vi.mock("@/server/drafts", () => ({
  createDraft: vi.fn(() => ({ draftId: 7 })),
  getDraft: vi.fn((raw: unknown, id: number) =>
    id === 7 ? { draftId: 7, status: "open", promptText: "", spec: null } : null
  ),
  updateDraft: vi.fn((raw: unknown, id: number, patch: unknown) => ({ draftId: id, ...patch })),
}));

import { POST as createDraftRoute } from "@/../app/api/drafts/route";
import { GET as getDraftRoute, PATCH as patchDraftRoute } from "@/../app/api/drafts/[draftId]/route";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/drafts", () => {
  it("returns 201 with the new draft_id", async () => {
    const res = await createDraftRoute(new Request("http://localhost/api/drafts", { method: "POST" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ draft_id: 7 });
  });
});

describe("GET /api/drafts/:draftId", () => {
  it("returns 200 for an existing draft", async () => {
    const res = await getDraftRoute(new Request("http://localhost/api/drafts/7"), { params: { draftId: "7" } });
    expect(res.status).toBe(200);
  });

  it("returns 404 for a missing draft", async () => {
    const res = await getDraftRoute(new Request("http://localhost/api/drafts/999"), { params: { draftId: "999" } });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/drafts/:draftId", () => {
  it("forwards the JSON body as the patch", async () => {
    const res = await patchDraftRoute(
      new Request("http://localhost/api/drafts/7", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "My prompt" }),
      }),
      { params: { draftId: "7" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "My prompt" });
  });
});
