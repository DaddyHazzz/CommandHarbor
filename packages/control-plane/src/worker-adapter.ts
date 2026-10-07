import type { TaskEnvelope } from "./task-envelope";

export interface WorkerDescriptor {
  workerId: string;
  provider: string;
  kind: "agent" | "model" | "process" | "sandbox";
  capabilities: string[];
  executionStrategies: string[];
}

export type WorkerTaskState =
  | "accepted"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkerTaskHandle {
  taskId: string;
  workerId: string;
  state: WorkerTaskState;
}

export interface WorkerProgressEvent {
  taskId: string;
  workerId: string;
  state: WorkerTaskState;
  message?: string;
  evidence?: unknown;
}

export interface WorkerAdapter {
  describe(): Promise<WorkerDescriptor>;
  accept(task: TaskEnvelope): Promise<WorkerTaskHandle>;
  status(taskId: string): Promise<WorkerTaskHandle>;
  cancel(taskId: string, reason?: string): Promise<WorkerTaskHandle>;
  events?(taskId: string): AsyncIterable<WorkerProgressEvent>;
}
