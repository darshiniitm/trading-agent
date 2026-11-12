// Process-wide telemetry state, held on globalThis so every bundle copy of this module (Next re-evaluates modules in dev;
// compare src/server/engine/supervisor.ts) sees the same tracer, meters, logger and store. Disabled (all no-op) until
// installRuntime() is called, so the app behaves exactly as before when no collector / database is configured.
import type { Counter, Histogram, Meter, Tracer } from "@opentelemetry/api";
import type { Logger as OtelLogger } from "@opentelemetry/api-logs";
import { noopStore, type RunStore } from "./store";

export type Instruments = {
  taskDuration: Histogram; agentInvocations: Counter; agentDuration: Histogram; toolCalls: Counter; toolDuration: Histogram; dropped: Counter;
  promptRunDuration: Histogram; llmDuration: Histogram; llmRequests: Counter; llmTokens: Counter; llmGpu: Counter; llmRetry: Counter; llmFallback: Counter;
};
export type Runtime = {
  enabled: boolean;
  tracer?: Tracer;
  meter?: Meter;
  instruments?: Instruments;
  logger?: OtelLogger;
  store: RunStore;
  salt: string;
  stdoutLogs: boolean;
};

const KEY = Symbol.for("trading.telemetry.runtime");
const holder = globalThis as unknown as Record<symbol, Runtime | undefined>;
const fresh = (): Runtime => ({ enabled: false, store: noopStore, salt: "", stdoutLogs: false });
export const runtime = (): Runtime => (holder[KEY] ??= fresh());
export const resetRuntime = () => { holder[KEY] = fresh(); };

export function createInstruments(meter: Meter): Instruments {
  return {
    taskDuration: meter.createHistogram("task.duration", { unit: "s", description: "Workflow task duration" }),
    agentInvocations: meter.createCounter("agent.invocations", { description: "LLM-backed agent invocations" }),
    agentDuration: meter.createHistogram("agent.duration", { unit: "s" }),
    toolCalls: meter.createCounter("tool.calls", { description: "Tool calls" }),
    toolDuration: meter.createHistogram("tool.duration", { unit: "s" }),
    dropped: meter.createCounter("telemetry.dropped", { description: "Run-record rows dropped by the bounded writer queue" }),
    promptRunDuration: meter.createHistogram("prompt.run.duration", { unit: "s", description: "Processing time of one prompt-run request, by stage (compile / screen / confirm) and outcome" }),
    llmDuration: meter.createHistogram("llm.request.duration", { unit: "s", description: "LLM HTTP attempt duration" }),
    llmRequests: meter.createCounter("llm.requests", { description: "LLM HTTP attempts by status" }),
    llmTokens: meter.createCounter("llm.tokens", { description: "LLM tokens by direction (prompt/completion)" }),
    llmGpu: meter.createCounter("llm.gpu", { unit: "s", description: "Ollama total_duration, a proxy for cloud usage consumed" }),
    llmRetry: meter.createCounter("llm.retry", { description: "LLM retries" }),
    llmFallback: meter.createCounter("llm.fallback", { description: "LLM fallbacks to the next model" }),
  };
}

export function installRuntime(opts: { tracer?: Tracer; meter?: Meter; logger?: OtelLogger; store?: RunStore; salt?: string; stdoutLogs?: boolean }): Runtime {
  const rt = runtime();
  rt.tracer = opts.tracer ?? rt.tracer;
  rt.meter = opts.meter ?? rt.meter;
  rt.instruments = opts.meter ? createInstruments(opts.meter) : rt.instruments;
  rt.logger = opts.logger ?? rt.logger;
  rt.store = opts.store ?? rt.store;
  rt.salt = opts.salt ?? rt.salt;
  rt.stdoutLogs = opts.stdoutLogs ?? rt.stdoutLogs;
  rt.enabled = Boolean(rt.tracer || rt.meter || rt.logger || opts.store);
  return rt;
}
