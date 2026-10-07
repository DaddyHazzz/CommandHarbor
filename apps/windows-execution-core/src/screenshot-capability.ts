import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";

export const SCREENSHOT_CAPABILITY_NAMES = ["take_screenshot"] as const;

const MAX_JPEG_BYTES = 180 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;

export interface ScreenshotCaptureResult {
  width: number;
  height: number;
  quality: number;
  jpeg: Buffer;
}

export interface ScreenshotCapabilityOptions {
  capture?: (signal: AbortSignal) => Promise<ScreenshotCaptureResult>;
  platform?: NodeJS.Platform;
  powershellPath?: string;
}

type PowerShellRun = {
  stdout: string;
  stderr: string;
};

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

function validateCapture(result: ScreenshotCaptureResult): void {
  if (
    !Number.isInteger(result.width)
    || result.width < 1
    || result.width > 32_768
    || !Number.isInteger(result.height)
    || result.height < 1
    || result.height > 32_768
    || !Number.isInteger(result.quality)
    || result.quality < 1
    || result.quality > 100
    || !Buffer.isBuffer(result.jpeg)
    || result.jpeg.length < 4
  ) {
    throw new Error("invalid_screenshot");
  }
  if (
    result.jpeg[0] !== 0xff
    || result.jpeg[1] !== 0xd8
    || result.jpeg[result.jpeg.length - 2] !== 0xff
    || result.jpeg[result.jpeg.length - 1] !== 0xd9
  ) {
    throw new Error("invalid_screenshot");
  }
  if (result.jpeg.length > MAX_JPEG_BYTES) throw new Error("screenshot_too_large");
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const CAPTURE_SCRIPT = [
  "param([Parameter(Mandatory=$true)][string]$OutputPath)",
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen",
  "if($bounds.Width -le 0 -or $bounds.Height -le 0){throw 'invalid_screen_bounds'}",
  "$bitmap=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
  "$graphics=[System.Drawing.Graphics]::FromImage($bitmap)",
  "try{",
  "  $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size,[System.Drawing.CopyPixelOperation]::SourceCopy)",
  "}finally{$graphics.Dispose()}",
  "try{",
  "  $bitmap.Save($OutputPath,[System.Drawing.Imaging.ImageFormat]::Jpeg)",
  "  [Console]::Out.Write(([ordered]@{width=$bounds.Width;height=$bounds.Height} | ConvertTo-Json -Compress))",
  "}finally{$bitmap.Dispose()}",
].join("\n");

const COMPRESS_SCRIPT = [
  "param(",
  "  [Parameter(Mandatory=$true)][string]$InputPath,",
  "  [Parameter(Mandatory=$true)][string]$OutputPath,",
  "  [Parameter(Mandatory=$true)][int]$Width,",
  "  [Parameter(Mandatory=$true)][int]$Height,",
  "  [Parameter(Mandatory=$true)][int]$Quality",
  ")",
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Drawing",
  "$source=[System.Drawing.Image]::FromFile($InputPath)",
  "$scaled=New-Object System.Drawing.Bitmap($Width,$Height,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)",
  "$graphics=[System.Drawing.Graphics]::FromImage($scaled)",
  "try{",
  "  $graphics.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic",
  "  $graphics.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality",
  "  $graphics.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighQuality",
  "  $graphics.DrawImage($source,0,0,$Width,$Height)",
  "}finally{$graphics.Dispose();$source.Dispose()}",
  "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'} | Select-Object -First 1",
  "if($null -eq $codec){$scaled.Dispose();throw 'jpeg_codec_unavailable'}",
  "$parameters=New-Object System.Drawing.Imaging.EncoderParameters(1)",
  "$parameter=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]$Quality)",
  "$parameters.Param[0]=$parameter",
  "try{$scaled.Save($OutputPath,$codec,$parameters)}finally{$parameter.Dispose();$parameters.Dispose();$scaled.Dispose()}",
].join("\n");

const ATTEMPTS = [
  { factor: 1.0, quality: 65 },
  { factor: 1.0, quality: 50 },
  { factor: 1.0, quality: 35 },
  { factor: 1.0, quality: 20 },
  { factor: 0.8, quality: 50 },
  { factor: 0.65, quality: 45 },
  { factor: 0.5, quality: 40 },
  { factor: 0.4, quality: 30 },
  { factor: 0.3, quality: 25 },
  { factor: 0.22, quality: 20 },
] as const;

async function runPowerShellFile(
  powershellPath: string,
  scriptPath: string,
  args: string[],
  signal: AbortSignal,
): Promise<PowerShellRun> {
  requireActive(signal);

  return await new Promise<PowerShellRun>((resolve, reject) => {
    const child = spawn(
      powershellPath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        ...args,
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let settled = false;
    let timedOut = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    const finish = (error?: Error, result?: PowerShellRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("screenshot_capture_failed"));
    };

    const terminate = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort owned child termination.
      }
    };

    const onAbort = (): void => {
      terminate();
      finish(new Error("cancelled"));
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, PROCESS_TIMEOUT_MS);

    signal.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_STDOUT_BYTES) {
        terminate();
        finish(new Error("screenshot_capture_failed"));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      const remaining = MAX_STDERR_BYTES - stderr.length;
      if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
    });

    child.once("error", () => finish(new Error("screenshot_capture_failed")));
    child.once("close", (code) => {
      if (settled) return;
      if (timedOut) {
        finish(new Error("screenshot_timeout"));
        return;
      }
      if (signal.aborted) {
        finish(new Error("cancelled"));
        return;
      }
      if (code !== 0) {
        finish(new Error("screenshot_capture_failed"));
        return;
      }
      finish(undefined, {
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function fitDimensions(width: number, height: number, factor: number): {
  width: number;
  height: number;
} {
  const fit = Math.min(1, 1600 / width, 1000 / height);
  return {
    width: Math.max(1, Math.round(width * fit * factor)),
    height: Math.max(1, Math.round(height * fit * factor)),
  };
}

async function captureWindows(
  signal: AbortSignal,
  powershellPath: string,
): Promise<ScreenshotCaptureResult> {
  requireActive(signal);
  const directory = await mkdtemp(join(tmpdir(), "commandharbor-shot-"));
  const captureScriptPath = join(directory, "capture.ps1");
  const compressScriptPath = join(directory, "compress.ps1");
  const sourcePath = join(directory, "source.jpg");
  const previewPath = join(directory, "preview.jpg");

  try {
    await writeFile(captureScriptPath, CAPTURE_SCRIPT, "utf8");
    await writeFile(compressScriptPath, COMPRESS_SCRIPT, "utf8");

    const capture = await runPowerShellFile(
      powershellPath,
      captureScriptPath,
      ["-OutputPath", sourcePath],
      signal,
    );
    const metadata = JSON.parse(capture.stdout) as {
      width?: unknown;
      height?: unknown;
    };
    if (
      typeof metadata.width !== "number"
      || typeof metadata.height !== "number"
      || !Number.isInteger(metadata.width)
      || !Number.isInteger(metadata.height)
      || metadata.width < 1
      || metadata.height < 1
      || metadata.width > 32_768
      || metadata.height > 32_768
    ) {
      throw new Error("invalid_screenshot");
    }

    const sourceStats = await stat(sourcePath);
    if (sourceStats.size < 4 || sourceStats.size > MAX_SOURCE_BYTES) {
      throw new Error("invalid_screenshot");
    }

    for (const attempt of ATTEMPTS) {
      requireActive(signal);
      const dimensions = fitDimensions(
        metadata.width,
        metadata.height,
        attempt.factor,
      );
      await rm(previewPath, { force: true });
      await runPowerShellFile(
        powershellPath,
        compressScriptPath,
        [
          "-InputPath",
          sourcePath,
          "-OutputPath",
          previewPath,
          "-Width",
          String(dimensions.width),
          "-Height",
          String(dimensions.height),
          "-Quality",
          String(attempt.quality),
        ],
        signal,
      );
      const previewStats = await stat(previewPath);
      if (previewStats.size > MAX_JPEG_BYTES) continue;

      return {
        width: dimensions.width,
        height: dimensions.height,
        quality: attempt.quality,
        jpeg: await readFile(previewPath),
      };
    }

    throw new Error("screenshot_too_large");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createScreenshotCapabilityExecutor(
  options: ScreenshotCapabilityOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const capture = options.capture
    ?? (platform === "win32"
      ? (signal: AbortSignal) => captureWindows(
          signal,
          options.powershellPath ?? defaultPowerShellPath(),
        )
      : async () => {
          throw new Error("unsupported_platform");
        });

  return async (
    name: string,
    args: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> => {
    requireActive(signal);
    if (!SCREENSHOT_CAPABILITY_NAMES.includes(
      name as (typeof SCREENSHOT_CAPABILITY_NAMES)[number],
    )) {
      throw new Error("unsupported_capability");
    }
    if (!isRecord(args) || !exactKeys(args, [])) throw new Error("invalid_arguments");

    const captured = await capture(signal);
    requireActive(signal);
    validateCapture(captured);

    const result: Record<string, JsonValue> = {
      mimeType: "image/jpeg",
      width: captured.width,
      height: captured.height,
      quality: captured.quality,
      bytes: captured.jpeg.length,
      base64: captured.jpeg.toString("base64"),
    };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
      throw new Error("screenshot_too_large");
    }
    return result;
  };
}
