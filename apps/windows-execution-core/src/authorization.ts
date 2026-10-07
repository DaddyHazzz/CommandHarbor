import { createHash } from "node:crypto";
import { canonicalJson, type ExecutionAuthorizationGrant, type JsonValue } from "@commandharbor/protocol";

export interface CapabilityExecutionContext {
  operationId: string;
  authorizationMode: "session" | "task";
  authorization?: ExecutionAuthorizationGrant;
  expiresAt: number;
}

export interface CapabilityAuthorizationRequest {
  capability: string;
  args: Record<string, JsonValue>;
  context?: CapabilityExecutionContext;
}

export type CapabilityAuthorizer = (
  request: CapabilityAuthorizationRequest,
) => Promise<void> | void;

export function capabilityArgsSha256(args: Record<string, JsonValue>): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}
export function authorizeCapabilityExecution(
  request: CapabilityAuthorizationRequest,
  nowMs: number = Date.now(),
): void {
  const context = request.context;
  if (!context || context.authorizationMode === "session") {
    if (context?.authorization) throw new Error("authorization_mode_mismatch");
    return;
  }

  const grant = context.authorization;
  if (!grant) throw new Error("authorization_required");
  if (grant.kind !== "task") throw new Error("authorization_kind_mismatch");
  if (grant.operationId !== context.operationId) throw new Error("authorization_operation_mismatch");
  if (grant.capability !== request.capability) throw new Error("authorization_capability_mismatch");
  if (grant.expiresAt > context.expiresAt) throw new Error("authorization_lifetime_mismatch");
  if (grant.expiresAt <= nowMs) throw new Error("authorization_expired");
  if (grant.argsSha256.toLowerCase() !== capabilityArgsSha256(request.args)) {
    throw new Error("authorization_args_mismatch");
  }
}
