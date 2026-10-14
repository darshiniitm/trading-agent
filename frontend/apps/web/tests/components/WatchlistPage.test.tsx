import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("entry=2"),
  usePathname: () => "/watchlists/5",
}));
import WatchlistPage from "@/../app/watchlists/[watchlistId]/page";

const entry = (o: any) => ({ entryId: 1, symbol: "AAA.NS", name: "Aaa Ltd", sector: "Tech", membership: "full_match", status: "entered", entryPrice: 100, stop: 90, refPrice: null, condValues: { C1: 25000 }, failedIds: [], addedAsOf: "2026-10-02", entryDate: "2026-10-05", ...o });
const VIEW = (entries: any[]) => ({
  watchlistId: 5, promptId: 12, title: "Mid-cap momentum", promptText: "market cap 10000 to 50000", hasRiskCap: false, isOwner: true, ownerName: "Owner", visibility: "private", followers: 0, version: 1, parentPromptId: null,
  confirmedAt: "2026-09-26", hypothesis: "h", killCriterion: "k", entryAt: "friday_close", lastRun: { asOf: "2026-10-02", appliedSteps: [] }, whatRuns: [{ label: "Evaluated on completed weekly bar", on: true }],
  conditions: [{ condNo: 1, label: "Market cap (cr) · between 10000–50000", valueOrigin: "prompt" }], entries,
  validation: { gradedWeeks: 2, horizons: [], gradedAsOf: "2026-10-02", dueDates: { "1": "2026-10-09", "2": "2026-10-16", "3": "2026-10-23" }, controls: {} },
});

function mockApi(entries: any[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body: any =
      url.startsWith("/api/watchlists/5/entries/2/series") ? { symbol: "BBB.NS", bars: [{ close: 1 }, { close: 2 }] }
      : url.startsWith("/api/watchlists/5/entries/") ? { entryId: 2, userNote: null, events: [] }
      : url.startsWith("/api/watchlists/5") ? VIEW(entries)
      : url.startsWith("/api/quotes") ? Object.fromEntries(entries.map((e) => [e.symbol, { price: 110, asOf: "2026-10-02T09:15:00Z", error: null, chgPct: 1.5 }]))
      : url.startsWith("/api/series/closes") ? {}
      : url.startsWith("/api/health") ? { last_bar_date: "2026-10-02" } : {};
    return { ok: true, status: 200, json: async () => body };
  }));
}
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WatchlistPage params={{ watchlistId: "5" }} /></QueryClientProvider>);

afterEach(() => vi.unstubAllGlobals());

describe("Watchlist page", () => {
  it("renders the header, prompt, KPIs and rows; no near-miss UI for a prompt without near-miss rows", async () => {
    mockApi([entry({ entryId: 1 }), entry({ entryId: 2, symbol: "BBB.NS", name: "Bbb Ltd", status: "pending_selection", entryPrice: null, refPrice: 50 })]);
    renderPage();
    expect(await screen.findByRole("heading", { name: "Mid-cap momentum" })).toBeInTheDocument();
    expect(screen.getByText(/Shadow arm · graded vs Control/)).toBeInTheDocument();
    expect(screen.getByText(/market cap 10000 to 50000/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Near miss/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Shadow on watchlist")).not.toBeInTheDocument();
    expect(screen.getByText("Unevaluated")).toBeInTheDocument();
    expect(await screen.findByText(/Prices as of/)).toHaveTextContent("09:15");
    expect(screen.getByText("Avg since entry")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AAA\.NS/ })).toBeInTheDocument();
  });

  it("shows the near-miss tab and 'not graded' banner only when near-miss rows exist; hides Edit for a follower", async () => {
    const v = [entry({ entryId: 2, symbol: "BBB.NS", membership: "near_miss", status: "watching", entryPrice: null, refPrice: 50, failedIds: ["C1"] })];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.startsWith("/api/watchlists/5/entries/") ? { entryId: 2, userNote: null, events: [] } : url.startsWith("/api/watchlists/5") ? { ...VIEW(v), isOwner: false, ownerName: "User 2" } : url.startsWith("/api/quotes") ? {} : {}) })));
    renderPage();
    expect(await screen.findByRole("button", { name: /Near miss/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit as new version/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Owner: User 2/)).toBeInTheDocument();
    const aside = await screen.findByLabelText("Selected stock");
    expect(within(aside).getByText(/not counted in forward-test scoring/)).toBeInTheDocument();
    expect(screen.getByText("Shadow on watchlist")).toBeInTheDocument();
  });
});
