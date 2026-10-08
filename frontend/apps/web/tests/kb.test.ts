// P1 of docs/prompt-agent-interpreter-plan.md: the parameter knowledge repository.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build } from "../../../packages/spec/scripts/kb-build";
import { INDICATORS, FIELDS } from "@/server/compiler/v5/registry";
import { buildIndex, closest, findMentions, indexOf, kbEntries, kbEntry, reviewedIndex, search, warmupBars, type IndicatorKb } from "spec/src/kb";

describe("knowledge repository", () => {
  it("generated files are current: the bundle and registry.json match what the entries produce", () => {
    const out = build();
    const dir = "../../packages/spec/src/";
    expect(readFileSync(dir + "kb.generated.json", "utf8")).toBe(out.bundle);
    expect(readFileSync(dir + "registry.json", "utf8")).toBe(out.registry);
  });

  it("registry.json contains exactly the implemented entries; proposed/unimplemented ones are not computable", () => {
    const impl = kbEntries().filter((e) => (e.kind === "indicator" || e.kind === "field") && e.engine.implemented).map((e) => e.id).sort();
    expect([...Object.keys(INDICATORS), ...Object.keys(FIELDS)].sort()).toEqual(impl);
    for (const id of ["ichimoku", "adx", "pe"]) expect(INDICATORS[id] ?? FIELDS[id]).toBeUndefined();
  });

  it("the weekly screener's own parameters are seeded as reviewed", () => {
    for (const [id, kind] of [["vstop", "indicator"], ["rsi", "indicator"], ["mcap_cr", "field"], ["nse_all", "universe"]] as const) {
      expect(kbEntry(id, kind)?.provenance.status).toBe("reviewed");
    }
  });

  it("every implemented indicator names an engine function and a warm-up rule that evaluates", () => {
    for (const e of kbEntries().filter((x): x is IndicatorKb => x.kind === "indicator" && x.engine.implemented)) {
      expect(e.engine.function).toMatch(/^engine\.v5\.indicators\./);
      const params = Object.fromEntries(e.params.map((p) => [p.name, p.common_values.find((v) => typeof v === "number") ?? 10]));
      expect(warmupBars(e, params), e.id).toBeGreaterThan(0);
    }
    expect(warmupBars(kbEntry("sma", "indicator") as IndicatorKb, { length: 30 })).toBe(30);
    expect(warmupBars(kbEntry("macd", "indicator") as IndicatorKb, { slow: 26, signal: 9 })).toBe(35);
    expect(warmupBars(kbEntry("sma", "indicator") as IndicatorKb, { length: null })).toBeNull();   // an unknown param is never guessed
  });

  it("common values stay inside the param's own range (suggestions must be acceptable answers)", () => {
    for (const e of kbEntries().filter((x): x is IndicatorKb => x.kind === "indicator")) {
      for (const p of e.params) for (const v of p.common_values) {
        if (p.type === "enum") expect(p.values, `${e.id}.${p.name}`).toContain(v);
        else if (typeof v === "number") { expect(v, `${e.id}.${p.name}`).toBeGreaterThanOrEqual(Number(p.min)); expect(v).toBeLessThanOrEqual(Number(p.max)); }
      }
    }
  });
});

describe("knowledge search", () => {
  const idx = reviewedIndex();
  const top = (q: string, kinds?: any) => search(idx, q, { kinds })[0]?.entry.id;

  it.each([["SMA", "sma"], ["sma6", "sma"], ["simple MA", "sma"], ["6 day moving avg", "sma"], ["simple moving average", "sma"], ["200 DMA", "sma"],
    ["exponential moving average", "ema"], ["V-Stop", "vstop"], ["vstop", "vstop"], ["relative strength index", "rsi"], ["Bollinger Bands", "bollinger"]])("%s -> %s", (q, id) => {
    expect(top(q, ["indicator"])).toBe(id);
  });

  it("tolerates a typo, and never matches the unrelated", () => {
    expect(top("simpel moving average", ["indicator"])).toBe("sma");
    expect(search(idx, "the moon is in the seventh house")).toEqual([]);
  });

  it("universes and fields resolve by their usual names", () => {
    expect(top("Nifty 100", ["universe"])).toBe("nifty_100");
    expect(top("market cap", ["field"])).toBe("mcap_cr");
    expect(top("all nse stocks", ["universe"])).toBe("nse_all");
  });

  it("proposed entries are invisible to matching until reviewed, but findable by opting in", () => {
    expect(search(idx, "ichimoku cloud")).toEqual([]);
    const all = indexOf(["reviewed", "proposed"]);
    expect(search(all, "ichimoku cloud", { kinds: ["indicator"] })[0].entry.id).toBe("ichimoku");
  });

  it("findMentions lists every entry in free text, longest alias first, without overlaps", () => {
    const m = findMentions(buildIndex(kbEntries(), ["reviewed", "proposed"]), "Compute the exponential moving average and the Ichimoku Cloud", ["indicator"]);
    expect(m.map((x) => x.entry.id)).toEqual(["ema", "ichimoku"]);
  });

  it("closest gives suggestions for an unknown phrase", () => {
    const ids = closest(idx, "bolinger band", 3).map((e) => e.id);
    expect(ids).toContain("bollinger");
  });
});
