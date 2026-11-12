import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    // Node by default: PGlite (the test Postgres) needs a real fetch/Response, which jsdom replaces.
    environment: "node",
    environmentMatchGlobs: [["tests/components/**", "jsdom"], ["tests/**/*.test.tsx", "jsdom"]],
    testTimeout: 30_000,   // the first PGlite database in a worker builds its migration template
    hookTimeout: 60_000,
    globalSetup: ["./vitest.global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
