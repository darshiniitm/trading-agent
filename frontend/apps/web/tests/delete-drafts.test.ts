import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";
import { setIdentityResolver } from "@/server/auth/requireUser";
import { deleteDrafts } from "@/server/deleteDrafts";
import { program } from "./helpers/program";

let raw = createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));
import { DELETE } from "@/../app/api/drafts/route";

const OWNER = { authUserId: "test-owner-uuid", email: "owner@example.com", emailVerified: true, displayName: "Owner", provider: "email" };
const now = "2026-10-13T00:00:00Z";
const del = (body: unknown) => DELETE(new Request("http://x", { method: "DELETE", body: JSON.stringify(body) }));
const ids = () => (raw.prepare("SELECT draft_id FROM prompt_drafts ORDER BY draft_id").all() as any[]).map((r) => r.draft_id);

function world() {
  raw = createTestDb(); const owner = ensureOwnerUser(raw);
  raw.prepare("INSERT INTO users (user_id, display_name, email, role, status, created_at) VALUES (2, 'B', 'b@example.com', 'member', 'active', ?)").run(now);
  const d = raw.prepare("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, 'x', ?, ?, ?)");
  d.run(1, owner, "open", now, now); d.run(2, owner, "open", now, now); d.run(3, owner, "abandoned", now, now); d.run(4, 2, "open", now, now); d.run(5, owner, "confirmed", now, now);
  raw.prepare("INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, version, hypothesis, kill_criterion, confirmed_at) VALUES (5, ?, 5, 'T', 'x', 'literal', ?, 'h5', 'confirmed', 1, 'h', 'k', ?)").run(owner, JSON.stringify(program()), now);
  raw.prepare("INSERT INTO compilations (draft_id, model, raw_json, created_at) VALUES (1, 'm', '{}', ?)").run(now);
  return owner;
}
beforeEach(() => setIdentityResolver(async () => OWNER));

describe("deleteDrafts", () => {
  it("deletes only the selected unconfirmed drafts, with their compilations", () => {
    const owner = world();
    expect(deleteDrafts(raw, owner, [1, 4, 5, 999])).toBe(1);   // 4 is another user's, 5 is confirmed, 999 doesn't exist
    expect(ids()).toEqual([2, 3, 4, 5]);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM compilations").get() as any).n).toBe(0);
  });
  it("delete-all removes every unconfirmed draft of the caller and nothing else", () => {
    const owner = world();
    expect(deleteDrafts(raw, owner)).toBe(3);
    expect(ids()).toEqual([4, 5]);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM prompts").get()).toMatchObject({ n: 1 });
  });
});

describe("DELETE /api/drafts", () => {
  it("handles {ids} and {all:true}, rejects other bodies, and needs sign-in", async () => {
    world();
    expect(await (await del({ ids: [1] })).json()).toEqual({ deleted: 1 });
    expect((await del({ ids: ["x"] })).status).toBe(400);
    expect((await del({})).status).toBe(400);
    expect(await (await del({ all: true })).json()).toEqual({ deleted: 2 });
    expect(ids()).toEqual([4, 5]);
    setIdentityResolver(async () => null);
    expect((await del({ all: true })).status).toBe(401);
  });
});
