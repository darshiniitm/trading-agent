# Flag matrix status — 2026-09-07

mode: **late_backfill**  overall: **PASS**
eligible_count: 264

## Top 15 by flags_met

- JUBLPHARMA.NS: flags_met=11
- KPRMILL.NS: flags_met=10
- MRPL.NS: flags_met=9
- PINELABS.NS: flags_met=9
- PETRONET.NS: flags_met=9
- NIACL.NS: flags_met=9
- RAINBOW.NS: flags_met=9
- LICHSGFIN.NS: flags_met=9
- IIFL.NS: flags_met=9
- GRANULES.NS: flags_met=9
- GLAXO.NS: flags_met=9
- CONCOR.NS: flags_met=9
- KIRLOSENG.NS: flags_met=8
- WOCKPHARMA.NS: flags_met=8
- TATATECH.NS: flags_met=8

## T4 picks

none (K not frozen for this registry version, or none qualified)

## Last graded week: none yet

maturity: TOO_EARLY (first record for this registry version)

## Caveats
- yfinance weekly bars / corporate-action adjustment not independently verified
- market cap uses TODAY's shares outstanding held constant across history (no point-in-time share count available from open-source sources) — see design doc section 3.2
- delisted / merged tickers are not included -> survivorship bias, backtest returns are likely biased upward
- sector map is NSE index-classification 'Industry' field as of the CSV snapshot date, not strictly point-in-time historically
