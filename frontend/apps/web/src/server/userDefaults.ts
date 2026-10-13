import type Database from "better-sqlite3";

// Saved per-user defaults the interpreter uses to fill a slot the prompt did not state (priority 2 in
// docs/prompt-interpreter-spec.md §4). Stored in `user_defaults`; BUILTIN_DEFAULTS only seeds a user who has
// never saved any, so nothing in the resolver hard-codes them.
export type PriceSource = "open" | "high" | "low" | "close";
export type UserDefaults = {
  price_source: PriceSource;
  timeframe: "1D" | "1W" | "1M";
  evaluate_at: "friday_close";
  entry_recheck: "monday_open" | "friday_close";
  horizons_weeks: number[];
  universe: "nse_all";
};

export const BUILTIN_DEFAULTS: UserDefaults = {
  price_source: "close", timeframe: "1W", evaluate_at: "friday_close",
  entry_recheck: "monday_open", horizons_weeks: [1, 2, 3], universe: "nse_all",
};

export function getUserDefaults(raw: Database.Database, userId: number): UserDefaults {
  const row = raw.prepare("SELECT defaults_json FROM user_defaults WHERE user_id = ?").get(userId) as { defaults_json: string } | undefined;
  return { ...BUILTIN_DEFAULTS, ...(row ? JSON.parse(row.defaults_json) : {}) };
}

export function setUserDefaults(raw: Database.Database, userId: number, patch: Partial<UserDefaults>): UserDefaults {
  const next = validate({ ...getUserDefaults(raw, userId), ...patch });
  raw.prepare(`INSERT INTO user_defaults (user_id, defaults_json, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET defaults_json = excluded.defaults_json, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(next), new Date().toISOString());
  return next;
}

function validate(d: UserDefaults): UserDefaults {
  if (!["open", "high", "low", "close"].includes(d.price_source)) throw new Error("price_source must be open, high, low or close");
  if (!["1D", "1W", "1M"].includes(d.timeframe)) throw new Error("timeframe must be 1D, 1W or 1M");
  if (!["monday_open", "friday_close"].includes(d.entry_recheck)) throw new Error("entry_recheck must be monday_open or friday_close");
  if (!Array.isArray(d.horizons_weeks) || d.horizons_weeks.length === 0 || !d.horizons_weeks.every((h) => Number.isInteger(h) && h >= 1)) throw new Error("horizons_weeks must be whole weeks of at least 1");
  return d;
}
