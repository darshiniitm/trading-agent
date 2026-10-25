import { insertMany, type Db } from "./pg";
import { resetIdentitySequences } from "./sequences";

// One-off data move: the app's SQLite file (data/app.db at migration 0012) into screener_app on Postgres
// (docs/netlify-production-plan.md §4.3). Numeric ids are kept, everything happens in one transaction, and a target that already
// holds app data is refused. Used by scripts/migrate-sqlite-to-pg.ts; not imported by the running app.

type Sqlite = { prepare(sql: string): { all(...p: unknown[]): any[] } };

// Foreign-key order. symbols comes early because run_results / entries / metrics point at it.
const TABLES = [
  "users", "symbols", "prompt_drafts", "prompts", "prompt_conditions", "watchlists", "runs", "run_results", "watchlist_entries",
  "entry_events", "validations", "jobs", "compilations", "user_defaults", "interpreter_edit", "kb_alias_proposal", "interpreter_example",
  "run_condition_coverage", "run_provenance", "run_unevaluated", "symbol_fundamentals", "symbol_metrics", "user_benchmarks",
  "user_view_prefs", "signup_allowlist", "auth_events",
] as const;

// prompt_drafts and prompts point at each other (and prompts at itself): load these columns last, once every row exists.
const LATE_FKS: Record<string, string[]> = {
  prompt_drafts: ["parent_prompt_id", "confirmed_prompt_id", "copied_from_prompt_id"],
  prompts: ["parent_prompt_id", "copied_from_prompt_id"],
};
const KEYS: Record<string, string> = { prompt_drafts: "draft_id", prompts: "prompt_id" };

const REQUIRED_MIGRATION = "0012_watchlist_views.sql";

export type MoveReport = { rows: Record<string, number> };

export async function moveSqliteToPostgres(sqlite: Sqlite, pg: Db): Promise<MoveReport> {
  const applied = new Set(sqlite.prepare("SELECT filename FROM _migrations").all().map((r) => r.filename as string));
  if (!applied.has(REQUIRED_MIGRATION)) throw new Error(`the SQLite database is not at migration ${REQUIRED_MIGRATION}; start the old app once so it migrates, then retry`);

  for (const table of TABLES) {
    const where = table === "symbols" ? " WHERE kind = 'stock'" : "";   // the migration seeds the five index symbols itself
    const n = (await pg.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}${where}`))!.n;
    if (n > 0) throw new Error(`the target database is not empty (${table} has ${n} rows); the move only runs into a fresh schema`);
  }

  const rows: Record<string, number> = {};
  await pg.tx(async (t) => {
    const lateUpdates: { table: string; key: string; id: unknown; cols: string[]; values: unknown[] }[] = [];
    for (const table of TABLES) {
      try {
        const source = sqlite.prepare(`SELECT * FROM ${table}`).all();
        rows[table] = source.length;
        if (source.length === 0) continue;

        const pgCols = new Set((await t.all<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'screener_app' AND table_name = ?", [table])).map((c) => c.column_name));
        const cols = Object.keys(source[0]);
        const unknown = cols.filter((c) => !pgCols.has(c));
        if (unknown.length) throw new Error(`SQLite column(s) with no home in Postgres: ${unknown.join(", ")}`);

        const late = LATE_FKS[table] ?? [];
        await insertMany(t, table, cols, source.map((r) => cols.map((c) => (late.includes(c) ? null : r[c] ?? null))),
          table === "symbols" ? "ON CONFLICT DO NOTHING" : "");

        const key = KEYS[table];
        for (const r of source) {
          const set = late.filter((c) => r[c] !== null && r[c] !== undefined);
          if (key && set.length) lateUpdates.push({ table, key, id: r[key], cols: set, values: set.map((c) => r[c]) });
        }
      } catch (e) {
        throw new Error(`moving ${table}: ${(e as Error).message}`);
      }
    }
    for (const u of lateUpdates) {
      try { await t.run(`UPDATE ${u.table} SET ${u.cols.map((c) => `${c} = ?`).join(", ")} WHERE ${u.key} = ?`, [...u.values, u.id]); }
      catch (e) { throw new Error(`moving ${u.table} (${u.cols.join(", ")}): ${(e as Error).message}`); }
    }
    await resetIdentitySequences(t);

    for (const table of TABLES) {
      const total = (await t.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
      const seeded = table === "symbols" ? (await t.get<{ n: number }>("SELECT count(*) AS n FROM symbols WHERE kind = 'index'"))!.n : 0;
      // symbols: the source's own index rows collapse into the seeded ones, so only a shortfall is an error
      const mismatch = table === "symbols" ? total < Math.max(rows[table] ?? 0, seeded) : total !== (rows[table] ?? 0);
      if (mismatch) throw new Error(`row count differs for ${table}: SQLite ${rows[table]}, Postgres ${total}`);
    }
  });
  return { rows };
}
