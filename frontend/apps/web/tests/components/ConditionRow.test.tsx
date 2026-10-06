import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConditionRow } from "@/components/ConditionRow";

const EMPTY_CONDITION = { id: "C1", role: "filter" as const, kind: "field" as const, name: "", params: {}, op: "", value: null };

describe("ConditionRow", () => {
  it("renders every field empty — no pre-filled value anywhere", () => {
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/condition name/i)).toHaveValue("");
    expect(screen.getByLabelText(/operator/i)).toHaveValue("");
    expect(screen.getByLabelText(/^value/i)).toHaveValue("");
    expect(screen.getByLabelText(/^params/i)).toHaveValue("");
    expect(screen.getByLabelText(/direction/i)).toHaveValue("");
  });

  it("calls onChange with the updated condition when the name field changes", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/condition name/i), { target: { value: "vstop" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_CONDITION, name: "vstop" });
  });

  it("calls onRemove with the condition's id", () => {
    const onRemove = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={vi.fn()} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove/i }));
    expect(onRemove).toHaveBeenCalledWith("C1");
  });

  it("parses the value field as JSON and propagates it — e.g. a [min, max] band for an mcap_cr/between condition", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "[10000, 50000]" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_CONDITION, value: [10000, 50000] });
  });

  it("does not call onChange while the value field holds incomplete/invalid JSON (keeps typing from being blocked without propagating garbage)", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "[100" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^value/i)).toHaveValue("[100");
  });

  it("parses the params field as JSON and propagates it — e.g. vstop's length/mult/source", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^params/i), {
      target: { value: '{"length": 10, "mult": 2, "source": "close"}' },
    });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_CONDITION, params: { length: 10, mult: 2, source: "close" } });
  });

  it("sets dir to 'long' when the direction select is changed, and to null when cleared", () => {
    const onChange = vi.fn();
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/direction/i), { target: { value: "long" } });
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_CONDITION, dir: "long" });
  });

  it("resyncs its params/value text when the condition prop is replaced externally (e.g. after a needs_input answer), and a later edit builds on the new value, not the stale one", () => {
    const before = { id: "C1", role: "event" as const, kind: "indicator" as const, name: "vstop", params: { mult: 2, source: "close" }, op: "flip", value: null };
    const onChange = vi.fn();
    const { rerender } = render(<ConditionRow condition={before} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/^params/i)).toHaveValue('{"mult":2,"source":"close"}');

    // The parent swaps in server data where the answered length is now present.
    const after = { ...before, params: { mult: 2, source: "close", length: 10 } };
    rerender(<ConditionRow condition={after} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/^params/i)).toHaveValue('{"mult":2,"source":"close","length":10}');

    // Editing the value field afterwards carries the answered length along.
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "1" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...after, value: 1 });
  });

  it("does not reformat the user's own valid typing when the parent echoes the parsed value back", () => {
    let current: any = { ...EMPTY_CONDITION };
    const onChange = vi.fn((next) => { current = next; });
    const { rerender } = render(<ConditionRow condition={current} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/^value/i), { target: { value: "[10000,  50000]" } });
    rerender(<ConditionRow condition={current} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/^value/i)).toHaveValue("[10000,  50000]");
  });

  it("round-trips a non-empty value/params from the condition back into the inputs as JSON text", () => {
    const condition = {
      id: "C3", role: "event" as const, kind: "indicator" as const, name: "vstop",
      params: { length: 10, mult: 2, source: "close" }, op: "flip", value: null, dir: "long" as const,
    };
    render(<ConditionRow condition={condition} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/^params/i)).toHaveValue('{"length":10,"mult":2,"source":"close"}');
    expect(screen.getByLabelText(/direction/i)).toHaveValue("long");
  });
});
