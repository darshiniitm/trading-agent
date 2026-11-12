// Bridges Part A's LlmTelemetry events (one per HTTP attempt, plus retry / fallback) into spans, metrics, log lines and
// run-record rows. chat() itself is untouched: events fire synchronously inside the caller's async context, so
// context.active() is the right parent (the agent / task that asked for the model call).
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { currentNode, currentRun } from "./context";
import { emitLog } from "./logger";
import { runtime } from "./runtime";
import { setLlmTelemetry, type LlmCallEvent, type LlmTelemetry } from "../llm/telemetry";

const guard = (fn: () => void) => { try { fn(); } catch { /* telemetry never breaks an LLM call */ } };

export const llmSink: LlmTelemetry = {
  call(e: LlmCallEvent) {
    guard(() => {
      const rt = runtime();
      if (!rt.enabled) return;
      const now = Date.now();
      const started = now - e.latencyMs;
      const ctx = context.active();
      const run = currentRun(ctx);
      const t = e.timing ?? {};
      const inTok = t.prompt_eval_count, outTok = t.eval_count;
      const gpuMs = t.total_duration !== undefined ? Math.round(t.total_duration / 1e6) : undefined;
      const ok = e.status === "ok";

      const attrs: Record<string, string | number | boolean> = {
        "gen_ai.operation.name": "chat", "gen_ai.system": "ollama", "gen_ai.request.model": e.model, "llm.provider": e.provider,
        "llm.status": e.status, "llm.attempt": e.attempt,
      };
      if (e.task) attrs["llm.task"] = e.task;
      if (e.httpStatus !== undefined) attrs["http.response.status_code"] = e.httpStatus;
      if (inTok !== undefined) attrs["gen_ai.usage.input_tokens"] = inTok;
      if (outTok !== undefined) attrs["gen_ai.usage.output_tokens"] = outTok;

      const span = rt.tracer?.startSpan("llm.chat", { startTime: started, attributes: attrs }, ctx);
      if (span) { if (!ok) span.setStatus({ code: SpanStatusCode.ERROR, message: e.status }); span.end(now); }
      const sc = span?.spanContext();
      const spanId = sc?.spanId ?? randomUUID().replace(/-/g, "").slice(0, 16);
      const traceId = sc?.traceId ?? run?.traceId ?? "";

      const ins = rt.instruments;
      if (ins) {
        ins.llmDuration.record(e.latencyMs / 1000, { model: e.model, provider: e.provider, status: e.status });
        ins.llmRequests.add(1, { model: e.model, status: e.status });
        if (inTok !== undefined) ins.llmTokens.add(inTok, { model: e.model, direction: "prompt" });
        if (outTok !== undefined) ins.llmTokens.add(outTok, { model: e.model, direction: "completion" });
        if (t.total_duration !== undefined) ins.llmGpu.add(t.total_duration / 1e9, { model: e.model });
      }

      // roll the model, tokens and gpu time up to the agent / task that made the call
      const node = currentNode(ctx);
      if (node) {
        node.model = e.model; node.provider = e.provider;
        if (inTok !== undefined) node.inputTokens = (node.inputTokens ?? 0) + inTok;
        if (outTok !== undefined) node.outputTokens = (node.outputTokens ?? 0) + outTok;
        if (gpuMs !== undefined) node.gpuMs = (node.gpuMs ?? 0) + gpuMs;
      }

      emitLog(ok ? "INFO" : "WARN", "llm.chat", {
        event: "end", kind: "llm", tool_name: "llm.chat", run_id: run?.runId, prompt_id: run?.promptId, trace_id: traceId, span_id: spanId,
        parent_span_id: trace.getSpanContext(ctx)?.spanId, task_id: run?.taskId, task_name: run?.taskName, seq: run?.seq,
        agent_name: run?.agentName, agent_version: run?.agentVersion, status: ok ? "ok" : "error", error_type: ok ? undefined : e.status,
        model: e.model, provider: e.provider, input_tokens: inTok, output_tokens: outTok, gpu_ms: gpuMs, duration_ms: e.latencyMs,
        started_at: new Date(started).toISOString(), ended_at: new Date(now).toISOString(), llm_task: e.task, attempt: e.attempt,
      }, ctx);

      if (run) {
        // which model served this run (partial upsert: status / started_at are left as they are)
        rt.store.upsertRun({ run_id: run.runId, trace_id: run.traceId, kind: "prompt_run", provider: e.provider, model: e.model });
        rt.store.insertTool({
          run_id: run.runId, trace_id: traceId, span_id: spanId, parent_span_id: trace.getSpanContext(ctx)?.spanId ?? null,
          agent_span_id: run.agentSpanId ?? null, tool_name: "llm.chat", tool_args: { task: e.task, attempt: e.attempt, http_status: e.httpStatus },
          model: e.model, provider: e.provider, input_tokens: inTok ?? null, output_tokens: outTok ?? null, gpu_ms: gpuMs ?? null,
          status: ok ? "ok" : "error", started_at: new Date(started).toISOString(), ended_at: new Date(now).toISOString(), duration_ms: e.latencyMs,
          truncated: false, error_type: ok ? null : e.status, error_msg: null,
        });
      }
    });
  },

  retry(e) {
    guard(() => {
      const rt = runtime();
      if (!rt.enabled) return;
      rt.instruments?.llmRetry.add(1, { from_model: e.model, to_model: e.model });
      trace.getActiveSpan()?.addEvent("llm.retry", { model: e.model, status: e.status, attempt: e.attempt });
      const n = currentNode();
      if (n && n.status === "ok") n.status = "retried";
    });
  },

  fallback(e) {
    guard(() => {
      const rt = runtime();
      if (!rt.enabled) return;
      rt.instruments?.llmFallback.add(1, { from_model: e.from_model, to_model: e.to_model });
      trace.getActiveSpan()?.addEvent("llm.fallback", { from_model: e.from_model, to_model: e.to_model });
      const n = currentNode();
      if (n) n.status = "fallback";
    });
  },
};

/** Idempotent: always installs the same stateless sink. */
export const installLlmTelemetry = () => setLlmTelemetry(llmSink);
