import type { Db } from "./pg";
import { seedOwnerEmail } from "../auth/ensureAppUser";
import { resetIdentitySequences } from "./sequences";

export async function ensureOwnerUser(raw: Db): Promise<number> {
  const existing = await raw.get<{ user_id: number }>("SELECT user_id FROM users ORDER BY user_id LIMIT 1");
  if (existing) { await seedOwnerEmail(raw); return existing.user_id; }
  const now = new Date().toISOString();
  const created = await raw.get<{ user_id: number }>(
    "INSERT INTO users (display_name, role, status, created_at) VALUES ('Owner', 'owner', 'active', ?) RETURNING user_id", [now]);
  await seedOwnerEmail(raw);   // OWNER_EMAIL claims this row, so the owner's first sign-in links to it
  return created!.user_id;
}

// Serverless instances start cold often; the owner seed is idempotent but is still two queries, so run it once
// per database handle (the plan's "not on every db() call").
const seeded = new WeakMap<Db, Promise<number>>();
export function ensureOwnerSeeded(raw: Db): Promise<number> {
  let p = seeded.get(raw);
  if (!p) {
    p = ensureOwnerUser(raw);
    seeded.set(raw, p);
    p.catch(() => seeded.delete(raw));   // a failed seed (db briefly down) is retried by the next request
  }
  return p;
}

// Demo data for the P5 visual check (scripts/seed-ui-demo.ts). Never run against a real database.
// Covers: an entered pick, a pending pick, a v4 near-miss "watching" row, two followers, a version chain, two drafts.
// Users 2 and 3 are 'disabled' so the demo stays single-user (no sign-in gate) while still counting as followers/owners.
export async function seedUiDemo(raw: Db) {
  const owner = await ensureOwnerUser(raw);
  const now = "2026-09-26T09:00:00.000Z";
  const ins = (sql: string, params: unknown[] = []) => raw.run(`${sql} ON CONFLICT DO NOTHING`, params);
  await ins("INSERT INTO users (user_id, display_name, email, role, status, created_at) VALUES (2, 'User 2', 'u2@example.com', 'member', 'disabled', ?)", [now]);
  await ins("INSERT INTO users (user_id, display_name, email, role, status, created_at) VALUES (3, 'User 3', 'u3@example.com', 'member', 'disabled', ?)", [now]);
  const spec = JSON.stringify({ spec_version: 4, structure: "literal", timeframe: "1W", selection_point: null, conditions: [], stop: null, risk_cap_pct: null, near_miss: null });
  const draft = (id: number, user: number, text: string) =>
    ins("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, 'confirmed', ?, ?)", [id, user, text, now, now]);
  const prompt = (id: number, user: number, draftId: number, title: string, text: string, hash: string, status: string, parent: number | null, version: number, visibility: string) =>
    ins("INSERT INTO prompts (prompt_id, owner_user_id, draft_id, title, prompt_text, structure, spec_json, spec_hash, status, parent_prompt_id, version, hypothesis, kill_criterion, visibility, confirmed_at) VALUES (?, ?, ?, ?, ?, 'literal', ?, ?, ?, ?, ?, 'h', 'k', ?, ?)",
      [id, user, draftId, title, text, spec, hash, status, parent, version, visibility, now]);
  await draft(1, owner, "mid caps, rsi 50 to 65, vstop flips long");
  await draft(2, owner, "mid caps with rsi 50 to 65 and a vstop flip long this week");
  await draft(3, 2, "small momentum names above 200 cr");
  await prompt(9, owner, 1, "Mid-cap momentum", "mid caps, rsi 50 to 65, vstop flips long", "h9", "superseded", null, 1, "private");
  await prompt(12, owner, 2, "Mid-cap momentum v2", "mid caps with rsi 50 to 65 and a vstop flip long this week", "h12", "confirmed", 9, 2, "shared");
  await prompt(15, 2, 3, "Small momentum", "small momentum names above 200 cr", "h15", "confirmed", null, 1, "shared");
  const cond = (...p: unknown[]) => ins("INSERT INTO prompt_conditions (prompt_id, cond_no, role, kind, name, params_json, op, value_json, value_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", p);
  for (const id of [12, 15]) {
    await cond(id, 1, "filter", "field", "mcap_cr", "{}", "between", "[10000,50000]", "prompt");
    await cond(id, 2, "filter", "indicator", "rsi", '{"length":14}', "between", "[50,65]", id === 12 ? "prompt" : "user_answer");
    await cond(id, 3, "event", "indicator", "vstop", '{"length":10,"mult":2,"source":"close"}', "flips_long", null, "prompt");
  }
  const steps = JSON.stringify([{ step: "evaluate_on_completed_weekly_bar", applied: true, reason: null }, { step: "trade_plan_entry_at_signal_close", applied: true, reason: null }]);
  const run = (id: number, promptId: number, asOf: string) =>
    ins("INSERT INTO runs (run_id, prompt_id, as_of, kind, status, applied_steps_json) VALUES (?, ?, ?, 'scheduled', 'done', ?)", [id, promptId, asOf, steps]);
  await run(10, 12, "2026-09-25"); await run(11, 12, "2026-10-02"); await run(20, 15, "2026-10-02");
  for (const r of [["AAA.NS", "Aaa Industries", "Industrials"], ["BBB.NS", "Bbb Pharma", "Healthcare"], ["CCC.NS", "Ccc Finance", "Financials"]])
    await ins("INSERT INTO symbols (symbol, name, sector) VALUES (?, ?, ?)", r);
  await ins("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (1, ?, 12, 'Prompt 12', ?)", [owner, now]);
  await ins("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (2, 2, 12, 'Prompt 12', ?)", [now]);
  await ins("INSERT INTO watchlists (watchlist_id, user_id, prompt_id, name, created_at) VALUES (3, 3, 12, 'Prompt 12', ?)", [now]);
  const rr = (...p: unknown[]) => ins("INSERT INTO run_results (run_id, symbol, membership, in_forward_record, failed_conds_json, cond_json, ref_price) VALUES (?, ?, ?, ?, ?, ?, ?)", p);
  await rr(11, "AAA.NS", "full_match", 1, "[]", '{"C1":25000,"C2":58.2,"C3":true}', 100);
  await rr(11, "BBB.NS", "full_match", 1, "[]", '{"C1":18000,"C2":61.4,"C3":true}', 250);
  await rr(11, "CCC.NS", "near_miss", 0, '["C2"]', '{"C1":32000,"C2":71.9,"C3":true}', 80);
  const ent = (...p: unknown[]) => ins("INSERT INTO watchlist_entries (entry_id, watchlist_id, symbol, first_run_id, last_run_id, membership, status, entry_date, entry_price, stop, ref_price, created_at, updated_at) VALUES (?, 1, ?, ?, 11, ?, ?, ?, ?, ?, ?, ?, ?)", p);
  await ent(1, "AAA.NS", 10, "full_match", "entered", "2026-09-28", 101.5, 94, 100, now, now);
  await ent(2, "BBB.NS", 11, "full_match", "pending_selection", null, null, 232, 250, now, now);
  await ent(3, "CCC.NS", 11, "near_miss", "watching", null, null, null, 80, now, now);
  await ins("INSERT INTO entry_events (entry_id, run_id, type, from_value, to_value, at) VALUES (1, 10, 'status_changed', 'pending_selection', 'entered', ?)", [now]);
  await ins("INSERT INTO validations (run_id, horizon_w, n, ew_return, control_ew_return, hit_rate, computed_at) VALUES (10, 1, 2, 1.8, 0.9, 0.5, ?)", [now]);
  const open = (id: number, text: string) => ins("INSERT INTO prompt_drafts (draft_id, user_id, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)", [id, owner, text, now, now]);
  await open(58, "stocks near their 52 week high with strong relative strength and rising volume over the last month");
  await open(59, "buy stocks that the news is positive about");
  await resetIdentitySequences(raw);
}
