import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QuestionRow, parseAnswer } from "@/components/QuestionRow";

describe("parseAnswer", () => {
  it.each([
    ["10", 10], [" 10 ", 10], ["2.5", 2.5], ["-1", -1], [".5", 0.5],
    ["0x10", "0x10"], ["1e3", "1e3"], ["close", "close"], [" close ", "close"], ["10abc", "10abc"], ["Infinity", "Infinity"],
  ])("%j -> %j", (input, expected) => {
    expect(parseAnswer(input)).toBe(expected);
  });
});

describe("QuestionRow", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubAnswerFetch() {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ spec: null, needs_input: [] }) });
    vi.stubGlobal("fetch", fetchFn);
    return fetchFn;
  }

  it("keeps Save disabled for a whitespace-only answer (never posts Number(\" \") === 0)", () => {
    stubAnswerFetch();
    render(<QuestionRow index={1} item={{ path: "conditions.0.params.length", question: "What length?" }} draftId={1} onAnswered={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("answer for conditions.0.params.length"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save answer" })).toBeDisabled();
  });

  it("posts a hex-looking answer as text, not as 16", async () => {
    const fetchFn = stubAnswerFetch();
    const onAnswered = vi.fn();
    render(<QuestionRow index={1} item={{ path: "conditions.0.params.length", question: "What length?" }} draftId={1} onAnswered={onAnswered} />);
    fireEvent.change(screen.getByLabelText("answer for conditions.0.params.length"), { target: { value: "0x10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
    expect(JSON.parse(fetchFn.mock.calls[0][1].body)).toEqual({ path: "conditions.0.params.length", value: "0x10" });
  });

  it("renders the structure question as a select with no pre-selected answer", () => {
    stubAnswerFetch();
    render(<QuestionRow index={1} item={{ path: "structure", question: "Which structure?" }} draftId={1} onAnswered={vi.fn()} />);
    expect(screen.getByLabelText("answer for structure")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save answer" })).toBeDisabled();
  });
});
