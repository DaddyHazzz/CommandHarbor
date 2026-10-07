import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";

export const PROCESS_CAPABILITY_NAMES = [
  "execute_command",
  "start_process",
  "read_process_output",
  "send_process_input",
  "list_process_sessions",
  "terminate_process_session",
] as const;

const MAX_SESSIONS = 8;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_PAGE_CHARS = 32_768;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_ARGS = 128;
const MAX_ARG_CHARS = 32_768;
const MAX_TOTAL_ARG_CHARS = 128 * 1024;
const MAX_ENV_KEYS = 32;
const MAX_ENV_VALUE_CHARS = 8192;
const COMPLETED_RETENTION_MS = 10 * 60 * 1000;

const SAFE_INHERITED_ENV = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "USERNAME",
  "USERDOMAIN",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

type Args = Record<string, JsonValue>;
type StreamName = "stdout" | "stderr";
type OutputChunk = { stream: StreamName; text: string; offset: number };

type Session = {
  id: string;
  invocationId: string;
  payloadIdentitySha256: string;
  acceptedAtMs: number;
  startedAtMs: number | null;
  child: ChildProcessWithoutNullStreams;
  chunks: OutputChunk[];
  length: number;
  outputTruncated: boolean;
  exitCode: number | null;
  signal: string | null;
  done: boolean;
  timedOut: boolean;
  interactive: boolean;
  createdAt: number;
  completedAt: number | null;
  completion: Promise<void>;
  complete: () => void;
  timeout?: ReturnType<typeof setTimeout>;
};

export interface ProcessCapabilityOptions {
  validateWorkingDirectory(path: string): Promise<void>;
  parentEnv?: NodeJS.ProcessEnv;
  now?: () => number;
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

function requireSession(sessions: Map<string, Session>, id: unknown): Session {
  if (typeof id !== "string" || id.length < 1) throw new Error("invalid_arguments");
  const session = sessions.get(id);
  if (!session) throw new Error("session_not_found");
  return session;
}

function validateExecutable(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value)) {
    throw new Error("invalid_arguments");
  }
  return resolve(value);
}

function validateArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGS) throw new Error("invalid_arguments");
  let total = 0;
  return value.map((arg) => {
    if (typeof arg !== "string" || arg.length > MAX_ARG_CHARS) throw new Error("invalid_arguments");
    total += arg.length;
    if (total > MAX_TOTAL_ARG_CHARS) throw new Error("invalid_arguments");
    return arg;
  });
}

function validateCwd(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value)) {
    throw new Error("invalid_arguments");
  }
  return resolve(value);
}

function validateExplicitEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("invalid_arguments");
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_KEYS) throw new Error("invalid_arguments");
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error("invalid_arguments");
    if (typeof raw !== "string" || raw.length > MAX_ENV_VALUE_CHARS) throw new Error("invalid_arguments");
    result[key] = raw;
  }
  return result;
}

function buildEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  explicitEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined && SAFE_INHERITED_ENV.has(key.toUpperCase())) result[key] = value;
  }
  for (const [key, value] of Object.entries(explicitEnv)) result[key] = value;
  return result;
}

function validateTimeout(value: unknown, allowZero: boolean): number {
  if (!Number.isInteger(value)) throw new Error("invalid_arguments");
  const timeout = Number(value);
  if ((allowZero ? timeout < 0 : timeout < 1) || timeout > 86_400_000) {
    throw new Error("invalid_arguments");
  }
  return timeout;
}

function processPayloadIdentity(executable: string, argv: string[], cwd: string): string {
  return createHash("sha256")
    .update("commandharbor-process-payload-v1\0", "utf8")
    .update(JSON.stringify({ executable, argv, cwd }), "utf8")
    .digest("hex");
}

function appendOutput(session: Session, stream: StreamName, text: string): void {
  if (text.length === 0) return;
  const remaining = MAX_OUTPUT_CHARS - session.length;
  if (remaining <= 0) {
    session.outputTruncated = true;
    return;
  }
  const retained = text.slice(0, remaining);
  session.chunks.push({ stream, text: retained, offset: session.length });
  session.length += retained.length;
  if (retained.length !== text.length) session.outputTruncated = true;
}

function status(session: Session): Record<string, JsonValue> {
  const pid = session.child.pid ?? null;
  return {
    sessionId: session.id,
    pid,
    running: !session.done,
    exitCode: session.exitCode,
    signal: session.signal,
    outputLength: session.length,
    outputTruncated: session.outputTruncated,
    timedOut: session.timedOut,
    interactive: session.interactive,
    invocationReceipt: {
      schemaVersion: 1,
      invocationId: session.invocationId,
      payloadIdentity: {
        algorithm: "sha256",
        scope: "executable+argv+cwd-v1",
        digest: session.payloadIdentitySha256,
      },
      acceptedAtMs: session.acceptedAtMs,
      startedAtMs: session.startedAtMs,
      completedAtMs: session.completedAt,
      pid,
      exitCode: session.exitCode,
      signal: session.signal,
      timedOut: session.timedOut,
    },
  };
}

function page(session: Session, cursor: number, maxChars: number): Record<string, JsonValue> {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > session.length) {
    throw new Error("invalid_cursor");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_PAGE_CHARS) {
    throw new Error("invalid_arguments");
  }
  const end = Math.min(session.length, cursor + maxChars);
  const output = session.chunks
    .filter((chunk) => chunk.offset + chunk.text.length > cursor && chunk.offset < end)
    .map((chunk) => ({
      stream: chunk.stream,
      text: chunk.text.slice(Math.max(0, cursor - chunk.offset), end - chunk.offset),
    }));
  return {
    ...status(session),
    output,
    stdout: output.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join(""),
    stderr: output.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join(""),
    cursor,
    nextCursor: end,
    hasMore: end < session.length,
  };
}

export function createProcessCapabilityExecutor(options: ProcessCapabilityOptions) {
  const sessions = new Map<string, Session>();
  const now = options.now ?? Date.now;
  const parentEnv = options.parentEnv ?? process.env;

  function cleanupSessions(): void {
    const cutoff = now() - COMPLETED_RETENTION_MS;
    for (const [id, session] of sessions) {
      if (session.done && session.completedAt !== null && session.completedAt <= cutoff) {
        sessions.delete(id);
      }
    }
  }

  function evictOldestCompletedSession(): boolean {
    let oldest: { id: string; completedAt: number } | null = null;
    for (const [id, session] of sessions) {
      if (!session.done || session.completedAt === null) continue;
      if (oldest === null || session.completedAt < oldest.completedAt) {
        oldest = { id, completedAt: session.completedAt };
      }
    }
    if (oldest === null) return false;
    sessions.delete(oldest.id);
    return true;
  }

  async function terminateSession(session: Session, force: boolean): Promise<void> {
    if (session.done) return;
    const pid = session.child.pid;
    if (!pid) throw new Error("terminate_failed");

    if (process.platform === "win32") {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const argv = ["/PID", String(pid), "/T"];
        if (force) argv.push("/F");
        const killer = spawn("taskkill.exe", argv, {
          windowsHide: true,
          stdio: "ignore",
          shell: false,
        });
        killer.once("error", rejectPromise);
        killer.once("close", (code) => {
          if (code === 0 || session.done) resolvePromise();
          else rejectPromise(new Error("terminate_failed"));
        });
      });
    } else {
      session.child.kill(force ? "SIGKILL" : "SIGTERM");
    }

    const finished = await Promise.race([
      session.completion.then(() => true),
      new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
    ]);
    if (force && !finished) throw new Error("terminate_failed");
  }

  async function startSession(
    args: Args,
    interactive: boolean,
    timeoutMs: number,
  ): Promise<Session> {
    cleanupSessions();
    if (sessions.size >= MAX_SESSIONS && !evictOldestCompletedSession()) {
      throw new Error("process_session_limit");
    }

    const executable = validateExecutable(args.executable);
    const argv = validateArgv(args.args);
    const cwd = validateCwd(args.cwd);
    const explicitEnv = validateExplicitEnv(args.env);
    await options.validateWorkingDirectory(cwd);
    const acceptedAtMs = now();
    const invocationId = randomUUID();
    const payloadIdentitySha256 = processPayloadIdentity(executable, argv, cwd);

    const child = spawn(executable, argv, {
      cwd,
      env: buildEnvironment(parentEnv, explicitEnv),
      windowsHide: true,
      stdio: "pipe",
      shell: false,
    });

    let complete!: () => void;
    const completion = new Promise<void>((resolvePromise) => {
      complete = resolvePromise;
    });
    const session: Session = {
      id: randomUUID(),
      invocationId,
      payloadIdentitySha256,
      acceptedAtMs,
      startedAtMs: child.pid ? now() : null,
      child,
      chunks: [],
      length: 0,
      outputTruncated: false,
      exitCode: null,
      signal: null,
      done: false,
      timedOut: false,
      interactive,
      createdAt: now(),
      completedAt: null,
      completion,
      complete,
    };

    const finish = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (session.done) return;
      session.done = true;
      session.exitCode = code;
      session.signal = signalName;
      session.completedAt = now();
      if (session.timeout) clearTimeout(session.timeout);
      session.complete();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text) => appendOutput(session, "stdout", String(text)));
    child.stderr.on("data", (text) => appendOutput(session, "stderr", String(text)));
    child.stdin.on("error", (error) => appendOutput(session, "stderr", error.message));
    child.on("error", (error) => appendOutput(session, "stderr", error.message));
    child.on("close", (code, signalName) => finish(code, signalName));

    sessions.set(session.id, session);

    if (!interactive) child.stdin.end();
    if (timeoutMs > 0) {
      session.timeout = setTimeout(() => {
        if (session.done) return;
        session.timedOut = true;
        void terminateSession(session, true).catch((error) => {
          appendOutput(session, "stderr", error instanceof Error ? error.message : String(error));
        });
      }, timeoutMs);
    }
    return session;
  }

  async function waitForCompletion(session: Session, signal: AbortSignal): Promise<void> {
    requireActive(signal);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      let cancellationOwnsSettlement = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error) rejectPromise(error);
        else resolvePromise();
      };

      const onAbort = (): void => {
        if (settled) return;
        cancellationOwnsSettlement = true;
        void terminateSession(session, true)
          .catch(() => undefined)
          .finally(() => finish(new Error("cancelled")));
      };

      signal.addEventListener("abort", onAbort, { once: true });
      session.completion.then(() => {
        if (!cancellationOwnsSettlement) finish();
      });
      if (signal.aborted) onAbort();
    });
  }

  return async (tool: string, args: Args, signal: AbortSignal): Promise<JsonValue> => {
    requireActive(signal);
    cleanupSessions();
    if (!PROCESS_CAPABILITY_NAMES.includes(tool as (typeof PROCESS_CAPABILITY_NAMES)[number])) {
      throw new Error("unsupported_capability");
    }
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (tool === "execute_command") {
      if (!exactKeys(args, ["executable", "args", "cwd", "env", "timeoutMs"])) {
        throw new Error("invalid_arguments");
      }
      const timeoutMs = validateTimeout(args.timeoutMs, false);
      const session = await startSession(args, false, timeoutMs);
      await waitForCompletion(session, signal);
      return page(session, 0, MAX_PAGE_CHARS);
    }

    if (tool === "start_process") {
      if (!exactKeys(args, ["executable", "args", "cwd", "env", "interactive", "timeoutMs"])) {
        throw new Error("invalid_arguments");
      }
      if (typeof args.interactive !== "boolean") throw new Error("invalid_arguments");
      const timeoutMs = validateTimeout(args.timeoutMs, true);
      return status(await startSession(args, args.interactive, timeoutMs));
    }

    if (tool === "read_process_output") {
      if (!exactKeys(args, ["sessionId", "cursor", "maxChars"])) throw new Error("invalid_arguments");
      const session = requireSession(sessions, args.sessionId);
      if (typeof args.cursor !== "number" || typeof args.maxChars !== "number") {
        throw new Error("invalid_arguments");
      }
      return page(session, args.cursor, args.maxChars);
    }

    if (tool === "send_process_input") {
      if (!exactKeys(args, ["sessionId", "stdin", "closeStdin"])) throw new Error("invalid_arguments");
      const session = requireSession(sessions, args.sessionId);
      if (typeof args.stdin !== "string" || typeof args.closeStdin !== "boolean") {
        throw new Error("invalid_arguments");
      }
      if (Buffer.byteLength(args.stdin, "utf8") > MAX_STDIN_BYTES) {
        throw new Error("invalid_arguments");
      }
      if (session.done || session.child.stdin.destroyed || !session.interactive) {
        throw new Error("process_stdin_closed");
      }
      if (args.stdin.length > 0) {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          session.child.stdin.write(args.stdin as string, (error) => {
            if (error) rejectPromise(error);
            else resolvePromise();
          });
        });
      }
      if (args.closeStdin) session.child.stdin.end();
      return status(session);
    }

    if (tool === "list_process_sessions") {
      if (!exactKeys(args, [])) throw new Error("invalid_arguments");
      const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
      return { sessions: ordered.map((session) => status(session)) };
    }

    if (!exactKeys(args, ["sessionId", "force"])) throw new Error("invalid_arguments");
    if (typeof args.force !== "boolean") throw new Error("invalid_arguments");
    const session = requireSession(sessions, args.sessionId);
    await terminateSession(session, args.force);
    return status(session);
  };
}
