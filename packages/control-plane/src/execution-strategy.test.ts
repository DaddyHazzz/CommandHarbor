import { describe, expect, it } from "vitest";
import { selectExecutionStrategy } from "./execution-strategy";

describe("selectExecutionStrategy", () => {
  it("prefers structured execution before fragile UI interaction", () => {
    expect(selectExecutionStrategy([
      { strategy: "pixel", available: true },
      { strategy: "semantic_ui", available: true },
      { strategy: "webmcp", available: true },
    ])).toEqual({ strategy: "webmcp", rank: 3, reason: "strongest_available" });
  });

  it("uses pixel control only when stronger mechanisms are unavailable", () => {
    expect(selectExecutionStrategy([
      { strategy: "native_api", available: false },
      { strategy: "cli", available: false },
      { strategy: "mcp", available: false },
      { strategy: "webmcp", available: false },
      { strategy: "semantic_ui", available: false },
      { strategy: "browser_dom", available: false },
      { strategy: "pixel", available: true },
    ])?.strategy).toBe("pixel");
  });

  it("returns null when no execution strategy is available", () => {
    expect(selectExecutionStrategy([])).toBeNull();
  });
});
