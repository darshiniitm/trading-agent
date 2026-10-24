import type { Db } from "./pg";

/**
 * After rows are inserted with explicit ids (the SQLite data move, demo seeds), move every identity
 * sequence in screener_app past max(id) so the next default id cannot collide.
 */
export async function resetIdentitySequences(db: Db): Promise<void> {
  const cols = await db.all<{ table_name: string; column_name: string }>(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'screener_app' AND is_identity = 'YES'");
  for (const { table_name, column_name } of cols) {
    await db.query(
      `SELECT setval(pg_get_serial_sequence('screener_app.${table_name}', '${column_name}'), COALESCE(MAX(${column_name}), 0) + 1, false) FROM screener_app.${table_name}`);
  }
}
