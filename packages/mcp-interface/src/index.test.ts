import { describe, expect, it } from "vitest";
import { PRODUCTION_READ_ONLY_TOOLS } from "./index";

describe("public MCP interface", () => {
  it("keeps the production read-only discovery surface explicit and unique", () => {
    expect(PRODUCTION_READ_ONLY_TOOLS).toEqual([
      "list_devices",
      "device_status",
      "system_info",
      "list_directory",
      "get_file_info",
      "read_file",
    ]);
    expect(new Set(PRODUCTION_READ_ONLY_TOOLS).size).toBe(PRODUCTION_READ_ONLY_TOOLS.length);
  });
});
