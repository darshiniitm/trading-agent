/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 14 needs this for instrumentation.ts (loads the local model into memory at server start)
  experimental: {
    instrumentationHook: true,
    // observability (Part B): Node-only packages stay out of the webpack bundle so one copy of the OTel API is shared process-wide
    serverComponentsExternalPackages: [
      "pg", "@opentelemetry/api", "@opentelemetry/api-logs", "@opentelemetry/core", "@opentelemetry/context-async-hooks", "@opentelemetry/resources",
      "@opentelemetry/sdk-trace-base", "@opentelemetry/sdk-metrics", "@opentelemetry/sdk-logs",
      "@opentelemetry/exporter-trace-otlp-http", "@opentelemetry/exporter-metrics-otlp-http", "@opentelemetry/exporter-logs-otlp-http",
    ],
  },
};
export default nextConfig;
