import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { DraftEditor } from "@/components/DraftEditor";

const SAVED_DRAFT = {
  draftId: 5, userId: 1, parentPromptId: 3, title: "v2", promptText: "", status: "open",
  structure: "literal",
  spec: {
    spec_version: 4, structure: "literal", timeframe: "1W",
    selection_point: { session_of_week: 1, at: "open" },
    conditions: [
      { id: "C1", role: "filter", kind: "field", name: "mcap_cr", params: {}, op: "between", value: [10000, 50000] },
      { id: "C2", role: "filter", kind: "field", name: "traded_value_cr", params: { window: "1W" }, op: ">=", value: 10 },
    ],
    stop: null, risk_cap_pct: null, near_miss: null,
  },
  hypothesis: "mid caps trend", killCriterion: "negative after 13 weeks",
};

type Route = { ok?: boolean; status?: number; body: unknown } | Error;

function routedFetch(routes: Record<string, Route>) {
  return vi.fn().mockImplementation(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch ${key}`);
    if (route instanceof Error) throw route;
    return { ok: route.ok ?? true, status: route.status ?? 200, json: async () => route.body };
  });
}

function callsTo(fetchFn: ReturnType<typeof vi.fn>, key: string) {
  return fetchFn.mock.calls.filter(([url, init]) => `${init?.method ?? "GET"} ${url}` === key);
}

describe("DraftEditor", () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal("alert", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a fresh draft on mount when no draft id is given (/drafts/new)", async () => {
    const fetchFn = routedFetch({ "POST /api/drafts": { body: { draft_id: 9 } } });
    vi.stubGlobal("fetch", fetchFn);
    render(<DraftEditor />);
    await screen.findByText(/Draft 9/);
    expect(callsTo(fetchFn, "POST /api/drafts")).toHaveLength(1);
  });

  it("loads an existing draft (edit-as-new-version / Continue) instead of creating one, and populates the form", async () => {
    const fetchFn = routedFetch({ "GET /api/drafts/5": { body: SAVED_DRAFT } });
    vi.stubGlobal("fetch", fetchFn);
    render(<DraftEditor initialDraftId={5} />);

    await screen.findByText(/Draft 5/);
    expect(callsTo(fetchFn, "POST /api/drafts")).toHaveLength(0);
    expect(screen.getByLabelText("hypothesis")).toHaveValue("mid caps trend");
    expect(screen.getByLabelText("kill criterion")).toHaveValue("negative after 13 weeks");
    expect(screen.getByLabelText("structure")).toHaveValue("literal");
    // The trailing liquidity filter comes back as the liquidity answer, not a free condition row.
    expect(screen.getAllByLabelText("condition name")).toHaveLength(1);
    expect(screen.getByLabelText("condition name")).toHaveValue("mcap_cr");
    expect(screen.getByLabelText(/Yes, ₹10 cr\/week/)).toBeChecked();
    expect(screen.getByLabelText("session of week")).toHaveValue(1);
  });

  it("shows an error instead of the form when the draft can't be loaded", async () => {
    vi.stubGlobal("fetch", routedFetch({ "GET /api/drafts/404": { ok: false, status: 404, body: { error: "draft not found" } } }));
    render(<DraftEditor initialDraftId={404} />);
    expect(await screen.findByText(/draft not found/)).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("button", { name: /Confirm and assign Prompt ID/ })).not.toBeInTheDocument();
  });

  it("confirms with the engine's last_bar_date as as_of, alerts the selection warning, then navigates", async () => {
    const fetchFn = routedFetch({
      "GET /api/drafts/5": { body: SAVED_DRAFT },
      "PATCH /api/drafts/5": { body: SAVED_DRAFT },
      "GET /api/health": { body: { status: "ok", last_bar_date: "2026-10-02" } },
      "POST /api/drafts/5/confirm": { status: 201, body: { prompt_id: 4, watchlist_id: 7, selection_warning: "prompt confirmed, but selection could not run yet: engine down" } },
    });
    vi.stubGlobal("fetch", fetchFn);
    render(<DraftEditor initialDraftId={5} />);
    await screen.findByText(/Draft 5/);

    fireEvent.click(screen.getByRole("button", { name: /Confirm and assign Prompt ID/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/watchlists/7"));

    const [[, confirmInit]] = callsTo(fetchFn, "POST /api/drafts/5/confirm");
    expect(JSON.parse(confirmInit.body)).toEqual({ as_of: "2026-10-02" });
    expect(window.alert).toHaveBeenCalledWith("prompt confirmed, but selection could not run yet: engine down");
  });

  it("does not alert when confirm returns no selection warning", async () => {
    vi.stubGlobal("fetch", routedFetch({
      "GET /api/drafts/5": { body: SAVED_DRAFT },
      "PATCH /api/drafts/5": { body: SAVED_DRAFT },
      "GET /api/health": { body: { status: "ok", last_bar_date: "2026-10-02" } },
      "POST /api/drafts/5/confirm": { status: 201, body: { prompt_id: 4, watchlist_id: 7, selection_warning: null } },
    }));
    render(<DraftEditor initialDraftId={5} />);
    await screen.findByText(/Draft 5/);
    fireEvent.click(screen.getByRole("button", { name: /Confirm and assign Prompt ID/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/watchlists/7"));
    expect(window.alert).not.toHaveBeenCalled();
  });

  it("falls back to today's date as as_of for a dry run when the health check fails", async () => {
    const fetchFn = routedFetch({
      "GET /api/drafts/5": { body: SAVED_DRAFT },
      "PATCH /api/drafts/5": { body: SAVED_DRAFT },
      "GET /api/health": new Error("network down"),
      "POST /api/drafts/5/dry-run": { body: { candidates: [] } },
    });
    vi.stubGlobal("fetch", fetchFn);
    render(<DraftEditor initialDraftId={5} />);
    await screen.findByText(/Draft 5/);

    fireEvent.click(screen.getByRole("button", { name: /Dry run/ }));
    await screen.findByText(/Dry run \(not recorded/);
    const [[, init]] = callsTo(fetchFn, "POST /api/drafts/5/dry-run");
    expect(JSON.parse(init.body)).toEqual({ as_of: new Date().toISOString().slice(0, 10) });
  });
});
