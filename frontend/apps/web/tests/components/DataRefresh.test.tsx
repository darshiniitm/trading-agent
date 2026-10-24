import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataRefresh } from "@/components/DataRefresh";
import { ageOf, barInProgress, barLabel, whenLabel } from "@/lib/dataRefresh";

const HOUR = 3_600_000;
const status = (o: any = {}) => ({ state: "idle", done: 0, total: 0, error: null, last_refreshed: { fetched_at: new Date(Date.now() - 2 * HOUR).toISOString(), latest_bar_date: "2026-10-12" }, ...o });

function api(opts: { role?: string | null; statuses?: any[]; postResult?: any; postStatus?: number } = {}) {
  const queue = [...(opts.statuses ?? [status()])];
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/auth/me") return { ok: true, status: 200, json: async () => ({ currentUser: opts.role === null ? null : { role: opts.role ?? "owner" } }) };
    if (url === "/api/data/refresh" && method === "POST") return { ok: (opts.postStatus ?? 200) < 400, status: opts.postStatus ?? 200, json: async () => opts.postResult ?? status({ state: "running", total: 100, started: true }) };
    if (url === "/api/data/refresh") return { ok: true, status: 200, json: async () => (queue.length > 1 ? queue.shift() : queue[0]) };
    throw new Error(`unexpected fetch ${method} ${url}`);
  }));
  return calls;
}
const renderIt = (onRefreshed?: () => void) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DataRefresh onRefreshed={onRefreshed} pollMs={25} /></QueryClientProvider>);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("wording helpers", () => {
  it("ages and flags data older than the engine's 12 h cache", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(ageOf("2026-10-15T11:30:00Z", now)).toMatchObject({ label: "30 min ago", stale: false });
    expect(ageOf("2026-10-15T09:00:00Z", now)).toMatchObject({ label: "3 h ago", stale: false });
    expect(ageOf("2026-10-14T20:00:00Z", now)).toMatchObject({ label: "16 h ago", stale: true });
    expect(ageOf("2026-10-10T12:00:00Z", now)).toMatchObject({ label: "5 days ago", stale: true });
    expect(ageOf(null, now)).toBeNull();
    expect(whenLabel(null)).toBe("never");
    expect(whenLabel("garbage")).toBe("unknown");
  });
  it("a Monday-dated weekly bar is in progress until the Friday has passed", () => {
    expect(barInProgress("2026-10-12", Date.parse("2026-10-15T12:00:00Z"))).toBe(true);
    expect(barInProgress("2026-10-12", Date.parse("2026-10-16T20:00:00Z"))).toBe(true);
    expect(barInProgress("2026-10-12", Date.parse("2026-10-17T06:00:00Z"))).toBe(false);
    expect(barInProgress("2026-10-05", Date.parse("2026-10-15T12:00:00Z"))).toBe(false);
    expect(barLabel("2026-10-12")).toBe("week of 12 Oct");
  });
});

describe("DataRefresh", () => {
  it("shows when the data was last refreshed and the latest bar, flagging a week in progress", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    api({ statuses: [status({ last_refreshed: { fetched_at: "2026-10-15T10:00:00Z", latest_bar_date: "2026-10-12" } })] });
    renderIt();
    const box = await screen.findByLabelText("data refresh");
    expect(box).toHaveTextContent("Market data refreshed");
    expect(box).toHaveTextContent("2 h ago");
    expect(box).toHaveTextContent("latest weekly bar: week of 12 Oct (week in progress)");
  });

  it("warns when the data is older than 12 hours", async () => {
    api({ statuses: [status({ last_refreshed: { fetched_at: new Date(Date.now() - 30 * HOUR).toISOString(), latest_bar_date: "2026-10-05" } })] });
    renderIt();
    expect(await screen.findByText(/older than 12 h/)).toBeInTheDocument();
  });

  it("the owner can refresh: POSTs once, shows progress, then says to run again", async () => {
    const onRefreshed = vi.fn();
    const calls = api({ statuses: [status(), status({ state: "running", done: 40, total: 100 }), status({ state: "done", done: 100, total: 100 })] });
    renderIt(onRefreshed);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh data" }));
    await waitFor(() => expect(calls.filter((c) => c === "POST /api/data/refresh")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(await screen.findByText(/Refreshing prices/)).toBeInTheDocument();
    expect(await screen.findByText("Data refreshed. Click Run again to screen on the new data.")).toBeInTheDocument();
    expect(onRefreshed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  });

  it("a finished refresh tells the user to run again and notifies the parent", async () => {
    const onRefreshed = vi.fn();
    api({ statuses: [status({ state: "running", done: 10, total: 100 }), status({ state: "done", done: 100, total: 100 })] });
    renderIt(onRefreshed);
    expect(await screen.findByText(/Refreshing prices · 10 of 100 \(10%\)/)).toBeInTheDocument();
    expect(await screen.findByText("Data refreshed. Click Run again to screen on the new data.")).toBeInTheDocument();
    expect(onRefreshed).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh shows the reason and keeps the button available", async () => {
    api({ statuses: [status({ state: "running", done: 5, total: 100 }), status({ state: "error", error: "only 3/100 tickers came back; the existing data was kept" })] });
    renderIt();
    expect(await screen.findByRole("alert")).toHaveTextContent("the existing data was kept");
    expect(screen.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  });

  it("non-owners see the time but no button", async () => {
    api({ role: "member" });
    renderIt();
    expect(await screen.findByText("Only the owner can refresh.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Refresh/ })).not.toBeInTheDocument();
  });

  it("a 403 on start is explained, not shown as a raw error", async () => {
    api({ postStatus: 403, postResult: { error: "owner only" } });
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner can refresh the data.");
  });

  it("renders nothing when the engine is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const { container } = renderIt();
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
