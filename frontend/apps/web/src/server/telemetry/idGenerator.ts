// OpenTelemetry cannot create a span with a chosen id. The `prompt.run` root of a draft is emitted at confirm, AFTER the
// compile / screen spans already named it as their parent, so its ids must equal the ones derived from the draft.
// forceNext() makes the very next root span (created synchronously right after) take those ids; everything else is random.
import { RandomIdGenerator, type IdGenerator } from "@opentelemetry/sdk-trace-base";

const KEY = Symbol.for("trading.telemetry.forcedIds");
type Forced = { traceId?: string; spanId?: string };
const holder = globalThis as unknown as Record<symbol, Forced | undefined>;
export const forceNext = (ids: { traceId: string; spanId: string }) => { holder[KEY] = { ...ids }; };
export const clearForced = () => { holder[KEY] = undefined; };

// The SDK asks for the trace id and the span id in either order; each forced value is used once.
export class ForcedIdGenerator implements IdGenerator {
  private base = new RandomIdGenerator();
  generateTraceId = () => { const f = holder[KEY]; if (f?.traceId) { const id = f.traceId; f.traceId = undefined; return id; } return this.base.generateTraceId(); };
  generateSpanId = () => { const f = holder[KEY]; if (f?.spanId) { const id = f.spanId; f.spanId = undefined; return id; } return this.base.generateSpanId(); };
}
