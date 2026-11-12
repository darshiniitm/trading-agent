// In-memory OpenTelemetry providers + store for tests. Nothing here talks to a collector or a database.
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { installRuntime, resetRuntime, MemoryRunStore } from "@/server/telemetry";
import { ForcedIdGenerator } from "@/server/telemetry/idGenerator";

let cm: AsyncLocalStorageContextManager | undefined;

export function setupTelemetry(opts: { store?: MemoryRunStore } = {}) {
  cm ??= new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(cm);
  const spans = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({ idGenerator: new ForcedIdGenerator(), spanProcessors: [new SimpleSpanProcessor(spans)] });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 1e9 })] });
  const records: any[] = [];
  const loggerProvider = new LoggerProvider({ processors: [{ onEmit: (r: any) => { records.push(r); }, forceFlush: async () => {}, shutdown: async () => {} } as any] });
  const store = opts.store ?? new MemoryRunStore();
  resetRuntime();
  installRuntime({ tracer: tracerProvider.getTracer("test"), meter: meterProvider.getMeter("test"), logger: loggerProvider.getLogger("test"), store, salt: "s" });
  return {
    spans, store, records,
    finished: () => spans.getFinishedSpans(),
    async metrics() { await meterProvider.forceFlush(); return metricExporter.getMetrics().flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics)); },
    logs: (event?: string) => records.map((r) => ({ body: r.body as string, ...r.attributes, traceId: r.spanContext?.traceId })).filter((r) => !event || r.event === event),
  };
}
export const teardownTelemetry = () => resetRuntime();
