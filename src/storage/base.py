from __future__ import annotations
from abc import ABC, abstractmethod
import pandas as pd

CANDIDATE_COLS = ["ticker", "candidate_class", "reject_reason", "conditions_met"]


class Store(ABC):
    """Candidates are returned as a frame with CANDIDATE_COLS, sorted by ticker, so backends are comparable."""

    @abstractmethod
    def get_prices_daily(self, ticker: str, start: str | None = None, end: str | None = None) -> pd.DataFrame:
        """[date, open, high, low, close, volume], ascending."""

    @abstractmethod
    def get_candidates(self, arm: str, signal_date: str) -> pd.DataFrame: ...

    @abstractmethod
    def get_trades(self, arm: str, signal_date: str) -> pd.DataFrame:
        """[ticker, stop_loss, exit_plan_price, confidence, r_pct, is_shadow, ret_pct_net_1w]"""

    @abstractmethod
    def get_watchlist(self, prompt_id: int) -> pd.DataFrame: ...

    @abstractmethod
    def save_run(self, arm: str, signal_date: str, candidates: pd.DataFrame, params: dict | None = None) -> None:
        """Write-once: refuses to overwrite an existing (arm, week) run, like track_forward.record()."""
