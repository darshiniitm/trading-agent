import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: '{"ok":true}' }] }) },
  })),
}));

describe("callClaude", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  it("throws a clear error when ANTHROPIC_API_KEY is unset", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { callClaude } = await import("@/server/compiler/callModel");
    await expect(callClaude("system", "user")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("calls messages.create with the system/user and returns the first text block", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { callClaude } = await import("@/server/compiler/callModel");
    const result = await callClaude("system prompt", "user prompt");
    expect(result).toBe('{"ok":true}');
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });
});
