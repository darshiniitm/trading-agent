"""
Survivorship-bias disclosure (design doc §3.3, §9).

This does NOT correct the backtest -- it can't, with open-source data (see
below). What it does: pull NSE's official delisted-companies list, count how
many equities were delisted within the backtest's lookback window, and
empirically confirm whether yfinance actually has price history for them
(it doesn't, for the ones checked). That turns "there's probably survivorship
bias" into a concrete, sourced number the user can weigh.

    python scripts/survivorship_check.py [--years N] [--verify-samples N]
"""
from __future__ import annotations

import argparse
import io

import pandas as pd
import requests

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                     "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
DELISTED_URL = "https://archives.nseindia.com/content/equities/delisted.csv"


def fetch_delisted() -> pd.DataFrame:
    r = requests.get(DELISTED_URL, headers=UA, timeout=20)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    df = df[["Symbol", "Company", "Delisted Date", "Type of Delisting"]].dropna(subset=["Symbol"])
    df["Delisted Date"] = pd.to_datetime(df["Delisted Date"].str.strip(), format="%d-%b-%y", errors="coerce")
    df["Type of Delisting"] = df["Type of Delisting"].str.strip()
    return df


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=float, default=5.0, help="Lookback window to match the backtest history")
    ap.add_argument("--verify-samples", type=int, default=5, help="How many delisted symbols to actually try fetching via yfinance")
    args = ap.parse_args()

    df = fetch_delisted()
    cutoff = pd.Timestamp.now() - pd.Timedelta(days=args.years * 365.25)
    in_window = df[df["Delisted Date"] >= cutoff].sort_values("Delisted Date", ascending=False)
    archive_max_date = df["Delisted Date"].max()

    print(f"NSE delisted-companies archive: {len(df)} total records, "
          f"covering {df['Delisted Date'].min().date()} -> {archive_max_date.date()}")
    print(f"Delisted within last {args.years:.1f} years (matches backtest lookback): {len(in_window)}")

    if archive_max_date < cutoff:
        gap_years = (pd.Timestamp.now() - archive_max_date).days / 365.25
        print(f"\n*** THIS ARCHIVE IS STALE: its most recent record is from "
              f"{archive_max_date.date()}, {gap_years:.1f} years ago. It has NOT been updated to "
              f"cover the backtest's actual lookback window. The in-window count above is "
              f"meaningless as a survivorship estimate -- this source cannot tell us how many "
              f"names were delisted in the period that matters. This is itself a reportable "
              f"open-source data-quality gap (design doc §3.3): there is no reliable open-source, "
              f"point-in-time delisting feed for NSE. Only a paid vendor / broker API is likely to "
              f"have this current. ***")
    print("\nBy delisting type (in-window):")
    print(in_window["Type of Delisting"].value_counts().to_string())

    print(f"\nThese {len(in_window)} names are NOT in the current Nifty Midcap150 / Smallcap250 / "
          f"Nifty500 constituent lists this POC's universe is built from -- they were excluded from "
          f"every backtest fold, even for the weeks they were still listed and possibly in the "
          f"₹10-50k cr band. That is the survivorship-bias mechanism.")

    sample_source = in_window if not in_window.empty else df.sort_values("Delisted Date", ascending=False)
    if args.verify_samples > 0 and not sample_source.empty:
        import yfinance as yf
        sample = sample_source.head(args.verify_samples)
        note = "" if not in_window.empty else " (archive is stale -- sampling its most recent records regardless of window, just to test yfinance coverage of delisted names generally)"
        print(f"\nEmpirically checking yfinance coverage for {len(sample)} of them{note}:")
        for _, row in sample.iterrows():
            ticker = f"{row['Symbol']}.NS"
            try:
                d = yf.download(ticker, period="1y", interval="1wk", progress=False, auto_adjust=False)
                status = f"{len(d)} weekly bars found" if not d.empty else "NO DATA"
            except Exception as e:
                status = f"ERROR ({e})"
            print(f"  {ticker:<20} delisted {row['Delisted Date'].date()}  ({row['Type of Delisting']})  -> {status}")

    print("\nConclusion: the open-source adapter (yfinance) cannot supply price history for names "
          "no longer listed, so this survivorship gap cannot be closed within the open-source POC. "
          "The count above is a LOWER BOUND on the number of excluded names (it only counts formal "
          "NSE delistings, not names that merely rolled out of the index constituent lists via "
          "market-cap drift while remaining listed). Treat every backtest return in this POC as "
          "upward-biased by an unknown, unquantified amount until re-run on a paid feed with a true "
          "point-in-time, delisting-inclusive universe (design doc's data_source: paid swap).")


if __name__ == "__main__":
    main()
