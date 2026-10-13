import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthGate } from "@/components/AuthGate";

vi.mock("next/navigation", () => ({ usePathname: () => "/prompts" }));
afterEach(() => vi.restoreAllMocks());

const me = (body: object) => vi.spyOn(globalThis, "fetch").mockResolvedValue({ json: async () => body } as any);

describe("AuthGate", () => {
  it("shows the app to a signed-in user", async () => {
    me({ multiUser: false, currentUser: { userId: 1, displayName: "Owner", email: "o@example.com" } });
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText("app content")).toBeInTheDocument());
  });

  it("gates a signed-out visitor even when only one user exists", async () => {
    me({ multiUser: false, currentUser: null });
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByText(/sign in/i)).toBeInTheDocument());
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });

  it("explains a not-invited account instead of the app", async () => {
    me({ multiUser: true, currentUser: null, denied: "not_invited" });
    render(<AuthGate><p>app content</p></AuthGate>);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/invited/i));
    expect(screen.queryByText("app content")).not.toBeInTheDocument();
  });
});
