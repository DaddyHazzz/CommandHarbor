import { z } from "zod";
import { CAPABILITY_PROFILE_VERSION } from "./capabilities";
import { PROTOCOL_VERSION } from "./version";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const UuidSchema = z.uuid();
const TimestampSchema = z.number().int().nonnegative();
const ToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/);
const AuthorizationSubjectIdSchema = z.string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

const EnvelopeFields = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: UuidSchema,
};

export const CapabilityDescriptorSchema = z.object({
  name: ToolNameSchema,
  category: z.enum(["system", "filesystem", "process", "visual", "desktop", "network"]),
  effect: z.enum(["read", "mutate", "execute"]),
}).strict();

export const CapabilityProfileSchema = z.object({
  version: z.literal(CAPABILITY_PROFILE_VERSION),
  executionAuthorizationVersion: z.literal(1).nullable().default(null),
  tools: z.array(CapabilityDescriptorSchema).max(64),
}).strict().superRefine((value, ctx) => {
  const names = new Set<string>();
  for (const [index, tool] of value.tools.entries()) {
    if (names.has(tool.name)) {
      ctx.addIssue({
        code: "custom",
        path: ["tools", index, "name"],
        message: "capability names must be unique",
      });
    }
    names.add(tool.name);
  }
});

const HelloBaseSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("hello"),
  deviceId: UuidSchema,
  agentVersion: z.string().min(1).max(64),
  platform: z.enum(["win32", "darwin"]),
  arch: z.enum(["x64", "arm64"]),
  capabilities: z.array(ToolNameSchema).max(64),
  capabilityProfile: CapabilityProfileSchema.optional(),
  connectedAt: TimestampSchema,
});

export const HelloSchema = HelloBaseSchema.superRefine((value, ctx) => {
  if (!value.capabilityProfile) return;
  const legacy = [...value.capabilities].sort();
  const structured = value.capabilityProfile.tools.map((tool) => tool.name).sort();
  if (
    legacy.length !== structured.length
    || legacy.some((name, index) => name !== structured[index])
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["capabilityProfile", "tools"],
      message: "structured capability names must exactly match legacy capabilities",
    });
  }
});

const BenchmarkIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const BenchmarkCorrelationSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: BenchmarkIdSchema,
  runId: BenchmarkIdSchema,
  taskId: BenchmarkIdSchema,
  taskVersion: BenchmarkIdSchema,
  conditionId: BenchmarkIdSchema,
  repetitionIndex: z.number().int().min(0).max(10_000),
  source: z.enum(["explicit", "implicit"]),
}).strict();

export const ExecutionAuthorizationGrantSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("task"),
  grantId: UuidSchema,
  authorityId: AuthorizationSubjectIdSchema,
  taskId: UuidSchema,
  subject: z.object({
    kind: z.enum(["human", "worker", "service"]),
    id: AuthorizationSubjectIdSchema,
  }).strict(),
  operationId: UuidSchema,
  capability: ToolNameSchema,
  argsSha256: Sha256Schema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  leaseId: UuidSchema,
  leaseGeneration: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.issuedAt) {
    ctx.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "authorization expiresAt must be greater than issuedAt",
    });
  }
});

const OperationRequestBaseSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("operation.request"),
  operationId: UuidSchema,
  tool: ToolNameSchema,
  args: z.record(z.string(), JsonValueSchema),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  idempotencyKey: z.string().min(1).max(128),
  benchmark: BenchmarkCorrelationSchema.optional(),
  authorizationMode: z.enum(["session", "task"]).default("session"),
  authorization: ExecutionAuthorizationGrantSchema.optional(),
});

export const OperationRequestSchema = OperationRequestBaseSchema.superRefine(
  (value, ctx) => {
    if (value.expiresAt <= value.issuedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be greater than issuedAt",
      });
    }
    if (value.authorizationMode === "task" && !value.authorization) {
      ctx.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "task authorization mode requires a grant",
      });
    }
    if (value.authorizationMode === "session" && value.authorization) {
      ctx.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "session authorization mode must not carry a task grant",
      });
    }
    if (value.authorization) {
      if (value.authorization.operationId !== value.operationId) {
        ctx.addIssue({
          code: "custom",
          path: ["authorization", "operationId"],
          message: "authorization operationId must match operationId",
        });
      }
      if (value.authorization.capability !== value.tool) {
        ctx.addIssue({
          code: "custom",
          path: ["authorization", "capability"],
          message: "authorization capability must match tool",
        });
      }
      if (value.authorization.expiresAt > value.expiresAt) {
        ctx.addIssue({
          code: "custom",
          path: ["authorization", "expiresAt"],
          message: "authorization must not outlive operation",
        });
      }
    }
  },
);

export const OperationResultSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("operation.result"),
  operationId: UuidSchema,
  result: JsonValueSchema,
  completedAt: TimestampSchema,
});

export const OperationChunkSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("operation.chunk"),
  operationId: UuidSchema,
  stream: z.enum(["stdout", "stderr", "data"]),
  sequence: z.number().int().nonnegative(),
  data: z.string().max(65_536),
  eof: z.boolean(),
});

export const OperationCancelSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("operation.cancel"),
  operationId: UuidSchema,
  reason: z.string().min(1).max(256).optional(),
});

export const ErrorSchema = z.object({
  ...EnvelopeFields,
  type: z.literal("error"),
  operationId: UuidSchema.optional(),
  code: z.enum([
    "invalid_message",
    "unsupported_version",
    "unauthorized",
    "expired",
    "cancelled",
    "device_busy",
    "tool_error",
    "internal_error",
  ]),
  message: z.string().min(1).max(512),
  retryable: z.boolean(),
});

export const DeviceMessageSchema = z.union([
  HelloSchema,
  OperationRequestSchema,
  OperationResultSchema,
  OperationChunkSchema,
  OperationCancelSchema,
  ErrorSchema,
]);

export type CapabilityProfile = z.infer<typeof CapabilityProfileSchema>;
export type BenchmarkCorrelation = z.infer<typeof BenchmarkCorrelationSchema>;
export type ExecutionAuthorizationGrant = z.infer<typeof ExecutionAuthorizationGrantSchema>;
export type Hello = z.infer<typeof HelloSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationResult = z.infer<typeof OperationResultSchema>;
export type OperationChunk = z.infer<typeof OperationChunkSchema>;
export type OperationCancel = z.infer<typeof OperationCancelSchema>;
export type ProtocolError = z.infer<typeof ErrorSchema>;
export type DeviceMessage = z.infer<typeof DeviceMessageSchema>;
