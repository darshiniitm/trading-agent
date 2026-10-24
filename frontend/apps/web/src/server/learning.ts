// The learning loop (plan §6). Three stores, all driven by what the user does:
//   edits      (phrase, what it compiled to, what the user changed it to) — an audit trail and the signal;
//   alias proposals  a new phrasing the user taught us -> a `proposed` knowledge-repository alias, never used
//              for matching until a person marks it reviewed;
//   examples   accepted prompts with their accepted conditions -> the 3–5 most similar are shown to the Reader.
// Nothing here changes the compiler's rules: it only feeds the Reader's examples and queues proposals.
import type { Db } from "./db/pg";
import type { ScreenProgram } from "spec";
import { kbEntry, norm } from "spec/src/kb";
import { canonicalConditions } from "@/server/compiler/v5/goldenSet";

export async function recordEdit(raw: Db, e: { userId: number; draftId?: number; phrase: string; from: unknown; to: unknown; path?: string }) {
  await raw.run("INSERT INTO interpreter_edit (user_id, draft_id, phrase, compiled_json, edited_json, path, created_at) VALUES (?,?,?,?,?,?,?)",
    [e.userId, e.draftId ?? null, e.phrase, JSON.stringify(e.from ?? null), JSON.stringify(e.to ?? null), e.path ?? null, new Date().toISOString()]);
}

export type Proposal = { entry_kind: string; entry_id: string; alias: string; seen: number; status: string };

export async function proposeAlias(raw: Db, p: { kind: "indicator" | "field" | "universe"; id: string; alias: string }): Promise<Proposal | null> {
  const entry = kbEntry(p.id, p.kind);
  const alias = norm(p.alias);
  if (!entry || !alias) return null;
  if ([entry.id.replace(/_/g, " "), entry.label, ...entry.aliases].some((a) => norm(a) === alias)) return null;   // already known
  await raw.run(`INSERT INTO kb_alias_proposal (entry_kind, entry_id, alias, created_at) VALUES (?,?,?,?)
               ON CONFLICT(entry_kind, entry_id, alias) DO UPDATE SET seen = kb_alias_proposal.seen + 1`, [p.kind, p.id, alias, new Date().toISOString()]);
  return (await raw.get<Proposal>("SELECT entry_kind, entry_id, alias, seen, status FROM kb_alias_proposal WHERE entry_kind=? AND entry_id=? AND alias=?", [p.kind, p.id, alias]))!;
}
export const pendingProposals = (raw: Db) =>
  raw.all<Proposal>("SELECT entry_kind, entry_id, alias, seen, status FROM kb_alias_proposal WHERE status = 'proposed' ORDER BY seen DESC, alias");

// A line the tools could not read was rewritten by the user and now compiles to exactly one indicator:
// the old wording is a candidate alias for it. Only short, number-free phrases qualify.
export async function learnFromClauseEdit(raw: Db, e: { userId: number; draftId?: number; oldText: string; newText: string; program: ScreenProgram }): Promise<Proposal | null> {
  const inds = e.program.conditions.filter((c) => c.phrase && e.newText.includes(c.phrase) && "ind" in c.lhs).map((c) => (c.lhs as any).ind as string);
  await recordEdit(raw, { userId: e.userId, draftId: e.draftId, phrase: e.oldText, from: null, to: { text: e.newText, indicators: inds } });
  const words = norm(e.oldText.replace(/\d+/g, " ")).split(" ").filter((w) => w && !["the", "a", "an", "of", "on"].includes(w));
  if (inds.length !== 1 || words.length < 1 || words.length > 4) return null;
  return proposeAlias(raw, { kind: "indicator", id: inds[0], alias: words.join(" ") });
}

// ---- few-shot store
export const conditionsOf = (p: ScreenProgram) => canonicalConditions(p);

export async function saveAccepted(raw: Db, a: { userId: number; promptText: string; program: ScreenProgram; goldenOk?: boolean }) {
  await raw.run(`INSERT INTO interpreter_example (user_id, prompt_text, conditions_json, golden_ok, accepted_at) VALUES (?,?,?,?,?)
               ON CONFLICT(user_id, prompt_text) DO UPDATE SET conditions_json = excluded.conditions_json, golden_ok = GREATEST(interpreter_example.golden_ok, excluded.golden_ok), accepted_at = excluded.accepted_at`,
    [a.userId, a.promptText, JSON.stringify(conditionsOf(a.program)), a.goldenOk ? 1 : 0, new Date().toISOString()]);
}

const tokens = (s: string) => new Set(norm(s).split(" ").filter((w) => w.length > 1));
export async function similarExamples(raw: Db, text: string, k = 4, userId?: number): Promise<{ prompt: string; conditions: string[] }[]> {
  const rows = userId === undefined
    ? await raw.all<{ prompt_text: string; conditions_json: string }>("SELECT prompt_text, conditions_json FROM interpreter_example")
    : await raw.all<{ prompt_text: string; conditions_json: string }>("SELECT prompt_text, conditions_json FROM interpreter_example WHERE user_id = ?", [userId]);
  const q = tokens(text);
  return rows.map((r) => {
    const t = tokens(r.prompt_text);
    const inter = [...q].filter((w) => t.has(w)).length;
    return { prompt: r.prompt_text, conditions: JSON.parse(r.conditions_json) as string[], score: inter / (q.size + t.size - inter || 1) };
  }).filter((r) => r.score >= 0.08 && r.prompt !== text).sort((a, b) => b.score - a.score || a.prompt.localeCompare(b.prompt)).slice(0, k)
    .map(({ prompt, conditions }) => ({ prompt, conditions }));
}

// Accepted prompts the user agreed to share become golden-set cases (same shape as goldenSet.ts).
export async function exportGolden(raw: Db) {
  return (await raw.all("SELECT example_id, prompt_text, conditions_json FROM interpreter_example WHERE golden_ok = 1 ORDER BY example_id"))
    .map((r) => ({ id: `user-${r.example_id}`, text: r.prompt_text as string, conditions: JSON.parse(r.conditions_json) as string[] }));
}

export async function shareAsGolden(raw: Db, userId: number, promptText: string, share = true) {
  return (await raw.run("UPDATE interpreter_example SET golden_ok = ? WHERE user_id = ? AND prompt_text = ?", [share ? 1 : 0, userId, promptText])) > 0;
}
