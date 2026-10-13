import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// The Interpret view has its own tests; here it just reports a view upward, as it does after a compile.
let reportView: (v: any) => void = () => undefined;
let pushText: (t: string) => void = () => undefined;
vi.mock("@/components/InterpretationView", () => ({
  InterpretationView: (props: any) => {
    reportView = props.onViewChange; pushText = props.onPromptTextChange;
    return <div data-testid="interpretation" data-has-program={String(props.hasProgram)} data-prompt={props.promptText}>{props.addonsExtra}</div>;
  },
}));
import { DraftEditor } from "@/components/DraftEditor";

const READY = { ready: true, problems: [], clauses: [], chips: [], conditions: [], notEvaluable: [], normalised: "" };
const NO_RULES = { ...READY, ready: false, problems: ["no part of the prompt could be turned into a rule to screen on"] };

function stub(routes: Record<string, (init?: any) => any>) {
  const f = vi.fn(async (url: string, init?: any) => {
    const key = Object.keys(routes).find((k) => (init?.method ?? "GET") + " " + url === k);
    if (!key) throw new Error(`unexpected fetch ${(init?.method ?? "GET")} ${url}`);
    const r = routes[key](init);
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body ?? r };
  });
  vi.stubGlobal("fetch", f);
  return f;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); push.mockReset(); });

describe("DraftEditor (v5)", () => {
  it("creates a draft; saving needs only a read prompt — no answers, hypothesis or kill criterion", async () => {
    stub({ "POST /api/drafts": () => ({ body: { draft_id: 5 } }) });
    render(<DraftEditor />);
    await screen.findByTestId("interpretation");
    const confirm = screen.getByRole("button", { name: /Save and assign Prompt ID/ });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Read your prompt first");

    reportView(NO_RULES);
    await screen.findByText(/no part of the prompt could be turned into a rule/);
    expect(screen.getByRole("button", { name: /Save and assign Prompt ID/ })).toBeDisabled();
    reportView(READY);
    await waitFor(() => expect(screen.getByRole("button", { name: /Save and assign Prompt ID/ })).toBeEnabled());
    expect(screen.queryByText(/Add a hypothesis|Add a kill criterion|Still open/)).not.toBeInTheDocument();
  });

  it("saves hypothesis and kill criterion first, then confirms on the engine's latest bar date, then opens the watchlist", async () => {
    const calls: string[] = [];
    stub({
      "POST /api/drafts": () => ({ body: { draft_id: 5 } }),
      "PATCH /api/drafts/5": (init) => { calls.push("save:" + init.body); return { body: {} }; },
      "GET /api/health": () => ({ body: { last_bar_date: "2026-10-05" } }),
      "POST /api/drafts/5/confirm": (init) => { calls.push("confirm:" + init.body); return { status: 201, body: { prompt_id: 9, watchlist_id: 4, selection_warning: null } }; },
    });
    render(<DraftEditor />);
    await screen.findByTestId("interpretation");
    reportView(READY);
    fireEvent.change(screen.getByLabelText("hypothesis"), { target: { value: "mid-caps in an uptrend" } });
    fireEvent.change(screen.getByLabelText("kill criterion"), { target: { value: "negative after 13 weeks" } });
    fireEvent.click(await screen.findByRole("button", { name: /Save and assign Prompt ID/ }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/watchlists/4"));
    expect(calls).toEqual([
      'save:{"hypothesis":"mid-caps in an uptrend","killCriterion":"negative after 13 weeks"}',
      'confirm:{"as_of":"2026-10-05"}',
    ]);
  });

  it("does not confirm on top of a save that failed, and shows the server's reason", async () => {
    const f = stub({
      "POST /api/drafts": () => ({ body: { draft_id: 5 } }),
      "PATCH /api/drafts/5": () => ({ ok: false, status: 400, body: { error: "prompt_text must be 2000 characters or fewer" } }),
    });
    render(<DraftEditor />);
    await screen.findByTestId("interpretation");
    reportView(READY);
    fireEvent.change(screen.getByLabelText("hypothesis"), { target: { value: "h" } });
    fireEvent.change(screen.getByLabelText("kill criterion"), { target: { value: "k" } });
    fireEvent.click(await screen.findByRole("button", { name: /Save and assign Prompt ID/ }));
    expect(await screen.findByText(/Could not save the draft: prompt_text must be 2000/)).toBeInTheDocument();
    expect(f.mock.calls.some(([u]) => String(u).endsWith("/confirm"))).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a confirm failure (e.g. a duplicate prompt) instead of leaving the page", async () => {
    stub({
      "POST /api/drafts": () => ({ body: { draft_id: 5 } }),
      "PATCH /api/drafts/5": () => ({ body: {} }),
      "GET /api/health": () => ({ ok: false, status: 503, body: {} }),
      "POST /api/drafts/5/confirm": () => ({ ok: false, status: 409, body: { error: "you already have a confirmed prompt with these exact conditions (Prompt 3)" } }),
    });
    render(<DraftEditor />);
    await screen.findByTestId("interpretation");
    reportView(READY);
    fireEvent.change(screen.getByLabelText("hypothesis"), { target: { value: "h" } });
    fireEvent.change(screen.getByLabelText("kill criterion"), { target: { value: "k" } });
    fireEvent.click(await screen.findByRole("button", { name: /Save and assign Prompt ID/ }));
    expect(await screen.findByText(/already have a confirmed prompt.*Prompt 3/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("reopening a draft loads its prompt, hypothesis and kill criterion, and tells the view a program exists", async () => {
    stub({ "GET /api/drafts/8": () => ({ body: { draftId: 8, status: "open", promptText: "my prompt", hypothesis: "hh", killCriterion: "kk", program: { program_version: 5 } } }) });
    render(<DraftEditor initialDraftId={8} />);
    await screen.findByTestId("interpretation");
    expect(screen.getByLabelText("prompt text")).toHaveValue("my prompt");
    expect(screen.getByLabelText("hypothesis")).toHaveValue("hh");
    expect(screen.getByLabelText("kill criterion")).toHaveValue("kk");
    expect(screen.getByTestId("interpretation")).toHaveAttribute("data-has-program", "true");
  });

  it("says so when a draft is not open, and shows a load error plainly", async () => {
    stub({ "GET /api/drafts/8": () => ({ body: { draftId: 8, status: "confirmed", promptText: "", program: null } }) });
    render(<DraftEditor initialDraftId={8} />);
    expect(await screen.findByText(/This draft is confirmed/)).toBeInTheDocument();
    cleanup();
    stub({ "GET /api/drafts/9": () => ({ ok: false, status: 404, body: { error: "draft not found" } }) });
    render(<DraftEditor initialDraftId={9} />);
    expect(await screen.findByText("draft not found")).toBeInTheDocument();
  });

  it("shows the prompt text the server rewrote after a line edit (never a stale textarea)", async () => {
    stub({ "POST /api/drafts": () => ({ body: { draft_id: 5 } }) });
    render(<DraftEditor />);
    await screen.findByTestId("interpretation");
    const { act } = await import("@testing-library/react");
    act(() => pushText("Rank Nifty 200 by 12-month return (formula) excluding the most recent month"));
    expect(screen.getByLabelText("prompt text")).toHaveValue("Rank Nifty 200 by 12-month return (formula) excluding the most recent month");
  });
});
