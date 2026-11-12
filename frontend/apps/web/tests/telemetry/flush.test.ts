// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushTelemetryBounded } from "@/server/telemetry/flush";

afterEach(() => vi.useRealTimers());

describe("flushTelemetryBounded", () => {
  it("does nothing off Netlify (a long-lived server flushes on its own timers)", async () => {
    const flush = vi.fn(async () => {});
    await flushTelemetryBounded({ flush }, {} as NodeJS.ProcessEnv);
    expect(flush).not.toHaveBeenCalled();
  });

  it("flushes on Netlify", async () => {
    const flush = vi.fn(async () => {});
    await flushTelemetryBounded({ flush }, { NETLIFY: "true" } as unknown as NodeJS.ProcessEnv);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("never holds a response longer than the budget, even if the collector hangs", async () => {
    vi.useFakeTimers();
    const hung = vi.fn(() => new Promise<void>(() => {}));
    const done = flushTelemetryBounded({ flush: hung }, { NETLIFY: "true" } as unknown as NodeJS.ProcessEnv, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(done).resolves.toBeUndefined();
  });

  it("swallows a failing flush: telemetry must never fail a request", async () => {
    const flush = vi.fn(async () => { throw new Error("collector down"); });
    await expect(flushTelemetryBounded({ flush }, { NETLIFY: "true" } as unknown as NodeJS.ProcessEnv)).resolves.toBeUndefined();
  });
});
