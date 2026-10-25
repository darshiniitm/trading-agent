import type { Db } from "@/server/db/pg";

// What /api/health?deep=1 reports about this app instance (docs/netlify-production-plan.md §6.3 / go-live checklist):
// the database answers *and* the screener_app tables resolve for the connecting role, and what start-up learned about the
// LLM model. A missing model must not fail the cold start (every request would 500); it is reported here instead.
export type ModelCheck = { state: "unchecked" | "skipped" | "ok" | "unavailable"; detail?: string };
export type AppHealth = { ok: boolean; db: { ok: boolean; error?: string }; model: ModelCheck };

const KEY = Symbol.for("screener.app.modelCheck");
const g = globalThis as unknown as Record<symbol, ModelCheck | undefined>;

export function recordModelCheck(check: ModelCheck): void { g[KEY] = check; }
export function resetModelCheck(): void { g[KEY] = undefined; }

export async function appHealth(raw: Db): Promise<AppHealth> {
  let db: AppHealth["db"];
  try {
    const row = await raw.get<{ ok: boolean }>("SELECT to_regclass('screener_app.prompts') IS NOT NULL AND to_regclass('prompts') IS NOT NULL AS ok");
    // `prompts` only resolves unqualified when the role's search_path includes screener_app (migration 0011 sets it)
    db = row?.ok ? { ok: true } : { ok: false, error: "screener_app tables not found for this role (run db migrations / check search_path)" };
  } catch {
    db = { ok: false, error: "database unreachable" };   // the driver's message can carry hosts and credentials
  }
  const model = g[KEY] ?? { state: "unchecked" as const };
  return { ok: db.ok, db, model };
}
