// Run-record persistence seam. The Postgres implementation lives in pgStore.ts; tests use MemoryRunStore.
// Contract: methods never throw and never block the caller (a failed write must not fail a run).
export type RowStatus = "ok" | "error" | "retried" | "fallback" | "skipped";

export type RunRow = {
  run_id: string; trace_id: string; kind: "prompt_run" | "weekly_job"; draft_id?: string | null; prompt_id?: number | null;
  user_hash?: string | null; provider?: string | null; model?: string | null; status?: "running" | "ok" | "error" | "partial"; outcome?: string | null;
  started_at?: string; ended_at?: string | null; duration_ms?: number | null; rows_in?: number | null; rows_out?: number | null;
  error_type?: string | null; error_msg?: string | null; code_version?: string | null; attrs?: Record<string, unknown>;
};
type SpanRow = {
  run_id: string; trace_id: string; span_id: string; parent_span_id?: string | null; status: RowStatus;
  started_at: string; ended_at: string; duration_ms: number; input?: unknown; output?: unknown; truncated: boolean;
  error_type?: string | null; error_msg?: string | null;
};
export type TaskRow = SpanRow & { task_id: string; task_name: string; seq: number; rows_in?: number | null; rows_out?: number | null };
export type AgentRow = SpanRow & {
  task_span_id?: string | null; agent_name: string; agent_version?: string | null; model?: string | null; provider?: string | null;
  input_tokens?: number | null; output_tokens?: number | null; gpu_ms?: number | null;
};
export type ToolRow = SpanRow & {
  agent_span_id?: string | null; tool_name: string; tool_args?: unknown; rows_in?: number | null; rows_out?: number | null;
  model?: string | null; provider?: string | null; input_tokens?: number | null; output_tokens?: number | null; gpu_ms?: number | null;
};

export interface RunStore {
  upsertRun(row: RunRow): void;
  insertTask(row: TaskRow): void;
  insertAgent(row: AgentRow): void;
  insertTool(row: ToolRow): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export const noopStore: RunStore = { upsertRun() {}, insertTask() {}, insertAgent() {}, insertTool() {}, async flush() {}, async close() {} };

export class MemoryRunStore implements RunStore {
  runs = new Map<string, RunRow>();
  tasks: TaskRow[] = []; agents: AgentRow[] = []; tools: ToolRow[] = [];
  upsertRun(row: RunRow) { this.runs.set(row.trace_id, { ...(this.runs.get(row.trace_id) ?? {}), ...row }); }
  insertTask(row: TaskRow) { this.tasks.push(row); }
  insertAgent(row: AgentRow) { this.agents.push(row); }
  insertTool(row: ToolRow) { this.tools.push(row); }
  async flush() {}
  async close() {}
}
