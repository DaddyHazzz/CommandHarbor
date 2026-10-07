import { describe, expect, it } from "vitest";
import { runCoordinationContractDemo } from "./coordination-demo";

describe("runCoordinationContractDemo", () => {
  it("proves the Phase 8 composition contract without claiming real fleet evidence", async () => {
    await expect(runCoordinationContractDemo()).resolves.toEqual({
      schemaVersion: 1,
      contractOnly: true,
      conflictDetected: true,
      conflictResource: "repository:repo:demo",
      initialWorkerId: "worker-native",
      initialMachineId: "machine-a",
      reroutedWorkerId: "worker-mcp",
      reroutedMachineId: "machine-b",
      firstStrategy: "native_api",
      rerouteStrategy: "mcp",
      budgetEnforced: true,
      budgetBlockReason: "max_tool_calls",
      verification: "passed",
    });
  });
});
