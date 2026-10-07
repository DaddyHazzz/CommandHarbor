import type { DeviceMessage } from "./schemas";
import { DeviceMessageSchema } from "./schemas";

export function parseDeviceMessage(input: unknown): DeviceMessage {
  return DeviceMessageSchema.parse(input);
}

export function parseDeviceMessageJson(text: string): DeviceMessage {
  return parseDeviceMessage(JSON.parse(text));
}
