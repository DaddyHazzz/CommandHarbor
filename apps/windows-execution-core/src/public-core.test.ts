import { describe, expect, it } from "vitest";
import { CAPABILITY_NAMES, CAPABILITY_PROFILE } from "./index";

describe("public Windows execution core", () => {
  it("publishes a unique capability profile", () => {
    expect(CAPABILITY_NAMES.length).toBeGreaterThan(20);
    expect(new Set(CAPABILITY_NAMES).size).toBe(CAPABILITY_NAMES.length);
    expect(CAPABILITY_PROFILE.version).toBe(2);
    expect(CAPABILITY_PROFILE.tools.map((tool) => tool.name)).toEqual([...CAPABILITY_NAMES]);
  });
});
