import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import EntryDetailPage from "@/../app/watchlists/[watchlistId]/entries/[entryId]/page";

describe("Entry detail page (/watchlists/:watchlistId/entries/:entryId)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the entry and renders its status, prices and event timeline", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        entryId: 11, symbol: "FULL1", membership: "full_match", status: "entered",
        entryPrice: 101, stop: 95, refPrice: null, userNote: null,
        events: [{ type: "status_changed", fromValue: "pending_selection", toValue: "entered", at: "2026-10-02T00:00:00.000Z" }],
      }),
    });
    vi.stubGlobal("fetch", fetchFn);
    render(<EntryDetailPage params={{ watchlistId: "3", entryId: "11" }} />);

    expect(await screen.findByRole("heading", { name: "FULL1" })).toBeInTheDocument();
    expect(fetchFn).toHaveBeenCalledWith("/api/watchlists/3/entries/11");
    expect(screen.getByText("entered")).toBeInTheDocument();
    expect(screen.getByText("101")).toBeInTheDocument();
    expect(screen.getByText(/Status changed: pending_selection → entered/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to watchlist/ })).toHaveAttribute("href", "/watchlists/3");
  });

  it("shows the API error when the entry doesn't exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "entry not found" }) }));
    render(<EntryDetailPage params={{ watchlistId: "3", entryId: "999" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("entry not found");
  });
});
