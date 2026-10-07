import { resolve } from "node:path";

export const WINDOWS_NORMAL_AGENT_INSTALL_ROOT = "C:\\Program Files\\CommandHarbor\\agent";

export function normalAgentProtectedRoots(
  stateRoot: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const roots = [resolve(stateRoot, "..")];
  if (platform === "win32") roots.push(WINDOWS_NORMAL_AGENT_INSTALL_ROOT);
  return roots;
}
