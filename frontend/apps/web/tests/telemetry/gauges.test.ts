// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AggregationTemporality, InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { pushGauge, pushGauges } from "@/server/telemetry/gauges";
import { endpointFor, headersFrom, otlpConfigured, serviceInstanceId } from "@/server/telemetry/otlp";
import { initTelemetry, resetBootstrapForTests } from "@/server/telemetry/bootstrap";
import { resetRuntime, task, withRunCtx, newRunCtx } from "@/server/telemetry";
import { setLlmTelemetry } from "@/server/llm/telemetry";

let server: Server | undefined;
afterEach(async () => { resetBootstrapForTests(); resetRuntime(); setLlmTelemetry(null); await new Promise((r) => (server ? server.close(() => r(null)) : r(null))); server = undefined; });

function collector() {
  const hits: { path: string; auth?: string; bytes: number }[] = [];
  return new Promise<{ url: string; hits: typeof hits }>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => { hits.push({ path: req.url ?? "", auth: req.headers.authorization, bytes: Buffer.concat(chunks).length }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, hits }));
  });
}

describe("otlp helpers", () => {
  it("per-signal endpoints and URL-decoded headers, like the Python side", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20QUJD,x-scope=a=b" } as any;
    expect(endpointFor(env, "traces")).toBe("https://otlp-gateway-prod-eu-west-0.grafana.net/otlp/v1/traces");
    expect(endpointFor({ ...env, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://x/l" }, "logs")).toBe("http://x/l");
    expect(headersFrom(env)).toEqual({ Authorization: "Basic QUJD", "x-scope": "a=b" });
    expect(headersFrom({} as any)).toEqual({});
    expect(otlpConfigured({} as any)).toBe(false);
  });
});

describe("pushGauge (OTLP)", () => {
  it("records name, labels and value, then flushes", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 1e9 });
    expect(await pushGauge({ name: "golden_suite_accuracy", labels: { provider: "cloud", model: "m", suite_version: "v1" }, value: 0.98 }, { reader })).toBe(true);
    const m = exporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics)).find((x) => x.descriptor.name === "golden_suite_accuracy")!;
    expect((m.dataPoints[0] as any).value).toBe(0.98);
    expect(m.dataPoints[0].attributes).toEqual({ provider: "cloud", model: "m", suite_version: "v1" });
  });

  it("does nothing without an endpoint, rejects bad names / NaN, and never throws", async () => {
    expect(await pushGauge({ name: "x", labels: {}, value: 1 }, { env: {} as any })).toBe(false);
    const reader = new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 1e9 });
    expect(await pushGauges([{ name: "bad-name", labels: {}, value: 1 }, { name: "ok", labels: {}, value: NaN }], { reader })).toBe(false);
    expect(await pushGauge({ name: "x", labels: {}, value: 1 }, { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" } as any, timeoutMs: 800 })).toBeTypeOf("boolean");
  });

  it("sends the Authorization header Grafana Cloud requires", async () => {
    const c = await collector();
    const ok = await pushGauge({ name: "golden_suite_accuracy", labels: { provider: "cloud" }, value: 1 },
      { env: { OTEL_EXPORTER_OTLP_ENDPOINT: `${c.url}/otlp`, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20Zm9v" } as any });
    expect(ok).toBe(true);
    expect(c.hits.length).toBeGreaterThan(0);                       // flush + the shutdown's final export
    expect(c.hits.every((h) => h.path === "/otlp/v1/metrics" && h.auth === "Basic Zm9v")).toBe(true);
  });
});

describe("initTelemetry with Grafana-Cloud-style auth", () => {
  it("every signal (traces, metrics, logs) carries the Authorization header and the /otlp path prefix", async () => {
    const c = await collector();
    const t = initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: `${c.url}/otlp`, OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20aW5zdDp0b2s=" } as any);
    await withRunCtx(newRunCtx({ runId: "11111111-1111-1111-1111-111111111111", traceId: "a".repeat(32) }), () => task("demo", async () => 1)());
    await t.shutdown();
    expect(new Set(c.hits.map((h) => h.path))).toEqual(new Set(["/otlp/v1/traces", "/otlp/v1/metrics", "/otlp/v1/logs"]));
    expect(c.hits.every((h) => h.auth === "Basic aW5zdDp0b2s=")).toBe(true);
  });
});

describe("headersFrom tolerance", () => {
  it("a stray space after the auth scheme does not produce two spaces (which Grafana rejects with 401)", () => {
    const h = headersFrom({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20 QUJD,x-scope=a  b" } as any);
    expect(h.Authorization).toBe("Basic QUJD");
    expect(h["x-scope"]).toBe("a  b");
    expect(headersFrom({ OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer%20%20tok" } as any).authorization).toBe("Bearer tok");
  });
});

describe("serviceInstanceId", () => {
  it("tells serverless instances apart in Grafana (cold starts are new instances)", () => {
    expect(serviceInstanceId({ AWS_LAMBDA_LOG_STREAM_NAME: "2026/10/25/[$LATEST]abc" } as any)).toBe("2026/10/25/[$LATEST]abc");
    expect(serviceInstanceId({ NETLIFY: "true", DEPLOY_ID: "d1" } as any)).toMatch(/^d1-/);
  });
  it("is absent off serverless, so a long-lived server keeps its single resource identity", () => {
    expect(serviceInstanceId({} as any)).toBeUndefined();
  });
});
