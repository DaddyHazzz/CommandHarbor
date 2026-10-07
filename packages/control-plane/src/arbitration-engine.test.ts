import { describe, expect, it } from "vitest";
import {
  arbitrateDeterministically,
  validateArbitrationChoice,
  type ArbitrationCandidate,
} from "./arbitration-engine";
import type { TaskEnvelope } from "./task-envelope";

function task(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    principal: { kind: "human", id: "user-1" },
    originWorkerId: null,
    objective: "test arbitration",
    allowedCapabilities: ["read_file", "execute_command", "mouse_move"],
    resources: [{ kind: "device", id: "device:a", mode: "shared" }],
    budget: {
      maxDurationMs: 9_000,
      maxToolCalls: 10,
      maxConcurrentOperations: 2,
      maxNetworkRequests: 10,
      maxSpendMicrousd: 0,
      maxHumanApprovals: 1,
      destinations: [],
    },
    approval: { mode: "none" },
    success: [],
    ...overrides,
  };
}

function candidate(
  workerId: string,
  strategies: string[],
  availableStrategies: Array<"native_api" | "cli" | "mcp" | "webmcp" | "semantic_ui" | "browser_dom" | "pixel">,
  capabilities = ["read_file", "execute_command"],
  available = true,
): ArbitrationCandidate {
  return {
    worker: {
      workerId,
      provider: "provider-" + workerId,
      kind: "agent",
      capabilities,
      executionStrategies: strategies,
    },
    machineId: "machine-" + workerId,
    available,
    strategies: availableStrategies.map((strategy) => ({
      strategy,
      available: true,
    })),
  };
}

describe("arbitrateDeterministically", () => {
  it("blocks capabilities outside Task Envelope authority", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["delete_everything"],
      candidates: [candidate("worker-a", ["cli"], ["cli"], ["delete_everything"])],
    }, 2_000);

    expect(result).toEqual({
      taskId: "00000000-0000-4000-8000-000000000001",
      status: "blocked",
      reason: "capability_outside_task_authority",
      deniedCapabilities: ["delete_everything"],
      fallback: { type: "none" },
    });
  });

  it("blocks expired tasks before considering workers", () => {
    const result = arbitrateDeterministically({
      task: task({ expiresAtMs: 2_000 }),
      requiredCapabilities: ["read_file"],
      candidates: [candidate("worker-a", ["native_api"], ["native_api"])],
    }, 2_000);

    expect(result).toEqual({
      taskId: "00000000-0000-4000-8000-000000000001",
      status: "blocked",
      reason: "task_expired",
      fallback: { type: "none" },
    });
  });

  it("filters unavailable and capability-incompatible workers", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["execute_command"],
      candidates: [
        candidate("worker-a", ["native_api"], ["native_api"], ["read_file"]),
        candidate("worker-b", ["native_api"], ["native_api"], ["execute_command"], false),
      ],
    }, 2_000);

    expect(result).toEqual({
      taskId: "00000000-0000-4000-8000-000000000001",
      status: "blocked",
      reason: "no_eligible_worker",
      fallback: { type: "escalate" },
    });
  });

  it("requires strategy support from both the worker and current environment", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-a", ["cli"], ["native_api"]),
      ],
    }, 2_000);

    expect(result.status).toBe("blocked");
    expect(result).toMatchObject({ reason: "no_eligible_worker" });
  });

  it("selects the only eligible worker and grants only required capabilities", () => {
    const envelope = task();
    const result = arbitrateDeterministically({
      task: envelope,
      requiredCapabilities: ["read_file"],
      candidates: [candidate("worker-a", ["cli"], ["cli"])],
    }, 2_000);

    expect(result.status).toBe("selected");
    if (result.status !== "selected") throw new Error("expected selection");
    expect(result.reason).toBe("only_eligible_candidate");
    expect(result.selection).toMatchObject({
      workerId: "worker-a",
      machineId: "machine-worker-a",
      executionStrategy: "cli",
      grantedCapabilities: ["read_file"],
    });
    expect(result.selection.resources).toEqual(envelope.resources);
    expect(result.selection.resources).not.toBe(envelope.resources);
  });

  it("chooses the candidate with the objectively strongest execution strategy", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-cli", ["cli"], ["cli"]),
        candidate("worker-native", ["native_api", "cli"], ["native_api", "cli"]),
      ],
    }, 2_000);

    expect(result.status).toBe("selected");
    if (result.status !== "selected") throw new Error("expected selection");
    expect(result.reason).toBe("strongest_strategy");
    expect(result.selection.workerId).toBe("worker-native");
    expect(result.selection.executionStrategy).toBe("native_api");
  });

  it("returns typed ambiguity instead of making an arbitrary tied choice", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-b", ["mcp"], ["mcp"]),
        candidate("worker-a", ["mcp"], ["mcp"]),
      ],
    }, 2_000);

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error("expected ambiguity");
    expect(result.reason).toBe("equally_ranked_candidates");
    expect(result.fallback).toEqual({ type: "bounded_decision" });
    expect(result.eligible.map((item) => item.workerId)).toEqual(["worker-a", "worker-b"]);
  });

  it("validates a model or human suggestion against deterministic eligibility", () => {
    const envelope = task();
    const result = arbitrateDeterministically({
      task: envelope,
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-a", ["mcp"], ["mcp"]),
        candidate("worker-b", ["mcp"], ["mcp"]),
      ],
    }, 2_000);
    if (result.status !== "ambiguous") throw new Error("expected ambiguity");

    const accepted = validateArbitrationChoice(envelope, result, "worker-b");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error("expected validated choice");
    expect(accepted.selection.workerId).toBe("worker-b");
    expect(accepted.selection.grantedCapabilities).toEqual(["read_file"]);

    expect(validateArbitrationChoice(envelope, result, "worker-evil")).toEqual({
      ok: false,
      reason: "worker_not_eligible",
    });
  });

  it("rejects an otherwise eligible suggestion from a different task", () => {
    const firstTask = task();
    const result = arbitrateDeterministically({
      task: firstTask,
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-a", ["mcp"], ["mcp"]),
        candidate("worker-b", ["mcp"], ["mcp"]),
      ],
    }, 2_000);
    if (result.status !== "ambiguous") throw new Error("expected ambiguity");

    const otherTask = task({
      taskId: "00000000-0000-4000-8000-000000000099",
    });
    expect(validateArbitrationChoice(otherTask, result, "worker-a")).toEqual({
      ok: false,
      reason: "task_mismatch",
    });
  });
  it("rejects duplicate worker identities", () => {
    expect(() => arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-a", ["cli"], ["cli"]),
        candidate("worker-a", ["mcp"], ["mcp"]),
      ],
    }, 2_000)).toThrow("duplicate_arbitration_worker");
  });

  it("ignores unknown worker strategy claims instead of treating them as authority", () => {
    const result = arbitrateDeterministically({
      task: task(),
      requiredCapabilities: ["read_file"],
      candidates: [
        candidate("worker-a", ["telepathy"], ["cli"]),
      ],
    }, 2_000);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "no_eligible_worker",
    });
  });
});
