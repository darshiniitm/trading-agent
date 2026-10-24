// Run / task / agent context carried in the OpenTelemetry context (AsyncLocalStorage-backed in Node), so it follows awaits.
import { context, createContextKey, type Context } from "@opentelemetry/api";
import type { RowStatus } from "./store";

export type RunCtx = {
  runId: string;
  traceId: string;
  draftId?: string;
  promptId?: number;
  userHash?: string;
  /** shared, mutable per-run task counter */
  counter: { n: number };
  taskId?: string; taskName?: string; seq?: number; taskSpanId?: string;
  agentName?: string; agentVersion?: string; agentSpanId?: string;
};
/** The live record of the span being executed; annotate() mutates it, the wrapper turns it into log/metric/row at the end. */
export type Node = {
  status: RowStatus; rowsIn?: number; rowsOut?: number; model?: string; provider?: string;
  inputTokens?: number; outputTokens?: number; gpuMs?: number; toolArgs?: unknown; attrs: Record<string, string | number | boolean>;
};

export const RUN_KEY = createContextKey("trading.run");
export const NODE_KEY = createContextKey("trading.node");

export const currentRun = (ctx: Context = context.active()): RunCtx | undefined => ctx.getValue(RUN_KEY) as RunCtx | undefined;
export const currentNode = (ctx: Context = context.active()): Node | undefined => ctx.getValue(NODE_KEY) as Node | undefined;

/** Merge details into the span currently executing (rows in/out, status override such as "fallback", token counts…). */
export function annotate(patch: Partial<Omit<Node, "attrs">> & { attrs?: Node["attrs"] }): void {
  const n = currentNode();
  if (!n) return;
  const { attrs, ...rest } = patch;
  Object.assign(n, rest);
  if (attrs) Object.assign(n.attrs, attrs);
}

export const newRunCtx = (init: Omit<RunCtx, "counter"> & { counter?: RunCtx["counter"] }): RunCtx => ({ ...init, counter: init.counter ?? { n: 0 } });
/** Run `fn` inside a run: task/agent/tool wrappers below it attach their rows to `run`. */
export const withRunCtx = <R>(run: RunCtx, fn: () => R): R => context.with(context.active().setValue(RUN_KEY, run), fn);
