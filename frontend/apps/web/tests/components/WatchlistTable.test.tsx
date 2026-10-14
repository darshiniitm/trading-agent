import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WatchlistTable } from "@/components/WatchlistTable";

const ENTRIES = [
  { entryId: 1, symbol: "FULL1", membership: "full_match", status: "pending_selection", entryPrice: null, stop: null, refPrice: null, condValues: { C1: 25000 }, failedIds: [] },
  { entryId: 2, symbol: "NEAR1", membership: "near_miss", status: "watching", entryPrice: null, stop: null, refPrice: 50.0, condValues: { C1: 9000 }, failedIds: ["C1"] },
];

describe("WatchlistTable", () => {
  it("renders one row per entry with a status chip that carries text, not color alone", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} />);
    expect(screen.getByText("FULL1")).toBeInTheDocument();
    expect(screen.getByText("NEAR1")).toBeInTheDocument();
    expect(screen.getByText(/watching.*not graded/i)).toBeInTheDocument();
  });

  it("renders one column per condition name passed in, hiding columns that don't apply", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} />);
    expect(screen.getAllByText("25000")).toHaveLength(1);
    expect(screen.getAllByText("9000")).toHaveLength(1);
  });

  it("renders an empty table without crashing when there are zero entries", () => {
    render(<WatchlistTable entries={[]} conditionNames={["C1"]} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders a quote's price when one is available for the row's symbol", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} quotes={{ FULL1: { price: 101.5, asOf: "2026-10-02T09:15:00Z", error: null } }} />);
    expect(screen.getByText("101.5")).toBeInTheDocument();
  });

  it("renders a dash, not a crash, when no quote has been fetched yet for a symbol", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThan(0);
  });

  it("renders the quote's own error instead of a price when the engine couldn't fetch one", () => {
    render(<WatchlistTable entries={ENTRIES} conditionNames={["C1"]} quotes={{ FULL1: { price: null, asOf: null, error: "possibly delisted" } }} />);
    expect(screen.getByText("possibly delisted")).toBeInTheDocument();
  });
});
