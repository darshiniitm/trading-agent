import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EngineBuffer, EnginePill } from "@/components/EngineStatus";
import { emptyStatus } from "@/lib/engineStatus";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const warming = (over = {}) => emptyStatus("warming", true, { phase: "shares", phaseIndex: 2, done: 575, total: 2300, elapsedS: 75, ...over });

describe("EngineBuffer", () => {
  it("shows where loading is: finished steps, the current one with a real count, the rest still to do", () => {
    render(<EngineBuffer status={warming()} queued={false} onCancel={() => {}} onRetry={() => {}} />);
    const panel = screen.getByRole("status", { name: /data engine status/i });
    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(within(panel).getByText("Loading market data")).toBeInTheDocument();
    expect(within(panel).getByText("1m 15s")).toBeInTheDocument();
    const steps = within(panel).getAllByRole("listitem");
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(["done", "done", "active", "todo", "todo", "todo"]);   // ends with "Building indexes"
    expect(steps[2]).toHaveAttribute("aria-current", "step");
    const bar = within(panel).getByRole("progressbar", { name: /shares outstanding progress/i });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(within(panel).getByText("575 of 2,300")).toBeInTheDocument();
  });

  it("never invents a percentage: without a count the bar is indeterminate", () => {
    render(<EngineBuffer status={warming({ done: null, total: null, phase: "weekly_prices", phaseIndex: 1 })} queued={false} onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  });

  it("says a queued run starts by itself, and Cancel run stops it", () => {
    const cancel = vi.fn();
    render(<EngineBuffer status={warming()} queued onCancel={cancel} onRetry={() => {}} />);
    expect(screen.getByText(/your run is queued and will start automatically/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    expect(cancel).toHaveBeenCalled();
  });

  it("tells a user with nothing queued that their rules are saved", () => {
    render(<EngineBuffer status={warming()} queued={false} onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText(/your rules are saved/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel run/i })).toBeNull();
  });

  it("while the process itself is starting there are no steps yet", () => {
    render(<EngineBuffer status={emptyStatus("starting")} queued={false} onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("Starting the data engine")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /loading steps/i })).toBeNull();
  });

  it("when the app does not manage the engine and it is not running, says so instead of promising a start", () => {
    const cancel = vi.fn();
    render(<EngineBuffer status={emptyStatus("stopped", false)} queued onCancel={cancel} onRetry={() => {}} />);
    expect(screen.getByText("The data engine is not running")).toBeInTheDocument();
    expect(screen.getByText(/ENGINE_MANAGED=0/)).toBeInTheDocument();
    expect(screen.queryByText(/starting the data engine/i)).toBeNull();
    expect(screen.queryByText(/\d+s$/)).toBeNull();   // no ticking timer: nothing is in progress
    fireEvent.click(screen.getByRole("button", { name: /cancel run/i }));
    expect(cancel).toHaveBeenCalled();
  });

  it("a managed app that has stopped the engine (idle) still says it is starting", () => {
    render(<EngineBuffer status={emptyStatus("stopped", true)} queued onCancel={() => {}} onRetry={() => {}} />);
    expect(screen.getByText("Starting the data engine")).toBeInTheDocument();
  });

  it("a failure is an alert in plain words with Retry; the raw error and log are behind 'Show details'", () => {
    const retry = vi.fn();
    const status = emptyStatus("error", true, { phase: "weekly_prices", error: "OSError: Unexpected end of stream", log: ["Traceback (most recent call last):", "OSError: Unexpected end of stream"] });
    render(<EngineBuffer status={status} queued onCancel={() => {}} onRetry={retry} />);
    const alert = screen.getByRole("alert", { name: /data engine error/i });
    expect(within(alert).getByText(/stopped while loading weekly prices/i)).toBeInTheDocument();
    expect(alert.textContent).not.toMatch(/Internal Server Error|Check the engine log/i);
    const details = within(alert).getByText("Show details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details.textContent).toMatch(/Unexpected end of stream/);
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
  });
});

describe("EnginePill", () => {
  const withStatus = (status: unknown) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => status })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(<QueryClientProvider client={client}><EnginePill /></QueryClientProvider>);
  };

  it("is a quiet 'Data ready' when the engine is ready", async () => {
    withStatus(emptyStatus("ready"));
    const pill = await screen.findByRole("status");
    expect(pill).toHaveTextContent("Data ready");
    expect(pill).toHaveAttribute("data-engine-state", "ready");
  });

  it("names the phase while loading, and offers Retry on an error", async () => {
    withStatus(warming({ phase: "weekly_prices", phaseIndex: 1 }));
    expect(await screen.findByText("Loading market data · Weekly prices")).toBeInTheDocument();
    cleanup();
    withStatus(emptyStatus("error"));
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders nothing until the status is known (and when the status call fails)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}><EnginePill /></QueryClientProvider>);
    await new Promise((r) => setTimeout(r, 50));
    expect(container).toBeEmptyDOMElement();
  });
});
