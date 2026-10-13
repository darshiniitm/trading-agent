import { describe, expect, it } from "vitest";
import { createTestDb } from "@/server/db/test-db";

const cols = (raw: ReturnType<typeof createTestDb>, t: string) => (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);

describe("0010_data_resolution migration (docs/data-fallback-spec.md §8)", () => {
  it("adds run coverage columns and the provenance tables", () => {
    const raw = createTestDb();
    expect(cols(raw, "runs")).toEqual(expect.arrayContaining(["coverage_status", "coverage", "universe_quality", "scored"]));
    expect(cols(raw, "run_results")).toEqual(expect.arrayContaining(["outcome", "unknown_count", "reasons_json"]));
    expect(cols(raw, "run_condition_coverage")).toEqual(["run_id", "condition_id", "coverage", "unfeedable"]);
    expect(cols(raw, "run_provenance")).toEqual(expect.arrayContaining(["run_id", "data_type", "symbol", "source", "as_of", "quality", "reason"]));
    expect(cols(raw, "run_unevaluated")).toEqual(expect.arrayContaining(["run_id", "symbol", "set_id", "unknown_count", "met_count", "reasons_json", "cond_json"]));
  });

  it("keeps the existing runs.status lifecycle separate from coverage_status", () => {
    const raw = createTestDb();
    raw.prepare(`INSERT INTO users (user_id, display_name, role, status, created_at) VALUES (1,'o','owner','active','x')`).run();
    raw.prepare(`INSERT INTO prompt_drafts (draft_id,user_id,prompt_text,status,created_at,updated_at) VALUES (1,1,'x','confirmed','x','x')`).run();
    raw.prepare(`INSERT INTO prompts (prompt_id,owner_user_id,draft_id,title,prompt_text,structure,spec_json,spec_hash,status,version,hypothesis,kill_criterion,confirmed_at) VALUES (1,1,1,'t','x','literal','{}','h','confirmed',1,'h','k','x')`).run();
    const ins = (cs: string | null, scored: number | null) =>
      raw.prepare(`INSERT INTO runs (prompt_id, as_of, kind, status, coverage_status, scored) VALUES (1, ?, 'dry_run', 'done', ?, ?)`).run(`2026-10-0${Math.floor(Math.random() * 9) + 1}`, cs, scored);
    expect(() => ins("complete", 1)).not.toThrow();
    expect(() => ins("partial", 0)).not.toThrow();
    expect(() => ins("low_coverage", 0)).not.toThrow();
    expect(() => ins("bogus", 0)).toThrow();
    expect(() => ins("complete", 2)).toThrow();
  });
});
