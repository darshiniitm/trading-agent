import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const nav = vi.hoisted(() => ({ search: "entry=1" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/watchlists/5",
}));
import WatchlistPage from "@/../app/watchlists/[watchlistId]/page";
import axe from "axe-core";
import { buildViewCsv } from "@/lib/viewCsv";
import { COLUMNS } from "@/components/watchlist/columns";

const userEvent = { click: async (el: Element) => { fireEvent.click(el); } };
const row = (o: any = {}) => ({
  symbol: "AAA.NS", kind: "stock", name: "Aaa Ltd", computing: false, entryId: 1, status: "entered", membership: "full_match",
  price: { last: 1000, chg: 12.5, chgPct: 1.27, volume: 5_200_000, avgVol10: 4_100_000, marketCap: 10.56e12, currency: "INR", unit: null },
  financials: { revenue: 9.9e12, eps: 55.5, pe: 18.02, beta: 0.93, dividend: 10, yield: 1.0 },
  performance: { w1: 1.5, m1: -2.25, m3: 3, ytd: 4, y1: 5, y5: null, all: 900, firstCloseDate: "2002-07-01" },
  risk: { beta1y: 0.93, beta3y: 1.1, beta5y: 1.05, benchmark: "^NSEI", vol1d: 0.88, vol1w: 1.61, vol1m: 1.12 },
  technicals: { timeframe: "1D", rsi: 61.2, mom: 12, ao: 3.5, cci: 80, techRating: 0.6, maRating: 0.8, osRating: 0.05, techLabel: "Strong buy", maLabel: "Strong buy", osLabel: "Neutral", votes: null },
  ...o,
});
const bench = row({ symbol: "^NSEI", kind: "index", name: "NIFTY 50", entryId: undefined, status: undefined, membership: undefined,
  price: { last: 25000, chg: 125, chgPct: 0.5, volume: null, avgVol10: null, marketCap: null, currency: null, unit: "POINT" },
  financials: { revenue: null, eps: null, pe: null, beta: null, dividend: null, yield: null } });
const dropped = row({ symbol: "ZZZ.NS", name: "Zzz Ltd", entryId: 9, status: "dropped_from_screen" });
const VIEWS = (o: any = {}) => ({
  tf: "1D", missingSymbols: [], fx: { inrPerUsd: 80, usdPerInr: 0.0125, asOf: "2026-10-15T09:30:00Z" },
  asOf: { quotes: "2026-10-15T09:30:00Z", fundamentals: "2026-10-14", metrics: "2026-10-14", fx: "2026-10-15T09:30:00Z" },
  prefs: { view: "screen", hiddenColumns: {}, currency: "INR", techTimeframe: "1D", compact: false },
  sections: [
    { id: "benchmarks", label: "Benchmarks", rows: [bench], collapsedByDefault: false, pinned: true },
    { id: "picks", label: "Arm picks", rows: [row()], collapsedByDefault: false },
    { id: "dropped", label: "Dropped", rows: [dropped], collapsedByDefault: true },
  ],
  ...o,
});
const WATCHLIST = {
  watchlistId: 5, promptId: 12, title: "Mid-cap momentum", promptText: "p", hasRiskCap: false, isOwner: true, ownerName: "Owner", visibility: "private", followers: 0, version: 1, parentPromptId: null,
  confirmedAt: "2026-09-26", hypothesis: "h", killCriterion: "k", entryAt: "friday_close", lastRun: { asOf: "2026-10-02", appliedSteps: [] }, whatRuns: [],
  conditions: [{ condNo: 1, label: "Market cap", valueOrigin: "prompt" }],
  entries: [{ entryId: 1, symbol: "AAA.NS", name: "Aaa Ltd", membership: "full_match", status: "entered", entryPrice: 100, stop: 90, refPrice: null, condValues: {}, failedIds: [], addedAsOf: "2026-10-02" }],
  validation: { gradedWeeks: 2, horizons: [], gradedAsOf: "2026-10-02", dueDates: {}, controls: {} },
};

let calls: { url: string; method: string }[] = [];
function mockApi(views: any = VIEWS()) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const body: any =
      url.startsWith("/api/watchlists/5/views") ? (url.includes("tf=1W") ? { ...views, tf: "1W" } : views)
      : url.startsWith("/api/watchlists/5/view-prefs") ? {}
      : url.startsWith("/api/watchlists/5/entries/") ? { entryId: 1, userNote: null, events: [] }
      : url.startsWith("/api/watchlists/5") ? WATCHLIST
      : url.startsWith("/api/quotes") ? { "AAA.NS": { price: 110, asOf: "2026-10-15T09:15:00Z", error: null, chgPct: 1.5 } }
      : url.startsWith("/api/series/history") ? { closes: [1, 2, 3] }
      : url.startsWith("/api/health") ? { last_bar_date: "2026-10-15" } : {};
    return { ok: true, status: 200, json: async () => body };
  }));
}
const renderPage = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><WatchlistPage params={{ watchlistId: "5" }} /></QueryClientProvider>);
const viewsCalls = () => calls.filter((c) => c.url.startsWith("/api/watchlists/5/views") && c.method === "GET");
const switcher = () => screen.getByRole("group", { name: "Watchlist view" });
const pick = async (label: string) => { await userEvent.click(within(switcher()).getByRole("button", { name: label })); };

beforeEach(() => { nav.search = "entry=1"; });
afterEach(() => vi.unstubAllGlobals());

describe("watchlist views", () => {
  it("defaults to Screen and shows the six view buttons", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    const sw = switcher();
    expect(within(sw).getAllByRole("button").map((b) => b.textContent)).toEqual(["Screen", "Price", "Financials", "Performance", "Risk", "Technicals"]);
    expect(within(sw).getByRole("button", { name: "Screen" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Watchlist stocks" })).toBeInTheDocument();
  });

  it("switching views makes no network call: one views fetch serves every tab", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await waitFor(() => expect(viewsCalls()).toHaveLength(1));
    for (const v of ["Price", "Financials", "Performance", "Risk", "Technicals", "Price"]) await pick(v);
    expect(viewsCalls()).toHaveLength(1);
    expect(calls.filter((c) => c.url.startsWith("/api/quotes"))).toHaveLength(1);
  });

  it("Price view lists sections in order with benchmarks pinned first and Dropped collapsed", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await pick("Price");
    const grid = await screen.findByRole("region", { name: "Watchlist price view" });
    const heads = within(grid).getAllByRole("button", { expanded: true }).concat(within(grid).getAllByRole("button", { expanded: false }));
    expect(within(grid).getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded")).map((b) => b.textContent!.replace(/[▾▸\d\s]/g, ""))).toEqual(["Benchmarks", "Armpicks", "Dropped"]);
    expect(heads.find((b) => /Dropped/.test(b.textContent!))).toHaveAttribute("aria-expanded", "false");
    expect(within(grid).queryByText("ZZZ.NS")).not.toBeInTheDocument();
    await userEvent.click(within(grid).getByRole("button", { name: /Dropped/ }));
    expect(within(grid).getByText("ZZZ.NS")).toBeInTheDocument();
    await userEvent.click(within(grid).getByRole("button", { name: /Benchmarks/ }));
    expect(within(grid).queryByText("^NSEI")).not.toBeInTheDocument();
    expect(within(grid).getAllByText("10.56 T INR").length).toBeGreaterThan(0);
  });

  it("benchmark rows carry no status chip", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await pick("Price");
    const grid = await screen.findByRole("region", { name: "Watchlist price view" });
    const benchRow = grid.querySelector('[data-row="bench:^NSEI"]') as HTMLElement;
    expect(benchRow).toBeTruthy();
    expect(within(benchRow).getByText("25,000.00 POINT")).toBeInTheDocument();
    expect(within(benchRow).queryByText(/entered|pending|watching/i)).not.toBeInTheDocument();
  });

  it("Financials: index rows show — with the tooltip 'Not applicable to an index'", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await pick("Financials");
    const grid = await screen.findByRole("region", { name: "Watchlist financials view" });
    const benchRow = grid.querySelector('[data-row="bench:^NSEI"]') as HTMLElement;
    const dashes = within(benchRow).getAllByTitle("Not applicable to an index");
    expect(dashes.length).toBeGreaterThanOrEqual(5);
    dashes.forEach((d) => expect(d).toHaveTextContent("—"));
  });

  it("Technicals: ratings render text plus an icon, and the timeframe toggle exists only here", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    expect(screen.queryByRole("group", { name: "Technicals timeframe" })).not.toBeInTheDocument();
    await pick("Technicals");
    const grid = await screen.findByRole("region", { name: "Watchlist technicals view" });
    const aaa = grid.querySelector('[data-row="entry:1"]') as HTMLElement;
    expect(within(aaa).getAllByText("Strong buy")).toHaveLength(2);   // Tech and MA ratings
    expect(aaa.textContent).toContain("⌃⌃");
    expect(within(aaa).getByText("Neutral").parentElement!.textContent).toContain("—");
    expect(screen.getByRole("group", { name: "Technicals timeframe" })).toBeInTheDocument();
    await pick("Price");
    expect(screen.queryByRole("group", { name: "Technicals timeframe" })).not.toBeInTheDocument();
  });

  it("the 1W technicals timeframe is the only thing that fetches again", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await pick("Technicals");
    await userEvent.click(within(screen.getByRole("group", { name: "Technicals timeframe" })).getByRole("button", { name: "1W" }));
    await waitFor(() => expect(viewsCalls().map((c) => c.url)).toEqual(["/api/watchlists/5/views?tf=1D", "/api/watchlists/5/views?tf=1W"]));
    await userEvent.click(within(screen.getByRole("group", { name: "Technicals timeframe" })).getByRole("button", { name: "1D" }));
    expect(viewsCalls()).toHaveLength(2);   // 1D is already cached
  });

  it("Currency in USD converts money columns only, instantly", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await pick("Price");
    const grid = await screen.findByRole("region", { name: "Watchlist price view" });
    const aaa = () => grid.querySelector('[data-row="entry:1"]') as HTMLElement;
    expect(within(aaa()).getByText("1,000.00 INR")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /Currency in USD/ }));
    expect(within(aaa()).getByText("12.50 USD")).toBeInTheDocument();
    expect(within(aaa()).getByText("132.00 B USD")).toBeInTheDocument();
    expect(within(aaa()).getByText("+1.27%")).toBeInTheDocument();                        // percentage unchanged
    expect(within(grid.querySelector('[data-row="bench:^NSEI"]') as HTMLElement).getByText("25,000.00 POINT")).toBeInTheDocument();
    expect(viewsCalls()).toHaveLength(1);
    expect(calls.some((c) => c.url.includes("view-prefs") && c.method === "PATCH")).toBe(true);
  });

  it("restores the saved view, currency and hidden columns from the per-user prefs", async () => {
    mockApi(VIEWS({ prefs: { view: "risk", hiddenColumns: { risk: ["beta5y"] }, currency: "USD", techTimeframe: "1D", compact: false } }));
    renderPage();
    const grid = await screen.findByRole("region", { name: "Watchlist risk view" });
    expect(within(grid).queryByText("Beta 5Y")).not.toBeInTheDocument();
    expect(within(grid).getByText("Beta 1Y")).toBeInTheDocument();
    expect(within(switcher()).getByRole("button", { name: "Risk" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("checkbox", { name: /Currency in USD/ })).toBeChecked();
  });

  it("← / → move between views", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    fireEvent.keyDown(within(switcher()).getByRole("button", { name: "Screen" }), { key: "ArrowRight" });
    expect(within(switcher()).getByRole("button", { name: "Price" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.keyDown(within(switcher()).getByRole("button", { name: "Price" }), { key: "ArrowLeft" });
    expect(within(switcher()).getByRole("button", { name: "Screen" })).toHaveAttribute("aria-pressed", "true");
  });

  it("the column picker hides and restores columns", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    expect(screen.queryByRole("button", { name: "Choose columns" })).not.toBeInTheDocument();   // not on Screen
    await pick("Performance");
    const grid = await screen.findByRole("region", { name: "Watchlist performance view" });
    expect(within(grid).getByText("Perf % 5Y")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    await userEvent.click(await screen.findByRole("checkbox", { name: "Perf % 5Y" }));
    expect(within(grid).queryByText("Perf % 5Y")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Symbol" })).not.toBeInTheDocument();
  });

  it("shows the as-of line for fundamentals and metrics under the prices bar", async () => {
    mockApi(); renderPage();
    expect(await screen.findByTestId("views-as-of")).toHaveTextContent(/Fundamentals as of 14 Oct · Metrics as of last close 14 Oct/);
  });

  it("selecting a benchmark opens the slim panel (chart + performance tiles, no entry or stop)", async () => {
    nav.search = "bench=^NSEI";
    mockApi(VIEWS({ prefs: { view: "price", hiddenColumns: {}, currency: "INR", techTimeframe: "1D", compact: false } }));
    renderPage();
    const aside = await screen.findByLabelText("Selected stock");
    expect(await within(aside).findByText("NIFTY 50")).toBeInTheDocument();
    expect(within(aside).getByLabelText("Performance")).toBeInTheDocument();
    expect(within(aside).queryByText(/entry|stop/i)).not.toBeInTheDocument();
  });

  it("'Refresh metrics' posts to the views route", async () => {
    mockApi(); renderPage();
    await screen.findByRole("heading", { name: "Mid-cap momentum" });
    await userEvent.click(screen.getByLabelText("More options"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Refresh metrics" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.startsWith("/api/watchlists/5/views"))).toBe(true));
  });
});

describe("accessibility (axe, structure only: jsdom has no layout, so contrast is checked in the browser pass)", () => {
  for (const v of ["Price", "Financials", "Performance", "Risk", "Technicals"]) {
    it(`${v} view has no serious or critical axe violations`, async () => {
      mockApi(); const { container } = renderPage();
      await screen.findByRole("heading", { name: "Mid-cap momentum" });
      await pick(v);
      await screen.findByRole("region", { name: `Watchlist ${v.toLowerCase()} view` });
      const res = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
      const bad = res.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
      expect(bad.map((x) => `${x.id}: ${x.nodes[0]?.target}`)).toEqual([]);
    });
  }
});

describe("view CSV", () => {
  const v = VIEWS();
  const cols = COLUMNS.price;
  it("exports the visible columns, a Section column and the as-of lines", () => {
    const csv = buildViewCsv({ view: "Price", sections: v.sections as any, cols: cols.filter((c) => c.id !== "chg"), ctx: { ccy: "INR", usdPerInr: 0.0125 }, asOf: v.asOf });
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^# View: Price · Prices as of 2026-10-15T09:30:00Z/);
    expect(lines[1]).toBe("# Fundamentals as of 14 Oct · Metrics as of last close 14 Oct");
    expect(lines[2]).toBe('"Section","Symbol","Name","Last","Chg %","Volume","Avg Vol (10)","Market cap"');
    expect(lines[3].startsWith('"Benchmarks","^NSEI","NIFTY 50"')).toBe(true);
    expect(lines.some((l) => l.startsWith('"Arm picks","AAA.NS"'))).toBe(true);
  });
  it("notes the currency basis when exporting in USD and honours the search filter", () => {
    const csv = buildViewCsv({ view: "Price", sections: v.sections as any, cols, ctx: { ccy: "USD", usdPerInr: 0.0125 }, query: "aaa", asOf: v.asOf });
    expect(csv).toMatch(/# Money columns in USD/);
    expect(csv).toContain('"12.50 USD"');
    expect(csv).not.toContain("^NSEI");
  });
});
