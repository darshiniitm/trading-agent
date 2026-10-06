import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/client", () => ({ db: () => ({ marker: "db" }) }));
vi.mock("@/server/confirm", () => ({
  confirmDraft: vi.fn(async () => ({ promptId: 4, watchlistId: 7, selectionWarning: "prompt confirmed, but selection could not run yet: engine down" })),
}));

import { POST as confirmRoute } from "@/../app/api/drafts/[draftId]/confirm/route";

describe("POST /api/drafts/[draftId]/confirm route wiring", () => {
  it("passes confirmDraft's selectionWarning through as selection_warning", async () => {
    const res = await confirmRoute(
      new Request("http://localhost/api/drafts/5/confirm", { method: "POST", body: JSON.stringify({ as_of: "2026-10-02" }) }),
      { params: { draftId: "5" } }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      prompt_id: 4, watchlist_id: 7, selection_warning: "prompt confirmed, but selection could not run yet: engine down",
    });
  });
});
