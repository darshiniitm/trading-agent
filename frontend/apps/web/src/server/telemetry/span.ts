// task() / agent() / tool(): higher-order wrappers over one withSpan(). The wrapped function keeps its exact signature, so
// injected callModel / fetchFn in tests are unaffected. With telemetry disabled the wrapper calls fn directly.
// Per call it opens a span, writes one start and one end log line, records metrics and queues the run-record row.
// Nothing here may throw into, or change the result of, the wrapped function.
import { context, SpanStatusCode, trace, type Context } from "@opentelemetry/api";
import { createHash, randomUUID } from "node:crypto";
import { currentRun, NODE_KEY, RUN_KEY, type Node, type RunCtx } from "./context";
import { emitLog } from "./logger";
import { redactString, redactValue, truncate } from "./redact";
import { runtime } from "./runtime";

export type Kind = "task" | "agent" | "tool";
export type Opts<A extends unknown[]> = {
  /** span name; defaults to the wrapper's name */
  spanName?: string;
  /** agent_version = sha256 prefix of the agent's system prompt (or any stable text) */
  versionOf?: string;
  /** small, human-meaningful tool arguments (stored as tool_args); defaults to none */
  argsOf?: (...a: A) => unknown;
  captureInput?: boolean;
  captureOutput?: boolean;
};

const PG_FIELD_CAP = 1024 * 1024;
const GEN_AI_OP: Record<Kind, string | undefined> = { task: undefined, agent: "invoke_agent", tool: "execute_tool" };

export const versionHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

type Captured = { value: unknown; text: string; logTruncated: boolean; pgTruncated: boolean };
function capture(v: unknown): Captured | undefined {
  if (v === undefined) return undefined;
  const value = redactValue(v);
  let text: string;
  try { text = JSON.stringify(value) ?? ""; } catch { text = redactString(String(v)); }
  const log = truncate(text);
  if (text.length > PG_FIELD_CAP) return { value: { _truncated: text.slice(0, PG_FIELD_CAP) }, text: log.text, logTruncated: log.truncated, pgTruncated: true };
  return { value, text: log.text, logTruncated: log.truncated, pgTruncated: false };
}

const isThenable = (x: unknown): x is PromiseLike<unknown> => typeof (x as { then?: unknown })?.then === "function";
const errType = (e: unknown) => (e instanceof Error ? e.name : typeof e);
const errMsg = (e: unknown) => redactString(e instanceof Error ? e.message : String(e)).slice(0, 2000);

export function withSpan<A extends unknown[], R>(kind: Kind, name: string, fn: (...a: A) => R, opts: Opts<A> = {}): (...a: A) => R {
  return function wrapped(this: unknown, ...args: A): R {
    const rt = runtime();
    if (!rt.enabled) return fn.apply(this, args);

    let begin: ReturnType<typeof start>;
    try { begin = start(kind, name, opts, args); } catch { return fn.apply(this, args); }

    let result: R;
    try {
      result = context.with(begin.ctx, () => fn.apply(this, args));
    } catch (e) {
      finish(begin, undefined, e);
      throw e;
    }
    if (isThenable(result)) {
      return (result as unknown as Promise<unknown>).then(
        (v) => { finish(begin, v); return v; },
        (e) => { finish(begin, undefined, e); throw e; },
      ) as unknown as R;
    }
    finish(begin, result);
    return result;
  };
}

function start<A extends unknown[]>(kind: Kind, name: string, opts: Opts<A>, args: A) {
  const rt = runtime();
  const parentCtx = context.active();
  const run = currentRun(parentCtx);
  const started = Date.now();
  const spanName = opts.spanName ?? name;
  const attributes: Record<string, string | number | boolean> = { "telemetry.kind": kind };
  const op = GEN_AI_OP[kind];
  if (op) attributes["gen_ai.operation.name"] = op;
  if (kind === "agent") attributes["gen_ai.agent.name"] = name;
  if (kind === "tool") attributes["gen_ai.tool.name"] = name;
  if (kind === "task") attributes["task.name"] = name;
  if (run) { attributes["run.id"] = run.runId; if (run.promptId !== undefined) attributes["prompt.id"] = run.promptId; }

  const span = rt.tracer?.startSpan(spanName, { attributes }, parentCtx);
  const spanCtx = span ? trace.setSpan(parentCtx, span) : parentCtx;
  const sc = span?.spanContext();
  const spanId = sc?.spanId ?? randomUUID().replace(/-/g, "").slice(0, 16);
  const traceId = sc?.traceId ?? run?.traceId ?? "";
  const parentSpanId = trace.getSpanContext(parentCtx)?.spanId;

  const node: Node = { status: "ok", attrs: {} };
  let child: RunCtx | undefined = run;
  if (run) {
    child = { ...run };
    if (kind === "task") { child.taskId = randomUUID(); child.taskName = name; child.seq = ++run.counter.n; child.taskSpanId = spanId; child.agentName = undefined; child.agentVersion = undefined; child.agentSpanId = undefined; }
    if (kind === "agent") { child.agentName = name; child.agentVersion = opts.versionOf ? versionHash(opts.versionOf) : undefined; child.agentSpanId = spanId; }
  }
  const ctx = (child ? spanCtx.setValue(RUN_KEY, child) : spanCtx).setValue(NODE_KEY, node);

  const input = opts.captureInput === false ? undefined : capture(args);
  if (opts.argsOf) { try { node.toolArgs = redactValue(opts.argsOf(...args)); } catch { /* optional */ } }
  const ids = ids_(kind, name, child, spanId, traceId, parentSpanId, opts);
  emitLog("INFO", `${kind}.start ${name}`, { event: "start", kind, ...ids, status: undefined, input: input?.text, started_at: new Date(started).toISOString(), ...(input?.logTruncated ? { truncated: true } : {}) }, ctx);
  return { kind, name, opts: { captureOutput: opts.captureOutput }, span, ctx, node, run: child, started, spanId, traceId, parentSpanId, input, ids };
}

function ids_(kind: Kind, name: string, run: RunCtx | undefined, spanId: string, traceId: string, parentSpanId: string | undefined, opts: Opts<never>) {
  return {
    run_id: run?.runId, prompt_id: run?.promptId, trace_id: traceId, span_id: spanId, parent_span_id: parentSpanId,
    task_id: run?.taskId, task_name: run?.taskName, seq: run?.seq,
    agent_name: kind === "agent" ? name : run?.agentName, agent_version: kind === "agent" ? (opts.versionOf ? versionHash(opts.versionOf) : undefined) : run?.agentVersion,
    ...(kind === "tool" ? { tool_name: name } : {}),
  };
}

function finish(b: ReturnType<typeof start>, value: unknown, error?: unknown) {
  try {
    const rt = runtime();
    const ended = Date.now();
    const durationMs = ended - b.started;
    const failed = error !== undefined;
    const status = failed ? "error" : b.node.status;
    const output = failed || b.opts.captureOutput === false ? undefined : capture(value);

    if (b.span) {
      for (const [k, v] of Object.entries(b.node.attrs)) b.span.setAttribute(k, v);
      if (b.node.model) b.span.setAttribute("gen_ai.request.model", b.node.model);
      if (b.node.inputTokens !== undefined) b.span.setAttribute("gen_ai.usage.input_tokens", b.node.inputTokens);
      if (b.node.outputTokens !== undefined) b.span.setAttribute("gen_ai.usage.output_tokens", b.node.outputTokens);
      if (b.node.rowsIn !== undefined) b.span.setAttribute("rows.in", b.node.rowsIn);
      if (b.node.rowsOut !== undefined) b.span.setAttribute("rows.out", b.node.rowsOut);
      if (failed) { b.span.recordException(error instanceof Error ? error : new Error(String(error))); b.span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) }); }
      b.span.setAttribute("telemetry.status", status);
      b.span.end(ended);
    }

    const labels = { status };
    const secs = durationMs / 1000;
    const ins = rt.instruments;
    if (ins) {
      if (b.kind === "task") ins.taskDuration.record(secs, { task: b.name, status });
      else if (b.kind === "agent") { ins.agentInvocations.add(1, { agent: b.name, ...labels }); ins.agentDuration.record(secs, { agent: b.name }); }
      else { ins.toolCalls.add(1, { tool: b.name, ...labels }); ins.toolDuration.record(secs, { tool: b.name }); }
    }

    const n = b.node;
    emitLog(failed ? "ERROR" : "INFO", `${b.kind}.end ${b.name}`, {
      event: "end", kind: b.kind, ...b.ids, status, error_type: failed ? errType(error) : undefined, error_msg: failed ? errMsg(error) : undefined,
      started_at: new Date(b.started).toISOString(), ended_at: new Date(ended).toISOString(), duration_ms: durationMs,
      output: output?.text, rows_in: n.rowsIn, rows_out: n.rowsOut, model: n.model, provider: n.provider,
      input_tokens: n.inputTokens, output_tokens: n.outputTokens, gpu_ms: n.gpuMs, ...(output?.logTruncated ? { truncated: true } : {}),
    }, b.ctx);

    const run = b.run;
    if (!run) return;
    const base = {
      run_id: run.runId, trace_id: b.traceId, span_id: b.spanId, parent_span_id: b.parentSpanId ?? null, status,
      started_at: new Date(b.started).toISOString(), ended_at: new Date(ended).toISOString(), duration_ms: durationMs,
      input: b.input?.value, output: output?.value, truncated: Boolean(b.input?.pgTruncated || output?.pgTruncated),
      error_type: failed ? errType(error) : null, error_msg: failed ? errMsg(error) : null,
    } as const;
    if (b.kind === "task") rt.store.insertTask({ ...base, task_id: run.taskId ?? "", task_name: b.name, seq: run.seq ?? 0, rows_in: n.rowsIn ?? null, rows_out: n.rowsOut ?? null });
    else if (b.kind === "agent") rt.store.insertAgent({ ...base, task_span_id: run.taskSpanId ?? null, agent_name: b.name, agent_version: run.agentVersion ?? null, model: n.model ?? null, provider: n.provider ?? null, input_tokens: n.inputTokens ?? null, output_tokens: n.outputTokens ?? null, gpu_ms: n.gpuMs ?? null });
    else rt.store.insertTool({ ...base, agent_span_id: run.agentSpanId ?? null, tool_name: b.name, tool_args: n.toolArgs, rows_in: n.rowsIn ?? null, rows_out: n.rowsOut ?? null, model: n.model ?? null, provider: n.provider ?? null, input_tokens: n.inputTokens ?? null, output_tokens: n.outputTokens ?? null, gpu_ms: n.gpuMs ?? null });
  } catch { /* telemetry never breaks the caller */ }
}

export const task = <A extends unknown[], R>(name: string, fn: (...a: A) => R, opts?: Opts<A>) => withSpan("task", name, fn, opts);
export const agent = <A extends unknown[], R>(name: string, fn: (...a: A) => R, opts?: Opts<A>) => withSpan("agent", name, fn, opts);
export const tool = <A extends unknown[], R>(name: string, fn: (...a: A) => R, opts?: Opts<A>) => withSpan("tool", name, fn, opts);
export type { Context };
