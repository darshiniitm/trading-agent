import { describe, expect, it } from "vitest";
import { buildCompilerPrompt, buildRetryUser } from "@/server/compiler/promptBuilder";

describe("buildCompilerPrompt", () => {
  it("embeds the catalog and the prompt text, and states the no-invented-values and liquidity rules", () => {
    const catalog = [{ kind: "indicator", name: "vstop", required_params: [{ name: "length" }] }];
    const { system, user } = buildCompilerPrompt("Buy when VStop flips up", catalog, [{ structure: "literal" }]);
    expect(system).toContain("vstop");
    expect(system).toContain("source_phrases");
    expect(system).toMatch(/never.*liquidity/i);
    expect(system).toMatch(/never invent/i);
    expect(user).toContain("Buy when VStop flips up");
  });
});

describe("buildRetryUser", () => {
  it("appends the errors to the original user prompt, asking for corrected JSON only", () => {
    const retried = buildRetryUser("original prompt text", ["risk_cap_pct: no source phrase"]);
    expect(retried).toContain("original prompt text");
    expect(retried).toContain("risk_cap_pct: no source phrase");
    expect(retried).toMatch(/only the corrected JSON/i);
  });
});
