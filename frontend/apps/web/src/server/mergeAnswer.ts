import type Database from "better-sqlite3";
import { getDraft, updateDraft, type DraftRow } from "@/server/drafts";

// Path segments that would let an assignment reach Object.prototype (or a
// constructor's prototype) instead of the spec's own data. A needs_input
// path comes from the model's output, so it is untrusted input: compile.ts
// already rejects any path outside an explicit allow-list grammar, but this
// is the function that actually performs the dynamic assignment, so it
// refuses these segments on its own too (defense in depth — it must hold
// even if that upstream check is ever bypassed or has a gap).
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
// Upper bound on a numeric (array index) segment: an index like 1e9 would
// make JSON.stringify emit a billion nulls.
const MAX_INDEX = 1000;

export function setAtPath(obj: any, path: string, value: unknown): void {
  const keys = path.split(".");
  for (const key of keys) {
    if (key === "" || FORBIDDEN_SEGMENTS.has(key)) throw new Error(`refusing to write to unsafe path "${path}"`);
    if (/^\d+$/.test(key) && Number(key) > MAX_INDEX) throw new Error(`refusing to write to unsafe path "${path}" (index too large)`);
  }
  let node = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!Object.prototype.hasOwnProperty.call(node, key) || node[key] === null || node[key] === undefined) {
      node[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    node = node[key];
    if (node === null || typeof node !== "object") throw new Error(`cannot write "${path}": "${key}" is not an object`);
  }
  node[keys[keys.length - 1]] = value;
}

const STRUCTURES = ["literal", "t1_literal"] as const;

export function applyAnswer(
  raw: Database.Database,
  draftId: number,
  { path, value }: { path: string; value: number | string }
): DraftRow {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet — compile or build it first");

  const needsInput = draft.needsInput ?? [];
  if (!needsInput.some((n) => n.path === path)) {
    throw new Error(`"${path}" is not a current needs_input item for draft ${draftId}`);
  }

  // The structure answer goes to two places: spec.structure (via setAtPath
  // below, like any other path) AND the draft's own structure column, which
  // is what confirmDraft's gate actually checks.
  let structure: (typeof STRUCTURES)[number] | undefined;
  if (path === "structure") {
    if (!STRUCTURES.includes(value as any)) {
      throw new Error(`structure must be one of ${STRUCTURES.map((s) => `"${s}"`).join(", ")}, got ${JSON.stringify(value)}`);
    }
    structure = value as (typeof STRUCTURES)[number];
  }

  const spec = JSON.parse(JSON.stringify(draft.spec));
  setAtPath(spec, path, value);
  const remainingNeedsInput = needsInput.filter((n) => n.path !== path);

  return raw.transaction(() => {
    const existingAnswersRow = raw.prepare("SELECT answers_json FROM prompt_drafts WHERE draft_id = ?").get(draftId) as { answers_json: string | null };
    const answers = (existingAnswersRow.answers_json ? JSON.parse(existingAnswersRow.answers_json) : []) as { path: string; value: unknown }[];
    const nextAnswers = answers.filter((a) => a.path !== path).concat([{ path, value }]);
    raw.prepare("UPDATE prompt_drafts SET answers_json = ? WHERE draft_id = ?").run(JSON.stringify(nextAnswers), draftId);

    return updateDraft(raw, draftId, {
      specJson: JSON.stringify(spec),
      needsInputJson: JSON.stringify(remainingNeedsInput),
      ...(structure ? { structure } : {}),
    });
  })();
}
