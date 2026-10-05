import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConditionRow } from "@/components/ConditionRow";

const EMPTY_CONDITION = { id: "C1", role: "filter" as const, kind: "field" as const, name: "", params: {}, op: "", value: null };

describe("ConditionRow", () => {
  it("renders every field empty — no pre-filled value anywhere", () => {
    render(<ConditionRow condition={EMPTY_CONDITION} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText(/condition name/i)).toHaveValue("");
    expect(screen.getByLabelText(/operator/i)).toHaveValue("");
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
});
