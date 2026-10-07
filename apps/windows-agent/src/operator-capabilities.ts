import type { CapabilityProfile, JsonValue } from "@commandharbor/protocol";

export const OPERATOR_CAPABILITY_NAMES = [
  "ping_agent",
  "get_agent_status",
  "get_recent_activity",
  "get_agent_diagnostics",
  "describe_agent",
] as const;

type OperatorCapabilityName = (typeof OPERATOR_CAPABILITY_NAMES)[number];
type Args = Record<string, JsonValue>;

export type OperatorTransportEvent = {
  event: "connected" | "closed" | "retry" | "heartbeat_timeout";
  closeCode?: number;
  retryDelayMs?: number;
};

export type OperatorRuntimeEvent = {
  event: "operation_received"; operationId: string; capability: string;
} | {
  event: "operation_finished"; operationId: string; capability: string;
  outcome: "success" | "expired" | "cancelled" | "tool_error";
} | {
  event: "benchmark.stage";
  stage: "agent.receive" | "executor.start" | "executor.end" | "agent.result";
  schemaVersion: 1;
  campaignId: string;
  runId: string;
  taskId: string;
  taskVersion: string;
  conditionId: string;
  repetitionIndex: number;
  source: "explicit" | "implicit";
  wallTimeMs: number;
  monotonicMs: number;
  durationMs: number;
  operationId: string;
  capability: string;
  outcome?: "success" | "expired" | "cancelled" | "tool_error";
};
type ActivityEntry = {
  at: number;
  capability: string;
  outcome: "success" | "expired" | "cancelled" | "tool_error";
};

export interface AgentOperatorStateOptions {
  now?: () => number;
  startedAt?: number;
  agentVersion: string;
  platform: string;
  arch: string;
  capabilityProfile: CapabilityProfile;
}

const MAX_ACTIVITY = 64;
const HEALTH_DEGRADED_WINDOW_MS = 60_000;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function requireInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error("invalid_arguments");
  return Number(value);
}

function requireNonce(value: unknown): string {
  if (typeof value !== "string" || value.length > 128 || value.includes("\0")) throw new Error("invalid_arguments");
  return value;
}

export class AgentOperatorState {
  private readonly now: () => number;
  private readonly startedAt: number;
  private connected = false;
  private endpointOrigin: string | null = null;
  private lastConnectedAt: number | null = null;
  private lastDisconnectedAt: number | null = null;
  private lastTransportEventAt: number | null = null;
  private lastTransportEvent: OperatorTransportEvent["event"] | null = null;
  private lastCloseCode: number | null = null;
  private retryDelayMs: number | null = null;
  private readonly activity: ActivityEntry[] = [];
  private received = 0; private finished = 0; private success = 0;
  private expired = 0; private cancelled = 0; private toolError = 0; private inFlight = 0;
  private connections = 0; private closes = 0; private retries = 0; private heartbeatTimeouts = 0;
  private readonly capabilityUsage = new Map<string, number>();
  private benchmarkStages = 0;
  private readonly benchmarkStageCounts = new Map<string, number>();
  private lastBenchmarkCorrelation: JsonValue = null;

  constructor(private readonly options: AgentOperatorStateOptions) {
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
  }

  setEndpointOrigin(origin: string): void {
    try {
      const url = new URL(origin);
      if (url.protocol === "https:") this.endpointOrigin = url.origin;
    } catch {
      // Transport validation owns invalid origins; diagnostics remain honest and bounded.
    }
  }

  recordTransport(event: OperatorTransportEvent): void {
    const at = this.now();
    this.lastTransportEventAt = at;
    this.lastTransportEvent = event.event;
    if (event.event === "connected") {
      this.connected = true; this.lastConnectedAt = at; this.connections += 1; this.retryDelayMs = null; return;
    }
    if (event.event === "closed") {
      this.connected = false; this.lastDisconnectedAt = at; this.closes += 1;
      this.lastCloseCode = Number.isInteger(event.closeCode) ? Number(event.closeCode) : null; return;
    }
    if (event.event === "retry") {
      this.connected = false; this.retries += 1;
      this.retryDelayMs = Number.isInteger(event.retryDelayMs) ? Number(event.retryDelayMs) : null;
      if (Number.isInteger(event.closeCode)) this.lastCloseCode = Number(event.closeCode);
      return;
    }
    this.connected = false; this.lastDisconnectedAt = at; this.heartbeatTimeouts += 1;
  }

  recordRuntime(event: OperatorRuntimeEvent): void {
    if (event.event === "benchmark.stage") {
      this.benchmarkStages += 1;
      this.benchmarkStageCounts.set(event.stage, (this.benchmarkStageCounts.get(event.stage) ?? 0) + 1);
      this.lastBenchmarkCorrelation = {
        campaignId: event.campaignId.slice(0, 128),
        runId: event.runId.slice(0, 128),
        taskId: event.taskId.slice(0, 128),
        taskVersion: event.taskVersion.slice(0, 128),
        conditionId: event.conditionId.slice(0, 128),
        repetitionIndex: Math.max(0, Math.min(10_000, event.repetitionIndex)),
        source: event.source,
        capability: event.capability.slice(0, 64),
        ...(event.outcome ? { outcome: event.outcome } : {}),
        durationMs: Math.max(0, Math.min(900_000, event.durationMs)),
      };
      return;
    }
    if (event.event === "operation_received") {
      this.received += 1; this.inFlight += 1;
      this.capabilityUsage.set(event.capability, (this.capabilityUsage.get(event.capability) ?? 0) + 1);
      return;
    }
    this.finished += 1; this.inFlight = Math.max(0, this.inFlight - 1);
    if (event.outcome === "success") this.success += 1;
    else if (event.outcome === "expired") this.expired += 1;
    else if (event.outcome === "cancelled") this.cancelled += 1;
    else this.toolError += 1;
    this.activity.push({ at: this.now(), capability: event.capability.slice(0, 64), outcome: event.outcome });
    if (this.activity.length > MAX_ACTIVITY) this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
  }

  private health(sampleAt: number): "healthy" | "degraded" | "stale" | "unknown" {
    if (this.connected) return "healthy";
    if (this.lastTransportEventAt === null) return "unknown";
    return sampleAt - this.lastTransportEventAt <= HEALTH_DEGRADED_WINDOW_MS ? "degraded" : "stale";
  }

  ping(nonce: string): JsonValue {
    const sampleAt = this.now();
    return { nonce, agentTime: sampleAt, uptimeMs: Math.max(0, Math.floor(sampleAt - this.startedAt)) };
  }

  status(): JsonValue {
    const sampleAt = this.now();
    return {
      health: this.health(sampleAt), connected: this.connected, startedAt: this.startedAt, sampleAt,
      uptimeMs: Math.max(0, Math.floor(sampleAt - this.startedAt)), pid: process.pid,
      agentVersion: this.options.agentVersion.slice(0, 64), platform: this.options.platform.slice(0, 32),
      arch: this.options.arch.slice(0, 32), capabilityCount: this.options.capabilityProfile.tools.length,
      endpointOrigin: this.endpointOrigin, lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt, lastTransportEventAt: this.lastTransportEventAt,
      lastTransportEvent: this.lastTransportEvent, lastCloseCode: this.lastCloseCode, retryDelayMs: this.retryDelayMs,
    };
  }

  recentActivity(limit: number): JsonValue {
    const retained = this.activity.length;
    return { events: this.activity.slice(Math.max(0, retained - limit)), truncated: retained > limit, retained };
  }

  diagnostics(): JsonValue {
    const sampleAt = this.now();
    const memory = process.memoryUsage();
    return {
      health: this.health(sampleAt), sampleAt, uptimeMs: Math.max(0, Math.floor(sampleAt - this.startedAt)),
      operations: {
        received: this.received, finished: this.finished, success: this.success, expired: this.expired,
        cancelled: this.cancelled, toolError: this.toolError, inFlight: this.inFlight,
      },
      transport: {
        connected: this.connected, connections: this.connections, closes: this.closes, retries: this.retries,
        heartbeatTimeouts: this.heartbeatTimeouts, lastCloseCode: this.lastCloseCode, retryDelayMs: this.retryDelayMs,
      },
      memory: {
        rss: memory.rss, heapTotal: memory.heapTotal, heapUsed: memory.heapUsed,
        external: memory.external, arrayBuffers: memory.arrayBuffers,
      },
      benchmark: {
        stages: this.benchmarkStages,
        stageCounts: [...this.benchmarkStageCounts.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([stage, count]) => ({ stage, count })),
        lastCorrelation: this.lastBenchmarkCorrelation,
      },
      capabilityUsage: [...this.capabilityUsage.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([capability, count]) => ({ capability, count })),
    };
  }

  describe(): JsonValue {
    return {
      agentVersion: this.options.agentVersion.slice(0, 64),
      capabilityProfileVersion: this.options.capabilityProfile.version,
      capabilityCount: this.options.capabilityProfile.tools.length,
      capabilities: this.options.capabilityProfile.tools.map(({ name, category, effect }) => ({ name, category, effect })),
      lifecycle: { restartSupported: false, shutdownSupported: false, control: "host-owned" },
      boundaries: [
        "Normal capabilities cannot read or mutate protected CommandHarbor agent state.",
        "Outbound network access is explicit and limited to network-classified capabilities.",
        "Recent activity and diagnostics are bounded in-memory process-lifetime observations.",
        "Remote restart and shutdown are intentionally deferred to the host lifecycle surface.",
      ],
    };
  }
}

export function createAgentOperatorState(options: AgentOperatorStateOptions): AgentOperatorState {
  return new AgentOperatorState(options);
}

export function createOperatorCapabilityExecutor(state: AgentOperatorState) {
  return async (name: string, args: Args, signal: AbortSignal): Promise<JsonValue> => {
    if (signal.aborted) throw new Error("cancelled");
    if (!OPERATOR_CAPABILITY_NAMES.includes(name as OperatorCapabilityName)) throw new Error("unsupported_capability");
    if (name === "ping_agent") {
      if (!exactKeys(args, ["nonce"])) throw new Error("invalid_arguments");
      return state.ping(requireNonce(args.nonce));
    }
    if (name === "get_recent_activity") {
      if (!exactKeys(args, ["limit"])) throw new Error("invalid_arguments");
      return state.recentActivity(requireInteger(args.limit, 1, 32));
    }
    if (!exactKeys(args, [])) throw new Error("invalid_arguments");
    if (name === "get_agent_status") return state.status();
    if (name === "get_agent_diagnostics") return state.diagnostics();
    if (name === "describe_agent") return state.describe();
    throw new Error("unsupported_capability");
  };
}
