import { describe, expect, it, vi } from "vitest";
import type { ExecutionAuthorizationGrant } from "@commandharbor/protocol";
import {
  authorizeCapabilityExecution,
  capabilityArgsSha256,
  createCapabilityExecutor,
} from "./index";

function grant(overrides: Partial<ExecutionAuthorizationGrant> = {}): ExecutionAuthorizationGrant {
  return {
    schemaVersion: 1,
    kind: "task",
    grantId: "10000000-0000-4000-8000-000000000001",
    authorityId: "control-plane",
    taskId: "20000000-0000-4000-8000-000000000001",
    subject: { kind: "human", id: "user-1" },
    operationId: "30000000-0000-4000-8000-000000000001",
    capability: "system_info",
    argsSha256: capabilityArgsSha256({}),
    issuedAt: 1_000,
    expiresAt: 2_000,
    leaseId: "40000000-0000-4000-8000-000000000001",
    leaseGeneration: 1,
    ...overrides,
  };
}

describe("execution authorization", () => {
  it("allows ordinary session execution without a task grant", async () => {
    const execute = createCapabilityExecutor({ stateRoot: process.cwd() });
    const result = await execute(
      "system_info",
      {},
      new AbortController().signal,
      {
        operationId: "30000000-0000-4000-8000-000000000010",
        authorizationMode: "session",
        expiresAt: Date.now() + 1_000,
      },
    );
    expect(result).toMatchObject({ platform: process.platform });
  });

  it("denies task execution when the grant is missing", async () => {
    const execute = createCapabilityExecutor({ stateRoot: process.cwd() });
    await expect(execute(
      "system_info",
      {},
      new AbortController().signal,
      {
        operationId: "30000000-0000-4000-8000-000000000011",
        authorizationMode: "task",
        expiresAt: Date.now() + 1_000,
      },
    )).rejects.toThrow("authorization_required");
  });

  it("binds a task grant to exact operation, capability, args, and lifetime", () => {
    const valid = grant();
    const context = {
      operationId: valid.operationId,
      authorizationMode: "task" as const,
      authorization: valid,
      expiresAt: valid.expiresAt,
    };
    expect(() => authorizeCapabilityExecution(
      { capability: "system_info", args: {}, context },
      1_500,
    )).not.toThrow();

    expect(() => authorizeCapabilityExecution(
      { capability: "system_info", args: { unexpected: true }, context },
      1_500,
    )).toThrow("authorization_args_mismatch");

    expect(() => authorizeCapabilityExecution(
      { capability: "system_info", args: {}, context },
      2_000,
    )).toThrow("authorization_expired");
  });

  it("invokes a custom authorizer before capability execution", async () => {
    const authorize = vi.fn(() => {
      throw new Error("policy_denied");
    });
    const execute = createCapabilityExecutor({
      stateRoot: process.cwd(),
      authorize,
    });

    await expect(execute(
      "system_info",
      {},
      new AbortController().signal,
      {
        operationId: "30000000-0000-4000-8000-000000000012",
        authorizationMode: "session",
        expiresAt: Date.now() + 1_000,
      },
    )).rejects.toThrow("policy_denied");
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});
