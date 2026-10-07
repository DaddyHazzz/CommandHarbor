import { describe, expect, it } from "vitest";
import { InMemoryTaskBudgetLedger } from "./budget-ledger";
import type { TaskEnvelope } from "./task-envelope";

function task(overrides: Partial<TaskEnvelope["budget"]> = {}): TaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 1_000,
    expiresAtMs: 11_000,
    principal: { kind: "worker", id: "worker-1" },
    originWorkerId: "worker-1",
    objective: "budget test",
    allowedCapabilities: ["execute"],
    resources: [],
    budget: {
      maxDurationMs: 5_000,
      maxToolCalls: 3,
      maxConcurrentOperations: 2,
      maxNetworkRequests: 10,
      maxSpendMicrousd: 1_000,
      maxHumanApprovals: 2,
      destinations: [
        { destination: "api:example", maxRequests: 5, maxConcurrent: 1 },
      ],
      ...overrides,
    },
    approval: { mode: "none" },
    success: [],
  };
}

function ids(): () => string {
  let next = 0;
  return () => "reservation-" + String(++next);
}

const zero = {
  networkRequests: 0,
  spendMicrousd: 0,
  humanApprovals: 0,
  destinations: [],
};

describe("InMemoryTaskBudgetLedger", () => {
  it("reserves capacity before dispatch and settles actual usage", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    const reserved = ledger.reserveOperation({
      networkRequests: 4,
      spendMicrousd: 500,
      humanApprovals: 1,
      destinations: [{ destination: "api:example", requests: 4 }],
    }, 2_000);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) throw new Error("expected reservation");

    expect(ledger.snapshot(2_000)).toMatchObject({
      committed: { toolCalls: 0, networkRequests: 0, spendMicrousd: 0, humanApprovals: 0 },
      reserved: { toolCalls: 1, networkRequests: 4, spendMicrousd: 500, humanApprovals: 1 },
      concurrentOperations: 1,
    });

    const settled = ledger.settleOperation(reserved.reservation.reservationId, task().taskId, {
      networkRequests: 2,
      spendMicrousd: 300,
      humanApprovals: 1,
      destinations: [{ destination: "api:example", requests: 2 }],
    }, 2_100);
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error("expected settlement");
    expect(settled.snapshot.committed).toEqual({
      toolCalls: 1,
      networkRequests: 2,
      spendMicrousd: 300,
      humanApprovals: 1,
    });
    expect(settled.snapshot.concurrentOperations).toBe(0);
  });

  it("blocks concurrent reservations from oversubscribing a global budget", () => {
    const ledger = new InMemoryTaskBudgetLedger(task({ maxSpendMicrousd: 1_000 }), {
      reservationIdFactory: ids(),
    });
    expect(ledger.reserveOperation({ ...zero, spendMicrousd: 700 }, 2_000).ok).toBe(true);
    expect(ledger.reserveOperation({ ...zero, spendMicrousd: 400 }, 2_000)).toEqual({
      ok: false,
      reason: "max_spend",
    });
  });

  it("enforces max concurrent operations immediately", () => {
    const ledger = new InMemoryTaskBudgetLedger(task({ maxConcurrentOperations: 1 }), {
      reservationIdFactory: ids(),
    });
    expect(ledger.reserveOperation(zero, 2_000).ok).toBe(true);
    expect(ledger.reserveOperation(zero, 2_000)).toEqual({
      ok: false,
      reason: "max_concurrent_operations",
    });
  });

  it("enforces destination request and concurrency budgets", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    expect(ledger.reserveOperation({
      ...zero,
      networkRequests: 3,
      destinations: [{ destination: "api:example", requests: 3 }],
    }, 2_000).ok).toBe(true);

    expect(ledger.reserveOperation({
      ...zero,
      networkRequests: 1,
      destinations: [{ destination: "api:example", requests: 1 }],
    }, 2_000)).toEqual({
      ok: false,
      reason: "destination_max_concurrent",
      destination: "api:example",
    });
  });

  it("enforces destination request totals after completed operations", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    const first = ledger.reserveOperation({
      ...zero,
      networkRequests: 4,
      destinations: [{ destination: "api:example", requests: 4 }],
    }, 2_000);
    if (!first.ok) throw new Error("expected first reservation");
    expect(ledger.settleOperation(first.reservation.reservationId, task().taskId, {
      ...zero,
      networkRequests: 4,
      destinations: [{ destination: "api:example", requests: 4 }],
    }, 2_100).ok).toBe(true);

    expect(ledger.reserveOperation({
      ...zero,
      networkRequests: 2,
      destinations: [{ destination: "api:example", requests: 2 }],
    }, 2_200)).toEqual({
      ok: false,
      reason: "destination_max_requests",
      destination: "api:example",
    });
  });

  it("cancels an undispatched reservation without consuming budget", () => {
    const ledger = new InMemoryTaskBudgetLedger(task({ maxToolCalls: 1 }), {
      reservationIdFactory: ids(),
    });
    const reserved = ledger.reserveOperation(zero, 2_000);
    if (!reserved.ok) throw new Error("expected reservation");
    expect(ledger.cancelReservation(
      reserved.reservation.reservationId,
      task().taskId,
      2_100,
    ).ok).toBe(true);
    expect(ledger.reserveOperation(zero, 2_200).ok).toBe(true);
  });

  it("rejects usage that exceeds its reservation", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    const reserved = ledger.reserveOperation({ ...zero, networkRequests: 2 }, 2_000);
    if (!reserved.ok) throw new Error("expected reservation");

    expect(ledger.settleOperation(reserved.reservation.reservationId, task().taskId, {
      ...zero,
      networkRequests: 3,
    }, 2_100)).toEqual({
      ok: false,
      reason: "actual_exceeds_reservation",
    });
    expect(ledger.snapshot(2_100).concurrentOperations).toBe(1);
  });

  it("requires exact task ownership for settle and cancel", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    const reserved = ledger.reserveOperation(zero, 2_000);
    if (!reserved.ok) throw new Error("expected reservation");

    expect(ledger.settleOperation(
      reserved.reservation.reservationId,
      "00000000-0000-4000-8000-000000000002",
      zero,
      2_100,
    )).toEqual({ ok: false, reason: "reservation_task_mismatch" });

    expect(ledger.cancelReservation(
      reserved.reservation.reservationId,
      "00000000-0000-4000-8000-000000000002",
      2_100,
    )).toEqual({ ok: false, reason: "reservation_task_mismatch" });
  });

  it("enforces the earlier of Task Envelope expiry and max duration", () => {
    const ledger = new InMemoryTaskBudgetLedger(task({ maxDurationMs: 2_000 }), {
      reservationIdFactory: ids(),
    });
    expect(ledger.snapshot(2_999).deadlineMs).toBe(3_000);
    expect(ledger.reserveOperation(zero, 2_999).ok).toBe(true);

    const second = new InMemoryTaskBudgetLedger(task({ maxDurationMs: 2_000 }), {
      reservationIdFactory: ids(),
    });
    expect(second.reserveOperation(zero, 3_000)).toEqual({
      ok: false,
      reason: "duration_exhausted",
    });
  });

  it("allows settlement after the deadline so final usage is still accounted", () => {
    const ledger = new InMemoryTaskBudgetLedger(task({ maxDurationMs: 2_000 }), {
      reservationIdFactory: ids(),
    });
    const reserved = ledger.reserveOperation({ ...zero, spendMicrousd: 100 }, 2_999);
    if (!reserved.ok) throw new Error("expected reservation");

    const settled = ledger.settleOperation(
      reserved.reservation.reservationId,
      task().taskId,
      { ...zero, spendMicrousd: 80 },
      3_500,
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error("expected settlement");
    expect(settled.snapshot.committed.spendMicrousd).toBe(80);
  });
  it("enforces tool, network, spend, and approval maxima independently", () => {
    const cases = [
      [task({ maxToolCalls: 0 }), zero, "max_tool_calls"],
      [task({ maxNetworkRequests: 0 }), { ...zero, networkRequests: 1 }, "max_network_requests"],
      [task({ maxSpendMicrousd: 0 }), { ...zero, spendMicrousd: 1 }, "max_spend"],
      [task({ maxHumanApprovals: 0 }), { ...zero, humanApprovals: 1 }, "max_human_approvals"],
    ] as const;

    for (const [envelope, request, reason] of cases) {
      const ledger = new InMemoryTaskBudgetLedger(envelope, { reservationIdFactory: ids() });
      expect(ledger.reserveOperation(request, 2_000)).toEqual({ ok: false, reason });
    }
  });

  it("requires destination request reservations to fit inside global network reservation", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    expect(() => ledger.reserveOperation({
      ...zero,
      networkRequests: 1,
      destinations: [{ destination: "api:example", requests: 2 }],
    }, 2_000)).toThrow("destination_requests_exceed_network_reservation");
  });

  it("applies global network budget to destinations without a special destination budget", () => {
    const ledger = new InMemoryTaskBudgetLedger(task(), { reservationIdFactory: ids() });
    expect(ledger.reserveOperation({
      ...zero,
      networkRequests: 2,
      destinations: [{ destination: "api:other", requests: 2 }],
    }, 2_000).ok).toBe(true);
  });
});
