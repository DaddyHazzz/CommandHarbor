import { describe, expect, it } from "vitest";
import { InMemoryResourceArbiter } from "./resource-arbiter";
import type { TaskEnvelope, TaskResourceRequest } from "./task-envelope";

function task(
  suffix: number,
  resources: TaskResourceRequest[],
  expiresAtMs = 10_000,
): TaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-" + String(suffix).padStart(12, "0"),
    createdAtMs: 0,
    expiresAtMs,
    principal: { kind: "worker", id: "worker-" + suffix },
    originWorkerId: "worker-" + suffix,
    objective: "test task " + suffix,
    allowedCapabilities: ["read_file", "write_file"],
    resources,
    budget: {
      maxDurationMs: 10_000,
      maxToolCalls: 10,
      maxConcurrentOperations: 2,
      maxNetworkRequests: 10,
      maxSpendMicrousd: 0,
      maxHumanApprovals: 0,
      destinations: [],
    },
    approval: { mode: "none" },
    success: [],
  };
}

function ids(): () => string {
  let next = 0;
  return () => "lease-" + String(++next);
}

describe("InMemoryResourceArbiter", () => {
  it("allows shared holders and snapshots task authority", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const resource: TaskResourceRequest = {
      kind: "repository",
      id: "repo:commandharbor",
      mode: "shared",
    };
    const firstTask = task(1, [resource]);
    const first = arbiter.acquire(firstTask, 1_000, 100);
    const second = arbiter.acquire(task(2, [resource]), 1_000, 100);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(arbiter.listActive(100)).toHaveLength(2);

    firstTask.allowedCapabilities.push("execute_command");
    if (!first.ok) throw new Error("expected first lease");
    expect(first.lease.authority.allowedCapabilities).toEqual(["read_file", "write_file"]);
    expect(first.lease.authority.principal).toEqual({ kind: "worker", id: "worker-1" });
  });

  it("rejects an exclusive request when a shared holder exists", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const shared = task(1, [{ kind: "desktop", id: "device:a", mode: "shared" }]);
    const exclusive = task(2, [{ kind: "desktop", id: "device:a", mode: "exclusive" }]);

    expect(arbiter.acquire(shared, 1_000, 100).ok).toBe(true);
    const blocked = arbiter.acquire(exclusive, 1_000, 100);

    expect(blocked.ok).toBe(false);
    if (blocked.ok || blocked.reason !== "resource_conflict") {
      throw new Error("expected resource conflict");
    }
    expect(blocked.conflicts).toHaveLength(1);
    expect(blocked.conflicts[0]?.holders[0]?.mode).toBe("shared");
  });

  it("rejects a shared request when an exclusive holder exists", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const exclusive = task(1, [{ kind: "application", id: "app:a", mode: "exclusive" }]);
    const shared = task(2, [{ kind: "application", id: "app:a", mode: "shared" }]);

    expect(arbiter.acquire(exclusive, 1_000, 100).ok).toBe(true);
    const blocked = arbiter.acquire(shared, 1_000, 100);

    expect(blocked.ok).toBe(false);
    if (blocked.ok || blocked.reason !== "resource_conflict") {
      throw new Error("expected resource conflict");
    }
    expect(blocked.conflicts[0]?.holders[0]?.mode).toBe("exclusive");
  });
  it("acquires a task resource set atomically", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    expect(
      arbiter.acquire(
        task(1, [{ kind: "repository", id: "repo:a", mode: "exclusive" }]),
        1_000,
        100,
      ).ok,
    ).toBe(true);

    const blocked = arbiter.acquire(
      task(2, [
        { kind: "desktop", id: "device:a", mode: "exclusive" },
        { kind: "repository", id: "repo:a", mode: "shared" },
      ]),
      1_000,
      100,
    );
    expect(blocked.ok).toBe(false);

    const desktopOnly = arbiter.acquire(
      task(3, [{ kind: "desktop", id: "device:a", mode: "exclusive" }]),
      1_000,
      100,
    );
    expect(desktopOnly.ok).toBe(true);
  });

  it("reaps expired leases and makes the resource available", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const resource: TaskResourceRequest = {
      kind: "paid_capability",
      id: "model:bounded",
      mode: "exclusive",
    };

    expect(arbiter.acquire(task(1, [resource]), 100, 1_000).ok).toBe(true);
    expect(arbiter.acquire(task(2, [resource]), 100, 1_099).ok).toBe(false);

    const expired = arbiter.reapExpired(1_100);
    expect(expired).toHaveLength(1);
    expect(expired[0]?.taskId).toBe(task(1, [resource]).taskId);
    expect(arbiter.acquire(task(2, [resource]), 100, 1_100).ok).toBe(true);
  });

  it("never extends a lease past the task envelope expiry", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const t = task(
      1,
      [{ kind: "device", id: "device:a", mode: "exclusive" }],
      1_300,
    );
    const acquired = arbiter.acquire(t, 1_000, 1_000);

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected lease");
    expect(acquired.lease.expiresAtMs).toBe(1_300);
  });

  it("renews only the exact task lease and remains task-bounded", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const t = task(
      1,
      [{ kind: "browser_session", id: "browser:a", mode: "exclusive" }],
      2_000,
    );
    const acquired = arbiter.acquire(t, 200, 1_000);
    if (!acquired.ok) throw new Error("expected lease");

    expect(
      arbiter.renew(acquired.lease.leaseId, task(2, []).taskId, 500, 1_100),
    ).toEqual({ ok: false, reason: "lease_owner_mismatch" });

    const renewed = arbiter.renew(acquired.lease.leaseId, t.taskId, 5_000, 1_100);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error("expected renewal");
    expect(renewed.lease.expiresAtMs).toBe(2_000);
  });

  it("releases only the exact lease owner and records why", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const t = task(1, [{ kind: "process_session", id: "proc:a", mode: "exclusive" }]);
    const acquired = arbiter.acquire(t, 500, 1_000);
    if (!acquired.ok) throw new Error("expected lease");

    expect(
      arbiter.release(acquired.lease.leaseId, task(2, []).taskId, "manual", 1_100),
    ).toEqual({ ok: false, reason: "lease_owner_mismatch" });

    const released = arbiter.release(
      acquired.lease.leaseId,
      t.taskId,
      "worker_lost",
      1_100,
    );
    expect(released.ok).toBe(true);
    if (!released.ok) throw new Error("expected release");
    expect(released.reason).toBe("worker_lost");
    expect(arbiter.listActive(1_100)).toHaveLength(0);
  });

  it("keeps one atomic active lease per task", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });
    const t = task(1, [{ kind: "application", id: "app:a", mode: "shared" }]);

    expect(arbiter.acquire(t, 500, 1_000).ok).toBe(true);
    const duplicate = arbiter.acquire(t, 500, 1_000);
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("expected duplicate lease rejection");
    expect(duplicate.reason).toBe("task_already_leased");
  });

  it("treats resource kind and id as the exact resource identity", () => {
    const arbiter = new InMemoryResourceArbiter({ leaseIdFactory: ids() });

    expect(
      arbiter.acquire(
        task(1, [{ kind: "filesystem_path", id: "same", mode: "exclusive" }]),
        500,
        1_000,
      ).ok,
    ).toBe(true);
    expect(
      arbiter.acquire(
        task(2, [{ kind: "repository", id: "same", mode: "exclusive" }]),
        500,
        1_000,
      ).ok,
    ).toBe(true);
  });
});
