import type { Db } from "@/server/db/pg";

// Test-only shim that keeps the old `raw.prepare(sql).run(...args)` shape of the SQLite-era tests on top of
// the async Postgres Db, so fixtures stay readable. Variadic params, like better-sqlite3; run() also reports
// lastInsertRowid (the first column of the last inserted row, which is the identity id in every table here).
export function prep(db: Db, sql: string) {
  let text = sql.trim().replace(/;$/, "");
  const isInsert = /^INSERT\b/i.test(text);
  if (/^INSERT\s+OR\s+IGNORE/i.test(text)) text = text.replace(/INSERT\s+OR\s+IGNORE/i, "INSERT") + " ON CONFLICT DO NOTHING";
  const returning = isInsert && !/\bRETURNING\b/i.test(text);
  return {
    run: async (...params: unknown[]) => {
      if (!returning) return { changes: await db.run(text, params), lastInsertRowid: 0 };
      const { rows, rowCount } = await db.query(`${text} RETURNING *`, params);
      const last = rows[rows.length - 1];
      return { changes: rowCount, lastInsertRowid: last ? Number(Object.values(last)[0]) : 0 };
    },
    get: (...params: unknown[]) => db.get<any>(text, params),
    all: (...params: unknown[]) => db.all<any>(text, params),
  };
}
