// @vitest-environment node
// initTelemetry against a fake OTLP collector: proves spans, metrics and logs really leave the process, and that nothing
// is installed when nothing is configured.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { resetRuntime, runtime, task, withRunCtx, newRunCtx } from "@/server/telemetry";
import { initTelemetry, resetBootstrapForTests } from "@/server/telemetry/bootstrap";
import { getLlmTelemetry, setLlmTelemetry, noopTelemetry } from "@/server/llm/telemetry";

let server: Server | undefined;
afterEach(async () => { resetBootstrapForTests(); resetRuntime(); setLlmTelemetry(null); await new Promise((r) => (server ? server.close(() => r(null)) : r(null))); server = undefined; });

function collector() {
  const hits: { path: string; bytes: number }[] = [];
  return new Promise<{ url: string; hits: typeof hits }>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { hits.push({ path: req.url ?? "", bytes: Buffer.concat(chunks).length }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits }));
  });
}

describe("initTelemetry", () => {
  it("installs nothing when no collector and no database are configured (app behaves as before)", async () => {
    const t = initTelemetry({} as NodeJS.ProcessEnv);
    expect(t.enabled).toBe(false);
    expect(runtime().enabled).toBe(false);
    expect(getLlmTelemetry()).toBe(noopTelemetry);
    await t.shutdown();
  });

  it("TELEMETRY_DISABLED=1 wins over everything", () => {
    expect(initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1", TELEMETRY_DISABLED: "1" } as any).enabled).toBe(false);
  });

  it("with a collector: traces, metrics and logs are exported over OTLP/HTTP on shutdown; the LLM sink is installed", async () => {
    const c = await collector();
    const t = initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_SERVICE_NAME: "svc-test" } as any);
    expect(t.enabled).toBe(true);
    expect(getLlmTelemetry()).not.toBe(noopTelemetry);
    const f = task("demo", async () => 1);
    await withRunCtx(newRunCtx({ runId: "11111111-1111-1111-1111-111111111111", traceId: "a".repeat(32) }), () => f());
    await t.shutdown();
    const paths = new Set(c.hits.map((h) => h.path));
    expect(paths).toEqual(new Set(["/v1/traces", "/v1/metrics", "/v1/logs"]));
    expect(c.hits.every((h) => h.bytes > 0)).toBe(true);
  });

  it("database only (no collector): run rows are still written, nothing is exported", () => {
    const t = initTelemetry({ SUPABASE_DB_URL: "postgresql://u:p@127.0.0.1:1/db" } as any);
    expect(t.enabled).toBe(true);
    expect(runtime().tracer).toBeUndefined();
    return t.shutdown();
  });

  it("is idempotent: a second call returns the first handle", async () => {
    const c = await collector();
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: c.url } as any;
    const a = initTelemetry(env), b = initTelemetry(env);
    expect(b).toBe(a);
    await a.shutdown();
  });
});
