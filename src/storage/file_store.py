"""Wraps today's file layout (read-only for candidates/trades; prices from the daily parquet cache)."""
from __future__ import annotations
import json
from pathlib import Path
import pandas as pd
from .base import Store, CANDIDATE_COLS

ROOT = Path(__file__).resolve().parents[2]
_ARM_FILE = {"control": ("forward_test", "picks_{d}.json"), "T1": ("forward_test", "picks_{d}_t1.json"),
             "literal": ("literal_test", "picks_{d}.json")}


def _class(status: str, near: bool) -> str:
    s = (status or "").upper()
    if near or s.startswith("NEAR_MISS"):
        return "near_miss"
    if s.startswith("SHADOW") or s.startswith("T1_EXTRA"):
        return "shadow"
    return "selected" if s == "TRADE" else "rejected"


class FileStore(Store):
    def __init__(self, root: Path = ROOT):
        self.root = Path(root)

    def _rec(self, arm, signal_date):
        d, pat = _ARM_FILE[arm]
        p = self.root / "results" / d / pat.format(d=signal_date)
        return json.loads(p.read_text()), p

    def get_prices_daily(self, ticker, start=None, end=None):
        p = self.root / "data_cache" / "ohlcv" / "daily" / f"{ticker}.parquet"
        df = pd.read_parquet(p)[["date", "open", "high", "low", "close", "volume"]]
        if start:
            df = df[df["date"] >= start]
        if end:
            df = df[df["date"] <= end]
        return df.sort_values("date").reset_index(drop=True)

    def get_candidates(self, arm, signal_date):
        rec, _ = self._rec(arm, signal_date)
        rows = [{"ticker": p["ticker"], "candidate_class": _class(p.get("status"), near),
                 "reject_reason": None if _class(p.get("status"), near) == "selected" else p.get("status"),
                 "conditions_met": None}
                for lst, near in (("picks", False), ("near_miss", True)) for p in rec.get(lst, [])]
        return pd.DataFrame(rows, columns=CANDIDATE_COLS).sort_values("ticker").reset_index(drop=True)

    def get_trades(self, arm, signal_date):
        rec, _ = self._rec(arm, signal_date)
        g = {x["ticker"]: x for x in (rec.get("graded") or {}).get("detail", [])}
        rows = [{"ticker": p["ticker"], "stop_loss": p.get("vstop_line_SL", p.get("SL")),
                 "exit_plan_price": p.get("target_ref", p.get("target")), "confidence": p.get("confidence"),
                 "r_pct": p.get("R_pct_of_close"), "is_shadow": _class(p.get("status"), False) != "selected",
                 "ret_pct_net_1w": g.get(p["ticker"], {}).get("ret_pct_net")} for p in rec.get("picks", [])]
        return pd.DataFrame(rows).sort_values("ticker").reset_index(drop=True)

    def get_watchlist(self, prompt_id):
        raise NotImplementedError("watchlists exist only in Postgres (screener_app.watchlists)")

    def save_run(self, arm, signal_date, candidates, params=None):
        raise NotImplementedError("file writes stay in tests/track_*.py record(); dual-write is Postgres-side")
