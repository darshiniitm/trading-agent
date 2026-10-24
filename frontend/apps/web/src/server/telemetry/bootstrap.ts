// Turns telemetry on for this process, from env only. With neither a collector (OTEL_EXPORTER_OTLP_ENDPOINT) nor a database
// (TELEMETRY_DB_URL / SUPABASE_DB_URL) configured this installs nothing and the app behaves exactly as before.
//   OTEL_EXPORTER_OTLP_ENDPOINT (+ OTEL_EXPORTER_OTLP_HEADERS)   Grafana Cloud OTLP gateway / any OTLP-HTTP collector -> traces, metrics, logs
//   TELEMETRY_DB_URL | SUPABASE_DB_URL   run records in observability.* (pgStore.ts)
//   OTEL_SERVICE_NAME, TELEMETRY_HASH_SALT, TELEMETRY_STDOUT_LOGS=1, TELEMETRY_DISABLED=1
// Composed by hand rather than with NodeSDK so the tracer can use ForcedIdGenerator (see idGenerator.ts).
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { ForcedIdGenerator } from "./idGenerator";
import { installLlmTelemetry } from "./llmSink";
import { createStoreFromEnv } from "./pgStore";
import { installRuntime, runtime } from "./runtime";
import { noopStore } from "./store";
import { endpointFor, headersFrom, otlpConfigured } from "./otlp";

export type Telemetry = { enabled: boolean; shutdown: () => Promise<void> };
const KEY = Symbol.for("trading.telemetry.bootstrap");
const holder = globalThis as unknown as Record<symbol, Telemetry | undefined>;
export const resetBootstrapForTests = () => { holder[KEY] = undefined; };

export function initTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  const existing = holder[KEY];
  if (existing) return existing;

  const wantOtlp = otlpConfigured(env);
  const wantDb = Boolean(env.TELEMETRY_DB_URL || env.SUPABASE_DB_URL);
  if (env.TELEMETRY_DISABLED === "1" || (!wantOtlp && !wantDb)) return { enabled: false, shutdown: async () => {} };

  const service = env.OTEL_SERVICE_NAME || "prompt-screener-web";
  const resource = resourceFromAttributes({ "service.name": service, "deployment.environment": env.NODE_ENV ?? "development" });

  // Context propagation follows awaits (AsyncLocalStorage) and traceparent is W3C. Harmless if the host already registered them.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  let tracerProvider: BasicTracerProvider | undefined, meterProvider: MeterProvider | undefined, loggerProvider: LoggerProvider | undefined;
  if (wantOtlp) {
    tracerProvider = new BasicTracerProvider({ resource, idGenerator: new ForcedIdGenerator(), spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpointFor(env, "traces"), headers: headersFrom(env) }))] });
    meterProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: endpointFor(env, "metrics"), headers: headersFrom(env) }), exportIntervalMillis: 15_000 })] });
    loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpointFor(env, "logs"), headers: headersFrom(env) }) })] });
  }

  const store = wantDb ? createStoreFromEnv(env, { onDrop: (n) => runtime().instruments?.dropped.add(n) }) : noopStore;
  installRuntime({
    tracer: tracerProvider?.getTracer(service), meter: meterProvider?.getMeter(service), logger: loggerProvider?.getLogger(service),
    store, salt: env.TELEMETRY_HASH_SALT ?? "", stdoutLogs: env.TELEMETRY_STDOUT_LOGS === "1",
  });
  installLlmTelemetry();

  let done: Promise<void> | undefined;
  const shutdown = () => (done ??= (async () => {
    await Promise.allSettled([tracerProvider?.shutdown(), meterProvider?.shutdown(), loggerProvider?.shutdown(), store.close()]);
  })());

  // flush on exit; for signals, flush then re-raise so the default termination still happens
  process.once("beforeExit", () => { void shutdown(); });
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => { void shutdown().finally(() => process.kill(process.pid, sig)); });
  }

  return (holder[KEY] = { enabled: true, shutdown });
}
