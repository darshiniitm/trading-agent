import { RATING_ICON, type RatingLabel } from "@/lib/ratings";
import { fmtNum } from "@/lib/viewFormat";
import type { Cell, Col, ViewRow } from "../viewTypes";
import { dash, gate } from "./helpers";

const RATING_TIP = "Our implementation of the TradingView rating method; may differ slightly.";
// A rating is always text + chevron icon, never colour alone.
const rating = (id: string, label: string, label_of: (r: ViewRow) => string | null, value_of: (r: ViewRow) => number | null): Col => ({
  id, label, tooltip: RATING_TIP, align: "left",
  get: (r): Cell => {
    const g = gate(r); if (g) return g;
    const l = label_of(r) as RatingLabel | null;
    return l ? { text: l, icon: RATING_ICON[l], title: `${RATING_TIP} Score ${fmtNum(value_of(r), 2)}` } : dash();
  },
});
const ind = (id: "rsi" | "mom" | "ao" | "cci", label: string, tooltip: string): Col => ({
  id, label, tooltip, align: "right", get: (r) => gate(r) ?? (r.technicals[id] === null ? dash() : { text: fmtNum(r.technicals[id], 2) }),
});

export const technicalsColumns: Col[] = [
  rating("techRating", "Tech Rating", (r) => r.technicals.techLabel, (r) => r.technicals.techRating),
  rating("maRating", "MA Rating", (r) => r.technicals.maLabel, (r) => r.technicals.maRating),
  rating("osRating", "Os Rating", (r) => r.technicals.osLabel, (r) => r.technicals.osRating),
  ind("rsi", "RSI (14)", "Relative Strength Index, Wilder, 14 completed bars."),
  ind("mom", "Mom (10)", "Momentum: close − close 10 bars ago."),
  ind("ao", "AO", "Awesome Oscillator: SMA5(hl2) − SMA34(hl2)."),
  ind("cci", "CCI (20)", "Commodity Channel Index on typical price, 20 bars."),
];
