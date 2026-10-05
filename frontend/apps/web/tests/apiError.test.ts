import { describe, expect, it } from "vitest";
import { describeApiError } from "@/lib/apiError";

describe("describeApiError", () => {
  it("returns this app's own {error} message", () => {
    expect(describeApiError({ error: "draft 7 not found" }, "fallback")).toBe("draft 7 not found");
  });

  it("joins the engine's {detail: [...]} 422 shape into a readable line", () => {
    expect(
      describeApiError(
        { detail: [{ condition_id: "C3", message: "missing required param 'mult'" }, { condition_id: "C1", message: "unsupported" }] },
        "fallback"
      )
    ).toBe("C3: missing required param 'mult'; C1: unsupported");
  });

  it("returns a bare string body as-is (the engine's plain-text 500)", () => {
    expect(describeApiError("Internal Server Error", "fallback")).toBe("Internal Server Error");
  });

  it("falls back when the body matches none of the known shapes", () => {
    expect(describeApiError({ something: "else" }, "confirm failed")).toBe("confirm failed");
    expect(describeApiError(null, "confirm failed")).toBe("confirm failed");
  });
});
