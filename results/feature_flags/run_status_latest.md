# Flag matrix status — 2026-09-21

mode: **late_backfill**  overall: **PASS**
eligible_count: 262

## Top 15 by flags_met

- AEGISVOPAK.NS: flags_met=8
- STARHEALTH.NS: flags_met=8
- IKS.NS: flags_met=8
- HFCL.NS: flags_met=7
- SHYAMMETL.NS: flags_met=7
- PNBHOUSING.NS: flags_met=7
- PFOCUS.NS: flags_met=7
- KPIL.NS: flags_met=7
- KIRLOSENG.NS: flags_met=7
- KARURVYSYA.NS: flags_met=7
- JSWDULUX.NS: flags_met=7
- IIFL.NS: flags_met=7
- LICHSGFIN.NS: flags_met=7
- HBLENGINE.NS: flags_met=7
- EMMVEE.NS: flags_met=7

## T4 picks

none (K not frozen for this registry version, or none qualified)

## Last graded week: none yet

maturity: TOO_EARLY (first record for this registry version)

## Caveats
- yfinance weekly bars / corporate-action adjustment not independently verified
- market cap uses TODAY's shares outstanding held constant across history (no point-in-time share count available from open-source sources) — see design doc section 3.2
- delisted / merged tickers are not included -> survivorship bias, backtest returns are likely biased upward
- sector map is NSE index-classification 'Industry' field as of the CSV snapshot date, not strictly point-in-time historically
