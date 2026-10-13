import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ValidationCard } from "@/components/ValidationCard";

describe("ValidationCard", () => {
  it("always shows graded week N of 13", () => {
    render(<ValidationCard gradedWeeks={5} horizons={[]} />);
    expect(screen.getByText(/graded week 5 of 13/i)).toBeInTheDocument();
  });

  it("shows 'no horizons graded yet' instead of an empty table when horizons is empty", () => {
    render(<ValidationCard gradedWeeks={5} horizons={[]} />);
    expect(screen.getByText(/no horizons graded yet/i)).toBeInTheDocument();
  });

  it("renders one row per horizon and the arm-picks-only note", () => {
    render(<ValidationCard gradedWeeks={13} horizons={[{ horizon: 1, n: 10, ewReturn: 2.5, hitRate: 0.6 }]} />);
    expect(screen.getByText(/2.50%/)).toBeInTheDocument();
    expect(screen.getByText(/arm picks vs Control only/i)).toBeInTheDocument();
    expect(screen.getByText(/near misses are not graded/i)).toBeInTheDocument();
  });
});
