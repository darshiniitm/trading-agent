// End-to-end coverage of the compile → (answer) → confirm flow through the
// real DraftEditor, the real Next route handlers, the real services and a
// real (in-memory) SQLite DB. Only the two network edges are faked: the
// Claude call (callClaude) and the engine (any ENGINE_BASE_URL request).
// The individual tasks' narrow tests could not see the integration bugs
// this file pins (C1, I2, I5, I6, I1 in the final whole-branch review).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTestDb } from "@/server/db/test-db";
import { ensureOwnerUser } from "@/server/db/seed";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let raw = createTestDb();
vi.mock("@/server/db/client", () => ({ db: () => raw }));

const callClaude = vi.fn();
vi.mock("@/server/compiler/callModel", () => ({
  callClaude: (...args: unknown[]) => callClaude(...args),
  DEFAULT_COMPILER_MODEL: "test-model",
}));

import { DraftEditor } from "@/components/DraftEditor";
import { ENGINE_BASE_URL } from "@/server/engine/client";
import * as draftsRoute from "@/../app/api/drafts/route";
import * as draftRoute from "@/../app/api/drafts/[draftId]/route";
import * as compileRoute from "@/../app/api/drafts/[draftId]/compile/route";
import * as answersRoute from "@/../app/api/drafts/[draftId]/answers/route";
import * as confirmRoute from "@/../app/api/drafts/[draftId]/confirm/route";
import * as dryRunRoute from "@/../app/api/drafts/[draftId]/dry-run/route";
import * as healthRoute from "@/../app/api/health/route";

const CATALOG = [
  { kind: "field", name: "mcap_cr", required_params: [] },
  { kind: "field", name: "traded_value_cr", required_params: [{ name: "window" }] },
  { kind: "indicator", name: "vstop", required_params: [{ name: "length" }, { name: "mult" }, { name: "source" }] },
  { kind: "indicator", name: "rsi", required_params: [{ name: "length" }] },
];
const STRUCTURES = [{ structure: "literal" }, { structure: "t1_literal" }];
const EMPTY_SCREEN = { candidates: [], applied_steps: [], funnel: [], sector_view: [] };

function engineResponse(path: string): unknown {
  if (path === "/conditions") return CATALOG;
  if (path === "/structures") return STRUCTURES;
  if (path === "/health") return { status: "ok", last_bar_date: "2026-10-02" };
  return EMPTY_SCREEN;
}

// Dispatches the browser-side fetch("/api/...") calls to the real route
// handlers, and the server-side engine calls to engineResponse().
async function appFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (url.startsWith(ENGINE_BASE_URL)) {
    const body = engineResponse(new URL(url).pathname);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  const method = init.method ?? "GET";
  const req = new Request(`http://localhost${url}`, init);
  const m = /^\/api\/drafts\/(\d+)(?:\/([a-z-]+))?$/.exec(url);
  if (url === "/api/drafts" && method === "POST") return draftsRoute.POST();
  if (url === "/api/health") return healthRoute.GET();
  if (m) {
    const params = { draftId: m[1] };
    const sub = m[2];
    if (!sub && method === "GET") return draftRoute.GET(req, { params });
    if (!sub && method === "PATCH") return draftRoute.PATCH(req, { params });
    if (sub === "compile") return compileRoute.POST(req, { params });
    if (sub === "answers") return answersRoute.POST(req, { params });
    if (sub === "confirm") return confirmRoute.POST(req, { params });
    if (sub === "dry-run") return dryRunRoute.POST(req, { params });
  }
  throw new Error(`unexpected fetch ${method} ${url}`);
}

function modelReturns(output: unknown) {
  callClaude.mockResolvedValue(JSON.stringify(output));
}

async function compile(promptText: string) {
  render(<DraftEditor />);
  await screen.findByText(/Draft \d+/);
  fireEvent.change(screen.getByLabelText("prompt text"), { target: { value: promptText } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Read my prompt" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Read my prompt" }));
  await screen.findByText("How your prompt was read");
}

function fillHypothesisAndKill() {
  fireEvent.change(screen.getByLabelText("hypothesis"), { target: { value: "mid caps trend" } });
  fireEvent.change(screen.getByLabelText("kill criterion"), { target: { value: "negative after 13 weeks" } });
}

async function confirmAndWait() {
  const button = screen.getByRole("button", { name: /Confirm and assign Prompt ID/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/watchlists\/\d+$/)));
}

function confirmedPrompt() {
  const row = raw.prepare("SELECT prompt_id, structure, spec_json FROM prompts ORDER BY prompt_id DESC LIMIT 1").get() as any;
  const conditions = raw
    .prepare("SELECT cond_no, name, value_origin, source_phrase FROM prompt_conditions WHERE prompt_id = ? ORDER BY cond_no")
    .all(row.prompt_id) as any[];
  return { structure: row.structure, spec: JSON.parse(row.spec_json), conditions };
}

// The full-shape compile: everything beyond structure/conditions is set, so
// any of it being dropped on the way to the confirmed prompt is visible.
function fullLiteralOutput() {
  return {
    structure: "literal",
    conditions: [
      { id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 10, mult: 2, source: "close" }, op: "flip", value: null, dir: "long" },
      { id: "C2", role: "filter", kind: "indicator", name: "rsi", params: { length: 14 }, op: "between", value: [50, 65] },
    ],
    selection_point: { session_of_week: 1, at: "open" },
    stop: { from: "C1" }, risk_cap_pct: 15, near_miss: { max_failed: 1 }, t1_window: null,
    source_phrases: [
      { path: "structure", phrase: "weekly close" },
      { path: "conditions.0.params.length", phrase: "VStop 10" }, { path: "conditions.0.params.mult", phrase: "multiplier 2" },
      { path: "conditions.0.params.source", phrase: "on the close" },
      { path: "conditions.1.params.length", phrase: "RSI 14" }, { path: "conditions.1.value.0", phrase: "between 50" }, { path: "conditions.1.value.1", phrase: "and 65" },
      { path: "selection_point.session_of_week", phrase: "Monday" }, { path: "selection_point.at", phrase: "at the open" },
      { path: "risk_cap_pct", phrase: "risk under 15%" }, { path: "near_miss.max_failed", phrase: "one miss allowed" },
    ],
    needs_input: [], unsupported: [],
  };
}

describe("DraftEditor — compile → confirm, end to end", () => {
  beforeEach(() => {
    raw = createTestDb();
    ensureOwnerUser(raw);
    push.mockReset();
    callClaude.mockReset();
    vi.stubGlobal("fetch", vi.fn(appFetch));
    vi.stubGlobal("alert", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("compile → liquidity 'No' → confirm keeps every field the compiler found (selection point, stop, risk cap, near miss), not just structure/conditions", async () => {
    modelReturns(fullLiteralOutput());
    await compile("VStop(10,2) on the close flips up, RSI 14 between 50 and 65, Monday at the open, risk under 15%, one miss allowed");

    // The compile result is hydrated into the form exactly like a loaded draft.
    expect(screen.getByLabelText("structure")).toHaveValue("literal");
    expect(screen.getAllByLabelText("condition name").map((el) => (el as HTMLInputElement).value)).toEqual(["vstop", "rsi"]);
    expect(screen.getByLabelText("session of week")).toHaveValue(1);
    expect(screen.getByLabelText("selection at")).toHaveValue("open");
    expect(screen.getByLabelText("stop from")).toHaveValue("C1");
    expect(screen.getByLabelText("risk cap pct")).toHaveValue(15);
    expect(screen.getByLabelText("near miss max failed")).toHaveValue(1);
    // Liquidity is the app's own question (D3) — never answered by a compile.
    expect(screen.getByRole("button", { name: /Confirm and assign Prompt ID/ })).toBeDisabled();
    expect(screen.getByText("Answer the liquidity question")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/No liquidity filter/));
    fillHypothesisAndKill();
    await confirmAndWait();

    const { structure, spec, conditions } = confirmedPrompt();
    expect(structure).toBe("literal");
    expect(spec.selection_point).toEqual({ session_of_week: 1, at: "open" });
    expect(spec.stop).toEqual({ from: "C1" });
    expect(spec.risk_cap_pct).toBe(15);
    expect(spec.near_miss).toEqual({ max_failed: 1 });
    expect(spec.conditions.map((c: any) => c.id)).toEqual(["C1", "C2"]);
    expect(spec.conditions[0].params).toEqual({ length: 10, mult: 2, source: "close" });
    // A save that changed no traced value keeps provenance: both rows are
    // still 'prompt'-origin with their phrases.
    expect(conditions.map((c) => c.value_origin)).toEqual(["prompt", "prompt"]);
    expect(conditions[0].source_phrase).toContain("VStop 10");
  });

  it("compile → liquidity 'Yes ₹10cr' → confirm appends the liquidity filter under a fresh id (no duplicate C1) and the confirm succeeds", async () => {
    modelReturns(fullLiteralOutput());
    await compile("VStop(10,2) ...");

    fireEvent.click(screen.getByLabelText(/Yes, ₹10 cr\/week/));
    fillHypothesisAndKill();
    await confirmAndWait();

    const { spec, conditions } = confirmedPrompt();
    const ids = spec.conditions.map((c: any) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["C1", "C2", "C3"]);
    expect(spec.conditions[2]).toMatchObject({ name: "traded_value_cr", op: ">=", value: 10, params: { window: "1W" } });
    expect(conditions).toHaveLength(3);
    // The app-asked liquidity floor never claims to come from the prompt.
    expect(conditions[2].value_origin).toBe("user_answer");
  });

  it("compile → liquidity custom floor → confirm also gets a unique id", async () => {
    modelReturns({ ...fullLiteralOutput(), conditions: [fullLiteralOutput().conditions[0]], source_phrases: fullLiteralOutput().source_phrases.filter((p) => !p.path.startsWith("conditions.1")) });
    await compile("VStop(10,2) ...");
    fireEvent.click(screen.getByLabelText(/Yes, my own floor/));
    fireEvent.change(screen.getByLabelText("custom liquidity floor"), { target: { value: "25" } });
    fillHypothesisAndKill();
    await confirmAndWait();
    expect(confirmedPrompt().spec.conditions.map((c: any) => c.id)).toEqual(["C1", "C2"]);
    expect(confirmedPrompt().spec.conditions[1].value).toBe(25);
  });

  it("a t1_literal compile with a t1_window keeps the t1_window all the way into the confirmed prompt", async () => {
    modelReturns({
      structure: "t1_literal",
      conditions: [{ id: "C1", role: "event", kind: "indicator", name: "vstop", params: { length: 14, mult: 3, source: "close" }, op: "flip", value: null, dir: "long" }],
      selection_point: null, stop: { from: "C1" }, risk_cap_pct: null, near_miss: null,
      t1_window: { length_sessions: 3, offsets: [0, 1, 2] },
      source_phrases: [
        { path: "structure", phrase: "during the week" },
        { path: "conditions.0.params.length", phrase: "VStop 14" }, { path: "conditions.0.params.mult", phrase: "3" }, { path: "conditions.0.params.source", phrase: "close" },
        { path: "t1_window.length_sessions", phrase: "3-session window" },
        { path: "t1_window.offsets.0", phrase: "day 0" }, { path: "t1_window.offsets.1", phrase: "day 1" }, { path: "t1_window.offsets.2", phrase: "day 2" },
      ],
      needs_input: [], unsupported: [],
    });
    await compile("VStop(14,3) flips up any day in a 3-session window");

    expect(screen.getByLabelText("structure")).toHaveValue("t1_literal");
    expect(screen.getByLabelText("t1 window length sessions")).toHaveValue(3);
    expect(screen.getByLabelText("t1 window offsets")).toHaveValue("0, 1, 2");

    fireEvent.click(screen.getByLabelText(/No liquidity filter/));
    fillHypothesisAndKill();
    await confirmAndWait();

    const { structure, spec, conditions } = confirmedPrompt();
    expect(structure).toBe("t1_literal");
    expect(spec.t1_window).toEqual({ length_sessions: 3, offsets: [0, 1, 2] });
    expect(conditions[0].value_origin).toBe("prompt");
  });

  it("answering a needs_input question updates the condition row and the how-it-was-read table; the answered row confirms as 'user_answer'", async () => {
    const out = fullLiteralOutput();
    modelReturns({
      ...out,
      conditions: [{ ...out.conditions[0], params: { mult: 2, source: "close" } }, out.conditions[1]],
      source_phrases: out.source_phrases.filter((p) => p.path !== "conditions.0.params.length"),
      needs_input: [{ path: "conditions.0.params.length", question: "What VStop length?" }],
    });
    await compile("VStop flips up ...");

    const table = screen.getByRole("table");
    expect(within(table).queryByText("length=10")).not.toBeInTheDocument();
    expect(screen.getByText("Answer 1 question(s) first")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("answer for conditions.0.params.length"), { target: { value: " 10 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(screen.queryByText("Questions for you")).not.toBeInTheDocument());

    // The row shows the answered value (I6), and so does the table (stale-table minor).
    expect(screen.getAllByLabelText("params (JSON)")[0]).toHaveValue('{"mult":2,"source":"close","length":10}');
    expect(within(screen.getByRole("table")).getByText("length=10")).toBeInTheDocument();

    // An unrelated edit after the answer must not revert the answered value.
    fireEvent.change(screen.getAllByLabelText("value (JSON)")[0], { target: { value: "" } });

    fireEvent.click(screen.getByLabelText(/No liquidity filter/));
    fillHypothesisAndKill();
    await confirmAndWait();
    const { spec, conditions } = confirmedPrompt();
    expect(spec.conditions[0].params).toEqual({ mult: 2, source: "close", length: 10 });
    expect(conditions[0].value_origin).toBe("user_answer");
    expect(conditions[1].value_origin).toBe("prompt");
  });

  it("a null-structure compile keeps the conditions it found; answering the structure question unblocks confirm with those conditions intact", async () => {
    modelReturns({ ...fullLiteralOutput(), structure: null, source_phrases: fullLiteralOutput().source_phrases.filter((p) => p.path !== "structure") });
    await compile("VStop(10,2) ...");

    expect(screen.getByText("unclear")).toBeInTheDocument();
    expect(screen.getByLabelText("structure")).toHaveValue("");
    expect(screen.getAllByLabelText("condition name")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("answer for structure"), { target: { value: "literal" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(screen.getByLabelText("structure")).toHaveValue("literal"));

    fireEvent.click(screen.getByLabelText(/No liquidity filter/));
    fillHypothesisAndKill();
    await confirmAndWait();
    const { structure, spec } = confirmedPrompt();
    expect(structure).toBe("literal");
    expect(spec.structure).toBe("literal");
    expect(spec.conditions.map((c: any) => c.name)).toEqual(["vstop", "rsi"]);
  });

  it("reopening a compiled draft with a pending question shows the question (and the unsupported block) and keeps confirm blocked", async () => {
    const out = fullLiteralOutput();
    modelReturns({
      ...out,
      conditions: [{ ...out.conditions[0], params: { mult: 2, source: "close" } }, out.conditions[1]],
      source_phrases: out.source_phrases.filter((p) => p.path !== "conditions.0.params.length"),
      needs_input: [{ path: "conditions.0.params.length", question: "What VStop length?" }],
      unsupported: [{ text: "MACD crossover", reason: "MACD is not in the catalog" }],
    });
    await compile("VStop flips up and MACD crosses");
    const draftId = Number(/Draft (\d+)/.exec(screen.getByRole("heading", { level: 1 }).textContent!)![1]);
    // Drop the mounted editor and open the same draft fresh ("Continue").
    cleanup();
    render(<DraftEditor initialDraftId={draftId} />);
    await screen.findByText(`Draft ${draftId} · not yet numbered`);

    expect(await screen.findByText("Questions for you")).toBeInTheDocument();
    expect(screen.getByLabelText("answer for conditions.0.params.length")).toHaveValue("");
    expect(screen.getByText(/MACD crossover/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm and assign Prompt ID/ })).toBeDisabled();
    // A compiler-written spec doesn't answer the liquidity question by omission.
    expect(screen.getByLabelText(/No liquidity filter/)).not.toBeChecked();
  });
});
