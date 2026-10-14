import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FeasibilityChip, RunHeader, UnevaluatedSection, UploadControl, chipText, reasonText } from "@/components/DataStatus";

describe("chipText (spec §6.2)", () => {
  it.each([
    [{ status: "ready" }, "data ready"],
    [{ status: "fallback", source: "bhavcopy" }, "via fallback · bhavcopy"],
    [{ status: "stale", as_of: "2026-10-03" }, "stale · as of 2026-10-03"],
    [{ status: "approx", detail: "top 100 by mcap" }, "approx universe · top 100 by mcap"],
    [{ status: "unavailable" }, "no data source"],
    [{ status: "unknown" }, "checking…"],
  ])("%j -> %s", (entry, text) => expect(chipText(entry as any)).toBe(text));
});

describe("FeasibilityChip", () => {
  it("renders the status in a data attribute and shows source and date on hover", () => {
    render(<FeasibilityChip entry={{ status: "fallback", source: "nse_bhavcopy", as_of: "2026-10-05" }} />);
    const chip = screen.getByText("via fallback · nse_bhavcopy");
    expect(chip).toHaveAttribute("data-feasibility", "fallback");
    expect(chip).toHaveAttribute("title", expect.stringContaining("2026-10-05"));
  });
  it("shows 'checking…' while the check is pending", () => {
    render(<FeasibilityChip entry={null} />);
    expect(screen.getByText("checking…")).toBeInTheDocument();
  });
});

const COV = { universe_size: 100, fully_evaluated: 80, coverage: 0.8, per_condition: {}, universe_quality: "approx", unfeedable_conditions: ["C5"], status: "partial" as const, scored: false };

describe("RunHeader (spec §10.2)", () => {
  it("shows the status badge, coverage %, universe quality, 'not applied' conditions and the not-scored note", () => {
    render(<RunHeader coverage={COV} conditionLabels={{ C5: "Sector = Tech" }} />);
    expect(screen.getByText("partial")).toHaveAttribute("data-run-status", "partial");
    expect(screen.getByText(/80% of 100 stocks fully evaluated/)).toBeInTheDocument();
    expect(screen.getByText(/universe: approx/i)).toBeInTheDocument();
    expect(screen.getByText(/not applied: no data source/i)).toBeInTheDocument();
    expect(screen.getByText(/Sector = Tech/)).toBeInTheDocument();
    expect(screen.getByText(/not counted in forward-test scoring/i)).toBeInTheDocument();
  });
  it("low coverage shows a banner alert", () => {
    render(<RunHeader coverage={{ ...COV, coverage: 0.4, status: "low_coverage", unfeedable_conditions: [] }} conditionLabels={{}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/low coverage/i);
    expect(screen.getByText("low coverage")).toBeInTheDocument();
  });
  it("a complete run has no banner and no not-applied list", () => {
    render(<RunHeader coverage={{ ...COV, coverage: 1, status: "complete", unfeedable_conditions: [], universe_quality: "ok", scored: true }} conditionLabels={{}} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/not applied/i)).toBeNull();
    expect(screen.queryByText(/not counted/i)).toBeNull();
  });
  it("renders nothing for an engine without coverage", () => {
    const { container } = render(<RunHeader coverage={undefined} conditionLabels={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("UnevaluatedSection", () => {
  it("lists each unevaluated stock with a plain-language reason", () => {
    render(<UnevaluatedSection rows={[{ ticker: "NEW.NS", name: "New Co", reasons: ["insufficient_history"], unknown_count: 1, met_count: 0 }]} />);
    expect(screen.getByText(/Unevaluated \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("NEW.NS")).toBeInTheDocument();
    expect(screen.getByText(reasonText("insufficient_history"))).toBeInTheDocument();
  });
  it("renders nothing when there are none", () => {
    const { container } = render(<UnevaluatedSection rows={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("UploadControl", () => {
  it("posts the chosen CSV and reports success; never blocks anything", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ saved: "u.csv" }) });
    vi.stubGlobal("fetch", f);
    const done = vi.fn();
    render(<UploadControl draftId={7} onUploaded={done} />);
    const file = new File(["symbol\nAAA\n"], "u.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/upload a universe csv/i), { target: { files: [file] } });
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(f).toHaveBeenCalledWith("/api/drafts/7/program/upload", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((f.mock.calls[0][1] as any).body)).toEqual({ name: "u.csv", text: "symbol\nAAA\n" });
    vi.unstubAllGlobals();
  });
  it("shows the error when the engine rejects the file", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ detail: "invalid universe CSV: no Symbol column" }) }));
    render(<UploadControl draftId={7} onUploaded={() => undefined} />);
    fireEvent.change(screen.getByLabelText(/upload a universe csv/i), { target: { files: [new File(["x\n1\n"], "bad.csv")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/no Symbol column/);
    vi.unstubAllGlobals();
  });
});
