import { describe, expect, it } from "vitest";
import {
  BenchmarkCorrelationSchema,
  OperationRequestSchema,
  PROTOCOL_VERSION,
} from "./index";

const benchmark = {
  schemaVersion: 1,
  campaignId: "bf0-pilot",
  runId: "run-001",
  taskId: "CHB-001",
  taskVersion: "0.1.0",
  conditionId: "semantic",
  repetitionIndex: 0,
  source: "explicit",
} as const;

describe("BF0 benchmark protocol correlation", () => {
  it("accepts bounded correlation and rejects payload-shaped metadata", () => {
    expect(BenchmarkCorrelationSchema.parse(benchmark)).toEqual(benchmark);
    expect(BenchmarkCorrelationSchema.safeParse({
      ...benchmark,
      prompt: "secret prompt",
    }).success).toBe(false);
    expect(BenchmarkCorrelationSchema.safeParse({
      ...benchmark,
      runId: "contains spaces and raw prose",
    }).success).toBe(false);
  });

  it("propagates optional correlation without changing ordinary requests", () => {
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: "11111111-1111-4111-8111-111111111111",
      type: "operation.request",
      operationId: "22222222-2222-4222-8222-222222222222",
      tool: "read_file",
      args: { path: "C:\\fixture.txt", offset: 0, length: 1 },
      issuedAt: 1000,
      expiresAt: 5000,
      idempotencyKey: "bf0-protocol-test",
    };
    expect(OperationRequestSchema.safeParse(base).success).toBe(true);
    expect(OperationRequestSchema.parse({ ...base, benchmark }).benchmark).toEqual(benchmark);
  });
});
