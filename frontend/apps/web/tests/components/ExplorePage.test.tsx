import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ExplorePage from "@/../app/explore/page";

const ROWS = [
  { promptId: 15, title: "Mine", ownerName: "Me", isMine: true, followers: 2, gradedWeeks: 3, isFollowing: false, conditionLabels: ["RSI(14) · between 50–65"], vsControl: 1.5, watchlistId: 4 },
  { promptId: 16, title: "Theirs", ownerName: "User 2", isMine: false, followers: 0, gradedWeeks: 1, isFollowing: false, conditionLabels: [], vsControl: null, watchlistId: null },
];
const wrap = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ExplorePage /></QueryClientProvider>);
afterEach(() => vi.unstubAllGlobals());

describe("Explore page", () => {
  it("renders cards, no structure filter, 'Yours' for own prompts and Follow/Copy for others", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ROWS })));
    wrap();
    expect(await screen.findByText("Theirs")).toBeInTheDocument();
    expect(screen.queryByLabelText("filter by structure")).not.toBeInTheDocument();
    expect(screen.getByText(/Yours · open watchlist/)).toHaveAttribute("href", "/watchlists/4");
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Copy to my drafts" })).toBeInTheDocument();
  });

  it("follows optimistically and rolls back when the server refuses", async () => {
    const fetchFn = vi.fn(async (url: string, init?: any) => (init?.method === "POST" ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ROWS }));
    vi.stubGlobal("fetch", fetchFn);
    wrap();
    fireEvent.click(await screen.findByRole("button", { name: "Follow" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't follow Prompt 16/));
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");
  });
});
