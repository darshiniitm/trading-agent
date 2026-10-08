import type Database from "better-sqlite3";

export function ensureOwnerUser(raw: Database.Database): number {
  const existing = raw.prepare("SELECT user_id FROM users ORDER BY user_id LIMIT 1").get() as
    | { user_id: number }
    | undefined;
  if (existing) return existing.user_id;
  const now = new Date().toISOString();
  const info = raw
    .prepare("INSERT INTO users (display_name, role, status, created_at) VALUES ('Owner', 'owner', 'active', ?)")
    .run(now);
  return Number(info.lastInsertRowid);
}

// Demo data for the P5 visual check (scripts/seed-ui-demo.ts). Never run against a real database.
// Covers: an entered pick, a pending pick, a v4 near-miss "watching" row, two followers, a version chain, two drafts.
// Users 2 and 3 are 'disabled' so the demo stays single-user (no sign-in gate) while still counting as followers/owners.
export function seedUiDemo(raw: Database.Database) {
  const owner = ensureOwnerUser(raw);
  const now = "2026-09-26T09:00:00.000Z";
  raw.prepare("INSERT OR IGNORE INTO users (user_id, display_name, email, role, status, created_at) VALUES (2, 'User 2', 'u2@example.com', 'member', 'disabled', ?)").run(now);
  raw.prepare("INSERT OR IGNORE INTO users (user_id, display_name, email, role, status, created_at) VALUES (3, 'User 3', 'u3@example.com', 'member', 'disabled', ?)").run(now);
  const spec = JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null });
  const draft = raw.prepare("INSERT OR IGNORE INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, 'confirmed', ?, ?)");
  const prompt = raw.prepare("INSERT OR IGNORE INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, visibility, confirmed_at) VALUES (?, ?, ?, ?, ?, 'literal', ?, ?, ?, ?, ?, 'h', 'k', ?, ?)");
  draft.run(1, owner, "mid caps, rsi 50 to 65, vstop flips long", now, now);
  draft.run(2, owner, "mid caps with rsi 50 to 65 and a vstop flip long this week", now, now);
  draft.run(3, 2, "small momentum names above 200 cr", now, now);
  prompt.run(9, owner, 1, "Mid-cap momentum", "mid caps, rsi 50 to 65, vstop flips long", spec, "h9", "superseded", null, 1, "private", now);
  prompt.run(12, owner, 2, "Mid-cap momentum v2", "mid caps with rsi 50 to 65 and a vstop flip long this week", spec, "h12", "confirmed", 9, 2, "shared", now);
  prompt.run(15, 2, 3, "Small momentum", "small momentum names above 200 cr", spec, "h15", "confirmed", null, 1, "shared", now);
  const cond = raw.prepare("INSERT OR IGNORE INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const id of [12, 15]) {
    cond.run(id, 1, "filter", "field", "mcap_cr", "{}", "between", "[10000,50000]", "prompt");
    cond.run(id, 2, "filter", "indicator", "rsi", '{"length":14}', "between", "[50,65]", id === 12 ? "prompt" : "user_answer");
    cond.run(id, 3, "event", "indicator", "vstop", '{"length":10,"mult":2,"source":"close"}', "flips_long", null, "prompt");
  }
  const run = raw.prepare("INSERT OR IGNORE INTO runs (run_id, prompt_id, as_of, kind, status, applied_steps_json) VALUES (?, ?, ?, ?, 'done', ?)");
  const steps = JSON.stringify([{ step: "evaluate_on_completed_weekly_bar", applied: true, reason: null }, { step: "trade_plan_entry_at_signal_close", applied: true, reason: null }]);
  run.run(10, 12, "2026-09-25", "scheduled", steps); run.run(11, 12, "2026-10-02", "scheduled", steps); run.run(20, 15, "2026-10-02", "scheduled", steps);
  const sym = raw.prepare("INSERT OR IGNORE INTO symbols (symbol, name, sector) VALUES (?, ?, ?)");
  [["AAA.NS", "Aaa Industries", "Industrials"], ["BBB.NS", "Bbb Pharma", "Healthcare"], ["CCC.NS", "Ccc Finance", "Financials"]].forEach((r) => sym.run(...r));
  raw.prepare("INSERT OR IGNORE INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 12, 'Prompt 12', ?)").run(owner, now);
  raw.prepare("INSERT OR IGNORE INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 12, 'Prompt 12', ?)").run(now);
  raw.prepare("INSERT OR IGNORE INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (3, 3, 12, 'Prompt 12', ?)").run(now);
  const rr = raw.prepare("INSERT OR IGNORE INTO run_results (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, ref_price) VALUES (?, ?, ?, ?, ?, ?, ?)");
  rr.run(11, "AAA.NS", "full_match", 1, "[]", '{"C1":25000,"C2":58.2,"C3":true}', 100);
  rr.run(11, "BBB.NS", "full_match", 1, "[]", '{"C1":18000,"C2":61.4,"C3":true}', 250);
  rr.run(11, "CCC.NS", "near_miss", 0, '["C2"]', '{"C1":32000,"C2":71.9,"C3":true}', 80);
  const ent = raw.prepare("INSERT OR IGNORE INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_date, entry_price, stop, ref_price, created_at, updated_at) VALUES (?, 1, ?, ?, 11, ?, ?, ?, ?, ?, ?, ?, ?)");
  ent.run(1, "AAA.NS", 10, "full_match", "entered", "2026-09-28", 101.5, 94, 100, now, now);
  ent.run(2, "BBB.NS", 11, "full_match", "pending_selection", null, null, 232, 250, now, now);
  ent.run(3, "CCC.NS", 11, "near_miss", "watching", null, null, null, 80, now, now);
  raw.prepare("INSERT OR IGNORE INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (1, 10, 'status_changed', 'pending_selection', 'entered', ?)").run(now);
  raw.prepare("INSERT OR IGNORE INTO validations (run_id, horizon_w, n, ew_return, control_ew_return, hit_rate, computed_at) VALUES (10, 1, 2, 1.8, 0.9, 0.5, ?)").run(now);
  const d = raw.prepare("INSERT OR IGNORE INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)");
  d.run(58, owner, "stocks near their 52 week high with strong relative strength and rising volume over the last month", now, now);
  d.run(59, owner, "buy stocks that the news is positive about", now, now);
}
