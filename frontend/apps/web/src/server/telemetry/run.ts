// One trace per draft lifecycle: compile -> screen -> confirm are three separate HTTP requests with no shared state, so the
// trace id is derived from the draft id. Each request opens `prompt.<stage>` as a child of a synthetic remote parent; the
// `prompt.run` root (same ids, started at draft creation) is emitted when confirm finishes. Stateless: survives restarts.
import { context, ROOT_CONTEXT, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { currentRun, newRunCtx, RUN_KEY, type RunCtx } from "./context";
import { clearForced, forceNext } from "./idGenerator";
import { hashUser, redactString } from "./redact";
import { runtime } from "./runtime";

export type Stage = "compile" | "screen" | "confirm";
export type RunOpts<R> = {
  draftId: number | string;
  stage: Stage;
  /** evaluated only when telemetry is enabled */
  lookup?: () => { userId?: number | string; createdAt?: string };
  /** confirm: what the finished run should record */
  summarize?: (result: Awaited<R>) => { promptId?: number; outcome?: string };
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function deriveRunIds(draftId: number | string) {
  const h = sha(`run:${draftId}`), u = sha(`runid:${draftId}`);
  return {
    traceId: h.slice(0, 32),
    rootSpanId: h.slice(32, 48),
    runId: `${u.slice(0, 8)}-${u.slice(8, 12)}-5${u.slice(13, 16)}-8${u.slice(17, 20)}-${u.slice(20, 32)}`,
  };
}

const isThenable = (x: unknown): x is PromiseLike<unknown> => typeof (x as { then?: unknown })?.then === "function";
const errType = (e: unknown) => (e instanceof Error ? e.name : typeof e);
const errMsg = (e: unknown) => redactString(e instanceof Error ? e.message : String(e)).slice(0, 2000);

export function inPromptRun<R>(o: RunOpts<R>, fn: () => R): R {
  const rt = runtime();
  if (!rt.enabled) return fn();
  const outer = currentRun();
  if (outer && outer.draftId === String(o.draftId)) return fn();     // e.g. editProgramClause -> compileProgramDraft

  let h: ReturnType<typeof open>;
  try { h = open(o); } catch { return fn(); }
  let result: R;
  try { result = context.with(h.ctx, fn); }
  catch (e) { close(o, h, undefined, e); throw e; }
  if (isThenable(result)) {
    return (result as unknown as Promise<Awaited<R>>).then(
      (v) => { close(o, h, v as Awaited<R>); return v; },
      (e) => { close(o, h, undefined, e); throw e; },
    ) as unknown as R;
  }
  close(o, h, result as Awaited<R>);
  return result;
}

function open<R>(o: RunOpts<R>) {
  const rt = runtime();
  const ids = deriveRunIds(o.draftId);
  const info = o.lookup?.() ?? {};
  const startedAt = info.createdAt && !Number.isNaN(Date.parse(info.createdAt)) ? new Date(info.createdAt).toISOString() : new Date().toISOString();
  const run: RunCtx = newRunCtx({
    runId: ids.runId, traceId: ids.traceId, draftId: String(o.draftId),
    userHash: info.userId !== undefined ? hashUser(String(info.userId), rt.salt || process.env.TELEMETRY_HASH_SALT || "dev") : undefined,
  });
  const remoteParent = trace.setSpanContext(context.active(), { traceId: ids.traceId, spanId: ids.rootSpanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });
  const span = rt.tracer?.startSpan(`prompt.${o.stage}`, { attributes: { "run.id": ids.runId, "draft.id": String(o.draftId), "prompt.stage": o.stage } }, remoteParent);
  const ctx = (span ? trace.setSpan(remoteParent, span) : remoteParent).setValue(RUN_KEY, run);
  // first request creates the row; started_at is never changed afterwards
  rt.store.upsertRun({ run_id: ids.runId, trace_id: ids.traceId, kind: "prompt_run", draft_id: String(o.draftId), user_hash: run.userHash ?? null, status: "running", started_at: startedAt });
  return { ids, ctx, span, startedAt, begun: Date.now() };
}

function close<R>(o: RunOpts<R>, h: ReturnType<typeof open>, result?: Awaited<R>, error?: unknown) {
  try {
    const rt = runtime();
    const failed = error !== undefined;
    rt.instruments?.promptRunDuration.record((Date.now() - h.begun) / 1000, { stage: o.stage, outcome: failed ? "error" : "ok" });
    if (h.span) {
      if (failed) { h.span.recordException(error instanceof Error ? error : new Error(String(error))); h.span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) }); }
      h.span.end();
    }
    if (o.stage !== "confirm") return;                        // compile / screen can be retried: the run stays open

    let summary: { promptId?: number; outcome?: string } = {};
    if (!failed) { try { summary = o.summarize?.(result as Awaited<R>) ?? {}; } catch { /* optional */ } }
    const now = Date.now();
    const outcome = summary.outcome ?? (failed ? "failed" : "confirmed");
    rt.store.upsertRun({
      run_id: h.ids.runId, trace_id: h.ids.traceId, kind: "prompt_run", status: failed ? "error" : "ok", outcome,
      prompt_id: summary.promptId ?? null, ended_at: new Date(now).toISOString(), duration_ms: now - Date.parse(h.startedAt),
      error_type: failed ? errType(error) : null, error_msg: failed ? errMsg(error) : null,
    });
    if (rt.tracer) {
      forceNext({ traceId: h.ids.traceId, spanId: h.ids.rootSpanId });
      let root;
      try {
        root = rt.tracer.startSpan("prompt.run", { startTime: Date.parse(h.startedAt), root: true, attributes: {
          "run.id": h.ids.runId, "draft.id": String(o.draftId), "prompt.outcome": outcome, ...(summary.promptId !== undefined ? { "prompt.id": summary.promptId } : {}),
        } }, ROOT_CONTEXT);
      } finally { clearForced(); }
      if (failed) root.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) });
      root.end(now);
    }
  } catch { /* telemetry never breaks the caller */ }
}

// ---- scheduled / catch-up jobs ---------------------------------------------------------------------------------------------
// No HTTP request and no draft: each job invocation is its own run (kind weekly_job) with a fresh trace; tasks below attach to it.
export function inJobRun<R>(o: { name: string; promptId?: number; attrs?: Record<string, string | number | boolean> }, fn: () => R): R {
  const rt = runtime();
  if (!rt.enabled) return fn();
  if (currentRun()) return fn();

  let h: { ctx: ReturnType<typeof context.active>; span?: ReturnType<NonNullable<typeof rt.tracer>["startSpan"]>; runId: string; traceId: string; begun: number };
  try {
    const runId = randomUUID(), begun = Date.now();
    const run: RunCtx = newRunCtx({ runId, traceId: randomBytes(16).toString("hex"), promptId: o.promptId });
    const span = rt.tracer?.startSpan(`job.${o.name}`, { attributes: { "run.id": runId, "job.name": o.name, ...(o.promptId !== undefined ? { "prompt.id": o.promptId } : {}) } }, ROOT_CONTEXT);
    const sc = span?.spanContext();
    if (sc) run.traceId = sc.traceId;
    rt.store.upsertRun({ run_id: runId, trace_id: run.traceId, kind: "weekly_job", prompt_id: o.promptId ?? null, status: "running", started_at: new Date(begun).toISOString(), attrs: { job: o.name, ...o.attrs } });
    h = { ctx: (span ? trace.setSpan(ROOT_CONTEXT, span) : ROOT_CONTEXT).setValue(RUN_KEY, run), span, runId, traceId: run.traceId, begun };
  } catch { return fn(); }

  const end = (error?: unknown) => {
    try {
      const failed = error !== undefined, now = Date.now();
      if (h.span) { if (failed) { h.span.recordException(error instanceof Error ? error : new Error(String(error))); h.span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg(error) }); } h.span.end(now); }
      rt.store.upsertRun({ run_id: h.runId, trace_id: h.traceId, kind: "weekly_job", status: failed ? "error" : "ok", outcome: o.name, ended_at: new Date(now).toISOString(), duration_ms: now - h.begun,
        error_type: failed ? errType(error) : null, error_msg: failed ? errMsg(error) : null });
    } catch { /* telemetry never breaks the job */ }
  };
  let result: R;
  try { result = context.with(h.ctx, fn); } catch (e) { end(e); throw e; }
  if (isThenable(result)) return (result as unknown as Promise<unknown>).then((v) => { end(); return v; }, (e) => { end(e); throw e; }) as unknown as R;
  end();
  return result;
}
