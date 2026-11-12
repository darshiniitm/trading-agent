"""Universe providers (plan §4): nse_all, index (Nifty Indices CSV snapshots), list.

Index membership is point-in-time: a snapshot is a dated CSV (<slug>_<YYYY-MM-DD>.csv) and
the latest snapshot on or before as_of is used. Fetching is a separate, explicit step
(never done inside a screen or a test)."""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

INDEX_URLS = {
    "NIFTY 50": "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv",
    "NIFTY 100": "https://www.niftyindices.com/IndexConstituent/ind_nifty100list.csv",
    "NIFTY 200": "https://www.niftyindices.com/IndexConstituent/ind_nifty200list.csv",
    "NIFTY 500": "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv",
    "NIFTY MIDCAP 150": "https://www.niftyindices.com/IndexConstituent/ind_niftymidcap150list.csv",
}


def _slug(index: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", index.lower()).strip("_")


class UniverseError(Exception):
    pass


def fetch_index_snapshot(index: str, dest_dir: str, on: pd.Timestamp | None = None) -> Path:
    """Network call — run deliberately, e.g. weekly. Saves <slug>_<date>.csv."""
    import urllib.request
    key = index.upper()
    if key not in INDEX_URLS:
        raise UniverseError(f"no known Nifty Indices list for {index!r}")
    d = Path(dest_dir); d.mkdir(parents=True, exist_ok=True)
    out = d / f"{_slug(index)}_{(on or pd.Timestamp.today()).date()}.csv"
    req = urllib.request.Request(INDEX_URLS[key], headers={"User-Agent": "Mozilla/5.0"})
    out.write_bytes(urllib.request.urlopen(req, timeout=30).read())
    return out


def load_index_snapshot(index: str, snapshot_dir: str, as_of: pd.Timestamp) -> tuple[list[str], str]:
    files = []
    for f in Path(snapshot_dir).glob(f"{_slug(index)}_*.csv"):
        m = re.search(r"_(\d{4}-\d{2}-\d{2})\.csv$", f.name)
        if m and pd.Timestamp(m.group(1)) <= pd.Timestamp(as_of):
            files.append((m.group(1), f))
    if not files:
        raise UniverseError(f"no snapshot of {index!r} on or before {pd.Timestamp(as_of).date()} in {snapshot_dir}")
    date, f = max(files)
    df = pd.read_csv(f)
    col = next((c for c in df.columns if c.strip().lower() == "symbol"), None)
    if col is None:
        raise UniverseError(f"{f.name} has no Symbol column")
    return [f"{s.strip()}.NS" for s in df[col].dropna()], date


def approx_mcap(ctx, as_of: pd.Timestamp) -> pd.Series:
    """shares_outstanding x latest daily close on/before as_of, per ticker (inputs to the rule-based approximation)."""
    out = {}
    for t, daily in (ctx.daily_panels or {}).items():
        sh = (ctx.shares or {}).get(t)
        if not sh or daily is None or daily.empty:
            continue
        d = daily[pd.to_datetime(daily["date"]) <= pd.Timestamp(as_of)]
        c = d["close"].dropna()
        if len(c):
            out[t] = float(sh) * float(c.iloc[-1])
    return pd.Series(out, dtype=float)


def resolve_universe(universe: dict, universe_df: pd.DataFrame, as_of: pd.Timestamp,
                     snapshot_dir: str | None, resolver=None, mcap: pd.Series | None = None,
                     upload: dict | None = None) -> tuple[pd.DataFrame, dict]:
    """Returns (rows of universe_df in scope, meta). Tickers with no row in universe_df are
    reported as `missing`, not invented. Index universes go through the DataResolver chain
    (upload -> snapshot -> niftyindices -> older snapshot -> approximation); meta carries the
    provenance (source, quality, reason, chain_trace)."""
    src = universe["source"]
    if src == "nse_all":
        return universe_df, {"source": src}
    if src == "list":
        wanted = [s if "." in s else f"{s}.NS" for s in (universe.get("symbols") or [])]
        meta = {"source": src}
    else:
        if not snapshot_dir and resolver is None:
            raise UniverseError("index universe needs an index snapshot directory")
        from engine.resolution.types import DataRequest, DataType
        from engine.resolution.universe import build_universe_resolver
        resolver = resolver or build_universe_resolver(cache_dir=snapshot_dir, network=False)
        index = universe["index"]
        res = resolver.resolve(DataRequest(DataType.UNIVERSE, pd.Timestamp(as_of).date(), key=index,
                                           params={"mcap": mcap, **(upload or {})}))
        if res.missing:
            raise UniverseError(f"no snapshot of {index!r} on or before {pd.Timestamp(as_of).date()} and no fallback "
                                f"could build one (tried: {', '.join(res.chain_trace) or 'nothing'}); upload a CSV to proceed")
        wanted = list(res.value)
        meta = {"source": src, "index": index, "snapshot": res.meta.get("snapshot"), "quality": res.quality,
                "data_source": res.source, "as_of_data": str(res.as_of), "reason": res.reason,
                "chain_trace": res.chain_trace, **({"approximation": res.meta["rule"]} if "rule" in res.meta else {})}
    have = set(universe_df["ticker"])
    meta["missing"] = [t for t in wanted if t not in have]
    return universe_df[universe_df["ticker"].isin(wanted)].reset_index(drop=True), meta
