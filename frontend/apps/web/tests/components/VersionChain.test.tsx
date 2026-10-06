import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VersionChain } from "@/components/VersionChain";

describe("VersionChain", () => {
  it("shows the parent -> current arrow and the stop-being-graded note when there is a parent", () => {
    render(<VersionChain promptId={12} parentPromptId={9} version={2} />);
    expect(screen.getByText(/Prompt 9/)).toBeInTheDocument();
    expect(screen.getByText(/Prompt 12/)).toBeInTheDocument();
    expect(screen.getByText(/stop being graded/i)).toBeInTheDocument();
  });

  it("shows just the prompt number when there is no parent", () => {
    render(<VersionChain promptId={5} parentPromptId={null} version={1} />);
    expect(screen.getByText(/Prompt 5/)).toBeInTheDocument();
    expect(screen.queryByText(/stop being graded/i)).not.toBeInTheDocument();
  });
});
