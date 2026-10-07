import type { JsonValue } from "@commandharbor/protocol";
import type { TaskEnvelope } from "@commandharbor/control-plane";

export const PRODUCTION_READ_ONLY_TOOLS = [
  "list_devices",
  "device_status",
  "system_info",
  "list_directory",
  "get_file_info",
  "read_file",
] as const;

export interface McpPrincipal {
  accountId: string;
  userId: string;
}

export interface DeviceSummary {
  deviceId: string;
  deviceName: string;
  online: boolean;
  capabilities: string[];
}

export interface CapabilityInvocation {
  deviceId: string;
  capability: string;
  args: Record<string, JsonValue>;
  task: TaskEnvelope;
}

export interface CommandHarborMcpBackend {
  listDevices(principal: McpPrincipal): Promise<DeviceSummary[]>;
  deviceStatus(principal: McpPrincipal, deviceId: string): Promise<DeviceSummary | null>;
  invoke(principal: McpPrincipal, invocation: CapabilityInvocation): Promise<JsonValue>;
}
