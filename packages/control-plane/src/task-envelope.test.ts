import { describe, expect, it } from "vitest";
import { parseTaskEnvelope, remainingTaskDurationMs, taskAllowsCapability } from "./task-envelope";

function validEnvelope(): any {
  return {
    schemaVersion: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    createdAtMs: 1_000,
    expiresAtMs: 61_000,
    principal: { kind: "human", id: "user:alpha" },
    originWorkerId: "worker:codex",
    objective: "Create a disposable file and independently verify its contents.",
    allowedCapabilities: ["write_file", "read_file"],
    resources: [
      { kind: "device", id: "device:test", mode: "shared" },
      { kind: "filesystem_path", id: "C:\\Temp\\commandharbor", mode: "exclusive" },
    ],
    budget: {
      maxDurationMs: 60_000,
      maxToolCalls: 10,
      maxConcurrentOperations: 1,
      maxNetworkRequests: 0,
      maxSpendMicrousd: 0,
      maxHumanApprovals: 1,
      destinations: [],
    },
    approval: { mode: "mutation", remaining: 1 },
    success: [
      { type: "file_exists", path: "C:\\Temp\\commandharbor\\first-run.txt" },
    ],
  };
}

describe("parseTaskEnvelope", () => {
  it("accepts a bounded task envelope", () => {
    const parsed = parseTaskEnvelope(validEnvelope(), 2_000);
    expect(parsed.taskId).toBe("11111111-1111-4111-8111-111111111111");
    expect(taskAllowsCapability(parsed, "write_file")).toBe(true);
    expect(taskAllowsCapability(parsed, "delete_path")).toBe(false);
    expect(remainingTaskDurationMs(parsed, 60_000)).toBe(1_000);
  });

  it("rejects expired envelopes", () => {
    expect(() => parseTaskEnvelope(validEnvelope(), 70_000)).toThrow("expired_task_envelope");
  });

  it("rejects duplicate resource identities", () => {
    const value = validEnvelope();
    value.resources.push({ kind: "device", id: "device:test", mode: "exclusive" });
    expect(() => parseTaskEnvelope(value, 2_000)).toThrow("duplicate_task_resource");
  });

  it("rejects duplicate capabilities", () => {
    const value = validEnvelope();
    value.allowedCapabilities.push("write_file");
    expect(() => parseTaskEnvelope(value, 2_000)).toThrow("invalid_allowed_capabilities");
  });

  it("rejects unknown fields instead of silently widening authority", () => {
    expect(() => parseTaskEnvelope({ ...validEnvelope(), allowEverything: true }, 2_000))
      .toThrow("invalid_task_envelope");
  });

  it("bounds aggregate and per-destination budgets", () => {
    const value = validEnvelope();
    value.budget.destinations.push({
      destination: "api.example.test",
      maxRequests: 20,
      maxConcurrent: 2,
    });
    expect(parseTaskEnvelope(value, 2_000).budget.destinations[0]).toEqual({
      destination: "api.example.test",
      maxRequests: 20,
      maxConcurrent: 2,
    });
  });

  it("validates independent success predicates", () => {
    const value = validEnvelope();
    value.success.push({
      type: "file_sha256",
      path: "C:\\Temp\\commandharbor\\first-run.txt",
      sha256: "a".repeat(64),
    });
    expect(parseTaskEnvelope(value, 2_000).success).toHaveLength(2);
  });
});
