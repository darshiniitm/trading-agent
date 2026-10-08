import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthGate } from "@/components/AuthGate";

afterEach(() => vi.restoreAllMocks());

describe("AuthGate", () => {
  it("keeps the app visible in single-user mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => ({ multiUser: false, currentUser: { userId: 1, displayName: "Owner", email: null } }) } as any);
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText("app content")).toBeInTheDocument());
  });

  it("gates unauthenticated users only after a second user exists", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => ({ multiUser: true, currentUser: null }) } as any);
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });
});
