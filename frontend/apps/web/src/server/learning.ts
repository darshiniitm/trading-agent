// The learning loop (plan §6). Three stores, all driven by what the user does:
//   edits      (phrase, what it compiled to, what the user changed it to) — an audit trail and the signal;
//   alias proposals  a new phrasing the user taught us -> a `proposed` knowledge-repository alias, never used
//              for matching until a person marks it reviewed;
//   examples   accepted prompts with their accepted conditions -> the 3–5 most similar are shown to the Reader.
// Nothing here changes the compiler's rules: it only feeds the Reader's examples and queues proposals.
import type Database from "better-sqlite3";
import type { ScreenProgram } from "spec";
import { kbEntry, norm } from "spec/src/kb";
import { canonicalConditions } from "@/server/compiler/v5/goldenSet";

export function recordEdit(raw: Database.Database, e: { userId: number; draftId?: number; phrase: string; from: unknown; to: unknown; path?: string }) {
  raw.prepare("INSERT INTO interpreter_edit (user_id, draft_id, phrase, compiled_json, edited_json, path, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(e.userId, e.draftId ?? null, e.phrase, JSON.stringify(e.from ?? null), JSON.stringify(e.to ?? null), e.path ?? null, new Date().toISOString());
}

export type Proposal = { entry_kind: string; entry_id: string; alias: string; seen: number; status: string };

export function proposeAlias(raw: Database.Database, p: { kind: "indicator" | "field" | "universe"; id: string; alias: string }): Proposal | null {
  const entry = kbEntry(p.id, p.kind);
  const alias = norm(p.alias);
  if (!entry || !alias) return null;
  if ([entry.id.replace(/_/g, " "), entry.label, ...entry.aliases].some((a) => norm(a) === alias)) return null;   // already known
  raw.prepare(`INSERT INTO kb_alias_proposal (entry_kind, entry_id, alias, created_at) VALUES (?,?,?,?)
               ON CONFLICT(entry_kind, entry_id, alias) DO UPDATE SET seen = seen + 1`).run(p.kind, p.id, alias, new Date().toISOString());
  return raw.prepare("SELECT entry_kind, entry_id, alias, seen, status FROM kb_alias_proposal WHERE entry_kind=? AND entry_id=? AND alias=?").get(p.kind, p.id, alias) as Proposal;
}
export const pendingProposals = (raw: Database.Database) =>
  raw.prepare("SELECT entry_kind, entry_id, alias, seen, status FROM kb_alias_proposal WHERE status = 'proposed' ORDER BY seen DESC, alias").all() as Proposal[];

// A line the tools could not read was rewritten by the user and now compiles to exactly one indicator:
// the old wording is a candidate alias for it. Only short, number-free phrases qualify.
export function learnFromClauseEdit(raw: Database.Database, e: { userId: number; draftId?: number; oldText: string; newText: string; program: ScreenProgram }): Proposal | null {
  const inds = e.program.conditions.filter((c) => c.phrase && e.newText.includes(c.phrase) && "ind" in c.lhs).map((c) => (c.lhs as any).ind as string);
  recordEdit(raw, { userId: e.userId, draftId: e.draftId, phrase: e.oldText, from: null, to: { text: e.newText, indicators: inds } });
  const words = norm(e.oldText.replace(/\d+/g, " ")).split(" ").filter((w) => w && !["the", "a", "an", "of", "on"].includes(w));
  if (inds.length !== 1 || words.length < 1 || words.length > 4) return null;
  return proposeAlias(raw, { kind: "indicator", id: inds[0], alias: words.join(" ") });
}

// ---- few-shot store
export const conditionsOf = (p: ScreenProgram) => canonicalConditions(p);

export function saveAccepted(raw: Database.Database, a: { userId: number; promptText: string; program: ScreenProgram; goldenOk?: boolean }) {
  raw.prepare(`INSERT INTO interpreter_example (user_id, prompt_text, conditions_json, golden_ok, accepted_at) VALUES (?,?,?,?,?)
               ON CONFLICT(user_id, prompt_text) DO UPDATE SET conditions_json = excluded.conditions_json, golden_ok = MAX(golden_ok, excluded.golden_ok), accepted_at = excluded.accepted_at`)
    .run(a.userId, a.promptText, JSON.stringify(conditionsOf(a.program)), a.goldenOk ? 1 : 0, new Date().toISOString());
}

const tokens = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
export function similarExamples(raw: Database.Database, text: string, k = 4, userId?: number): { prompt: string; conditions: string[] }[] {
  const rows = (userId === undefined
    ? raw.prepare("SELECT prompt_text, conditions_json FROM interpreter_example").all()
    : raw.prepare("SELECT prompt_text, conditions_json FROM interpreter_example WHERE user_id = ?").all(userId)) as { prompt_text: string; conditions_json: string }[];
  const q = tokens(text);
  return rows.map((r) => {
    const t = tokens(r.prompt_text);
    const inter = [...q].filter((w) => t.has(w)).length;
    return { prompt: r.prompt_text, conditions: JSON.parse(r.conditions_json) as string[], score: inter / (q.size + t.size - inter || 1) };
  }).filter((r) => r.score >= 0.08 && r.prompt !== text).sort((a, b) => b.score - a.score || a.prompt.localeCompare(b.prompt)).slice(0, k)
    .map(({ prompt, conditions }) => ({ prompt, conditions }));
}

// Accepted prompts the user agreed to share become golden-set cases (same shape as goldenSet.ts).
export function exportGolden(raw: Database.Database) {
  return (raw.prepare("SELECT example_id, prompt_text, conditions_json FROM interpreter_example WHERE golden_ok = 1 ORDER BY example_id").all() as any[])
    .map((r) => ({ id: `user-${r.example_id}`, text: r.prompt_text as string, conditions: JSON.parse(r.conditions_json) as string[] }));
}

export function shareAsGolden(raw: Database.Database, userId: number, promptText: string, share = true) {
  return raw.prepare("UPDATE interpreter_example SET golden_ok = ? WHERE user_id = ? AND prompt_text = ?").run(share ? 1 : 0, userId, promptText).changes > 0;
}
