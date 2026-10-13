import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { EngineStatus } from "@/lib/engineStatus";
import { InterpretationView, ruleLine } from "@/components/InterpretationView";

// The view reads the engine's state through react-query (as in the app, where app/providers.tsx supplies the client).
// These tests don't stub /api/engine/status, so that call fails and the state stays unknown — which must never block a run.
const render = (ui: ReactElement) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return rtlRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
};

const ADDONS = { liquidity: { enabled: false, cr: null, suggested_cr: 10 }, min_price: { enabled: false, price: null }, asm_gsm: { enabled: false, available: false, reason: "no ASM/GSM list in the data source yet" } };
const RSI_SLOT = { id: "C2", source_text: "RSI Range 50 to 65", operator: "between", value: [50, 65], evaluable: true, not_evaluable_reason: null,
  parameter: { name: "rsi", args: { length: 14 }, source: null, timeframe: "1W" }, trigger: { evaluate_at: "friday_close" } };
const MCAP_SLOT = { id: "C1", source_text: "10K-50K", operator: "between", value: [10000, 50000], evaluable: true, not_evaluable_reason: null,
  parameter: { name: "mcap_cr", args: {}, source: null, timeframe: null }, trigger: { evaluate_at: "latest_close" } };
const VIEW = {
  normalised: "x", problems: [], ready: true, addons: ADDONS,
  clauses: [
    { id: "L1", text: "All stocks below 10K cr Market Cap", status: "ok", maps_to: "C1: Market cap < 10,000 cr", questions: 0 },
    { id: "L2", text: "RSI Range 50 to 65", status: "ok", maps_to: "C2: RSI(?) between 50–65", questions: 0 },
    { id: "L3", text: "the moon is in the seventh house", status: "not_understood", maps_to: "could not be turned into a rule", questions: 0 },
  ],
  conditions: [MCAP_SLOT, RSI_SLOT],
  chips: [
    { path: "conditions.C2.params.length", label: "RSI length", value: 14, provenance: "assumed" },
    { path: "conditions.C2.tf", label: "RSI timeframe", value: "1W", provenance: "inferred", options: [{ label: "daily", value: "1D" }, { label: "weekly", value: "1W" }] },
  ],
  notEvaluable: [{ id: "L3", text: "the moon is in the seventh house", reason: "could not be turned into a rule" }],
};
const RESULT = { as_of: "2026-08-03", universe: { count: 2337 }, funnel: [{ stage: "universe", count: 2337 }, { stage: "S2", label: "qualified", count: 1 }],
  sets: {
    S1: { label: "mcap", from: "universe", count: 2, members: [
      { ticker: "ABC.NS", name: "Abc Ltd", sector: "Auto", conditions: { C1: { passed: true, value: 23456.789 } } },
      { ticker: "XYZ.NS", name: "Xyz Ltd", sector: "Auto", conditions: { C1: { passed: true, value: 10500 } } }] },
    S2: { label: "qualified", from: "S1", count: 1, members: [
      { ticker: "ABC.NS", name: "Abc Ltd", sector: "Auto", conditions: { C2: { passed: true, value: 57.4 }, C3: { passed: true, value: { uptrend: true, vstop_line: 87.28 }, event_date: "2026-10-05", direction: "long", stop_line: 87.28 } } }] },
  },
  actions: { A2: { type: "trade_plan", set: "S2", plans: [{ ticker: "ABC.NS", ep: 100, sl: 92, r_pct: 8, confidence: { score: 75 }, status: "ok" }] } } };

// each fetch is matched by URL so the order of the (auto) run calls does not matter
function stub(routes: Record<string, any>) {
  const f = vi.fn(async (url: string, init?: any) => {
    const r = routes[url];
    if (r === undefined) throw new Error(`unexpected fetch ${url}`);
    const x = typeof r === "function" ? r(init) : r;
    return { ok: x.ok ?? true, status: x.status ?? (x.ok === false ? 500 : 200), json: async () => x.body ?? x };
  });
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const TABLE = { conditions: ["C1", "C2"], rows: [
  { ticker: "SKIP.NS", name: "Skip Ltd", sector: "Auto", conditions: { C1: { passed: false, value: 5000 }, C2: { passed: true, value: 60 } }, selected: [] },
  { ticker: "HALF.NS", name: "Half Ltd", sector: "Auto", conditions: { C1: { passed: true, value: 12000 }, C2: { passed: false, value: 40 } }, selected: ["S1"] },
  { ticker: "ABC.NS", name: "Abc Ltd", sector: "Auto", conditions: { C1: { passed: true, value: 23456 }, C2: { passed: true, value: 57.4 } }, selected: ["S1", "S2"] },
] };
const BASE = { "/api/drafts/7": { body: {} }, "/api/health": { body: { last_bar_date: "2026-08-03" } } };

async function open(extra: Record<string, any> = {}) {
  const f = stub({ ...BASE, "/api/drafts/7/program": VIEW, "/api/drafts/7/program/screen": (init: any) => (JSON.parse(init.body).table ? { ...RESULT, table: TABLE } : RESULT), "/api/drafts/7/program/answer": VIEW, ...extra });
  render(<InterpretationView draftId={7} promptText="some prompt" />);
  fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
  await screen.findByLabelText("dry run result");
  return f;
}
const bodyOf = (f: any, url: string, n = 0) => JSON.parse(f.mock.calls.filter((c: any) => c[0] === url)[n][1].body);

describe("InterpretationView", () => {
  it("reads the prompt and runs the screen at once — no question, no unanswered counter, no confirm step", async () => {
    const f = await open();
    expect(bodyOf(f, "/api/drafts/7")).toEqual({ promptText: "some prompt" });
    expect(bodyOf(f, "/api/drafts/7/program/screen")).toEqual({ as_of: "2026-08-03" });
    expect(screen.queryByText(/Still open|unanswered|question/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).not.toBeInTheDocument();
    expect(screen.getByText(/qualified: 1/)).toBeInTheDocument();
  });

  it("quotes each prompt phrase next to its one-line rule and its assumed/inferred chips", async () => {
    await open();
    const row = screen.getByText(/RSI Range 50 to 65/).closest("tr")!;
    expect(within(row).getByText("RSI(14) · weekly · Friday close · between 50–65")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "change RSI length" })).toHaveTextContent("RSI length: 14 · assumed");
    expect(within(row).getByRole("button", { name: "change RSI timeframe" })).toHaveTextContent("RSI timeframe: weekly · inferred");
  });

  it("clicking a chip lets you change it; the change is posted and the screen re-runs", async () => {
    const f = await open();
    const row = screen.getByText(/RSI Range 50 to 65/).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "change RSI length" }));
    fireEvent.change(screen.getByLabelText("new value for RSI length"), { target: { value: " 21 " } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(f.mock.calls.filter((c) => c[0] === "/api/drafts/7/program/screen")).toHaveLength(2));
    expect(bodyOf(f, "/api/drafts/7/program/answer")).toEqual({ path: "conditions.C2.params.length", value: 21 });

    fireEvent.click(within(row).getByRole("button", { name: "change RSI timeframe" }));
    fireEvent.change(screen.getByLabelText("new value for RSI timeframe"), { target: { value: "0" } });
    await waitFor(() => expect(f.mock.calls.filter((c) => c[0] === "/api/drafts/7/program/answer")).toHaveLength(2));
    expect(bodyOf(f, "/api/drafts/7/program/answer", 1)).toEqual({ path: "conditions.C2.tf", value: "1D" });
  });

  it("lists each stock with every condition it was tested on: the rule, its actual value, and pass/fail — including the parent set's", async () => {
    await open();
    const s1 = within(screen.getByLabelText("S1 stocks"));
    expect(s1.getByText("C1: Market cap (cr) · between 10000–50000")).toBeInTheDocument();
    const abc = s1.getByText("ABC.NS").closest("tr")!;
    expect(abc).toHaveTextContent("23,457 ✓");
    expect(within(abc).getByText(/23,457/).closest("td")).toHaveAttribute("data-passed", "true");
    const s2 = within(screen.getByLabelText("S2 stocks"));
    expect(s2.getByText("C2: RSI(14) · weekly · Friday close · between 50–65")).toBeInTheDocument();
    const row = s2.getByText("ABC.NS").closest("tr")!;
    expect(row).toHaveTextContent("23,457 ✓");   // C1 from S1
    expect(row).toHaveTextContent("57.4 ✓");     // C2 from S2
    expect(row).toHaveTextContent("long · 2026-10-05 · stop 87.28 ✓");   // an event rule shows when, which way, and its stop
    expect(row).not.toHaveTextContent("[object Object]");
  });

  it("shows every stock as a primary list with each condition's value, and highlights the selected ones", async () => {
    const f = await open();
    const all = await screen.findByLabelText("all stocks table");
    expect(f.mock.calls.filter((c) => c[0] === "/api/drafts/7/program/screen").map((c) => JSON.parse(c[1].body).table)).toEqual([undefined, true]);
    expect(screen.getByText(/All stocks \(3\) · 1 selected · 1 more pass only the earlier filters/)).toBeInTheDocument();
    const rows = within(all).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("ABC.NS");                     // selected first
    expect(rows[0]).toHaveAttribute("data-selected", "true");
    expect(rows[0]).toHaveTextContent("23,456 ✓");
    expect(rows[0]).toHaveTextContent("S1, S2");                      // which sets selected it
    expect(rows[1]).toHaveAttribute("data-partial", "true");          // passed S1 only: lighter highlight, not "selected"
    expect(rows[1]).toHaveAttribute("data-selected", "false");
    expect(rows[2]).toHaveTextContent("5,000 ✗");                     // a stock that failed is still listed, with its value
    expect(within(all).getByText("C1: Market cap (cr) · between 10000–50000")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Only selected"));
    expect(within(all).queryByText("SKIP.NS")).not.toBeInTheDocument();
  });

  it("shows the quick result first and says so while the full list loads, and survives that load failing", async () => {
    stub({ ...BASE, "/api/drafts/7/program": VIEW, "/api/drafts/7/program/screen": (init: any) => (JSON.parse(init.body).table ? { ok: false, body: { error: "x" } } : RESULT) });
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
    await screen.findByLabelText("dry run result");
    expect(await screen.findByText(/Could not load the full list of stocks/)).toBeInTheDocument();
    expect(screen.getByLabelText("dry run result")).toBeInTheDocument();
  });

  it("greys out a part that could not be used, with its reason, and still shows the result", async () => {
    await open();
    expect(screen.getByText(/Not used: could not be turned into a rule/).closest("tr")).toHaveStyle({ opacity: "0.55" });
    expect(within(screen.getByLabelText("not used")).getByText(/not used: could not be turned into a rule/)).toBeInTheDocument();
  });

  it("keeps the add-ons in a separate section, all off, and posts a switch-on", async () => {
    const f = await open();
    const details = screen.getByText("Optional add-ons").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText(/All off/)).toBeInTheDocument();
    for (const box of within(details).getAllByRole("checkbox")) expect(box).not.toBeChecked();
    expect(within(details).getByText(/unavailable: no ASM\/GSM list/)).toBeInTheDocument();
    fireEvent.click(within(details).getByLabelText(/Liquidity floor/));
    await waitFor(() => expect(bodyOf(f, "/api/drafts/7/program/answer")).toEqual({ liquidity: { mode: "floor", cr: 10 } }));
  });

  it("edits a line inline", async () => {
    const f = await open();
    fireEvent.click(within(screen.getByText(/RSI Range 50 to 65/).closest("tr")!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("edit line L2"), { target: { value: "RSI Range 40 to 70" } });
    fireEvent.click(screen.getByRole("button", { name: "Save line" }));
    await waitFor(() => expect(bodyOf(f, "/api/drafts/7/program/answer")).toEqual({ edit: { clause_id: "L2", text: "RSI Range 40 to 70" } }));
  });

  it("after a line edit, hands the server's rewritten prompt text back so the textarea can't go stale", async () => {
    const onText = vi.fn();
    const f = stub({ ...BASE, "/api/drafts/7": { body: { promptText: "RSI Range 40 to 70 (edited)" } }, "/api/drafts/7/program": VIEW,
      "/api/drafts/7/program/screen": RESULT, "/api/drafts/7/program/answer": VIEW });
    render(<InterpretationView draftId={7} promptText="some prompt" onPromptTextChange={onText} />);
    fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
    await screen.findByLabelText("dry run result");
    fireEvent.click(within(screen.getByText(/RSI Range 50 to 65/).closest("tr")!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("edit line L2"), { target: { value: "RSI Range 40 to 70" } });
    fireEvent.click(screen.getByRole("button", { name: "Save line" }));
    await waitFor(() => expect(onText).toHaveBeenCalledWith("RSI Range 40 to 70 (edited)"));
    expect(f.mock.calls.some((c) => c[0] === "/api/drafts/7" && !c[1]?.method)).toBe(true);
  });

  it("when no line reads as a rule, explains why nothing ran instead of leaving the run column empty", async () => {
    const NONE = { ...VIEW, ready: false, problems: ["no part of the prompt could be turned into a rule to screen on"], conditions: [] };
    stub({ ...BASE, "/api/drafts/7/program": NONE });
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
    expect(await screen.findByText(/Nothing to run yet/)).toBeInTheDocument();
    expect(screen.queryByLabelText("universe data status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run again" })).toBeDisabled();
  });

  it("a numeric chip opens pre-filled, refuses non-numbers inline, and Apply re-runs the screen", async () => {
    const f = await open();
    fireEvent.click(screen.getByLabelText("change RSI length"));
    const input = screen.getByLabelText("new value for RSI length") as HTMLInputElement;
    expect(input.value).toBe("14");
    fireEvent.change(input, { target: { value: "c" } });
    expect(screen.getByLabelText("new value for RSI length")).toBe(input);   // the same element: typing never remounts the box
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a number");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "21" } });
    const screens = () => f.mock.calls.filter((c) => c[0] === "/api/drafts/7/program/screen" && c[1]?.body && !JSON.parse(c[1].body).table).length;
    const before = screens();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(bodyOf(f, "/api/drafts/7/program/answer")).toEqual({ path: "conditions.C2.params.length", value: 21 }));
    await waitFor(() => expect(screens()).toBe(before + 1));
  });

  it("reopening a draft that already has a program loads, shows and runs it without re-interpreting", async () => {
    const f = stub({ ...BASE, "/api/drafts/7/program": VIEW, "/api/drafts/7/program/screen": RESULT });
    const onView = vi.fn();
    render(<InterpretationView draftId={7} promptText="some prompt" hasProgram onViewChange={onView} />);
    await screen.findByLabelText("dry run result");
    expect(f.mock.calls.some((c) => c[0] === "/api/drafts/7" && c[1]?.method === "PATCH")).toBe(false);
    expect(onView).toHaveBeenCalledWith(expect.objectContaining({ ready: true }));
  });

  it("shows a plain error when the compile route fails", async () => {
    stub({ ...BASE, "/api/drafts/7/program": { ok: false, body: { error: "draft has no prompt text yet" } } });
    render(<InterpretationView draftId={7} promptText="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("draft has no prompt text yet");
  });

  it("does not run a program with no rule at all, and says why", async () => {
    const none = { ...VIEW, ready: false, problems: ["no part of the prompt could be turned into a rule to screen on"], chips: [] };
    const f = stub({ ...BASE, "/api/drafts/7/program": none });
    render(<InterpretationView draftId={7} promptText="x" />);
    fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));
    expect(await screen.findByText(/no part of the prompt could be turned into a rule/)).toBeInTheDocument();
    expect(f.mock.calls.some((c) => c[0] === "/api/drafts/7/program/screen")).toBe(false);
  });
});

describe("ruleLine", () => {
  it("renders the resolved slots on one line", () => {
    expect(ruleLine(RSI_SLOT)).toBe("RSI(14) · weekly · Friday close · between 50–65");
    expect(ruleLine({ ...RSI_SLOT, parameter: { name: "vstop", args: { length: 10, mult: 2 }, source: "close", timeframe: "1W" }, operator: "flips_long", value: null }))
      .toBe("VSTOP(10, 2, close) · weekly · Friday close · flips long");
    expect(ruleLine({ ...RSI_SLOT, parameter: { name: "mcap_cr", args: {}, source: null, timeframe: null }, operator: "<", value: 10000 })).toBe("Market cap (cr) · < 10000");
  });
});

// ---- data availability (docs/data-fallback-spec.md §6.2, §10.2) ----
const FEAS = { feasibility: {
  universe: { status: "approx", source: "rule_approx", detail: "top 100 by mcap", can_upload: true },
  conditions: { C1: { status: "ready", source: "cache", as_of: null, detail: null },
                C2: { status: "fallback", source: "nse_bhavcopy", as_of: "2026-08-03", detail: null } },
} };
const COVERAGE = { universe_size: 2337, fully_evaluated: 2000, coverage: 0.8558, per_condition: {}, universe_quality: "approx", unfeedable_conditions: ["C2"], status: "partial", scored: false };
const RESULT_WITH_COVERAGE = {
  ...RESULT, run_coverage: COVERAGE,
  sets: { ...RESULT.sets, S1: { ...RESULT.sets.S1, unevaluated: [{ ticker: "NEW.NS", name: "New Co", reasons: ["insufficient_history"], unknown_count: 1, met_count: 0 }] } },
};

describe("InterpretationView data availability", () => {
  it("shows a status chip next to each rule and for the universe, without blocking the run", async () => {
    await open({ "/api/drafts/7/program/feasibility": FEAS });
    const row = screen.getByText(/RSI Range 50 to 65/).closest("tr")!;
    await waitFor(() => expect(within(row).getByText("via fallback · nse_bhavcopy")).toHaveAttribute("data-feasibility", "fallback"));
    const first = screen.getByText(/All stocks below 10K cr/).closest("tr")!;
    expect(within(first).getByText("data ready")).toBeInTheDocument();
    expect(screen.getByLabelText("universe data status")).toHaveTextContent("approx universe · top 100 by mcap");
    expect(screen.getByLabelText(/upload a universe csv/i)).toBeInTheDocument();
  });

  it("asks the engine about the same week it screens", async () => {
    const f = await open({ "/api/drafts/7/program/feasibility": FEAS });
    await waitFor(() => expect(f.mock.calls.some((c: any) => c[0] === "/api/drafts/7/program/feasibility")).toBe(true));
    expect(bodyOf(f, "/api/drafts/7/program/feasibility")).toEqual({ as_of: "2026-08-03" });
  });

  it("a failing data check hides the chips and nothing else changes", async () => {
    await open();                                            // the stub throws on the unrouted feasibility URL
    expect(screen.getByLabelText("dry run result")).toBeInTheDocument();
    expect(screen.queryByText("data ready")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("universe data status")).not.toBeInTheDocument();
  });

  it("the run header shows the status badge, coverage, 'not applied' conditions and the unevaluated section", async () => {
    await open({ "/api/drafts/7/program/screen": (init: any) => (JSON.parse(init.body).table ? { ...RESULT_WITH_COVERAGE, table: TABLE } : RESULT_WITH_COVERAGE) });
    const header = screen.getByLabelText("run data status");
    expect(within(header).getByText("partial")).toHaveAttribute("data-run-status", "partial");
    expect(header).toHaveTextContent("86% of 2337 stocks fully evaluated");
    expect(header).toHaveTextContent(/not applied: no data source/);
    const un = screen.getByLabelText("unevaluated stocks");
    expect(un).toHaveTextContent("NEW.NS");
    expect(un).toHaveTextContent(/not enough price history/);
  });

  it("an engine without coverage shows neither header nor unevaluated section", async () => {
    await open();
    expect(screen.queryByLabelText("run data status")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("unevaluated stocks")).not.toBeInTheDocument();
  });

  it("uploading a universe re-runs the screen", async () => {
    const f = await open({ "/api/drafts/7/program/feasibility": FEAS, "/api/drafts/7/program/upload": { saved: "u.csv" } });
    await screen.findByLabelText(/upload a universe csv/i);
    const before = f.mock.calls.filter((c: any) => c[0] === "/api/drafts/7/program/screen").length;
    fireEvent.change(screen.getByLabelText(/upload a universe csv/i), { target: { files: [new File(["symbol\nAAA\n"], "u.csv")] } });
    await waitFor(() => expect(f.mock.calls.filter((c: any) => c[0] === "/api/drafts/7/program/screen").length).toBeGreaterThan(before));
  });
});

describe("all-stocks table tri-state", () => {
  const T3 = { conditions: ["C1", "C2"], rows: [
    { ticker: "UNK.NS", name: "Unk Ltd", sector: "Auto", met_count: 1, unknown_count: 1, selected: [],
      data: { source: "cache:yahoo", as_of: "2026-08-03", quality: "stale", reason: "stale_data" },
      conditions: { C1: { passed: true, value: 12000, state: 1 }, C2: { state: "?", reason: "insufficient_history" } } },
    { ticker: "ABC.NS", name: "Abc Ltd", sector: "Auto", met_count: 2, unknown_count: 0, selected: ["S1", "S2"],
      conditions: { C1: { passed: true, value: 23456, state: 1 }, C2: { passed: true, value: 57.4, state: 1 } } },
  ] };
  it("shows ? for an unknown condition with its reason on hover, and the source / as-of of a stock's price data", async () => {
    await open({ "/api/drafts/7/program/screen": (init: any) => (JSON.parse(init.body).table ? { ...RESULT, table: T3 } : RESULT) });
    const row = (await screen.findByText("UNK.NS")).closest("tr")!;
    const c2 = row.querySelector('td[data-condition="C2"]')!;
    expect(c2).toHaveTextContent("?");
    expect(c2).toHaveAttribute("data-state", "?");
    expect(c2.getAttribute("title")).toMatch(/not enough price history/);
    expect(row.querySelector("td")!.getAttribute("title")).toMatch(/cache:yahoo.*2026-08-03/);
    expect(within(row).getByText("1 met · 1 unknown")).toBeInTheDocument();
  });
});


describe("InterpretationView while the engine loads", () => {
  const PHASES = ["universe", "weekly_prices", "shares", "daily_bars", "reference_data"];
  const WARMING: EngineStatus = { state: "warming", phase: "weekly_prices", phaseIndex: 1, phases: PHASES, done: null, total: null, elapsedS: 5, phaseElapsedS: 1, error: null, retryable: false, managed: true };
  const READY: EngineStatus = { ...WARMING, state: "ready", phase: null, phaseIndex: null };
  type Engine = { now: EngineStatus };
  const routes = (engine: Engine, extra: Record<string, any> = {}) => ({
    ...BASE, "/api/engine/status": () => ({ body: engine.now }), "/api/drafts/7/program": VIEW, "/api/drafts/7/program/feasibility": { body: {} },
    // like the real engine: while it is loading, the screen answers 503 with its state
    "/api/drafts/7/program/screen": (init: any) => engine.now.state !== "ready"
      ? { ok: false, status: 503, body: { detail: { engine: { state: "warming", phase: engine.now.phase } } } }
      : (JSON.parse(init.body).table ? { ...RESULT, table: TABLE } : RESULT),
    ...extra,
  });
  const screenCalls = (f: any) => f.mock.calls.filter((c: any) => c[0] === "/api/drafts/7/program/screen").length;
  // let the first status poll land, so the view knows the engine's state before the user acts
  const statusKnown = (f: any) => waitFor(() => expect(f.mock.calls.some((c: any) => c[0] === "/api/engine/status")).toBe(true)).then(() => new Promise((r) => setTimeout(r, 60)));
  const run = () => fireEvent.click(screen.getByRole("button", { name: /Read my prompt and run it/ }));

  it("queues the run instead of failing, shows the loading panel, and runs by itself when the engine is ready", async () => {
    const engine: Engine = { now: WARMING };
    const f = stub(routes(engine));
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    await statusKnown(f);
    run();
    expect(await screen.findByText(/your run is queued and will start automatically/i)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /data engine status/i })).toBeInTheDocument();
    expect(screenCalls(f)).toBe(0);                                         // nothing was sent to the loading engine
    expect(screen.queryByText(/failed|Internal Server Error|could not run/i)).toBeNull();
    engine.now = READY;
    expect(await screen.findByLabelText("dry run result", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screenCalls(f)).toBeGreaterThan(0);
    expect(screen.queryByRole("status", { name: /data engine status/i })).toBeNull();   // the panel gives way to the results
  }, 15000);

  it("Cancel run drops the queued run: nothing is sent when the engine becomes ready", async () => {
    const engine: Engine = { now: WARMING };
    const f = stub(routes(engine));
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    await statusKnown(f);
    run();
    fireEvent.click(await screen.findByRole("button", { name: /cancel run/i }));
    engine.now = READY;
    await new Promise((r) => setTimeout(r, 2200));
    expect(screenCalls(f)).toBe(0);
    expect(screen.queryByLabelText("dry run result")).toBeNull();
  }, 15000);

  it("an engine that answers 503 'loading' although it was said to be ready is queued and retried, not shown as an error", async () => {
    const engine: Engine = { now: READY };
    let first = true;
    const f = stub(routes(engine, {
      "/api/drafts/7/program/screen": (init: any) => {
        if (JSON.parse(init.body).table) return { ...RESULT, table: TABLE };
        if (first) {                                                         // the engine restarted behind the app's back
          first = false; engine.now = WARMING; setTimeout(() => { engine.now = READY; }, 400);
          return { ok: false, status: 503, body: { detail: { engine: { state: "warming", phase: "shares" } } } };
        }
        return RESULT;
      },
    }));
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    await statusKnown(f);
    run();
    expect(await screen.findByLabelText("dry run result", {}, { timeout: 9000 })).toBeInTheDocument();
    expect(screen.queryByText(/Internal Server Error|engine failed|could not run/i)).toBeNull();
    expect(screenCalls(f)).toBeGreaterThanOrEqual(2);                        // asked again after the 503
  }, 20000);

  it("reopening a saved draft while the engine loads queues its run (the first status isn't known yet, so the 503 queues it) and runs it when ready", async () => {
    const engine: Engine = { now: WARMING };
    const f = stub(routes(engine));
    render(<InterpretationView draftId={7} promptText="some prompt" hasProgram />);
    expect(await screen.findByText(/your run is queued and will start automatically/i, {}, { timeout: 6000 })).toBeInTheDocument();
    engine.now = READY;
    expect(await screen.findByLabelText("dry run result", {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.queryByText(/Internal Server Error|engine failed|could not run/i)).toBeNull();
    void f;
  }, 20000);

  it("once the engine is ready but the screen is still computing, says it is running (never an empty page), then shows the results", async () => {
    const engine: Engine = { now: READY };
    let release: (v: unknown) => void = () => {};
    const slow = new Promise((r) => { release = r; });
    const f = stub(routes(engine, {
      "/api/drafts/7/program/screen": async (init: any) => {
        if (JSON.parse(init.body).table) return { ...RESULT, table: TABLE };
        await slow;                                                          // the first screen after a start takes ~30s
        return RESULT;
      },
    }));
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    await statusKnown(f);
    run();
    const panel = await screen.findByRole("status", { name: /running your screen/i });
    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(within(panel).getByText(/the data is ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/your run is queued|loading market data/i)).toBeNull();   // not the loading panel: the engine is ready
    expect(screen.queryByLabelText("dry run result")).toBeNull();
    release(null);
    expect(await screen.findByLabelText("dry run result")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /running your screen/i })).toBeNull();
  }, 15000);

  it("a re-run keeps the old results on screen and only notes that they are updating", async () => {
    const engine: Engine = { now: READY };
    let hold: Promise<unknown> | null = null, release: (v: unknown) => void = () => {};
    const f = stub(routes(engine, {
      "/api/drafts/7/program/screen": async (init: any) => {
        if (JSON.parse(init.body).table) return { ...RESULT, table: TABLE };
        if (hold) await hold;
        return RESULT;
      },
    }));
    render(<InterpretationView draftId={7} promptText="some prompt" />);
    await statusKnown(f);
    run();
    await screen.findByLabelText("dry run result");
    hold = new Promise((r) => { release = r; });
    fireEvent.click(screen.getByRole("button", { name: /run again/i }));
    expect(await screen.findByText(/updating results/i)).toBeInTheDocument();
    expect(screen.getByLabelText("dry run result")).toBeInTheDocument();     // the previous answer stays visible
    expect(screen.queryByRole("status", { name: /running your screen/i })).toBeNull();
    release(null);
    await waitFor(() => expect(screen.queryByText(/updating results/i)).toBeNull());
  }, 15000);
});
