// Batch gauges (golden_suite_accuracy) over OTLP, for short-lived processes (eval scripts). Grafana Cloud has no Pushgateway, so the
// value is recorded on a one-shot MeterProvider and flushed before the process exits. Best effort: returns false instead of throwing,
// and does nothing without an OTLP endpoint. A pushed series goes stale minutes after the process exits, so dashboards and alerts read
// these with `last_over_time(metric[30d])` (observability/build.py). scripts/emit_job_metrics.py is the Python side for the weekly jobs.
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from "@opentelemetry/sdk-metrics";
import { endpointFor, headersFrom, otlpConfigured } from "./otlp";

export type Gauge = { name: string; labels: Record<string, string>; value: number };
export type PushOpts = { env?: NodeJS.ProcessEnv; reader?: MetricReader; service?: string; timeoutMs?: number };

export async function pushGauges(gauges: Gauge[], o: PushOpts = {}): Promise<boolean> {
  const env = o.env ?? process.env;
  const valid = gauges.filter((g) => /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(g.name) && Number.isFinite(g.value));
  if (!valid.length || (!o.reader && !otlpConfigured(env))) return false;
  const timeoutMs = o.timeoutMs ?? 5000;
  try {
    const service = env.OTEL_SERVICE_NAME || o.service || "prompt-screener-evals";
    const reader = o.reader ?? new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: endpointFor(env, "metrics"), headers: headersFrom(env), timeoutMillis: timeoutMs }), exportIntervalMillis: 3_600_000,
    });
    const provider = new MeterProvider({ resource: resourceFromAttributes({ "service.name": service }), readers: [reader] });
    const meter = provider.getMeter(service);
    const made = new Map<string, ReturnType<typeof meter.createGauge>>();
    for (const g of valid) {
      let inst = made.get(g.name);
      if (!inst) { inst = meter.createGauge(g.name); made.set(g.name, inst); }
      inst.record(g.value, g.labels);
    }
    await provider.forceFlush();
    if (!o.reader) await provider.shutdown();
    return true;
  } catch { return false; }
}

export const pushGauge = (g: Gauge, o: PushOpts = {}) => pushGauges([g], o);
