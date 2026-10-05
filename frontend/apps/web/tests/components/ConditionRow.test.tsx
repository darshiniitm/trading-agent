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
