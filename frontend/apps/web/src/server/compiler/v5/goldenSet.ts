// The golden / paraphrase set (plan §6): prompt -> the conditions it must compile to. One source for
// the unit tests (recognisers on, must be 100%) and for the model evaluation (recognisers off, pass
// rate recorded per candidate model — §8 decision 5).
import type { ScreenProgram } from "spec";

export type GoldenCase = { id: string; text: string; conditions: string[] };

export function canonicalConditions(p: ScreenProgram): string[] {
  return p.conditions.map((c) => {
    const o: any = c.lhs;
    const lhs = "field" in o ? o.field : `${o.ind}(${Object.entries(o.params).map(([k, v]) => `${k}=${v ?? "?"}`).join(",")})@${o.tf ?? "?"}`;
    const v = Array.isArray(c.value) ? c.value.map((x) => x ?? "?").join(",") : c.value ?? "";
    return [lhs, c.op ?? "?", String(v), c.dir ?? ""].filter((x) => x !== "").join(" ");
  });
}

const MC = "mcap_cr between 10000,50000";
const mk = (id: string, text: string, ...conditions: string[]): GoldenCase => ({ id, text, conditions });

export const GOLDEN: GoldenCase[] = [
  mk("mcap-1", "All stocks between 10K- 50K cr Market Cap", MC),
  mk("mcap-2", "all stocks with market cap between 10,000 and 50,000 crore", MC),
  mk("mcap-3", "All stocks Mcap 10K to 50K cr", MC),
  mk("mcap-4", "All stocks between 10k–50k Cr market cap", MC),
  mk("mcap-5", "All stocks between 10000 - 50000 crores market cap", MC),
  mk("mcap-6", "ALL STOCKS BETWEEN 10K TO 50K CR MARKET CAP", MC),
  mk("mcap-7", "All stocks   between   10K   and   50K   cr   Market   Cap", MC),
  mk("mcap-8", "stocks whose market cap is from 10,000 to 50,000 crore", MC),
  mk("mcap-below", "All stocks below  10K cr Market Cap", "mcap_cr < 10000"),
  mk("mcap-above", "All stocks above 20K cr market cap", "mcap_cr > 20000"),
  mk("rsi-1", "Weekly\nRSI Range 50 to 65", "rsi(length=?)@1W between 50,65"),
  mk("rsi-2", "Weekly\nRSI between 50 and 65", "rsi(length=?)@1W between 50,65"),
  mk("rsi-3", "Weekly\nRSI 50-65", "rsi(length=?)@1W between 50,65"),
  mk("rsi-4", "Weekly\nrsi range 50 to 65", "rsi(length=?)@1W between 50,65"),
  mk("rsi-5", "Weekly\nRSI(14) between 50 and 65", "rsi(length=14)@1W between 50,65"),
  mk("rsi-6", "Weekly\nRSI 14 between 50 and 65", "rsi(length=14)@1W between 50,65"),
  mk("rsi-7", "Weekly\nRSI(14) above 60", "rsi(length=14)@1W > 60"),
  mk("rsi-8", "Daily\nRSI(14) below 30", "rsi(length=14)@1D < 30"),
  mk("vstop-1", "Weekly\nflipped on VStop 10,2", "vstop(length=10,mult=2,source=?)@1W flip long"),
  mk("vstop-2", "Weekly\nflipped on VStop(10, 2)", "vstop(length=10,mult=2,source=?)@1W flip long"),
  mk("vstop-3", "Weekly\nVStop 10 2 flips long", "vstop(length=10,mult=2,source=?)@1W flip long"),
  mk("vstop-4", "Weekly\nstocks that turned long on V-Stop 10,2", "vstop(length=10,mult=2,source=?)@1W flip long"),
  mk("combo-1", "All stocks between 10K-50K cr\nWeekly\nflipped on VStop 10,2\nRSI Range 50 to 65", MC, "vstop(length=10,mult=2,source=?)@1W flip long", "rsi(length=?)@1W between 50,65"),
  mk("combo-2", "All stocks between 10K-50K cr\nWeekly\nRSI Range 50 to 65\nflipped on VStop 10,2", MC, "rsi(length=?)@1W between 50,65", "vstop(length=10,mult=2,source=?)@1W flip long"),
  mk("combo-3", "1. All stocks between 10K to 50K cr market cap\n2. Weekly timeframe: VStop 10,2 flipped and RSI 50 to 65", MC, "vstop(length=10,mult=2,source=?)@1W flip long", "rsi(length=?)@1W between 50,65"),
  mk("scope-1", "Monthly candles\nRSI 14 above 60", "rsi(length=14)@1M > 60"),
];
