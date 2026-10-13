import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataHealthView } from "@/components/DataHealth";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const HEALTH = {
  last_success: [{ provider: "nse_bhavcopy", data_type: "OHLCV", last_ok_at: "2026-10-06T20:05:00" }, { provider: "yahoo", data_type: "OHLCV", last_ok_at: "2026-10-06T20:09:00" }],
  stale_symbols: 12, missing_symbols: 3,
  approximated_indices: [{ index_name: "NIFTY 100", last_used_at: "2026-10-07T09:00:00", rule: "top 100 by mcap" }],
  failures_by_provider: [{ provider: "yahoo", data_type: "OHLCV", reason: "no_data", n: 7 }],
  recent_gaps: [{ id: 2, logged_at: "2026-10-07T09:00:01", data_type: "OHLCV", symbol: "ABC.NS", provider: "yahoo", reason: "no_data", detail: "OSError: yahoo down" }],
  gap_count: 1,
};

describe("DataHealthView (spec §9.2)", () => {
  it("shows last successful fetch per provider, symbol counts, approximated indices and recent gaps", () => {
    render(<DataHealthView health={HEALTH} />);
    expect(screen.getByLabelText("last successful fetch")).toHaveTextContent("nse_bhavcopy");
    expect(screen.getByLabelText("last successful fetch")).toHaveTextContent("2026-10-06 20:05");
    expect(screen.getByText(/12 stale symbols/)).toBeInTheDocument();
    expect(screen.getByText(/3 missing symbols/)).toBeInTheDocument();
    expect(screen.getByLabelText("approximated indices")).toHaveTextContent("NIFTY 100");
    expect(screen.getByLabelText("failures by provider")).toHaveTextContent("yahoo");
    expect(screen.getByLabelText("failures by provider")).toHaveTextContent("7");
    expect(screen.getByLabelText("recent gaps")).toHaveTextContent("OSError: yahoo down");
  });

  it("says so when there is nothing to report", () => {
    render(<DataHealthView health={{ ...HEALTH, last_success: [], approximated_indices: [], failures_by_provider: [], recent_gaps: [], gap_count: 0, stale_symbols: 0, missing_symbols: 0 }} />);
    expect(screen.getByText(/no gaps logged/i)).toBeInTheDocument();
    expect(screen.getByText(/no successful fetch recorded yet/i)).toBeInTheDocument();
  });

  it("the prefetch button starts a prefetch and says it started", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ started: true }) });
    vi.stubGlobal("fetch", f);
    render(<DataHealthView health={HEALTH} />);
    fireEvent.click(screen.getByRole("button", { name: /run prefetch now/i }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/started/i));
    expect(f).toHaveBeenCalledWith("/api/data/prefetch", expect.objectContaining({ method: "POST" }));
  });

  it("shows an error if the prefetch could not be started", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "engine unreachable: boom" }) }));
    render(<DataHealthView health={HEALTH} />);
    fireEvent.click(screen.getByRole("button", { name: /run prefetch now/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/engine unreachable/);
  });
});
