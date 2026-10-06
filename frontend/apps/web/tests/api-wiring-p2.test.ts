import { describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

const raw = createTestDb();
ensureOwnerUser(raw);

vi.mock("@/server/db/client", () => ({ db: () => raw }));

import { GET as getPromptsRoute } from "@/../app/api/prompts/route";

describe("GET /api/prompts route wiring", () => {
  it("defaults to view=mine and returns listPrompts's shape", async () => {
    const res = await getPromptsRoute(new Request("http://localhost/api/prompts"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});
