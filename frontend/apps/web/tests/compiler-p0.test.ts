import { describe, expect, it } from "vitest";
import { numbersIn, valueTracesToPhrase } from "@/server/compiler/spanCheck";
import { friendlyCompileError } from "@/lib/apiError";

describe("span check", () => {
  it("re-reads numbers with K / L / lakh suffixes, commas and weekday names", () => {
    expect([...numbersIn("10K- 50K cr Market Cap")].sort((a, b) => a - b)).toEqual([10, 50, 10000, 50000]);
    expect(valueTracesToPhrase(10000, "10,000 crore")).toBe(true);
    expect(valueTracesToPhrase(5, "friday closing")).toBe(true);
    expect(valueTracesToPhrase("1W", "Weekly timeframe")).toBe(true);
  });
  it("refuses a value the phrase does not contain", () => {
    expect(valueTracesToPhrase(14, "RSI")).toBe(false);
    expect(valueTracesToPhrase("high", "on the close")).toBe(false);
  });
});

describe("friendlyCompileError", () => {
  it("counts the unreadable parts instead of printing zod paths", () => {
    const msg = friendlyCompileError(["source_phrases.2.phrase: Required", "source_phrases.3.phrase: Required", "needs_input.0.path: Required"]);
    expect(msg).toMatch(/Couldn't read 2 parts/);
    expect(msg).not.toMatch(/source_phrases/);
  });
});
