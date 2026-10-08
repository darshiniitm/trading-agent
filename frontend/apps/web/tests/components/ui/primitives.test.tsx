import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Segmented } from "@/ui/Segmented";
import { Button } from "@/ui/Button";
import { ConditionFlags } from "@/ui/ConditionFlags";
import { IdBadge } from "@/ui/IdBadge";
import { activeNav } from "@/ui/AppShell";
import { sparkPath } from "@/ui/Sparkline";

describe("ui primitives", () => {
  it("Segmented marks the selected item with aria-pressed and reports changes", () => {
    const onChange = vi.fn();
    render(<Segmented items={[{ id: "a", label: "Mine", count: 2 }, { id: "b", label: "Drafts", count: 1 }]} value="a" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Mine/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Drafts/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: /Drafts/ }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("Button with disabledReason is disabled and shows the reason as text", () => {
    render(<Button disabledReason="Read your prompt first">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Read your prompt first")).toBeVisible();
  });

  it("ConditionFlags prints n/N and a hidden 'not met' text for unmet conditions", () => {
    render(<ConditionFlags conds={[{ id: "C1", label: "a", met: true }, { id: "C2", label: "b", met: true }, { id: "C3", label: "c", met: false }, { id: "C4", label: "d", met: false }]} />);
    expect(screen.getByText("2/4")).toBeInTheDocument();
    expect(screen.getByText("C3 not met")).toBeInTheDocument();
    expect(screen.getByText("C1 met")).toBeInTheDocument();
  });

  it("IdBadge copy writes just the number", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<IdBadge kind="prompt" id={12} />);
    fireEvent.click(screen.getByRole("button", { name: /copy prompt number/i }));
    expect(writeText).toHaveBeenCalledWith("12");
  });

  it("activeNav maps routes to nav items", () => {
    expect(activeNav("/watchlists/3")).toBe("prompts");
    expect(activeNav("/drafts/new")).toBe("new");
    expect(activeNav("/explore")).toBe("explore");
    expect(activeNav("/data-health")).toBe("data");
  });

  it("sparkPath needs at least two points", () => {
    expect(sparkPath([1], 88, 28)).toBe("");
    expect(sparkPath([1, 2, 3], 88, 28)).toMatch(/^M/);
  });
});
