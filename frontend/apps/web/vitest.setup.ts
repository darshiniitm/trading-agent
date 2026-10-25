import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  const { closeTestDb } = await import("@/server/db/test-db");
  await closeTestDb();
});

// Routes authenticate through requireUser(); tests sign in as the seeded Owner (ensureOwnerUser claims OWNER_EMAIL).
import { setIdentityResolver } from "@/server/auth/requireUser";
export const TEST_OWNER_EMAIL = "owner@example.com";
process.env.OWNER_EMAIL = TEST_OWNER_EMAIL;
setIdentityResolver(async () => ({ authUserId: "test-owner-uuid", email: TEST_OWNER_EMAIL, emailVerified: true, displayName: "Owner", provider: "email" }));
