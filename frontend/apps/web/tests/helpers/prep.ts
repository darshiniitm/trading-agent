import type { Db } from "@/server/db/pg";

// Test-only shim that keeps the old `raw.prepare(sql).run(...args)` shape of the SQLite-era tests on top of
// the async Postgres Db, so fixtures stay readable. Variadic params, like better-sqlite3; run() also reports
// lastInsertRowid (the first column of the last inserted row, which is the identity id in every table here).
//
// SQLite hands out max(rowid)+1 even after a row was inserted with an explicit id; a Postgres identity sequence
// does not, so after an INSERT that names an identity column the sequence is moved past the largest id.
export function prep(db: Db, sql: string) {
  let text = sql.trim().replace(/;$/, "");
  const insert = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/i.exec(text);
  if (/^INSERT\s+OR\s+IGNORE/i.test(text)) text = text.replace(/INSERT\s+OR\s+IGNORE/i, "INSERT") + " ON CONFLICT DO NOTHING";
  const returning = !!insert && !/\bRETURNING\b/i.test(text);

  async function resyncSequences() {
    if (!insert) return;
    const cols = insert[2].split(",").map((c) => c.trim());
    const identity = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'screener_app' AND table_name = ? AND is_identity = 'YES'", [insert[1]]);
    for (const { column_name } of identity) {
      if (!cols.includes(column_name)) continue;
      await db.query(`SELECT setval(pg_get_serial_sequence('screener_app.${insert[1]}', '${column_name}'), COALESCE(MAX(${column_name}), 0) + 1, false) FROM screener_app.${insert[1]}`);
    }
  }

  return {
    run: async (...params: unknown[]) => {
      if (!returning) return { changes: await db.run(text, params), lastInsertRowid: 0 };
      const { rows, rowCount } = await db.query(`${text} RETURNING *`, params);
      await resyncSequences();
      const last = rows[rows.length - 1];
      return { changes: rowCount, lastInsertRowid: last ? Number(Object.values(last)[0]) : 0 };
    },
    get: (...params: unknown[]) => db.get<any>(text, params),
    all: (...params: unknown[]) => db.all<any>(text, params),
  };
}
