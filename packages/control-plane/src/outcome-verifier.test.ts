import { describe, expect, it } from "vitest";
import {
  verifyTaskOutcome,
  type OutcomeObservation,
  type OutcomeProbeAdapter,
} from "./outcome-verifier";
import type { SuccessPredicate, TaskEnvelope } from "./task-envelope";

function task(success: SuccessPredicate[]): TaskEnvelope {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 0,
    expiresAtMs: 10_000,
    principal: { kind: "worker", id: "worker-1" },
    originWorkerId: "worker-1",
    objective: "verify a completed task",
    allowedCapabilities: ["read_file", "system_info"],
    resources: [],
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
    success,
  };
}

function adapter(
  observe: (
    predicate: SuccessPredicate,
  ) => Promise<OutcomeObservation | null> | OutcomeObservation | null,
): OutcomeProbeAdapter {
  return {
    async observe(_task, predicate) {
      return observe(predicate);
    },
  };
}

describe("verifyTaskOutcome", () => {
  it("passes only when every independent predicate matches", async () => {
    const success: SuccessPredicate[] = [
      { type: "file_exists", path: "C:\\Temp\\done.txt" },
      {
        type: "file_sha256",
        path: "C:\\Temp\\done.txt",
        sha256: "a".repeat(64),
      },
      { type: "process_exit", sessionId: "proc-1", exitCode: 0 },
      {
        type: "git_head",
        repository: "C:\\repo",
        sha: "b".repeat(40),
      },
      { type: "url_equals", url: "https://example.com/done" },
      {
        type: "capability_result",
        capability: "system_info",
        jsonPointer: "/platform",
        equals: { ok: true, values: [1, 2, 3] },
      },
    ];

    const report = await verifyTaskOutcome(
      task(success),
      adapter((predicate) => {
        switch (predicate.type) {
          case "file_exists":
            return { type: "file_exists", exists: true };
          case "file_sha256":
            return { type: "file_sha256", sha256: "A".repeat(64) };
          case "process_exit":
            return { type: "process_exit", exitCode: 0 };
          case "git_head":
            return { type: "git_head", sha: "B".repeat(40) };
          case "url_equals":
            return { type: "url_equals", url: "https://example.com/done" };
          case "capability_result":
            return {
              type: "capability_result",
              value: { values: [1, 2, 3], ok: true },
            };
        }
      }),
    );

    expect(report.status).toBe("passed");
    expect(report.reason).toBe("all_predicates_matched");
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((check) => check.reason === "matched")).toBe(true);
  });

  it("fails on a deterministic mismatch", async () => {
    const report = await verifyTaskOutcome(
      task([{ type: "process_exit", sessionId: "proc-1", exitCode: 0 }]),
      adapter(() => ({ type: "process_exit", exitCode: 1 })),
    );

    expect(report).toMatchObject({
      status: "failed",
      reason: "predicate_failed",
      checks: [{ status: "failed", reason: "mismatch" }],
    });
  });

  it("treats missing probe evidence as indeterminate", async () => {
    const report = await verifyTaskOutcome(
      task([{ type: "file_exists", path: "C:\\Temp\\done.txt" }]),
      adapter(() => null),
    );

    expect(report).toMatchObject({
      status: "indeterminate",
      reason: "evidence_incomplete",
      checks: [{ status: "indeterminate", reason: "probe_unavailable" }],
    });
  });

  it("contains probe exceptions and marks the check indeterminate", async () => {
    const report = await verifyTaskOutcome(
      task([{ type: "git_head", repository: "C:\\repo", sha: "a".repeat(40) }]),
      adapter(() => {
        throw new Error("do not leak this probe detail");
      }),
    );

    expect(report).toMatchObject({
      status: "indeterminate",
      checks: [{ status: "indeterminate", reason: "probe_error" }],
    });
    expect(JSON.stringify(report)).not.toContain("do not leak this probe detail");
  });

  it("marks a mismatched observation type indeterminate instead of guessing", async () => {
    const report = await verifyTaskOutcome(
      task([{ type: "file_exists", path: "C:\\Temp\\done.txt" }]),
      adapter(() => ({ type: "process_exit", exitCode: 0 })),
    );

    expect(report).toMatchObject({
      status: "indeterminate",
      checks: [{ status: "indeterminate", reason: "invalid_observation" }],
    });
  });

  it("does not treat an empty success contract as verified", async () => {
    const report = await verifyTaskOutcome(
      task([]),
      adapter(() => {
        throw new Error("adapter should not be called");
      }),
    );

    expect(report).toEqual({
      schemaVersion: 1,
      taskId: "00000000-0000-4000-8000-000000000001",
      status: "indeterminate",
      reason: "evidence_incomplete",
      checks: [],
    });
  });

  it("lets a proven failure dominate incomplete evidence", async () => {
    const predicates: SuccessPredicate[] = [
      { type: "file_exists", path: "C:\\Temp\\done.txt" },
      { type: "process_exit", sessionId: "proc-1", exitCode: 0 },
    ];
    const report = await verifyTaskOutcome(
      task(predicates),
      adapter((predicate) =>
        predicate.type === "file_exists"
          ? null
          : { type: "process_exit", exitCode: 9 },
      ),
    );

    expect(report.status).toBe("failed");
    expect(report.checks.map((check) => check.status)).toEqual([
      "indeterminate",
      "failed",
    ]);
  });

  it("uses structural JSON equality for capability predicates", async () => {
    const report = await verifyTaskOutcome(
      task([
        {
          type: "capability_result",
          capability: "system_info",
          jsonPointer: "/nested",
          equals: { alpha: 1, beta: { values: ["x", "y"] } },
        },
      ]),
      adapter(() => ({
        type: "capability_result",
        value: { beta: { values: ["x", "y"] }, alpha: 1 },
      })),
    );

    expect(report.status).toBe("passed");
  });

  it("does not copy raw probe payloads into durable reports", async () => {
    const report = await verifyTaskOutcome(
      task([
        {
          type: "capability_result",
          capability: "system_info",
          jsonPointer: "/secret",
          equals: "expected-value",
        },
      ]),
      adapter(() => ({
        type: "capability_result",
        value: "sensitive-observation",
      })),
    );

    expect(report.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("sensitive-observation");
    expect(JSON.stringify(report)).not.toContain("expected-value");
  });
  it("fails when a required file or observed URL is absent", async () => {
    const predicates: SuccessPredicate[] = [
      {
        type: "file_sha256",
        path: "C:\\Temp\\done.txt",
        sha256: "a".repeat(64),
      },
      { type: "url_equals", url: "https://example.com/done" },
    ];
    const report = await verifyTaskOutcome(
      task(predicates),
      adapter((predicate) =>
        predicate.type === "file_sha256"
          ? { type: "file_sha256", sha256: null }
          : { type: "url_equals", url: null },
      ),
    );

    expect(report.status).toBe("failed");
    expect(report.checks.every((check) => check.reason === "mismatch")).toBe(true);
  });
});
