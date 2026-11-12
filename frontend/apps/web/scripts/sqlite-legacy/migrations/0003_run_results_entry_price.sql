-- apps/web/src/server/db/migrations/0003_run_results_entry_price.sql
PRAGMA foreign_keys = ON;

-- N1 fix: validatePrior needs the RESOLVED entry price for a graded pick,
-- sourced from run_results (one immutable row per (run_id, symbol)) rather
-- than from watchlist_entries, whose rows are frozen per-watchlist once
-- status reaches 'entered'/'not_confirmed' and so cannot reliably reflect a
-- later re-entry of the same symbol. `ep` stays the screen-time draft value
-- (Friday close); `entry_price` is the real selection-point fill, written by
-- selectEntry.ts alongside entry_status. `sl` is unaffected and already
-- holds the correct resolved stop for a graded pick.
ALTER TABLE run_results ADD COLUMN entry_price REAL;
