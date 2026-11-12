// Shared fixtures keep this implementation identical to src/telemetry/redact.py (observability/redaction-fixtures.json).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hashUser, redactString, redactValue, truncate } from "@/server/telemetry/redact";

const fx = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../../observability/redaction-fixtures.json"), "utf8"));

describe("redact (shared fixtures)", () => {
  for (const c of fx.strings) it(`string: ${c.name}`, () => expect(redactString(c.in)).toBe(c.out));
  for (const c of fx.objects) it(`object: ${c.name}`, () => expect(redactValue(c.in)).toEqual(c.out));
  for (const c of fx.hash_user.cases) it(`hashUser(${c.in.slice(0, 6)}…)`, () => expect(hashUser(c.in, fx.hash_user.salt)).toBe(c.out));
  for (const c of fx.truncate.cases) it(`truncate ${JSON.stringify(c.in)}`, () => expect(truncate(c.in, fx.truncate.max)).toEqual({ text: c.text, truncated: c.truncated }));
});

describe("redact (behaviour)", () => {
  it("does not mangle token COUNTS (input_tokens / output_tokens are telemetry, not secrets)", () => {
    expect(redactValue({ input_tokens: 12, output_tokens: 3, tokens: 9 })).toEqual({ input_tokens: 12, output_tokens: 3, tokens: 9 });
  });
  it("does not mutate its input and tolerates cycles", () => {
    const a: any = { password: "p", n: { k: "v" } }; a.self = a;
    const out = redactValue(a) as any;
    expect(a.password).toBe("p");
    expect(out.password).toBe("[redacted]");
    expect(out.self).toBe("[circular]");
  });
  it("truncate defaults to 16 KB", () => {
    expect(truncate("x".repeat(20000)).text.length).toBe(16384);
    expect(truncate("x".repeat(20000)).truncated).toBe(true);
  });
});
