import {
  arbitrateDeterministically,
  type ArbitrationCandidate,
} from "./arbitration-engine";
import { InMemoryTaskBudgetLedger } from "./budget-ledger";
import { verifyTaskOutcome, type OutcomeProbeAdapter } from "./outcome-verifier";
import { InMemoryResourceArbiter } from "./resource-arbiter";
import type { SuccessPredicate, TaskEnvelope } from "./task-envelope";

export interface CoordinationContractDemoReport {
  schemaVersion: 1;
  contractOnly: true;
  conflictDetected: boolean;
  conflictResource: string;
  initialWorkerId: string;
  initialMachineId: string | null;
  reroutedWorkerId: string;
  reroutedMachineId: string | null;
  firstStrategy: string;
  rerouteStrategy: string;
  budgetEnforced: boolean;
  budgetBlockReason: string;
  verification: "passed" | "failed" | "indeterminate";
}

function demoTask(
  taskId: string,
  objective: string,
  resources: TaskEnvelope["resources"],
  success: SuccessPredicate[],
): TaskEnvelope {
  return {
    schemaVersion: 1,
    taskId,
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    principal: { kind: "human", id: "demo-user" },
    originWorkerId: null,
    objective,
    allowedCapabilities: ["execute_command", "read_file"],
    resources,
    budget: {
      maxDurationMs: 9_000,
      maxToolCalls: 2,
      maxConcurrentOperations: 1,
      maxNetworkRequests: 2,
      maxSpendMicrousd: 200,
      maxHumanApprovals: 0,
      destinations: [
        { destination: "api:demo", maxRequests: 2, maxConcurrent: 1 },
      ],
    },
    approval: { mode: "none" },
    success,
  };
}

function candidate(
  workerId: string,
  machineId: string,
  provider: string,
  strategy: "native_api" | "mcp",
  available: boolean,
): ArbitrationCandidate {
  return {
    worker: {
      workerId,
      provider,
      kind: workerId.includes("native") ? "process" : "agent",
      capabilities: ["execute_command", "read_file"],
      executionStrategies: [strategy],
    },
    machineId,
    available,
    strategies: [{ strategy, available: true }],
  };
}

/**
 * Executable, deterministic contract fixture for the Phase 8 product boundary.
 *
 * No external machine, provider, network destination, model, or privileged
 * runtime is touched. This proves composition semantics only.
 */
export async function runCoordinationContractDemo(): Promise<CoordinationContractDemoReport> {
  let leaseId = 0;
  const leases = new InMemoryResourceArbiter({
    leaseIdFactory: () => "demo-lease-" + String(++leaseId),
  });

  const repository = { kind: "repository", id: "repo:demo", mode: "exclusive" } as const;
  const contender = demoTask(
    "00000000-0000-4000-8000-000000000010",
    "hold repository to create an intentional conflict",
    [repository],
    [],
  );
  const main = demoTask(
    "00000000-0000-4000-8000-000000000011",
    "complete work with reroute, budget enforcement, and verification",
    [
      { kind: "repository", id: "repo:demo", mode: "shared" },
      { kind: "browser_session", id: "browser:demo", mode: "exclusive" },
    ],
    [
      {
        type: "git_head",
        repository: "repo:demo",
        sha: "a".repeat(40),
      },
      {
        type: "capability_result",
        capability: "read_file",
        jsonPointer: "/verified",
        equals: { verified: true },
      },
    ],
  );

  const held = leases.acquire(contender, 2_000, 2_000);
  if (!held.ok) throw new Error("demo_setup_lease_failed");

  const conflict = leases.acquire(main, 2_000, 2_000);
  if (conflict.ok || conflict.reason !== "resource_conflict") {
    throw new Error("demo_expected_resource_conflict");
  }
  const conflictResource =
    conflict.conflicts[0]?.resource.kind + ":" + conflict.conflicts[0]?.resource.id;

  const released = leases.release(
    held.lease.leaseId,
    contender.taskId,
    "completed",
    2_100,
  );
  if (!released.ok) throw new Error("demo_release_failed");

  const mainLease = leases.acquire(main, 2_000, 2_100);
  if (!mainLease.ok) throw new Error("demo_main_lease_failed");

  const native = candidate(
    "worker-native",
    "machine-a",
    "local-process",
    "native_api",
    true,
  );
  const mcp = candidate("worker-mcp", "machine-b", "mcp-provider", "mcp", true);

  const first = arbitrateDeterministically(
    {
      task: main,
      requiredCapabilities: ["execute_command"],
      candidates: [native, mcp],
    },
    2_200,
  );
  if (first.status !== "selected") throw new Error("demo_initial_arbitration_failed");

  // The fixture intentionally declares the selected worker failed, then reruns
  // deterministic arbitration with that worker unavailable.
  const reroute = arbitrateDeterministically(
    {
      task: main,
      requiredCapabilities: ["execute_command"],
      candidates: [{ ...native, available: false }, mcp],
    },
    2_300,
  );
  if (reroute.status !== "selected") throw new Error("demo_reroute_failed");

  let reservationId = 0;
  const budget = new InMemoryTaskBudgetLedger(main, {
    reservationIdFactory: () => "demo-budget-" + String(++reservationId),
  });

  const firstBudget = budget.reserveOperation(
    {
      networkRequests: 1,
      spendMicrousd: 50,
      humanApprovals: 0,
      destinations: [{ destination: "api:demo", requests: 1 }],
    },
    2_200,
  );
  if (!firstBudget.ok) throw new Error("demo_first_budget_failed");
  const firstSettled = budget.settleOperation(
    firstBudget.reservation.reservationId,
    main.taskId,
    {
      networkRequests: 1,
      spendMicrousd: 50,
      humanApprovals: 0,
      destinations: [{ destination: "api:demo", requests: 1 }],
    },
    2_250,
  );
  if (!firstSettled.ok) throw new Error("demo_first_settlement_failed");

  const secondBudget = budget.reserveOperation(
    {
      networkRequests: 1,
      spendMicrousd: 50,
      humanApprovals: 0,
      destinations: [{ destination: "api:demo", requests: 1 }],
    },
    2_300,
  );
  if (!secondBudget.ok) throw new Error("demo_second_budget_failed");
  const secondSettled = budget.settleOperation(
    secondBudget.reservation.reservationId,
    main.taskId,
    {
      networkRequests: 1,
      spendMicrousd: 50,
      humanApprovals: 0,
      destinations: [{ destination: "api:demo", requests: 1 }],
    },
    2_350,
  );
  if (!secondSettled.ok) throw new Error("demo_second_settlement_failed");

  const blockedBudget = budget.reserveOperation(
    {
      networkRequests: 0,
      spendMicrousd: 0,
      humanApprovals: 0,
      destinations: [],
    },
    2_400,
  );
  if (blockedBudget.ok) throw new Error("demo_expected_budget_block");

  const independentlyObserved = {
    gitHead: "a".repeat(40),
    capabilityValue: { verified: true },
  };
  const probe: OutcomeProbeAdapter = {
    async observe(_task, predicate) {
      if (predicate.type === "git_head") {
        return { type: "git_head", sha: independentlyObserved.gitHead };
      }
      if (predicate.type === "capability_result") {
        return {
          type: "capability_result",
          value: independentlyObserved.capabilityValue,
        };
      }
      return null;
    },
  };
  const verification = await verifyTaskOutcome(main, probe);

  const mainReleased = leases.release(
    mainLease.lease.leaseId,
    main.taskId,
    verification.status === "passed" ? "completed" : "failed",
    2_500,
  );
  if (!mainReleased.ok) throw new Error("demo_main_release_failed");

  return {
    schemaVersion: 1,
    contractOnly: true,
    conflictDetected: true,
    conflictResource,
    initialWorkerId: first.selection.workerId,
    initialMachineId: first.selection.machineId,
    reroutedWorkerId: reroute.selection.workerId,
    reroutedMachineId: reroute.selection.machineId,
    firstStrategy: first.selection.executionStrategy,
    rerouteStrategy: reroute.selection.executionStrategy,
    budgetEnforced: true,
    budgetBlockReason: blockedBudget.reason,
    verification: verification.status,
  };
}
