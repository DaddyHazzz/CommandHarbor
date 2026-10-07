import { spawn } from "node:child_process";
import type { JsonValue } from "@commandharbor/protocol";

export const SYSTEM_PROCESS_CAPABILITY_NAMES = [
  "list_system_processes",
  "kill_system_process",
] as const;

const MAX_CAPTURE_CHARS = 2_000_000;
const COMMAND_TIMEOUT_MS = 5_000;

type Args = Record<string, JsonValue>;
type ProcessRow = { pid: number; name: string };

export interface SystemProcessCapabilityOptions {
  protectedPids?: number[];
  platform?: NodeJS.Platform;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

async function runCapture(
  executable: string,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      rejectPromise(new Error("system_process_command_timeout"));
    }, COMMAND_TIMEOUT_MS);

    const append = (stream: "stdout" | "stderr", value: string): void => {
      if (settled) return;
      if (stdout.length + stderr.length + value.length > MAX_CAPTURE_CHARS) {
        child.kill("SIGKILL");
        settled = true;
        clearTimeout(timer);
        rejectPromise(new Error("system_process_output_too_large"));
        return;
      }
      if (stream === "stdout") stdout += value;
      else stderr += value;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value) => append("stdout", String(value)));
    child.stderr.on("data", (value) => append("stderr", String(value)));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields;
}

function parseWindowsTaskList(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("INFO:")) continue;
    const fields = parseCsvLine(line);
    const pid = Number(fields[1]);
    const name = fields[0];
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name) continue;
    rows.push({ pid, name });
  }
  return rows;
}

function parsePosixPs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const name = match[2]!.trim();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name) continue;
    rows.push({ pid, name });
  }
  return rows;
}

async function listProcesses(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  if (platform === "win32") {
    const result = await runCapture("tasklist.exe", ["/FO", "CSV", "/NH"]);
    if (result.code !== 0) throw new Error("process_list_failed");
    return parseWindowsTaskList(result.stdout);
  }
  const result = await runCapture("ps", ["-axo", "pid=,comm="]);
  if (result.code !== 0) throw new Error("process_list_failed");
  return parsePosixPs(result.stdout);
}

async function findProcess(
  platform: NodeJS.Platform,
  pid: number,
): Promise<ProcessRow | null> {
  if (platform === "win32") {
    const result = await runCapture("tasklist.exe", [
      "/FI",
      "PID eq " + String(pid),
      "/FO",
      "CSV",
      "/NH",
    ]);
    if (result.code !== 0) throw new Error("process_list_failed");
    return parseWindowsTaskList(result.stdout)[0] ?? null;
  }
  const result = await runCapture("ps", ["-p", String(pid), "-o", "pid=,comm="]);
  if (result.code !== 0) return null;
  return parsePosixPs(result.stdout)[0] ?? null;
}

function sameProcessName(platform: NodeJS.Platform, expected: string, actual: string): boolean {
  return platform === "win32"
    ? expected.toLowerCase() === actual.toLowerCase()
    : expected === actual;
}

async function terminateProcess(
  platform: NodeJS.Platform,
  pid: number,
  force: boolean,
): Promise<void> {
  if (platform === "win32") {
    const argv = ["/PID", String(pid), "/T"];
    if (force) argv.push("/F");
    const result = await runCapture("taskkill.exe", argv);
    if (result.code !== 0) throw new Error("terminate_failed");
    return;
  }
  try {
    process.kill(pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new Error("process_not_found");
    throw error;
  }
}

export function createSystemProcessCapabilityExecutor(
  options: SystemProcessCapabilityOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const protectedPids = new Set(
    (options.protectedPids ?? [process.pid, process.ppid])
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  );

  return async (tool: string, args: Args, signal: AbortSignal): Promise<JsonValue> => {
    requireActive(signal);
    if (!SYSTEM_PROCESS_CAPABILITY_NAMES.includes(
      tool as (typeof SYSTEM_PROCESS_CAPABILITY_NAMES)[number],
    )) {
      throw new Error("unsupported_capability");
    }
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (tool === "list_system_processes") {
      if (!exactKeys(args, ["maxResults"])) throw new Error("invalid_arguments");
      if (
        !Number.isSafeInteger(args.maxResults)
        || Number(args.maxResults) < 1
        || Number(args.maxResults) > 1000
      ) {
        throw new Error("invalid_arguments");
      }
      const rows = (await listProcesses(platform)).sort((a, b) => a.pid - b.pid);
      requireActive(signal);
      const maxResults = Number(args.maxResults);
      return {
        processes: rows.slice(0, maxResults),
        truncated: rows.length > maxResults,
      };
    }

    if (!exactKeys(args, ["pid", "expectedName", "force"])) {
      throw new Error("invalid_arguments");
    }
    if (
      !Number.isSafeInteger(args.pid)
      || Number(args.pid) <= 0
      || typeof args.expectedName !== "string"
      || args.expectedName.length < 1
      || args.expectedName.length > 512
      || typeof args.force !== "boolean"
    ) {
      throw new Error("invalid_arguments");
    }

    const pid = Number(args.pid);
    if (pid <= 4 || protectedPids.has(pid)) throw new Error("protected_process");

    const observed = await findProcess(platform, pid);
    requireActive(signal);
    if (!observed) throw new Error("process_not_found");
    if (!sameProcessName(platform, args.expectedName, observed.name)) {
      throw new Error("process_identity_mismatch");
    }

    await terminateProcess(platform, pid, args.force);
    return {
      pid,
      name: observed.name,
      terminated: true,
      force: args.force,
    };
  };
}
