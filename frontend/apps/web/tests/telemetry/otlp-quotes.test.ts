import { describe, expect, it } from "vitest";
import { endpointFor, headersFrom } from "@/server/telemetry/otlp";

// A pasted Netlify env value kept its quotes and 500'd every cold start ("Could not parse user-provided export URL").
describe("OTLP env values with stray quotes", () => {
  it("strips quotes around the endpoint", () => {
    expect(endpointFor({ OTEL_EXPORTER_OTLP_ENDPOINT: '"https://gw.grafana.net/otlp"' }, "traces")).toBe("https://gw.grafana.net/otlp/v1/traces");
  });
  it("strips quotes around the headers value", () => {
    expect(headersFrom({ OTEL_EXPORTER_OTLP_HEADERS: '"Authorization=Basic%20abc"' })).toEqual({ Authorization: "Basic abc" });
  });
  it("leaves clean values alone", () => {
    expect(endpointFor({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://gw.grafana.net/otlp/" }, "logs")).toBe("https://gw.grafana.net/otlp/v1/logs");
  });
});
