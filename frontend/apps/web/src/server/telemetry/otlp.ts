// OTLP/HTTP connection settings, read from the env object it is given (not process.env). Mirrors src/telemetry/otlp.py.
// Grafana Cloud: OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp and
// OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(instanceId:token)>   (python -m observability.cloud headers builds it).
export type Signal = "traces" | "metrics" | "logs";

export const otlpConfigured = (env: NodeJS.ProcessEnv) => Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);

export function endpointFor(env: NodeJS.ProcessEnv, signal: Signal): string {
  const specific = env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
  return specific || `${(env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/+$/, "")}/v1/${signal}`;
}

/** OTEL_EXPORTER_OTLP_HEADERS: comma-separated key=value, values URL-decoded (`Basic%20abc` -> `Basic abc`). */
export function headersFrom(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  // Stray quotes from a pasted env value ("Authorization=Basic%20...") would make an illegal header name.
  const raw = (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").trim().replace(/^["']+|["']+$/g, "");
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i < 0 || !part.slice(0, i).trim()) continue;
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    const key = part.slice(0, i).trim().replace(/^["']+|["']+$/g, "");
    // `Basic%20 <cred>` (a stray space after %20) would be two spaces -> 401: only the auth scheme separator is normalised
    out[key] = key.toLowerCase() === "authorization" ? v.replace(/^(\S+)\s+/, "$1 ") : v;
  }
  return out;
}

const instanceSuffix = Math.random().toString(36).slice(2, 8);   // one per process: a Netlify cold start is a new process

/** `service.instance.id` for serverless, so Grafana can tell instances (cold starts) apart; undefined elsewhere. */
export function serviceInstanceId(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AWS_LAMBDA_LOG_STREAM_NAME) return env.AWS_LAMBDA_LOG_STREAM_NAME;
  if (env.NETLIFY) return `${env.DEPLOY_ID ?? "netlify"}-${instanceSuffix}`;
  return undefined;
}
