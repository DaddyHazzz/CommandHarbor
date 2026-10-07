import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { JsonValue } from "@commandharbor/protocol";

export const RETRIEVAL_CAPABILITY_NAMES = [
  "fetch_url",
  "preview_file",
  "get_rich_file_info",
] as const;

type Args = Record<string, JsonValue>;

const MAX_FETCH_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15_000;
const MAX_PREVIEW_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PREVIEW_JPEG_BYTES = 180 * 1024;
const MAX_HASH_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_VALUE = 2048;
const PREVIEW_TIMEOUT_MS = 10_000;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;

export interface RetrievalCapabilityOptions {
  validatePath(path: string, allowMissing: boolean): Promise<void>;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;
  requestHttps?: typeof httpsRequest;
  platform?: NodeJS.Platform;
  powershellPath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, required: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === required.length && required.every((key) => actual.includes(key));
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

function requireString(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max || value.includes("\0")) {
    throw new Error("invalid_arguments");
  }
  return value;
}

function requireInteger(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error("invalid_arguments");
  }
  return Number(value);
}

function requireAbsolutePath(value: unknown): string {
  const path = requireString(value, 1, 4096);
  if (!isAbsolute(path)) throw new Error("invalid_arguments");
  return path;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map((part) => Number(part));
  if (values.some((value, index) => !Number.isInteger(value) || value < 0 || value > 255 || String(value) !== parts[index])) {
    return null;
  }
  return values;
}

function ipv4Public(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function expandedIpv6(address: string): number[] | null {
  let input = address.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);

  let ipv4Tail: number[] | null = null;
  const lastColon = input.lastIndexOf(":");
  if (input.includes(".") && lastColon >= 0) {
    const v4 = parseIpv4(input.slice(lastColon + 1));
    if (!v4) return null;
    ipv4Tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    input = input.slice(0, lastColon) + ":v4";
  }

  const sides = input.split("::");
  if (sides.length > 2) return null;
  const left = sides[0] ? sides[0].split(":").filter(Boolean) : [];
  const right = sides.length === 2 && sides[1] ? sides[1].split(":").filter(Boolean) : [];

  const parsePart = (part: string): number[] | null => {
    if (part === "v4") return ipv4Tail;
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return [Number.parseInt(part, 16)];
  };

  const leftValues: number[] = [];
  for (const part of left) {
    const parsed = parsePart(part);
    if (!parsed) return null;
    leftValues.push(...parsed);
  }
  const rightValues: number[] = [];
  for (const part of right) {
    const parsed = parsePart(part);
    if (!parsed) return null;
    rightValues.push(...parsed);
  }

  if (sides.length === 1) {
    const values = [...leftValues, ...rightValues];
    return values.length === 8 ? values : null;
  }
  const missing = 8 - leftValues.length - rightValues.length;
  if (missing < 1) return null;
  return [...leftValues, ...Array(missing).fill(0), ...rightValues];
}

function ipv6Public(address: string): boolean {
  const groups = expandedIpv6(address);
  if (!groups) return false;

  if (groups.every((group) => group === 0)) return false;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false;

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (first === 0x2001 && groups[1] === 0x0db8) return false;
  if (first === 0x2001 && groups[1] === 0x0000) return false;
  if (first === 0x2002) return false;
  if (first === 0x0064 && groups[1] === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) return false;

  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6]!;
    const low = groups[7]!;
    return ipv4Public([
      high >> 8,
      high & 0xff,
      low >> 8,
      low & 0xff,
    ].join("."));
  }
  return true;
}

export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Public(address);
  if (family === 6) return ipv6Public(address);
  return false;
}

function validateUrl(value: unknown): URL {
  const raw = requireString(value, 8, 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("unsupported_url");
  if (!url.hostname || url.hostname.length > 253) throw new Error("invalid_url");
  return url;
}

async function defaultResolveHost(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  if (isIP(hostname)) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
}

async function validatedAddresses(
  hostname: string,
  resolveHost: NonNullable<RetrievalCapabilityOptions["resolveHost"]>,
): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local")) {
    throw new Error("network_target_not_public");
  }
  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new Error("network_resolution_failed");
  }
  if (addresses.length < 1 || addresses.length > 16 || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error("network_target_not_public");
  }
  return [...addresses].sort((left, right) => left.family - right.family);
}

function responseMime(headers: Record<string, string | string[] | undefined>): string {
  const raw = headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "application/octet-stream";
  return value.split(";", 1)[0]!.trim().toLowerCase().slice(0, 255) || "application/octet-stream";
}

function textualMime(mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType === "application/xml"
    || mimeType === "application/javascript"
    || mimeType.endsWith("+json")
    || mimeType.endsWith("+xml");
}

type FetchHop = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

async function fetchHop(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
  resolveHost: NonNullable<RetrievalCapabilityOptions["resolveHost"]>,
  requestHttps: typeof httpsRequest,
): Promise<FetchHop> {
  requireActive(signal);
  const addresses = await validatedAddresses(url.hostname, resolveHost);
  let selectedIndex = 0;

  return await new Promise<FetchHop>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: FetchHop) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("network_request_failed"));
    };
    const onAbort = () => {
      request.destroy(new Error("cancelled"));
      finish(new Error("cancelled"));
    };
    const timeout = setTimeout(() => {
      request.destroy(new Error("network_timeout"));
      finish(new Error("network_timeout"));
    }, timeoutMs);

    const request = requestHttps(url, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "User-Agent": "CommandHarbor/0.0.0",
      },
      lookup(_hostname, lookupOptions, callback) {
        if (typeof lookupOptions === "object" && lookupOptions !== null && "all" in lookupOptions && lookupOptions.all) {
          (callback as unknown as (
            error: NodeJS.ErrnoException | null,
            addresses: Array<{ address: string; family: 4 | 6 }>,
          ) => void)(null, addresses);
          return;
        }
        const selected = addresses[0]!;
        (callback as unknown as (
          error: NodeJS.ErrnoException | null,
          address: string,
          family: 4 | 6,
        ) => void)(null, selected.address, selected.family);
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const contentEncodingRaw = response.headers["content-encoding"];
      const contentEncoding = Array.isArray(contentEncodingRaw) ? contentEncodingRaw[0] : contentEncodingRaw;
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        response.destroy();
        finish(new Error("unsupported_content_encoding"));
        return;
      }
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.destroy();
        finish(new Error("response_too_large"));
        return;
      }
      let total = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          finish(new Error("response_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", () => finish(new Error("network_request_failed")));
      response.once("end", () => {
        finish(undefined, {
          statusCode,
          headers: response.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks, total),
        });
      });
    });

    request.once("error", (error: Error) => {
      if (settled) return;
      if (error.message === "cancelled") finish(new Error("cancelled"));
      else if (error.message === "network_timeout") finish(new Error("network_timeout"));
      else finish(new Error("network_request_failed"));
    });

    signal.addEventListener("abort", onAbort, { once: true });
    request.end();
  });
}

async function fetchUrl(
  args: Args,
  signal: AbortSignal,
  options: RetrievalCapabilityOptions,
): Promise<JsonValue> {
  if (!exactKeys(args, ["url", "maxBytes", "maxRedirects", "timeoutMs"])) throw new Error("invalid_arguments");
  let url = validateUrl(args.url);
  const maxBytes = requireInteger(args.maxBytes, 1, MAX_FETCH_BYTES);
  const maxRedirects = requireInteger(args.maxRedirects, 0, MAX_REDIRECTS);
  const timeoutMs = requireInteger(args.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const requestHttps = options.requestHttps ?? httpsRequest;
  const redirects: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    requireActive(signal);
    const response = await fetchHop(url, maxBytes, timeoutMs, signal, resolveHost, requestHttps);
    const locationRaw = response.headers.location;
    const location = Array.isArray(locationRaw) ? locationRaw[0] : locationRaw;
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
      if (hop >= maxRedirects) throw new Error("redirect_limit");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new Error("invalid_redirect");
      }
      validateUrl(next.toString());
      redirects.push(next.toString());
      url = next;
      continue;
    }

    const mimeType = responseMime(response.headers);
    const encoding = textualMime(mimeType) ? "utf8" : "base64";
    const body = encoding === "utf8" ? response.body.toString("utf8") : response.body.toString("base64");
    return {
      url: url.toString(),
      statusCode: response.statusCode,
      mimeType,
      bytes: response.body.length,
      encoding,
      body,
      sha256: createHash("sha256").update(response.body).digest("hex"),
      redirects,
    };
  }
  throw new Error("redirect_limit");
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const PREVIEW_SCRIPT = [
  "param([Parameter(Mandatory=$true)][string]$InputPath,[Parameter(Mandatory=$true)][string]$OutputPath)",
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$source=[System.Drawing.Image]::FromFile($InputPath)",
  "try{",
  "  $fit=[Math]::Min(1.0,[Math]::Min(1600.0/$source.Width,1000.0/$source.Height))",
  "  $attempts=@(@(65,1.0),@(50,1.0),@(35,1.0),@(25,0.8),@(20,0.65),@(18,0.5),@(15,0.35))",
  "  $codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1",
  "  if($null -eq $codec){throw 'jpeg_codec_unavailable'}",
  "  foreach($attempt in $attempts){",
  "    $quality=[int]$attempt[0];$factor=[double]$attempt[1]",
  "    $w=[Math]::Max(1,[int][Math]::Round($source.Width*$fit*$factor));$h=[Math]::Max(1,[int][Math]::Round($source.Height*$fit*$factor))",
  "    $scaled=New-Object System.Drawing.Bitmap($w,$h,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
  "    $g=[System.Drawing.Graphics]::FromImage($scaled)",
  "    try{$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$g.DrawImage($source,0,0,$w,$h)}finally{$g.Dispose()}",
  "    $params=New-Object System.Drawing.Imaging.EncoderParameters(1)",
  "    $param=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$quality);$params.Param[0]=$param",
  "    try{$scaled.Save($OutputPath,$codec,$params)}finally{$param.Dispose();$params.Dispose();$scaled.Dispose()}",
  "    $length=(Get-Item -LiteralPath $OutputPath).Length",
  "    if($length -le 184320){[Console]::Out.Write(([ordered]@{width=$w;height=$h;quality=$quality;sourceWidth=$source.Width;sourceHeight=$source.Height} | ConvertTo-Json -Compress));exit 0}",
  "  }",
  "  throw 'preview_too_large'",
  "}finally{$source.Dispose()}",
].join("\n");

async function runPreview(
  path: string,
  signal: AbortSignal,
  options: RetrievalCapabilityOptions,
): Promise<{ width: number; height: number; quality: number; sourceWidth: number; sourceHeight: number; jpeg: Buffer }> {
  if ((options.platform ?? process.platform) !== "win32") throw new Error("preview_unavailable");
  requireActive(signal);
  const directory = await mkdtemp(join(tmpdir(), "commandharbor-preview-"));
  const scriptPath = join(directory, "preview.ps1");
  const outputPath = join(directory, "preview.jpg");
  await writeFile(scriptPath, PREVIEW_SCRIPT, "utf8");
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        options.powershellPath ?? defaultPowerShellPath(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, path, outputPath],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        finish(new Error("cancelled"));
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("preview_timeout"));
      }, PREVIEW_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_STDOUT_BYTES) {
          child.kill("SIGKILL");
          finish(new Error("preview_failed"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = MAX_STDERR_BYTES - stderr.length;
        if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      });
      child.once("error", () => finish(new Error("preview_failed")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) finish(new Error("unsupported_preview"));
        else finish(undefined, stdout.toString("utf8"));
      });
    });
    requireActive(signal);
    let metadata: unknown;
    try {
      metadata = JSON.parse(output);
    } catch {
      throw new Error("preview_failed");
    }
    if (!isRecord(metadata)) throw new Error("preview_failed");
    const jpeg = await readFile(outputPath);
    if (jpeg.length < 4 || jpeg.length > MAX_PREVIEW_JPEG_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new Error("preview_failed");
    }
    for (const key of ["width", "height", "quality", "sourceWidth", "sourceHeight"]) {
      if (!Number.isInteger(metadata[key]) || Number(metadata[key]) < 1) throw new Error("preview_failed");
    }
    return {
      width: Number(metadata.width),
      height: Number(metadata.height),
      quality: Number(metadata.quality),
      sourceWidth: Number(metadata.sourceWidth),
      sourceHeight: Number(metadata.sourceHeight),
      jpeg,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function previewFile(
  args: Args,
  signal: AbortSignal,
  options: RetrievalCapabilityOptions,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  await options.validatePath(path, false);
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error("not_a_file");
  if (stats.size > MAX_PREVIEW_SOURCE_BYTES) throw new Error("preview_source_too_large");
  const result = await runPreview(path, signal, options);
  return {
    path,
    mimeType: "image/jpeg",
    width: result.width,
    height: result.height,
    sourceWidth: result.sourceWidth,
    sourceHeight: result.sourceHeight,
    quality: result.quality,
    bytes: result.jpeg.length,
    base64: result.jpeg.toString("base64"),
  };
}

function mimeFromMagic(buffer: Buffer, extension: string): { mimeType: string; kind: string } {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) {
    return { mimeType: "image/png", kind: "image" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", kind: "image" };
  }
  const ascii = buffer.subarray(0, 8).toString("ascii");
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return { mimeType: "image/gif", kind: "image" };
  if (ascii.startsWith("BM")) return { mimeType: "image/bmp", kind: "image" };
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") return { mimeType: "application/pdf", kind: "pdf" };
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    if (extension === ".docx") return { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "docx" };
    if (extension === ".xlsx") return { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "xlsx" };
    return { mimeType: "application/zip", kind: "archive" };
  }
  if (!buffer.includes(0)) return { mimeType: "text/plain", kind: "text" };
  return { mimeType: "application/octet-stream", kind: "binary" };
}

function imageDimensions(buffer: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === "image/bmp" && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1]!;
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
      if (offset + 4 > buffer.length) break;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function sha256File(path: string, signal: AbortSignal): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    const onAbort = () => {
      stream.destroy(new Error("cancelled"));
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk) => {
      if (!signal.aborted) hash.update(chunk);
    });
    stream.once("error", (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error.message === "cancelled" ? new Error("cancelled") : error);
    });
    stream.once("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(hash.digest("hex"));
    });
  });
}

async function getRichFileInfo(
  args: Args,
  signal: AbortSignal,
  options: RetrievalCapabilityOptions,
): Promise<JsonValue> {
  if (!exactKeys(args, ["path"])) throw new Error("invalid_arguments");
  const path = requireAbsolutePath(args.path);
  await options.validatePath(path, false);
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error("not_a_file");
  requireActive(signal);
  const file = await open(path, "r");
  let prefix: Buffer;
  try {
    const length = Math.min(stats.size, 64 * 1024);
    prefix = Buffer.alloc(length);
    const { bytesRead } = await file.read(prefix, 0, length, 0);
    prefix = prefix.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  const extension = extname(path).toLowerCase();
  const detected = mimeFromMagic(prefix, extension);
  const dimensions = imageDimensions(prefix, detected.mimeType);
  const hashAvailable = stats.size <= MAX_HASH_BYTES;
  const sha256 = hashAvailable ? await sha256File(path, signal) : null;
  return {
    path,
    size: stats.size,
    createdAt: stats.birthtimeMs,
    modifiedAt: stats.mtimeMs,
    extension,
    kind: detected.kind,
    mimeType: detected.mimeType,
    magicHex: prefix.subarray(0, Math.min(prefix.length, 16)).toString("hex"),
    sha256,
    hashAvailable,
    imageWidth: dimensions?.width ?? null,
    imageHeight: dimensions?.height ?? null,
  };
}

export function createRetrievalCapabilityExecutor(options: RetrievalCapabilityOptions) {
  return async (name: string, args: Args, signal: AbortSignal): Promise<JsonValue> => {
    requireActive(signal);
    if (!isRecord(args)) throw new Error("invalid_arguments");
    switch (name) {
      case "fetch_url": return fetchUrl(args, signal, options);
      case "preview_file": return previewFile(args, signal, options);
      case "get_rich_file_info": return getRichFileInfo(args, signal, options);
      default: throw new Error("unsupported_capability");
    }
  };
}
