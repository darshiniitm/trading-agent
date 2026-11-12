import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const configUrl = new URL("../../next.config.mjs", import.meta.url).href;

test("Next config excludes the unused HF token while preserving required settings", () => {
  // Use synthetic values only; never send real credentials to the test process.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { default: config } = await import(${JSON.stringify(configUrl)});
    assert.equal(Object.hasOwn(process.env, "HF_TOKEN"), false);
    assert.equal(process.env.ENGINE_TOKEN, "test-engine-token");
    assert.equal(process.env.NEXT_PUBLIC_SUPABASE_URL, "https://example.invalid");
    assert.equal(config.experimental.instrumentationHook, true);
    assert.equal(config.env, undefined);
  `], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      HF_TOKEN: "test-only-hf-token",
      ENGINE_TOKEN: "test-engine-token",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
    },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
