import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

describe("createTestDb", () => {
  it("applies the migration and enforces foreign keys", () => {
    const raw = createTestDb();
    const fk = raw.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
    expect(() =>
      raw.prepare("INSERT INTO watchlists (user_id, prompt_id, name, created_at) VALUES (999, 999, 'x', '2026-01-01')").run()
    ).toThrow();
  });
});

describe("ensureOwnerUser", () => {
  it("creates user 1 on an empty users table", () => {
    const raw = createTestDb();
    const id = ensureOwnerUser(raw);
    expect(id).toBe(1);
    const row = raw.prepare("SELECT display_name, role FROM users WHERE user_id = 1").get() as any;
    expect(row.display_name).toBe("Owner");
    expect(row.role).toBe("owner");
  });

  it("is idempotent", () => {
    const raw = createTestDb();
    const first = ensureOwnerUser(raw);
    const second = ensureOwnerUser(raw);
    expect(second).toBe(first);
    const count = raw.prepare("SELECT COUNT(*) AS n FROM users").get() as any;
    expect(count.n).toBe(1);
  });
});
