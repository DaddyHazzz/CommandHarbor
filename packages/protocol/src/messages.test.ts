import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DeviceMessageSchema,
  OperationRequestSchema,
} from "./schemas";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  );

describe("device protocol", () => {
  for (const name of [
    "hello.v0_1.json",
    "operation-request.v0_1.json",
    "operation-result.v0_1.json",
    "error.v0_1.json",
  ]) {
    it(`parses ${name}`, () => {
      expect(DeviceMessageSchema.parse(fixture(name))).toBeTruthy();
    });
  }

  it("keeps legacy hello frames valid without a structured capability profile", () => {
    const parsed = DeviceMessageSchema.parse(fixture("hello.v0_1.json"));
    expect(parsed).toMatchObject({
      type: "hello",
      capabilities: ["echo", "delay", "fail", "stream"],
    });
    if (parsed.type !== "hello") throw new Error("expected hello");
    expect(parsed.capabilityProfile).toBeUndefined();
  });

  it("accepts a versioned capability profile whose names exactly match legacy capabilities", () => {
    const input = fixture("hello.v0_1.json") as Record<string, unknown>;
    input.capabilities = ["system_info", "read_file"];
    input.capabilityProfile = {
      version: 2,
      executionAuthorizationVersion: null,
      tools: [
        { name: "system_info", category: "system", effect: "read" },
        { name: "read_file", category: "filesystem", effect: "read" },
      ],
    };
    const parsed = DeviceMessageSchema.parse(input);
    if (parsed.type !== "hello") throw new Error("expected hello");
    expect(parsed.capabilityProfile).toEqual(input.capabilityProfile);
  });

  it("rejects unsupported capability-profile versions", () => {
    const input = fixture("hello.v0_1.json") as Record<string, unknown>;
    input.capabilityProfile = {
      version: 99,
      tools: [
        { name: "echo", category: "system", effect: "read" },
        { name: "delay", category: "system", effect: "read" },
        { name: "fail", category: "system", effect: "read" },
        { name: "stream", category: "system", effect: "read" },
      ],
    };
    expect(DeviceMessageSchema.safeParse(input).success).toBe(false);
  });

  it("rejects duplicate structured capability names", () => {
    const input = fixture("hello.v0_1.json") as Record<string, unknown>;
    input.capabilities = ["system_info"];
    input.capabilityProfile = {
      version: 2,
      executionAuthorizationVersion: null,
      tools: [
        { name: "system_info", category: "system", effect: "read" },
        { name: "system_info", category: "system", effect: "read" },
      ],
    };
    expect(DeviceMessageSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a structured capability profile that drifts from the legacy name set", () => {
    const input = fixture("hello.v0_1.json") as Record<string, unknown>;
    input.capabilities = ["system_info", "read_file"];
    input.capabilityProfile = {
      version: 2,
      executionAuthorizationVersion: null,
      tools: [
        { name: "system_info", category: "system", effect: "read" },
      ],
    };
    expect(DeviceMessageSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unknown message type", () => {
    expect(() => DeviceMessageSchema.parse({ type: "wat" })).toThrow();
  });

  it("rejects a missing operation id", () => {
    const input = fixture("operation-request.v0_1.json") as Record<string, unknown>;
    delete input.operationId;
    expect(OperationRequestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects expiry before issue time", () => {
    const input = fixture("operation-request.v0_1.json") as Record<string, unknown>;
    input.expiresAt = 1_700_000_000_000;
    input.issuedAt = 1_700_000_000_001;
    expect(OperationRequestSchema.safeParse(input).success).toBe(false);
  });

  it("defaults ordinary operation requests to session authorization", () => {
    const input = fixture("operation-request.v0_1.json") as Record<string, unknown>;
    const parsed = OperationRequestSchema.parse(input);
    expect(parsed.authorizationMode).toBe("session");
    expect(parsed.authorization).toBeUndefined();
  });

  it("requires a matching execution grant for task authorization", () => {
    const input = fixture("operation-request.v0_1.json") as Record<string, unknown>;
    input.authorizationMode = "task";
    expect(OperationRequestSchema.safeParse(input).success).toBe(false);

    input.authorization = {
      schemaVersion: 1,
      kind: "task",
      grantId: "10000000-0000-4000-8000-000000000001",
      authorityId: "control-plane",
      taskId: "20000000-0000-4000-8000-000000000001",
      subject: { kind: "human", id: "user-1" },
      operationId: input.operationId,
      capability: input.tool,
      argsSha256: "0".repeat(64),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      leaseId: "40000000-0000-4000-8000-000000000001",
      leaseGeneration: 1,
    };
    expect(OperationRequestSchema.safeParse(input).success).toBe(true);

    (input.authorization as Record<string, unknown>).capability = "different_tool";
    expect(OperationRequestSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an unsupported protocol version", () => {
    const input = fixture("hello.v0_1.json") as Record<string, unknown>;
    input.protocolVersion = "99.0";
    expect(DeviceMessageSchema.safeParse(input).success).toBe(false);
  });

  it("rejects oversized stream chunks", () => {
    const input = {
      protocolVersion: "0.1",
      messageId: "00000000-0000-4000-8000-000000000005",
      type: "operation.chunk",
      operationId: "00000000-0000-4000-8000-000000000010",
      stream: "stdout",
      sequence: 0,
      data: "x".repeat(65_537),
      eof: false,
    };
    expect(DeviceMessageSchema.safeParse(input).success).toBe(false);
  });
});