import { createReadStream } from "node:fs";
import { appendFile, cp, lstat, mkdir, readFile, realpath, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  CAPABILITY_PROFILE_VERSION,
  NEXT_RELEASE_CAPABILITY_PROFILE,
  type CapabilityProfile,
  type JsonValue,
} from "@commandharbor/protocol";
import { PROCESS_CAPABILITY_NAMES, createProcessCapabilityExecutor } from "./process-capabilities";
import {
  SEARCH_SESSION_CAPABILITY_NAMES,
  createSearchSessionCapabilityExecutor,
} from "./search-session-capabilities";
import {
  DOCUMENT_CAPABILITY_NAMES,
  createDocumentCapabilityExecutor,
} from "./document-capabilities";
import {
  RETRIEVAL_CAPABILITY_NAMES,
  createRetrievalCapabilityExecutor,
} from "./retrieval-capabilities";
import { OPERATOR_CAPABILITY_NAMES, createAgentOperatorState, createOperatorCapabilityExecutor, type AgentOperatorState } from "./operator-capabilities";
import { SYSTEM_PROCESS_CAPABILITY_NAMES, createSystemProcessCapabilityExecutor } from "./system-process-capabilities";
import { SCREENSHOT_CAPABILITY_NAMES, createScreenshotCapabilityExecutor } from "./screenshot-capability";
import { WINDOW_CAPABILITY_NAMES, createWindowCapabilityExecutor } from "./window-capability";
import {
  UI_AUTOMATION_CAPABILITY_NAMES,
  createUiAutomationCapabilityExecutor,
} from "./ui-automation-capability";
import {
  DESKTOP_CONTROL_CAPABILITY_NAMES,
  createDesktopControlCapabilityExecutor,
} from "./desktop-control-capability";

export const CAPABILITY_NAMES = [
  "system_info",
  ...OPERATOR_CAPABILITY_NAMES,
  "list_directory",
  "get_file_info",
  "read_file",
  "read_multiple_files",
  "search_files",
  "search_text",
  ...SEARCH_SESSION_CAPABILITY_NAMES,
  ...DOCUMENT_CAPABILITY_NAMES,
  ...RETRIEVAL_CAPABILITY_NAMES,
  "write_file",
  "edit_file",
  "create_directory",
  "copy_path",
  "move_path",
  "delete_path",
  ...PROCESS_CAPABILITY_NAMES,
  ...SYSTEM_PROCESS_CAPABILITY_NAMES,
  ...SCREENSHOT_CAPABILITY_NAMES,
  ...WINDOW_CAPABILITY_NAMES,
  ...UI_AUTOMATION_CAPABILITY_NAMES,
  ...DESKTOP_CONTROL_CAPABILITY_NAMES,
] as const;

const implementedCapabilityNames = new Set<string>(CAPABILITY_NAMES);

export const CAPABILITY_PROFILE: CapabilityProfile = {
  version: CAPABILITY_PROFILE_VERSION,
  tools: NEXT_RELEASE_CAPABILITY_PROFILE
    .filter((capability) => implementedCapabilityNames.has(capability.name))
    .map(({ name, category, effect }) => ({ name, category, effect })),
};

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_BATCH_FILES = 4;
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_SEARCH_LINE_CHARS = 4096;

type CapabilityName = (typeof CAPABILITY_NAMES)[number];
type CapabilityArgs = Record<string, JsonValue>;
type WriteMode = "create" | "replace" | "append";

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

function requireAbsolutePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("invalid_arguments");
  return resolve(value);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function pathIsInside(root: string, target: string): boolean {
  const relation = relative(root, target);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function ensureUnprotectedPath(
  path: string,
  protectedRoots: readonly string[],
  allowMissing: boolean,
): Promise<void> {
  const target = resolve(path);
  const roots = protectedRoots.map((protectedRoot) => resolve(protectedRoot));

  for (const root of roots) {
    if (pathIsInside(root, target)) throw new Error("protected_agent_path");
  }

  for (const root of roots) {
    const realRoot = await realpathIfExists(root);
    if (!realRoot) continue;
    try {
      const realTarget = await realpath(target);
      if (pathIsInside(realRoot, realTarget)) throw new Error("protected_agent_path");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      if (!allowMissing) throw error;

      let realParent: string;
      try {
        realParent = await realpath(dirname(target));
      } catch (parentError) {
        if (errorCode(parentError) === "ENOENT") throw new Error("path_not_found");
        throw parentError;
      }
      if (pathIsInside(realRoot, realParent)) throw new Error("protected_agent_path");
    }
  }
}

function fileType(stats: Awaited<ReturnType<typeof lstat>>): string {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function fitUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return value.slice(0, low);
}

async function listDirectory(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "depth", "maxEntries"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  const depth = args.depth;
  const maxEntries = args.maxEntries;
  if (!Number.isInteger(depth) || Number(depth) < 0 || Number(depth) > 4) throw new Error("invalid_arguments");
  if (!Number.isInteger(maxEntries) || Number(maxEntries) < 1 || Number(maxEntries) > 500) {
    throw new Error("invalid_arguments");
  }
  await ensureUnprotectedPath(path, protectedRoots, false);

  const entries: Array<Record<string, JsonValue>> = [];
  let truncated = false;
  const walk = async (dir: string, level: number): Promise<void> => {
    requireActive(signal);
    const children = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      requireActive(signal);
      if (entries.length >= Number(maxEntries)) { truncated = true; return; }
      const childPath = resolve(dir, child.name);
      await ensureUnprotectedPath(childPath, protectedRoots, false);
      const stats = await lstat(childPath);
      entries.push({ name: child.name, path: childPath, type: fileType(stats), size: stats.size });
      if (child.isDirectory() && level < Number(depth)) await walk(childPath, level + 1);
      if (truncated) return;
    }
  };
  await walk(path, 0);
  entries.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return { entries, truncated };
}

async function getFileInfo(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
): Promise<JsonValue> {
  if (!exactKeys(args, ["path"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  await ensureUnprotectedPath(path, protectedRoots, false);
  const stats = await lstat(path);
  return {
    path,
    type: fileType(stats),
    size: stats.size,
    createdAt: stats.birthtimeMs,
    modifiedAt: stats.mtimeMs,
  };
}

async function readTextFile(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "offset", "length"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  const offset = args.offset;
  const length = args.length;
  if (!Number.isInteger(offset) || Number(offset) < 0 || Number(offset) > 100_000) {
    throw new Error("invalid_arguments");
  }
  if (!Number.isInteger(length) || Number(length) < 1 || Number(length) > 1000) {
    throw new Error("invalid_arguments");
  }
  await ensureUnprotectedPath(path, protectedRoots, false);

  requireActive(signal);
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected: string[] = [];
  let lineIndex = 0;
  let bytes = 0;
  let truncated = false;
  try {
    for await (const line of lines) {
      requireActive(signal);
      if (lineIndex < Number(offset)) { lineIndex += 1; continue; }
      if (selected.length >= Number(length)) { truncated = true; break; }
      const separatorBytes = selected.length === 0 ? 0 : 1;
      const remaining = MAX_READ_BYTES - bytes - separatorBytes;
      if (remaining <= 0) { truncated = true; break; }
      const fitted = fitUtf8(line, remaining);
      selected.push(fitted);
      bytes += separatorBytes + Buffer.byteLength(fitted, "utf8");
      lineIndex += 1;
      if (fitted.length !== line.length) { truncated = true; break; }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return {
    text: selected.join("\n"),
    offset: Number(offset),
    linesRead: selected.length,
    truncated,
  };
}

async function requireRegularFile(
  path: string,
  protectedRoots: readonly string[],
): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    await ensureUnprotectedPath(path, protectedRoots, false);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    throw error;
  }

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    throw error;
  }
  if (!stats.isFile()) throw new Error("not_a_regular_file");
  return stats;
}

async function atomicReplace(
  path: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const tempPath = join(dirname(path), ".commandharbor-write-" + randomUUID() + ".tmp");
  let tempExists = false;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", flag: "wx" });
    tempExists = true;
    requireActive(signal);
    await rename(tempPath, path);
    tempExists = false;
  } finally {
    if (tempExists) {
      try {
        await unlink(tempPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
  }
}

async function writeTextFile(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "content", "mode"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  const content = args.content;
  const mode = args.mode;
  if (typeof content !== "string") throw new Error("invalid_arguments");
  if (mode !== "create" && mode !== "replace" && mode !== "append") {
    throw new Error("invalid_arguments");
  }

  const bytesWritten = Buffer.byteLength(content, "utf8");
  if (bytesWritten > MAX_WRITE_BYTES) throw new Error("write_too_large");
  requireActive(signal);

  const writeMode = mode as WriteMode;
  if (writeMode === "create") {
    await ensureUnprotectedPath(path, protectedRoots, true);
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw new Error("path_exists");
      if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
      throw error;
    }
  } else {
    await requireRegularFile(path, protectedRoots);
    requireActive(signal);
    if (writeMode === "replace") {
      await atomicReplace(path, content, signal);
    } else {
      await appendFile(path, content, { encoding: "utf8" });
    }
  }

  return { path, mode: writeMode, bytesWritten };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const next = text.indexOf(needle, index);
    if (next < 0) return count;
    count += 1;
    index = next + needle.length;
  }
}

async function editTextFile(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "oldText", "newText", "expectedReplacements"])) {
    throw new Error("invalid_arguments");
  }
  const path = requireAbsolutePath(args.path);
  const oldText = args.oldText;
  const newText = args.newText;
  const expectedReplacements = args.expectedReplacements;

  if (
    typeof oldText !== "string"
    || oldText.length === 0
    || typeof newText !== "string"
    || !Number.isInteger(expectedReplacements)
    || Number(expectedReplacements) < 1
    || Number(expectedReplacements) > 1000
  ) {
    throw new Error("invalid_arguments");
  }
  if (
    Buffer.byteLength(oldText, "utf8") > MAX_WRITE_BYTES
    || Buffer.byteLength(newText, "utf8") > MAX_WRITE_BYTES
  ) {
    throw new Error("write_too_large");
  }

  requireActive(signal);
  const stats = await requireRegularFile(path, protectedRoots);
  if (stats.size > MAX_WRITE_BYTES) throw new Error("write_too_large");

  const original = await readFile(path, "utf8");
  requireActive(signal);
  const replacements = countOccurrences(original, oldText);
  if (replacements !== Number(expectedReplacements)) {
    throw new Error("replacement_count_mismatch");
  }

  const updated = original.split(oldText).join(newText);
  const bytesWritten = Buffer.byteLength(updated, "utf8");
  if (bytesWritten > MAX_WRITE_BYTES) throw new Error("write_too_large");

  await atomicReplace(path, updated, signal);
  return { path, replacements, bytesWritten };
}

async function readMultipleTextFiles(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["paths", "offset", "length"])) throw new Error("invalid_arguments");
  const paths = args.paths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_BATCH_FILES) {
    throw new Error("invalid_arguments");
  }
  const normalized = paths.map((path) => requireAbsolutePath(path));
  if (new Set(normalized).size !== normalized.length) throw new Error("invalid_arguments");

  const files: Array<Record<string, JsonValue>> = [];
  for (const path of normalized) {
    requireActive(signal);
    const result = await readTextFile(
      { path, offset: args.offset, length: args.length },
      protectedRoots,
      signal,
    ) as Record<string, JsonValue>;
    files.push({ path, ...result });
  }
  return { count: files.length, files };
}

function validateSearchBounds(
  rootValue: unknown,
  queryValue: unknown,
  depthValue: unknown,
  maxResultsValue: unknown,
): { root: string; query: string; depth: number; maxResults: number } {
  const root = requireAbsolutePath(rootValue);
  if (typeof queryValue !== "string" || queryValue.length < 1 || queryValue.length > 1024) {
    throw new Error("invalid_arguments");
  }
  if (!Number.isInteger(depthValue) || Number(depthValue) < 0 || Number(depthValue) > 8) {
    throw new Error("invalid_arguments");
  }
  if (
    !Number.isInteger(maxResultsValue)
    || Number(maxResultsValue) < 1
    || Number(maxResultsValue) > 200
  ) {
    throw new Error("invalid_arguments");
  }
  return {
    root,
    query: queryValue,
    depth: Number(depthValue),
    maxResults: Number(maxResultsValue),
  };
}

async function requireSearchRoot(
  root: string,
  protectedRoots: readonly string[],
): Promise<void> {
  await ensureUnprotectedPath(root, protectedRoots, false);
  const stats = await lstatOrNotFound(root);
  if (!stats.isDirectory()) throw new Error("not_a_directory");
}

async function searchFiles(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["root", "query", "depth", "maxResults"])) {
    throw new Error("invalid_arguments");
  }
  const { root, query, depth, maxResults } = validateSearchBounds(
    args.root,
    args.query,
    args.depth,
    args.maxResults,
  );
  await requireSearchRoot(root, protectedRoots);
  const needle = query.toLowerCase();
  const results: Array<Record<string, JsonValue>> = [];
  let truncated = false;

  const walk = async (dir: string, level: number): Promise<void> => {
    requireActive(signal);
    const children = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      requireActive(signal);
      if (truncated) return;
      const childPath = resolve(dir, child.name);
      const stats = await lstat(childPath);
      if (stats.isSymbolicLink()) continue;
      await ensureUnprotectedPath(childPath, protectedRoots, false);

      const type = stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other";
      if (child.name.toLowerCase().includes(needle)) {
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        results.push({ path: childPath, type });
      }
      if (stats.isDirectory() && level < depth) await walk(childPath, level + 1);
    }
  };

  await walk(root, 0);
  return { results, truncated };
}

async function searchText(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["root", "query", "caseSensitive", "depth", "maxResults"])) {
    throw new Error("invalid_arguments");
  }
  if (typeof args.caseSensitive !== "boolean") throw new Error("invalid_arguments");
  const { root, query, depth, maxResults } = validateSearchBounds(
    args.root,
    args.query,
    args.depth,
    args.maxResults,
  );
  await requireSearchRoot(root, protectedRoots);

  const caseSensitive = args.caseSensitive;
  const needle = caseSensitive ? query : query.toLowerCase();
  const results: Array<Record<string, JsonValue>> = [];
  let truncated = false;

  const walk = async (dir: string, level: number): Promise<void> => {
    requireActive(signal);
    const children = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      requireActive(signal);
      if (truncated) return;
      const childPath = resolve(dir, child.name);
      const stats = await lstat(childPath);
      if (stats.isSymbolicLink()) continue;
      await ensureUnprotectedPath(childPath, protectedRoots, false);

      if (stats.isDirectory()) {
        if (level < depth) await walk(childPath, level + 1);
        continue;
      }
      if (!stats.isFile() || stats.size > MAX_SEARCH_FILE_BYTES) continue;

      const buffer = await readFile(childPath);
      requireActive(signal);
      if (buffer.includes(0)) continue;
      const fileText = buffer.toString("utf8");
      const lines = fileText.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        const haystack = caseSensitive ? line : line.toLowerCase();
        if (!haystack.includes(needle)) continue;
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        results.push({
          path: childPath,
          lineNumber: index + 1,
          text: line.slice(0, MAX_SEARCH_LINE_CHARS),
        });
      }
    }
  };

  await walk(root, 0);
  return { results, truncated };
}

async function ensureUnprotectedRecursiveTarget(
  path: string,
  protectedRoots: readonly string[],
): Promise<void> {
  const target = resolve(path);
  const roots = protectedRoots.map((protectedRoot) => resolve(protectedRoot));
  for (const root of roots) {
    if (pathIsInside(root, target)) throw new Error("protected_agent_path");
  }
  for (const root of roots) {
    const realRoot = await realpathIfExists(root);
    if (!realRoot) continue;

    let ancestor = target;
    while (true) {
      try {
        const realAncestor = await realpath(ancestor);
        if (pathIsInside(realRoot, realAncestor)) throw new Error("protected_agent_path");
        break;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw new Error("path_not_found");
        ancestor = parent;
      }
    }
  }
}

async function lstatOrNotFound(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function mutablePathType(stats: Awaited<ReturnType<typeof lstat>>): "file" | "directory" | "symlink" {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  throw new Error("unsupported_path_type");
}

async function createDirectoryPath(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "recursive"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  const recursive = args.recursive;
  if (typeof recursive !== "boolean") throw new Error("invalid_arguments");
  requireActive(signal);

  if (recursive) await ensureUnprotectedRecursiveTarget(path, protectedRoots);
  else await ensureUnprotectedPath(path, protectedRoots, true);

  if (await pathExists(path)) throw new Error("path_exists");
  try {
    await mkdir(path, { recursive });
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    if (errorCode(error) === "EEXIST") throw new Error("path_exists");
    throw error;
  }
  return { path, recursive };
}

async function copyPath(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["source", "destination", "recursive"])) {
    throw new Error("invalid_arguments");
  }
  const source = requireAbsolutePath(args.source);
  const destination = requireAbsolutePath(args.destination);
  const recursive = args.recursive;
  if (typeof recursive !== "boolean") throw new Error("invalid_arguments");
  if (source === destination) throw new Error("invalid_arguments");

  requireActive(signal);
  await ensureUnprotectedPath(source, protectedRoots, false);
  await ensureUnprotectedPath(destination, protectedRoots, true);
  if (await pathExists(destination)) throw new Error("path_exists");

  const sourceStats = await lstatOrNotFound(source);
  const type = mutablePathType(sourceStats);
  if (type === "directory" && !recursive) throw new Error("recursive_required");

  requireActive(signal);
  try {
    await cp(source, destination, {
      recursive: type === "directory",
      force: false,
      errorOnExist: true,
      dereference: false,
    });
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new Error("path_exists");
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    throw error;
  }
  return { source, destination, type };
}

async function movePath(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["source", "destination"])) throw new Error("invalid_arguments");
  const source = requireAbsolutePath(args.source);
  const destination = requireAbsolutePath(args.destination);
  if (source === destination) throw new Error("invalid_arguments");

  requireActive(signal);
  await ensureUnprotectedPath(source, protectedRoots, false);
  await ensureUnprotectedPath(destination, protectedRoots, true);
  if (await pathExists(destination)) throw new Error("path_exists");

  const sourceStats = await lstatOrNotFound(source);
  const type = mutablePathType(sourceStats);
  requireActive(signal);
  try {
    await rename(source, destination);
  } catch (error) {
    if (errorCode(error) === "EXDEV") throw new Error("cross_device_move_unsupported");
    if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
    if (errorCode(error) === "EEXIST") throw new Error("path_exists");
    throw error;
  }
  return { source, destination, type };
}

async function deletePath(
  args: Record<string, unknown>,
  protectedRoots: readonly string[],
  signal: AbortSignal,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path", "recursive"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  const recursive = args.recursive;
  if (typeof recursive !== "boolean") throw new Error("invalid_arguments");

  requireActive(signal);
  await ensureUnprotectedPath(path, protectedRoots, false);
  const stats = await lstatOrNotFound(path);
  const type = mutablePathType(stats);
  requireActive(signal);

  if (type === "directory") {
    try {
      if (recursive) await rm(path, { recursive: true, force: false });
      else await rmdir(path);
    } catch (error) {
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") {
        throw new Error("directory_not_empty");
      }
      if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
      throw error;
    }
  } else {
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error("path_not_found");
      throw error;
    }
  }

  return { path, type, recursive };
}

export function createCapabilityExecutor(options: {
  stateRoot: string;
  protectedRoots?: string[];
  operatorState?: AgentOperatorState;
  screenshot?: Parameters<typeof createScreenshotCapabilityExecutor>[0];
  window?: Parameters<typeof createWindowCapabilityExecutor>[0];
  uiAutomation?: Parameters<typeof createUiAutomationCapabilityExecutor>[0];
  desktopControl?: Parameters<typeof createDesktopControlCapabilityExecutor>[0];
}) {
  const stateRoot = resolve(options.stateRoot);
  const protectedRoots = (options.protectedRoots ?? [stateRoot]).map((root) => resolve(root));
  const operatorState = options.operatorState ?? createAgentOperatorState({
    agentVersion: "0.0.0",
    platform: platform(),
    arch: arch(),
    capabilityProfile: CAPABILITY_PROFILE,
  });
  const operatorExecutor = createOperatorCapabilityExecutor(operatorState);
  const searchSessionExecutor = createSearchSessionCapabilityExecutor({
    validatePath: async (path) => ensureUnprotectedPath(path, protectedRoots, false),
  });
  const documentExecutor = createDocumentCapabilityExecutor({
    validatePath: async (path, allowMissing) => ensureUnprotectedPath(path, protectedRoots, allowMissing),
  });
  const retrievalExecutor = createRetrievalCapabilityExecutor({
    validatePath: async (path, allowMissing) => ensureUnprotectedPath(path, protectedRoots, allowMissing),
  });
  const processExecutor = createProcessCapabilityExecutor({
    validateWorkingDirectory: async (path) => {
      await ensureUnprotectedPath(path, protectedRoots, false);
      const stats = await lstatOrNotFound(path);
      if (!stats.isDirectory()) throw new Error("not_a_directory");
    },
  });
  const systemProcessExecutor = createSystemProcessCapabilityExecutor();
  const screenshotExecutor = createScreenshotCapabilityExecutor(options.screenshot);
  const windowExecutor = createWindowCapabilityExecutor(options.window);
  const uiAutomationExecutor = createUiAutomationCapabilityExecutor(options.uiAutomation);
  const desktopControlExecutor = createDesktopControlCapabilityExecutor(options.desktopControl);

  return async (name: string, args: CapabilityArgs, signal: AbortSignal): Promise<JsonValue> => {
    requireActive(signal);
    if (!CAPABILITY_NAMES.includes(name as CapabilityName)) throw new Error("unsupported_capability");
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (name === "system_info") {
      if (!exactKeys(args, [])) throw new Error("invalid_arguments");
      return {
        platform: platform(),
        arch: arch(),
        release: release(),
        hostname: hostname(),
        nodeVersion: process.version,
      };
    }
    if (OPERATOR_CAPABILITY_NAMES.includes(name as (typeof OPERATOR_CAPABILITY_NAMES)[number])) {
      return operatorExecutor(name, args, signal);
    }
    if (name === "list_directory") return listDirectory(args, protectedRoots, signal);
    if (name === "get_file_info") return getFileInfo(args, protectedRoots);
    if (name === "read_file") return readTextFile(args, protectedRoots, signal);
    if (name === "read_multiple_files") return readMultipleTextFiles(args, protectedRoots, signal);
    if (name === "search_files") return searchFiles(args, protectedRoots, signal);
    if (name === "search_text") return searchText(args, protectedRoots, signal);
    if (SEARCH_SESSION_CAPABILITY_NAMES.includes(
      name as (typeof SEARCH_SESSION_CAPABILITY_NAMES)[number],
    )) {
      return searchSessionExecutor(name, args, signal);
    }
    if (DOCUMENT_CAPABILITY_NAMES.includes(
      name as (typeof DOCUMENT_CAPABILITY_NAMES)[number],
    )) {
      return documentExecutor(name, args, signal);
    }
    if (RETRIEVAL_CAPABILITY_NAMES.includes(
      name as (typeof RETRIEVAL_CAPABILITY_NAMES)[number],
    )) {
      return retrievalExecutor(name, args, signal);
    }
    if (name === "write_file") return writeTextFile(args, protectedRoots, signal);
    if (name === "edit_file") return editTextFile(args, protectedRoots, signal);
    if (name === "create_directory") return createDirectoryPath(args, protectedRoots, signal);
    if (name === "copy_path") return copyPath(args, protectedRoots, signal);
    if (name === "move_path") return movePath(args, protectedRoots, signal);
    if (name === "delete_path") return deletePath(args, protectedRoots, signal);
    if (PROCESS_CAPABILITY_NAMES.includes(name as (typeof PROCESS_CAPABILITY_NAMES)[number])) {
      return processExecutor(name, args, signal);
    }
    if (
      SYSTEM_PROCESS_CAPABILITY_NAMES.includes(
        name as (typeof SYSTEM_PROCESS_CAPABILITY_NAMES)[number],
      )
    ) {
      return systemProcessExecutor(name, args, signal);
    }
    if (
      SCREENSHOT_CAPABILITY_NAMES.includes(
        name as (typeof SCREENSHOT_CAPABILITY_NAMES)[number],
      )
    ) {
      return screenshotExecutor(name, args, signal);
    }
    if (
      WINDOW_CAPABILITY_NAMES.includes(
        name as (typeof WINDOW_CAPABILITY_NAMES)[number],
      )
    ) {
      return windowExecutor(name, args, signal);
    }
    if (
      UI_AUTOMATION_CAPABILITY_NAMES.includes(
        name as (typeof UI_AUTOMATION_CAPABILITY_NAMES)[number],
      )
    ) {
      return uiAutomationExecutor(name, args, signal);
    }
    if (
      DESKTOP_CONTROL_CAPABILITY_NAMES.includes(
        name as (typeof DESKTOP_CONTROL_CAPABILITY_NAMES)[number],
      )
    ) {
      return desktopControlExecutor(name, args, signal);
    }
    throw new Error("unsupported_capability");
  };
}
