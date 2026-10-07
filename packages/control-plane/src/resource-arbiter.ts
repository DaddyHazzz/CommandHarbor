import type {
  ResourceMode,
  TaskEnvelope,
  TaskPrincipal,
  TaskResourceRequest,
} from "./task-envelope";

export interface LeaseAuthority {
  principal: TaskPrincipal;
  originWorkerId: string | null;
  allowedCapabilities: string[];
}

export interface ResourceLease {
  schemaVersion: 1;
  leaseId: string;
  taskId: string;
  authority: LeaseAuthority;
  resources: TaskResourceRequest[];
  acquiredAtMs: number;
  expiresAtMs: number;
  taskExpiresAtMs: number;
}

export interface ResourceConflictHolder {
  leaseId: string;
  taskId: string;
  owner: TaskPrincipal;
  mode: ResourceMode;
  expiresAtMs: number;
}

export interface ResourceConflict {
  resource: TaskResourceRequest;
  holders: ResourceConflictHolder[];
}

export type LeaseAcquireResult =
  | { ok: true; lease: ResourceLease }
  | { ok: false; reason: "task_expired" }
  | { ok: false; reason: "task_already_leased"; lease: ResourceLease }
  | { ok: false; reason: "resource_conflict"; conflicts: ResourceConflict[] };

export type LeaseRenewResult =
  | { ok: true; lease: ResourceLease }
  | { ok: false; reason: "lease_not_found" | "lease_owner_mismatch" };

export type LeaseReleaseReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "worker_lost"
  | "manual";

export type LeaseReleaseResult =
  | { ok: true; lease: ResourceLease; reason: LeaseReleaseReason }
  | { ok: false; reason: "lease_not_found" | "lease_owner_mismatch" };

export interface ResourceArbiterOptions {
  leaseIdFactory?: () => string;
}

function assertNowMs(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("invalid_lease_time");
  }
}

function assertDurationMs(durationMs: number): void {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error("invalid_lease_duration");
  }
}

function clonePrincipal(principal: TaskPrincipal): TaskPrincipal {
  return { kind: principal.kind, id: principal.id };
}

function cloneResource(resource: TaskResourceRequest): TaskResourceRequest {
  return { kind: resource.kind, id: resource.id, mode: resource.mode };
}

function cloneLease(lease: ResourceLease): ResourceLease {
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    taskId: lease.taskId,
    authority: {
      principal: clonePrincipal(lease.authority.principal),
      originWorkerId: lease.authority.originWorkerId,
      allowedCapabilities: [...lease.authority.allowedCapabilities],
    },
    resources: lease.resources.map(cloneResource),
    acquiredAtMs: lease.acquiredAtMs,
    expiresAtMs: lease.expiresAtMs,
    taskExpiresAtMs: lease.taskExpiresAtMs,
  };
}

function resourceKey(resource: TaskResourceRequest): string {
  return resource.kind + "\0" + resource.id;
}

function modesConflict(requested: ResourceMode, existing: ResourceMode): boolean {
  return requested === "exclusive" || existing === "exclusive";
}

export class InMemoryResourceArbiter {
  private readonly leases = new Map<string, ResourceLease>();
  private readonly leaseByTaskId = new Map<string, string>();
  private readonly leaseIdFactory: () => string;

  constructor(options: ResourceArbiterOptions = {}) {
    this.leaseIdFactory = options.leaseIdFactory ?? (() => crypto.randomUUID());
  }

  acquire(
    task: TaskEnvelope,
    leaseDurationMs: number,
    nowMs: number = Date.now(),
  ): LeaseAcquireResult {
    assertNowMs(nowMs);
    assertDurationMs(leaseDurationMs);
    this.reapExpired(nowMs);

    if (task.expiresAtMs <= nowMs) {
      return { ok: false, reason: "task_expired" };
    }

    const existingLeaseId = this.leaseByTaskId.get(task.taskId);
    if (existingLeaseId !== undefined) {
      const existing = this.leases.get(existingLeaseId);
      if (existing !== undefined) {
        return {
          ok: false,
          reason: "task_already_leased",
          lease: cloneLease(existing),
        };
      }
      this.leaseByTaskId.delete(task.taskId);
    }

    const conflicts = this.findConflicts(task.resources);
    if (conflicts.length > 0) {
      return { ok: false, reason: "resource_conflict", conflicts };
    }

    const leaseId = this.leaseIdFactory().trim();
    if (leaseId.length === 0 || leaseId.length > 256) {
      throw new Error("invalid_lease_id");
    }
    if (this.leases.has(leaseId)) {
      throw new Error("duplicate_lease_id");
    }

    const expiresAtMs = Math.min(task.expiresAtMs, nowMs + leaseDurationMs);
    const lease: ResourceLease = {
      schemaVersion: 1,
      leaseId,
      taskId: task.taskId,
      authority: {
        principal: clonePrincipal(task.principal),
        originWorkerId: task.originWorkerId,
        allowedCapabilities: [...task.allowedCapabilities],
      },
      resources: task.resources.map(cloneResource),
      acquiredAtMs: nowMs,
      expiresAtMs,
      taskExpiresAtMs: task.expiresAtMs,
    };

    this.leases.set(leaseId, lease);
    this.leaseByTaskId.set(task.taskId, leaseId);
    return { ok: true, lease: cloneLease(lease) };
  }

  renew(
    leaseId: string,
    taskId: string,
    leaseDurationMs: number,
    nowMs: number = Date.now(),
  ): LeaseRenewResult {
    assertNowMs(nowMs);
    assertDurationMs(leaseDurationMs);
    this.reapExpired(nowMs);

    const lease = this.leases.get(leaseId);
    if (lease === undefined) {
      return { ok: false, reason: "lease_not_found" };
    }
    if (lease.taskId !== taskId) {
      return { ok: false, reason: "lease_owner_mismatch" };
    }

    const renewed: ResourceLease = {
      ...lease,
      expiresAtMs: Math.min(lease.taskExpiresAtMs, nowMs + leaseDurationMs),
    };
    this.leases.set(leaseId, renewed);
    return { ok: true, lease: cloneLease(renewed) };
  }

  release(
    leaseId: string,
    taskId: string,
    reason: LeaseReleaseReason,
    nowMs: number = Date.now(),
  ): LeaseReleaseResult {
    assertNowMs(nowMs);
    this.reapExpired(nowMs);

    const lease = this.leases.get(leaseId);
    if (lease === undefined) {
      return { ok: false, reason: "lease_not_found" };
    }
    if (lease.taskId !== taskId) {
      return { ok: false, reason: "lease_owner_mismatch" };
    }

    this.deleteLease(lease);
    return { ok: true, lease: cloneLease(lease), reason };
  }

  reapExpired(nowMs: number = Date.now()): ResourceLease[] {
    assertNowMs(nowMs);
    const expired: ResourceLease[] = [];
    for (const lease of this.leases.values()) {
      if (lease.expiresAtMs <= nowMs) {
        expired.push(cloneLease(lease));
        this.deleteLease(lease);
      }
    }
    return expired;
  }

  listActive(nowMs: number = Date.now()): ResourceLease[] {
    this.reapExpired(nowMs);
    return [...this.leases.values()].map(cloneLease);
  }

  leaseForTask(taskId: string, nowMs: number = Date.now()): ResourceLease | null {
    this.reapExpired(nowMs);
    const leaseId = this.leaseByTaskId.get(taskId);
    if (leaseId === undefined) {
      return null;
    }
    const lease = this.leases.get(leaseId);
    return lease === undefined ? null : cloneLease(lease);
  }

  private findConflicts(resources: readonly TaskResourceRequest[]): ResourceConflict[] {
    const conflicts: ResourceConflict[] = [];

    for (const requested of resources) {
      const key = resourceKey(requested);
      const holders: ResourceConflictHolder[] = [];

      for (const lease of this.leases.values()) {
        for (const existing of lease.resources) {
          if (resourceKey(existing) !== key || !modesConflict(requested.mode, existing.mode)) {
            continue;
          }
          holders.push({
            leaseId: lease.leaseId,
            taskId: lease.taskId,
            owner: clonePrincipal(lease.authority.principal),
            mode: existing.mode,
            expiresAtMs: lease.expiresAtMs,
          });
        }
      }

      if (holders.length > 0) {
        conflicts.push({ resource: cloneResource(requested), holders });
      }
    }

    return conflicts;
  }

  private deleteLease(lease: ResourceLease): void {
    this.leases.delete(lease.leaseId);
    if (this.leaseByTaskId.get(lease.taskId) === lease.leaseId) {
      this.leaseByTaskId.delete(lease.taskId);
    }
  }
}
