import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PromptsPage from "@/../app/prompts/page";

const D = (id: number) => ({ draftId: id, title: null, lastEditedAt: "2026-10-13T00:00:00Z", blockedReason: "not interpreted yet", promptText: `draft ${id}` });
function setup() {
  let drafts = [D(3), D(2), D(1)];
  const calls: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: any) => {
    if (init?.method === "DELETE") {
      const b = JSON.parse(init.body); calls.push(b);
      drafts = b.all ? [] : drafts.filter((d) => !b.ids.includes(d.draftId));
      return { ok: true, status: 200, json: async () => ({ deleted: 1 }) };
    }
    const view = new URL(url, "http://x").searchParams.get("view");
    return { ok: true, status: 200, json: async () => (view === "drafts" ? drafts : []) };
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PromptsPage /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: /Drafts/ }));
  return calls;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("draft deletion", () => {
  it("deletes only the ticked drafts after a confirmation", async () => {
    const calls = setup();
    await screen.findByLabelText("select draft 3");
    expect(screen.getByRole("button", { name: /Delete selected \(0\)/ })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("select draft 3")); fireEvent.click(screen.getByLabelText("select draft 1"));
    fireEvent.click(screen.getByRole("button", { name: /Delete selected \(2\)/ }));
    expect(await screen.findByText(/cannot be undone/)).toBeInTheDocument();
    expect(calls).toEqual([]);                                   // nothing is deleted until confirmed
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Delete/, hidden: true })).getByRole("button", { name: "Delete", hidden: true }));
    await waitFor(() => expect(calls).toEqual([{ ids: [3, 1] }]));
    await waitFor(() => expect(screen.queryByLabelText("select draft 3")).not.toBeInTheDocument());
    expect(screen.getByLabelText("select draft 2")).toBeInTheDocument();
  });

  it("delete all removes every draft, and select-all ticks them", async () => {
    const calls = setup();
    await screen.findByLabelText("select draft 3");
    fireEvent.click(screen.getByLabelText("select all drafts"));
    expect(screen.getByRole("button", { name: /Delete selected \(3\)/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Delete all \(3\)/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /^Delete/, hidden: true })).getByRole("button", { name: "Delete", hidden: true }));
    await waitFor(() => expect(calls).toEqual([{ all: true }]));
    expect(await screen.findByText(/No drafts/)).toBeInTheDocument();
  });
});
