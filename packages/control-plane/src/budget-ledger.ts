import type { DestinationBudget, TaskEnvelope } from "./task-envelope";

export interface DestinationReservation {
  destination: string;
  requests: number;
}

export interface OperationBudgetReservationRequest {
  networkRequests: number;
  spendMicrousd: number;
  humanApprovals: number;
  destinations: DestinationReservation[];
}

export interface OperationBudgetReservation {
  schemaVersion: 1;
  reservationId: string;
  taskId: string;
  reservedAtMs: number;
  request: OperationBudgetReservationRequest;
}

export interface OperationBudgetUsage {
  networkRequests: number;
  spendMicrousd: number;
  humanApprovals: number;
  destinations: DestinationReservation[];
}

export interface BudgetCounters {
  toolCalls: number;
  networkRequests: number;
  spendMicrousd: number;
  humanApprovals: number;
}

export interface DestinationBudgetSnapshot {
  destination: string;
  requests: number;
  concurrentOperations: number;
  maxRequests: number;
  maxConcurrent: number;
}

export interface TaskBudgetSnapshot {
  schemaVersion: 1;
  taskId: string;
  deadlineMs: number;
  committed: BudgetCounters;
  reserved: BudgetCounters;
  concurrentOperations: number;
  destinations: DestinationBudgetSnapshot[];
}

export type BudgetBlockReason =
  | "duration_exhausted"
  | "max_tool_calls"
  | "max_concurrent_operations"
  | "max_network_requests"
  | "max_spend"
  | "max_human_approvals"
  | "destination_max_requests"
  | "destination_max_concurrent";

export type ReserveOperationResult =
  | { ok: true; reservation: OperationBudgetReservation }
  | { ok: false; reason: BudgetBlockReason; destination?: string };

export type SettleOperationResult =
  | { ok: true; snapshot: TaskBudgetSnapshot }
  | {
      ok: false;
      reason:
        | "reservation_not_found"
        | "reservation_task_mismatch"
        | "actual_exceeds_reservation";
    };

export type CancelReservationResult =
  | { ok: true; snapshot: TaskBudgetSnapshot }
  | {
      ok: false;
      reason: "reservation_not_found" | "reservation_task_mismatch";
    };

export interface TaskBudgetLedgerOptions {
  reservationIdFactory?: () => string;
}

interface MutableCounters extends BudgetCounters {}

interface MutableDestinationState {
  requests: number;
  concurrentOperations: number;
}

interface StoredReservation extends OperationBudgetReservation {
  destinationMap: Map<string, number>;
}

function nonnegativeInt(value: number, error: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(error);
  }
  return value;
}

function assertNowMs(nowMs: number): void {
  nonnegativeInt(nowMs, "invalid_budget_time");
}

function parseDestinationReservations(
  value: readonly DestinationReservation[],
  error: string,
): DestinationReservation[] {
  if (!Array.isArray(value) || value.length > 64) {
    throw new Error(error);
  }

  const seen = new Set<string>();
  const parsed: DestinationReservation[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      throw new Error(error);
    }
    const destination = item.destination.trim();
    if (destination.length === 0 || destination.length > 512 || seen.has(destination)) {
      throw new Error(error);
    }
    const requests = nonnegativeInt(item.requests, error);
    seen.add(destination);
    parsed.push({ destination, requests });
  }
  return parsed;
}

function parseReservationRequest(
  request: OperationBudgetReservationRequest,
): OperationBudgetReservationRequest {
  if (typeof request !== "object" || request === null) {
    throw new Error("invalid_budget_reservation");
  }

  const parsed = {
    networkRequests: nonnegativeInt(
      request.networkRequests,
      "invalid_budget_reservation",
    ),
    spendMicrousd: nonnegativeInt(
      request.spendMicrousd,
      "invalid_budget_reservation",
    ),
    humanApprovals: nonnegativeInt(
      request.humanApprovals,
      "invalid_budget_reservation",
    ),
    destinations: parseDestinationReservations(
      request.destinations,
      "invalid_budget_reservation",
    ),
  };

  const attributedRequests = parsed.destinations.reduce(
    (sum, item) => sum + item.requests,
    0,
  );
  if (attributedRequests > parsed.networkRequests) {
    throw new Error("destination_requests_exceed_network_reservation");
  }

  return parsed;
}

function parseUsage(usage: OperationBudgetUsage): OperationBudgetUsage {
  if (typeof usage !== "object" || usage === null) {
    throw new Error("invalid_budget_usage");
  }

  const parsed = {
    networkRequests: nonnegativeInt(
      usage.networkRequests,
      "invalid_budget_usage",
    ),
    spendMicrousd: nonnegativeInt(usage.spendMicrousd, "invalid_budget_usage"),
    humanApprovals: nonnegativeInt(
      usage.humanApprovals,
      "invalid_budget_usage",
    ),
    destinations: parseDestinationReservations(
      usage.destinations,
      "invalid_budget_usage",
    ),
  };

  const attributedRequests = parsed.destinations.reduce(
    (sum, item) => sum + item.requests,
    0,
  );
  if (attributedRequests > parsed.networkRequests) {
    throw new Error("destination_requests_exceed_network_usage");
  }

  return parsed;
}

function destinationMap(
  destinations: readonly DestinationReservation[],
): Map<string, number> {
  return new Map(destinations.map((item) => [item.destination, item.requests]));
}

function cloneReservation(
  reservation: StoredReservation,
): OperationBudgetReservation {
  return {
    schemaVersion: 1,
    reservationId: reservation.reservationId,
    taskId: reservation.taskId,
    reservedAtMs: reservation.reservedAtMs,
    request: {
      networkRequests: reservation.request.networkRequests,
      spendMicrousd: reservation.request.spendMicrousd,
      humanApprovals: reservation.request.humanApprovals,
      destinations: reservation.request.destinations.map((item) => ({ ...item })),
    },
  };
}

function addCounters(
  target: MutableCounters,
  value: Omit<BudgetCounters, "toolCalls"> & { toolCalls?: number },
): void {
  target.toolCalls += value.toolCalls ?? 0;
  target.networkRequests += value.networkRequests;
  target.spendMicrousd += value.spendMicrousd;
  target.humanApprovals += value.humanApprovals;
}

function subtractCounters(
  target: MutableCounters,
  value: Omit<BudgetCounters, "toolCalls"> & { toolCalls?: number },
): void {
  target.toolCalls -= value.toolCalls ?? 0;
  target.networkRequests -= value.networkRequests;
  target.spendMicrousd -= value.spendMicrousd;
  target.humanApprovals -= value.humanApprovals;
}

function destinationBudgetMap(
  budgets: readonly DestinationBudget[],
): Map<string, DestinationBudget> {
  return new Map(budgets.map((item) => [item.destination, item]));
}

export class InMemoryTaskBudgetLedger {
  private readonly task: TaskEnvelope;
  private readonly reservationIdFactory: () => string;
  private readonly committed: MutableCounters = {
    toolCalls: 0,
    networkRequests: 0,
    spendMicrousd: 0,
    humanApprovals: 0,
  };
  private readonly reserved: MutableCounters = {
    toolCalls: 0,
    networkRequests: 0,
    spendMicrousd: 0,
    humanApprovals: 0,
  };
  private readonly destinationBudgets: Map<string, DestinationBudget>;
  private readonly destinationCommitted = new Map<string, MutableDestinationState>();
  private readonly destinationReserved = new Map<string, MutableDestinationState>();
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly deadlineMs: number;

  constructor(task: TaskEnvelope, options: TaskBudgetLedgerOptions = {}) {
    this.task = task;
    this.reservationIdFactory =
      options.reservationIdFactory ?? (() => crypto.randomUUID());
    this.destinationBudgets = destinationBudgetMap(task.budget.destinations);
    this.deadlineMs = Math.min(
      task.expiresAtMs,
      task.createdAtMs + task.budget.maxDurationMs,
    );
  }

  reserveOperation(
    request: OperationBudgetReservationRequest,
    nowMs: number = Date.now(),
  ): ReserveOperationResult {
    assertNowMs(nowMs);
    const parsed = parseReservationRequest(request);

    if (nowMs >= this.deadlineMs) {
      return { ok: false, reason: "duration_exhausted" };
    }
    if (
      this.committed.toolCalls +
        this.reserved.toolCalls +
        1 >
      this.task.budget.maxToolCalls
    ) {
      return { ok: false, reason: "max_tool_calls" };
    }
    if (this.reservations.size + 1 > this.task.budget.maxConcurrentOperations) {
      return { ok: false, reason: "max_concurrent_operations" };
    }
    if (
      this.committed.networkRequests +
        this.reserved.networkRequests +
        parsed.networkRequests >
      this.task.budget.maxNetworkRequests
    ) {
      return { ok: false, reason: "max_network_requests" };
    }
    if (
      this.committed.spendMicrousd +
        this.reserved.spendMicrousd +
        parsed.spendMicrousd >
      this.task.budget.maxSpendMicrousd
    ) {
      return { ok: false, reason: "max_spend" };
    }
    if (
      this.committed.humanApprovals +
        this.reserved.humanApprovals +
        parsed.humanApprovals >
      this.task.budget.maxHumanApprovals
    ) {
      return { ok: false, reason: "max_human_approvals" };
    }

    for (const item of parsed.destinations) {
      const budget = this.destinationBudgets.get(item.destination);
      if (budget === undefined) {
        continue;
      }
      const committed = this.destinationCommitted.get(item.destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      const reserved = this.destinationReserved.get(item.destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      if (committed.requests + reserved.requests + item.requests > budget.maxRequests) {
        return {
          ok: false,
          reason: "destination_max_requests",
          destination: item.destination,
        };
      }
      if (
        item.requests > 0 &&
        committed.concurrentOperations +
          reserved.concurrentOperations +
          1 >
          budget.maxConcurrent
      ) {
        return {
          ok: false,
          reason: "destination_max_concurrent",
          destination: item.destination,
        };
      }
    }

    const reservationId = this.reservationIdFactory().trim();
    if (
      reservationId.length === 0 ||
      reservationId.length > 256 ||
      this.reservations.has(reservationId)
    ) {
      throw new Error(
        this.reservations.has(reservationId)
          ? "duplicate_budget_reservation_id"
          : "invalid_budget_reservation_id",
      );
    }

    const reservation: StoredReservation = {
      schemaVersion: 1,
      reservationId,
      taskId: this.task.taskId,
      reservedAtMs: nowMs,
      request: parsed,
      destinationMap: destinationMap(parsed.destinations),
    };
    this.reservations.set(reservationId, reservation);
    addCounters(this.reserved, {
      toolCalls: 1,
      networkRequests: parsed.networkRequests,
      spendMicrousd: parsed.spendMicrousd,
      humanApprovals: parsed.humanApprovals,
    });
    for (const item of parsed.destinations) {
      const state = this.destinationReserved.get(item.destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      state.requests += item.requests;
      if (item.requests > 0) {
        state.concurrentOperations += 1;
      }
      this.destinationReserved.set(item.destination, state);
    }

    return { ok: true, reservation: cloneReservation(reservation) };
  }

  settleOperation(
    reservationId: string,
    taskId: string,
    usage: OperationBudgetUsage,
    nowMs: number = Date.now(),
  ): SettleOperationResult {
    assertNowMs(nowMs);
    const parsed = parseUsage(usage);
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      return { ok: false, reason: "reservation_not_found" };
    }
    if (reservation.taskId !== taskId) {
      return { ok: false, reason: "reservation_task_mismatch" };
    }

    const actualDestinationMap = destinationMap(parsed.destinations);
    if (
      parsed.networkRequests > reservation.request.networkRequests ||
      parsed.spendMicrousd > reservation.request.spendMicrousd ||
      parsed.humanApprovals > reservation.request.humanApprovals
    ) {
      return { ok: false, reason: "actual_exceeds_reservation" };
    }
    for (const [destination, requests] of actualDestinationMap) {
      if (requests > (reservation.destinationMap.get(destination) ?? 0)) {
        return { ok: false, reason: "actual_exceeds_reservation" };
      }
    }

    this.removeReservation(reservation);
    addCounters(this.committed, {
      toolCalls: 1,
      networkRequests: parsed.networkRequests,
      spendMicrousd: parsed.spendMicrousd,
      humanApprovals: parsed.humanApprovals,
    });
    for (const item of parsed.destinations) {
      const state = this.destinationCommitted.get(item.destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      state.requests += item.requests;
      this.destinationCommitted.set(item.destination, state);
    }

    return { ok: true, snapshot: this.snapshot(nowMs) };
  }

  cancelReservation(
    reservationId: string,
    taskId: string,
    nowMs: number = Date.now(),
  ): CancelReservationResult {
    assertNowMs(nowMs);
    const reservation = this.reservations.get(reservationId);
    if (reservation === undefined) {
      return { ok: false, reason: "reservation_not_found" };
    }
    if (reservation.taskId !== taskId) {
      return { ok: false, reason: "reservation_task_mismatch" };
    }

    this.removeReservation(reservation);
    return { ok: true, snapshot: this.snapshot(nowMs) };
  }

  snapshot(nowMs: number = Date.now()): TaskBudgetSnapshot {
    assertNowMs(nowMs);
    const destinations: DestinationBudgetSnapshot[] = [];

    for (const [destination, budget] of this.destinationBudgets) {
      const committed = this.destinationCommitted.get(destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      const reserved = this.destinationReserved.get(destination) ?? {
        requests: 0,
        concurrentOperations: 0,
      };
      destinations.push({
        destination,
        requests: committed.requests + reserved.requests,
        concurrentOperations:
          committed.concurrentOperations + reserved.concurrentOperations,
        maxRequests: budget.maxRequests,
        maxConcurrent: budget.maxConcurrent,
      });
    }

    return {
      schemaVersion: 1,
      taskId: this.task.taskId,
      deadlineMs: this.deadlineMs,
      committed: { ...this.committed },
      reserved: { ...this.reserved },
      concurrentOperations: this.reservations.size,
      destinations,
    };
  }

  private removeReservation(reservation: StoredReservation): void {
    this.reservations.delete(reservation.reservationId);
    subtractCounters(this.reserved, {
      toolCalls: 1,
      networkRequests: reservation.request.networkRequests,
      spendMicrousd: reservation.request.spendMicrousd,
      humanApprovals: reservation.request.humanApprovals,
    });

    for (const item of reservation.request.destinations) {
      const state = this.destinationReserved.get(item.destination);
      if (state === undefined) {
        continue;
      }
      state.requests -= item.requests;
      if (item.requests > 0) {
        state.concurrentOperations -= 1;
      }
      if (state.requests === 0 && state.concurrentOperations === 0) {
        this.destinationReserved.delete(item.destination);
      }
    }
  }
}
