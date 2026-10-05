import type Database from "better-sqlite3";
import { getDraft } from "@/server/drafts";
import { screen } from "@/server/engine/client";

export async function dryRunDraft(raw: Database.Database, draftId: number, asOf: string, fetchFn?: typeof fetch) {
  const draft = getDraft(raw, draftId);
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (!draft.spec) throw new Error("draft has no spec yet");
  return screen(draft.spec, asOf, fetchFn);
}
