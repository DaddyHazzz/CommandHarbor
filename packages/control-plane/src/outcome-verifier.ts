import type { SuccessPredicate, TaskEnvelope } from "./task-envelope";

export type OutcomeVerificationStatus = "passed" | "failed" | "indeterminate";

export type OutcomeObservation =
  | { type: "file_exists"; exists: boolean }
  | { type: "file_sha256"; sha256: string | null }
  | { type: "process_exit"; exitCode: number | null }
  | { type: "git_head"; sha: string | null }
  | { type: "url_equals"; url: string | null }
  | { type: "capability_result"; value: unknown };

export interface OutcomeProbeAdapter {
  /**
   * Observe the requested predicate through an authority surface independent
   * of the worker being judged.
   *
   * Raw observations are used only for comparison and are intentionally not
   * copied into the verification report.
   */
  observe(
    task: TaskEnvelope,
    predicate: SuccessPredicate,
  ): Promise<OutcomeObservation | null>;
}

export type OutcomeCheckReason =
  | "matched"
  | "mismatch"
  | "probe_unavailable"
  | "probe_error"
  | "invalid_observation";

export interface OutcomeCheck {
  predicateIndex: number;
  predicateType: SuccessPredicate["type"];
  status: OutcomeVerificationStatus;
  reason: OutcomeCheckReason;
}

export interface OutcomeVerificationReport {
  schemaVersion: 1;
  taskId: string;
  status: OutcomeVerificationStatus;
  reason: "all_predicates_matched" | "predicate_failed" | "evidence_incomplete";
  checks: OutcomeCheck[];
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (
    typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return false;
    }
    return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
  }

  return false;
}

function observationMatches(
  predicate: SuccessPredicate,
  observation: OutcomeObservation,
): boolean | null {
  if (predicate.type !== observation.type) {
    return null;
  }

  switch (predicate.type) {
    case "file_exists":
      return observation.type === "file_exists" && observation.exists;
    case "file_sha256":
      return (
        observation.type === "file_sha256" &&
        observation.sha256 !== null &&
        observation.sha256.toLowerCase() === predicate.sha256.toLowerCase()
      );
    case "process_exit":
      return (
        observation.type === "process_exit" &&
        observation.exitCode === predicate.exitCode
      );
    case "git_head":
      return (
        observation.type === "git_head" &&
        observation.sha !== null &&
        observation.sha.toLowerCase() === predicate.sha.toLowerCase()
      );
    case "url_equals":
      return observation.type === "url_equals" && observation.url === predicate.url;
    case "capability_result":
      return (
        observation.type === "capability_result" &&
        deepEqual(observation.value, predicate.equals)
      );
  }
}

async function verifyPredicate(
  task: TaskEnvelope,
  predicate: SuccessPredicate,
  predicateIndex: number,
  adapter: OutcomeProbeAdapter,
): Promise<OutcomeCheck> {
  const base = { predicateIndex, predicateType: predicate.type };

  let observation: OutcomeObservation | null;
  try {
    observation = await adapter.observe(task, predicate);
  } catch {
    return {
      ...base,
      status: "indeterminate",
      reason: "probe_error",
    };
  }

  if (observation === null) {
    return {
      ...base,
      status: "indeterminate",
      reason: "probe_unavailable",
    };
  }

  const matched = observationMatches(predicate, observation);
  if (matched === null) {
    return {
      ...base,
      status: "indeterminate",
      reason: "invalid_observation",
    };
  }

  return {
    ...base,
    status: matched ? "passed" : "failed",
    reason: matched ? "matched" : "mismatch",
  };
}

export async function verifyTaskOutcome(
  task: TaskEnvelope,
  adapter: OutcomeProbeAdapter,
): Promise<OutcomeVerificationReport> {
  if (task.success.length === 0) {
    return {
      schemaVersion: 1,
      taskId: task.taskId,
      status: "indeterminate",
      reason: "evidence_incomplete",
      checks: [],
    };
  }

  const checks: OutcomeCheck[] = [];
  for (let index = 0; index < task.success.length; index += 1) {
    const predicate = task.success[index]!;
    checks.push(await verifyPredicate(task, predicate, index, adapter));
  }

  if (checks.every((check) => check.status === "passed")) {
    return {
      schemaVersion: 1,
      taskId: task.taskId,
      status: "passed",
      reason: "all_predicates_matched",
      checks,
    };
  }

  if (checks.some((check) => check.status === "failed")) {
    return {
      schemaVersion: 1,
      taskId: task.taskId,
      status: "failed",
      reason: "predicate_failed",
      checks,
    };
  }

  return {
    schemaVersion: 1,
    taskId: task.taskId,
    status: "indeterminate",
    reason: "evidence_incomplete",
    checks,
  };
}
