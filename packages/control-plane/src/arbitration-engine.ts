import {
  EXECUTION_STRATEGY_ORDER,
  type ExecutionStrategy,
  type StrategyAvailability,
} from "./execution-strategy";
import type { TaskEnvelope, TaskResourceRequest } from "./task-envelope";
import type { WorkerDescriptor } from "./worker-adapter";

export interface ArbitrationCandidate {
  worker: WorkerDescriptor;
  machineId: string | null;
  available: boolean;
  strategies: StrategyAvailability[];
}

export interface ArbitrationRequest {
  task: TaskEnvelope;
  requiredCapabilities: string[];
  candidates: ArbitrationCandidate[];
}

export interface EligibleArbitrationCandidate {
  workerId: string;
  machineId: string | null;
  provider: string;
  workerKind: WorkerDescriptor["kind"];
  strategy: ExecutionStrategy;
  strategyRank: number;
  grantedCapabilities: string[];
}

export interface ArbitrationSelection {
  workerId: string;
  machineId: string | null;
  provider: string;
  workerKind: WorkerDescriptor["kind"];
  executionStrategy: ExecutionStrategy;
  grantedCapabilities: string[];
  resources: TaskResourceRequest[];
}

interface ArbitrationResultBase {
  taskId: string;
}

export type ArbitrationResult =
  | (ArbitrationResultBase & {
      status: "selected";
      reason: "only_eligible_candidate" | "strongest_strategy";
      selection: ArbitrationSelection;
      eligible: EligibleArbitrationCandidate[];
      fallback: { type: "none" };
    })
  | (ArbitrationResultBase & {
      status: "ambiguous";
      reason: "equally_ranked_candidates";
      eligible: EligibleArbitrationCandidate[];
      fallback: { type: "bounded_decision" };
    })
  | (ArbitrationResultBase & {
      status: "blocked";
      reason:
        | "task_expired"
        | "capability_outside_task_authority"
        | "no_eligible_worker";
      deniedCapabilities?: string[];
      fallback: { type: "none" | "escalate" };
    });

export type ArbitrationChoiceValidation =
  | { ok: true; selection: ArbitrationSelection }
  | { ok: false; reason: "task_mismatch" | "worker_not_eligible" };

const STRATEGY_SET = new Set<string>(EXECUTION_STRATEGY_ORDER);

function cloneResources(resources: readonly TaskResourceRequest[]): TaskResourceRequest[] {
  return resources.map((resource) => ({
    kind: resource.kind,
    id: resource.id,
    mode: resource.mode,
  }));
}

function normalizeCapabilities(capabilities: readonly string[]): string[] {
  if (!Array.isArray(capabilities) || capabilities.length > 128) {
    throw new Error("invalid_arbitration_capabilities");
  }
  const normalized = capabilities.map((capability) => {
    if (typeof capability !== "string") {
      throw new Error("invalid_arbitration_capabilities");
    }
    const value = capability.trim();
    if (value.length === 0 || value.length > 128) {
      throw new Error("invalid_arbitration_capabilities");
    }
    return value;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("invalid_arbitration_capabilities");
  }
  return normalized;
}

function validateIdentity(value: string, error: string): string {
  if (typeof value !== "string") {
    throw new Error(error);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256) {
    throw new Error(error);
  }
  return normalized;
}

function candidateStrategy(candidate: ArbitrationCandidate): {
  strategy: ExecutionStrategy;
  rank: number;
} | null {
  const workerStrategies = new Set(
    candidate.worker.executionStrategies.filter(
      (strategy): strategy is ExecutionStrategy => STRATEGY_SET.has(strategy),
    ),
  );

  const availability = new Map<ExecutionStrategy, boolean>();
  for (const item of candidate.strategies) {
    if (availability.has(item.strategy)) {
      throw new Error("duplicate_strategy_availability");
    }
    availability.set(item.strategy, item.available);
  }

  for (let rank = 0; rank < EXECUTION_STRATEGY_ORDER.length; rank += 1) {
    const strategy = EXECUTION_STRATEGY_ORDER[rank]!;
    if (workerStrategies.has(strategy) && availability.get(strategy) === true) {
      return { strategy, rank };
    }
  }
  return null;
}

function eligibleCandidates(
  request: ArbitrationRequest,
  requiredCapabilities: string[],
): EligibleArbitrationCandidate[] {
  if (!Array.isArray(request.candidates) || request.candidates.length > 256) {
    throw new Error("invalid_arbitration_candidates");
  }

  const seenWorkers = new Set<string>();
  const eligible: EligibleArbitrationCandidate[] = [];

  for (const candidate of request.candidates) {
    if (typeof candidate !== "object" || candidate === null) {
      throw new Error("invalid_arbitration_candidate");
    }
    const workerId = validateIdentity(
      candidate.worker.workerId,
      "invalid_arbitration_worker",
    );
    const provider = validateIdentity(
      candidate.worker.provider,
      "invalid_arbitration_provider",
    );
    const machineId =
      candidate.machineId === null
        ? null
        : validateIdentity(candidate.machineId, "invalid_arbitration_machine");

    if (seenWorkers.has(workerId)) {
      throw new Error("duplicate_arbitration_worker");
    }
    seenWorkers.add(workerId);

    if (!candidate.available) {
      continue;
    }

    const workerCapabilities = new Set(normalizeCapabilities(candidate.worker.capabilities));
    if (requiredCapabilities.some((capability) => !workerCapabilities.has(capability))) {
      continue;
    }

    const strategy = candidateStrategy(candidate);
    if (strategy === null) {
      continue;
    }

    eligible.push({
      workerId,
      machineId,
      provider,
      workerKind: candidate.worker.kind,
      strategy: strategy.strategy,
      strategyRank: strategy.rank,
      grantedCapabilities: [...requiredCapabilities],
    });
  }

  return eligible.sort((left, right) => left.workerId.localeCompare(right.workerId));
}

function selectionFromCandidate(
  task: TaskEnvelope,
  candidate: EligibleArbitrationCandidate,
): ArbitrationSelection {
  return {
    workerId: candidate.workerId,
    machineId: candidate.machineId,
    provider: candidate.provider,
    workerKind: candidate.workerKind,
    executionStrategy: candidate.strategy,
    grantedCapabilities: [...candidate.grantedCapabilities],
    resources: cloneResources(task.resources),
  };
}

/**
 * Deterministic, side-effect-free worker/strategy arbitration.
 *
 * This function does not acquire resources, reserve budget, dispatch work, or
 * invoke a model. It identifies what is already allowed and mechanically
 * decidable. Ambiguity is returned explicitly for a higher decision layer.
 */
export function arbitrateDeterministically(
  request: ArbitrationRequest,
  nowMs: number = Date.now(),
): ArbitrationResult {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("invalid_arbitration_time");
  }

  const taskId = request.task.taskId;
  if (request.task.expiresAtMs <= nowMs) {
    return {
      taskId,
      status: "blocked",
      reason: "task_expired",
      fallback: { type: "none" },
    };
  }

  const requiredCapabilities = normalizeCapabilities(request.requiredCapabilities);
  const taskCapabilities = new Set(request.task.allowedCapabilities);
  const deniedCapabilities = requiredCapabilities.filter(
    (capability) => !taskCapabilities.has(capability),
  );
  if (deniedCapabilities.length > 0) {
    return {
      taskId,
      status: "blocked",
      reason: "capability_outside_task_authority",
      deniedCapabilities,
      fallback: { type: "none" },
    };
  }

  const eligible = eligibleCandidates(request, requiredCapabilities);
  if (eligible.length === 0) {
    return {
      taskId,
      status: "blocked",
      reason: "no_eligible_worker",
      fallback: { type: "escalate" },
    };
  }

  if (eligible.length === 1) {
    return {
      taskId,
      status: "selected",
      reason: "only_eligible_candidate",
      selection: selectionFromCandidate(request.task, eligible[0]!),
      eligible,
      fallback: { type: "none" },
    };
  }

  const bestRank = Math.min(...eligible.map((candidate) => candidate.strategyRank));
  const best = eligible.filter((candidate) => candidate.strategyRank === bestRank);

  if (best.length === 1) {
    return {
      taskId,
      status: "selected",
      reason: "strongest_strategy",
      selection: selectionFromCandidate(request.task, best[0]!),
      eligible,
      fallback: { type: "none" },
    };
  }

  return {
    taskId,
    status: "ambiguous",
    reason: "equally_ranked_candidates",
    eligible: best,
    fallback: { type: "bounded_decision" },
  };
}

/**
 * Converts a model/human suggestion into an authorized selection only if the
 * ambiguity belongs to the same task and the worker was already proven
 * eligible by deterministic arbitration.
 */
export function validateArbitrationChoice(
  task: TaskEnvelope,
  ambiguous: Extract<ArbitrationResult, { status: "ambiguous" }>,
  workerId: string,
): ArbitrationChoiceValidation {
  if (ambiguous.taskId !== task.taskId) {
    return { ok: false, reason: "task_mismatch" };
  }

  const candidate = ambiguous.eligible.find((item) => item.workerId === workerId);
  if (candidate === undefined) {
    return { ok: false, reason: "worker_not_eligible" };
  }
  return { ok: true, selection: selectionFromCandidate(task, candidate) };
}
