// Pulls the data behind the P6 watchlist views into the app DB: every open watchlist entry + benchmark (the weekly
// job's set) plus any extra symbols passed as args (e.g. the TradingView parity symbols). Needs the engine on ENGINE_BASE_URL.
//   npx tsx scripts/pull-view-metrics.ts [RELIANCE.NS AXISBANK.NS ...]
import { closeDb, db } from "@/server/db/client";
import { computeAllWatchlistMetrics, computeMetrics } from "@/server/viewData";

async function main() {
  const raw = db();
  const all = await computeAllWatchlistMetrics(raw);
  console.log(`watchlist set: ${all.symbols} symbols, failed: ${JSON.stringify(all.failed)}`);
  const extra = process.argv.slice(2);
  if (extra.length) {
    for (const tf of ["1D", "1W"] as const) {
      const r = await computeMetrics(raw, extra, { tf });
      console.log(`extra ${tf}: stored ${r.stored}, failed: ${JSON.stringify(r.failed)}`);
    }
  }
  console.log(await raw.all("SELECT timeframe, COUNT(*) n, MAX(as_of) latest FROM symbol_metrics GROUP BY timeframe"));
  console.log(await raw.get("SELECT COUNT(*) n, COUNT(*) FILTER (WHERE error IS NOT NULL) errors, MAX(as_of) latest FROM symbol_fundamentals"));
  await closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
