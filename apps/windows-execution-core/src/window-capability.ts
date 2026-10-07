import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";

export const WINDOW_CAPABILITY_NAMES = [
  "list_windows",
  "get_foreground_window",
  "activate_window",
  "set_window_state",
  "close_window",
] as const;

const MAX_WINDOWS = 100;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const PROCESS_TIMEOUT_MS = 8_000;

export interface WindowDescriptor {
  windowHandle: string;
  processId: number;
  processName: string;
  title: string;
  className: string;
  bounds: { left: number; top: number; width: number; height: number };
  visible: boolean;
  minimized: boolean;
  maximized: boolean;
  foreground: boolean;
}

export interface WindowIdentity {
  windowHandle: string;
  processId: number;
}

export type WindowState = "minimize" | "maximize" | "restore";

export interface WindowCloseResult {
  closeRequested: true;
  closed: boolean;
  window: WindowDescriptor | null;
}

export interface WindowBackend {
  listWindows(maxResults: number): Promise<{ windows: WindowDescriptor[]; truncated: boolean }>;
  getForegroundWindow(): Promise<WindowDescriptor | null>;
  activateWindow?(target: WindowIdentity): Promise<WindowDescriptor>;
  setWindowState?(target: WindowIdentity, state: WindowState): Promise<WindowDescriptor>;
  closeWindow?(target: WindowIdentity): Promise<WindowCloseResult>;
}

export interface WindowCapabilityOptions {
  backend?: WindowBackend;
  platform?: NodeJS.Platform;
  powershellPath?: string;
}

type HelperResponse = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function requireActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("cancelled");
}

function boundedCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= -100_000 && Number(value) <= 100_000;
}

function parseWindowIdentity(
  args: Record<string, JsonValue>,
  expectedKeys: readonly string[],
): WindowIdentity {
  if (!exactKeys(args, expectedKeys)
    || typeof args.windowHandle !== "string"
    || !/^[1-9][0-9]*$/.test(args.windowHandle)
    || args.windowHandle.length > 20
    || !Number.isSafeInteger(args.processId)
    || Number(args.processId) <= 0
    || Number(args.processId) > 2_147_483_647) {
    throw new Error("invalid_arguments");
  }
  return { windowHandle: args.windowHandle, processId: Number(args.processId) };
}

function validDescriptor(value: unknown): value is WindowDescriptor {
  if (!isRecord(value) || !isRecord(value.bounds)) return false;
  return typeof value.windowHandle === "string"
    && /^[0-9]+$/.test(value.windowHandle)
    && value.windowHandle.length <= 20
    && Number.isSafeInteger(value.processId)
    && Number(value.processId) > 0
    && typeof value.processName === "string"
    && value.processName.length <= 512
    && typeof value.title === "string"
    && value.title.length <= 4096
    && typeof value.className === "string"
    && value.className.length <= 512
    && boundedCoordinate(value.bounds.left)
    && boundedCoordinate(value.bounds.top)
    && boundedCoordinate(value.bounds.width)
    && Number(value.bounds.width) >= 0
    && boundedCoordinate(value.bounds.height)
    && Number(value.bounds.height) >= 0
    && typeof value.visible === "boolean"
    && typeof value.minimized === "boolean"
    && typeof value.maximized === "boolean"
    && typeof value.foreground === "boolean";
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const WINDOWS_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CommandHarborWindows {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public sealed class WindowInfo {
    public string windowHandle = "";
    public int processId;
    public string processName = "";
    public string title = "";
    public string className = "";
    public int left;
    public int top;
    public int width;
    public int height;
    public bool visible;
    public bool minimized;
    public bool maximized;
    public bool foreground;
  }

  public sealed class WindowActionResult {
    public bool matched;
    public bool applied;
    public WindowInfo window;
  }

  public sealed class WindowCloseResult {
    public bool matched;
    public bool closeRequested;
    public bool closed;
    public WindowInfo window;
  }

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder className, int maxCount);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  private static string HandleString(IntPtr hWnd) {
    return unchecked((ulong)hWnd.ToInt64()).ToString(CultureInfo.InvariantCulture);
  }

  private static string WindowText(IntPtr hWnd) {
    int requested = GetWindowTextLengthW(hWnd);
    int bounded = Math.Max(0, Math.Min(requested, 4096));
    var value = new StringBuilder(bounded + 1);
    GetWindowTextW(hWnd, value, value.Capacity);
    return value.ToString();
  }

  private static string ClassName(IntPtr hWnd) {
    var value = new StringBuilder(513);
    GetClassNameW(hWnd, value, value.Capacity);
    return value.ToString();
  }

  private static string ProcessName(uint processId) {
    try {
      using (var process = Process.GetProcessById((int)processId)) {
        string name = process.ProcessName ?? "";
        return name.Length <= 512 ? name : name.Substring(0, 512);
      }
    } catch {
      return "";
    }
  }

  private static WindowInfo Describe(IntPtr hWnd, IntPtr foreground, uint pid) {
    RECT rect;
    bool hasRect = GetWindowRect(hWnd, out rect);
    return new WindowInfo {
      windowHandle = HandleString(hWnd),
      processId = checked((int)pid),
      processName = ProcessName(pid),
      title = WindowText(hWnd),
      className = ClassName(hWnd),
      left = hasRect ? rect.Left : 0,
      top = hasRect ? rect.Top : 0,
      width = hasRect ? Math.Max(0, rect.Right - rect.Left) : 0,
      height = hasRect ? Math.Max(0, rect.Bottom - rect.Top) : 0,
      visible = IsWindowVisible(hWnd),
      minimized = IsIconic(hWnd),
      maximized = IsZoomed(hWnd),
      foreground = hWnd == foreground
    };
  }

  private const int ACTION_WAIT_MS = 1500;
  private const int ACTION_POLL_MS = 50;

  private static IntPtr Resolve(string handle, int expectedPid, out uint actualPid) {
    actualPid = 0;
    ulong raw;
    if (!UInt64.TryParse(handle, NumberStyles.None, CultureInfo.InvariantCulture, out raw) || raw == 0) return IntPtr.Zero;
    if (IntPtr.Size == 4 && raw > UInt32.MaxValue) return IntPtr.Zero;
    IntPtr hWnd = IntPtr.Size == 4
      ? new IntPtr(unchecked((int)(uint)raw))
      : new IntPtr(unchecked((long)raw));
    if (hWnd == IntPtr.Zero || !IsWindow(hWnd)) return IntPtr.Zero;
    GetWindowThreadProcessId(hWnd, out actualPid);
    if (actualPid == 0 || actualPid != (uint)expectedPid) return IntPtr.Zero;
    return hWnd;
  }

  private static WindowActionResult ObserveAction(string handle, int expectedPid, Func<WindowInfo, bool> satisfied) {
    WindowInfo last = null;
    for (int elapsed = 0; elapsed <= ACTION_WAIT_MS; elapsed += ACTION_POLL_MS) {
      uint pid;
      IntPtr hWnd = Resolve(handle, expectedPid, out pid);
      if (hWnd == IntPtr.Zero) return new WindowActionResult { matched = false, applied = false, window = null };
      last = Describe(hWnd, GetForegroundWindow(), pid);
      if (satisfied(last)) return new WindowActionResult { matched = true, applied = true, window = last };
      if (elapsed < ACTION_WAIT_MS) Thread.Sleep(ACTION_POLL_MS);
    }
    return new WindowActionResult { matched = true, applied = false, window = last };
  }

  public static WindowActionResult Activate(string handle, int expectedPid) {
    uint pid;
    IntPtr hWnd = Resolve(handle, expectedPid, out pid);
    if (hWnd == IntPtr.Zero) return new WindowActionResult { matched = false, applied = false, window = null };

    IntPtr foreground = GetForegroundWindow();
    uint ignoredPid;
    uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignoredPid);
    uint targetThread = GetWindowThreadProcessId(hWnd, out ignoredPid);
    uint currentThread = GetCurrentThreadId();
    bool attachedForeground = false;
    bool attachedTarget = false;

    try {
      if (foregroundThread != 0 && foregroundThread != currentThread) {
        attachedForeground = AttachThreadInput(currentThread, foregroundThread, true);
      }
      if (targetThread != 0 && targetThread != currentThread && targetThread != foregroundThread) {
        attachedTarget = AttachThreadInput(currentThread, targetThread, true);
      }
      if (IsIconic(hWnd)) ShowWindowAsync(hWnd, 9);
      BringWindowToTop(hWnd);
      SetActiveWindow(hWnd);
      SetForegroundWindow(hWnd);
      SetFocus(hWnd);
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }

    return ObserveAction(handle, expectedPid, delegate(WindowInfo window) { return window.foreground; });
  }

  public static WindowActionResult SetState(string handle, int expectedPid, string state) {
    uint pid;
    IntPtr hWnd = Resolve(handle, expectedPid, out pid);
    if (hWnd == IntPtr.Zero) return new WindowActionResult { matched = false, applied = false, window = null };
    int command = state == "minimize" ? 6 : state == "maximize" ? 3 : 9;
    ShowWindowAsync(hWnd, command);
    return ObserveAction(handle, expectedPid, delegate(WindowInfo window) {
      return state == "minimize" ? window.minimized : state == "maximize" ? window.maximized : !window.minimized && !window.maximized;
    });
  }

  public static WindowCloseResult Close(string handle, int expectedPid) {
    uint pid;
    IntPtr hWnd = Resolve(handle, expectedPid, out pid);
    if (hWnd == IntPtr.Zero) return new WindowCloseResult { matched = false, closeRequested = false, closed = false, window = null };
    bool requested = PostMessageW(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    if (!requested) return new WindowCloseResult {
      matched = true, closeRequested = false, closed = false, window = Describe(hWnd, GetForegroundWindow(), pid)
    };
    WindowInfo last = null;
    for (int elapsed = 0; elapsed <= ACTION_WAIT_MS; elapsed += ACTION_POLL_MS) {
      uint currentPid;
      IntPtr current = Resolve(handle, expectedPid, out currentPid);
      if (current == IntPtr.Zero) return new WindowCloseResult { matched = true, closeRequested = true, closed = true, window = null };
      last = Describe(current, GetForegroundWindow(), currentPid);
      if (elapsed < ACTION_WAIT_MS) Thread.Sleep(ACTION_POLL_MS);
    }
    return new WindowCloseResult { matched = true, closeRequested = true, closed = false, window = last };
  }
  public static WindowInfo[] List(int maxResults, out bool truncated) {
    var values = new List<WindowInfo>();
    IntPtr foreground = GetForegroundWindow();
    bool sawExtra = false;
    EnumWindows(delegate(IntPtr hWnd, IntPtr ignored) {
      if (!IsWindowVisible(hWnd)) return true;
      if (WindowText(hWnd).Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (pid == 0) return true;
      if (values.Count >= maxResults) { sawExtra = true; return false; }
      values.Add(Describe(hWnd, foreground, pid));
      return true;
    }, IntPtr.Zero);
    truncated = sawExtra;
    return values.ToArray();
  }

  public static WindowInfo Foreground() {
    IntPtr hWnd = GetForegroundWindow();
    if (hWnd == IntPtr.Zero) return null;
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    if (pid == 0) return null;
    return Describe(hWnd, hWnd, pid);
  }
}
"@

$raw = [Console]::In.ReadToEnd()
$request = $raw | ConvertFrom-Json

function Convert-WindowObject($window) {
  if ($null -eq $window) { return $null }
  return [ordered]@{
    windowHandle = $window.windowHandle
    processId = $window.processId
    processName = $window.processName
    title = $window.title
    className = $window.className
    bounds = [ordered]@{ left = $window.left; top = $window.top; width = $window.width; height = $window.height }
    visible = $window.visible
    minimized = $window.minimized
    maximized = $window.maximized
    foreground = $window.foreground
  }
}

switch ([string]$request.action) {
  'list_windows' {
    $truncated = $false
    $windows = [CommandHarborWindows]::List([int]$request.maxResults, [ref]$truncated)
    [Console]::Out.Write(([ordered]@{ windows = @($windows | ForEach-Object {
      [ordered]@{
        windowHandle = $_.windowHandle; processId = $_.processId; processName = $_.processName
        title = $_.title; className = $_.className
        bounds = [ordered]@{ left = $_.left; top = $_.top; width = $_.width; height = $_.height }
        visible = $_.visible; minimized = $_.minimized; maximized = $_.maximized; foreground = $_.foreground
      }
    }); truncated = $truncated } | ConvertTo-Json -Compress -Depth 5))
  }
  'get_foreground_window' {
    $window = [CommandHarborWindows]::Foreground()
    if ($null -eq $window) {
      [Console]::Out.Write('{"window":null}')
    } else {
      [Console]::Out.Write(([ordered]@{ window = [ordered]@{
        windowHandle = $window.windowHandle; processId = $window.processId; processName = $window.processName
        title = $window.title; className = $window.className
        bounds = [ordered]@{ left = $window.left; top = $window.top; width = $window.width; height = $window.height }
        visible = $window.visible; minimized = $window.minimized; maximized = $window.maximized; foreground = $window.foreground
      } } | ConvertTo-Json -Compress -Depth 5))
    }
  }
  'activate_window' {
    $result = [CommandHarborWindows]::Activate(
      [string]$request.windowHandle,
      [int]$request.processId
    )
    [Console]::Out.Write(([ordered]@{
      matched = $result.matched
      applied = $result.applied
      window = Convert-WindowObject $result.window
    } | ConvertTo-Json -Compress -Depth 5))
  }
  'set_window_state' {
    $result = [CommandHarborWindows]::SetState(
      [string]$request.windowHandle,
      [int]$request.processId,
      [string]$request.state
    )
    [Console]::Out.Write(([ordered]@{
      matched = $result.matched
      applied = $result.applied
      window = Convert-WindowObject $result.window
    } | ConvertTo-Json -Compress -Depth 5))
  }
  'close_window' {
    $result = [CommandHarborWindows]::Close(
      [string]$request.windowHandle,
      [int]$request.processId
    )
    [Console]::Out.Write(([ordered]@{
      matched = $result.matched
      closeRequested = $result.closeRequested
      closed = $result.closed
      window = Convert-WindowObject $result.window
    } | ConvertTo-Json -Compress -Depth 5))
  }
  default { throw 'unsupported_action' }
}
`;

async function runWindowsHelper(
  powershellPath: string,
  request: Record<string, unknown>,
): Promise<HelperResponse> {
  const directory = await mkdtemp(join(tmpdir(), "commandharbor-window-"));
  const scriptPath = join(directory, "window.ps1");
  try {
    await writeFile(scriptPath, WINDOWS_HELPER, "utf8");
    return await new Promise<HelperResponse>((resolve, reject) => {
      const child = spawn(
        powershellPath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-STA",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const finish = (error?: Error, result?: HelperResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result ?? {});
      };
      const timeout = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        finish(new Error("window_control_timeout"));
      }, PROCESS_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_STDOUT_BYTES) {
          try { child.kill("SIGKILL"); } catch {}
          finish(new Error("window_control_output_too_large"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_STDERR_BYTES - stderr.length;
        if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      });
      child.once("error", () => finish(new Error("window_control_failed")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error("window_control_failed"));
          return;
        }
        try {
          const parsed = stdout.length === 0 ? {} : JSON.parse(stdout.toString("utf8"));
          if (!isRecord(parsed)) throw new Error("invalid_helper_result");
          finish(undefined, parsed);
        } catch {
          finish(new Error("window_control_failed"));
        }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function descriptorFrom(value: unknown): WindowDescriptor {
  if (!validDescriptor(value)) throw new Error("window_control_failed");
  return value;
}

function actionWindowFrom(result: HelperResponse, target: WindowIdentity): WindowDescriptor {
  if (!exactKeys(result, ["matched", "applied", "window"])
    || typeof result.matched !== "boolean"
    || typeof result.applied !== "boolean") {
    throw new Error("window_control_failed");
  }
  if (!result.matched) throw new Error("stale_window");
  if (!result.applied) throw new Error("window_control_failed");
  const window = descriptorFrom(result.window);
  if (window.windowHandle !== target.windowHandle || window.processId !== target.processId) {
    throw new Error("window_control_failed");
  }
  return window;
}

function closeResultFrom(result: HelperResponse, target: WindowIdentity): WindowCloseResult {
  if (!exactKeys(result, ["matched", "closeRequested", "closed", "window"])
    || typeof result.matched !== "boolean"
    || typeof result.closeRequested !== "boolean"
    || typeof result.closed !== "boolean") {
    throw new Error("window_control_failed");
  }
  if (!result.matched) throw new Error("stale_window");
  if (!result.closeRequested) throw new Error("window_control_failed");
  if (result.closed) {
    if (result.window !== null) throw new Error("window_control_failed");
    return { closeRequested: true, closed: true, window: null };
  }
  const window = descriptorFrom(result.window);
  if (window.windowHandle !== target.windowHandle || window.processId !== target.processId) {
    throw new Error("window_control_failed");
  }
  return { closeRequested: true, closed: false, window };
}
function createWindowsBackend(powershellPath: string): WindowBackend {
  return {
    listWindows: async (maxResults) => {
      const result = await runWindowsHelper(powershellPath, { action: "list_windows", maxResults });
      if (!Array.isArray(result.windows)
        || result.windows.length > maxResults
        || typeof result.truncated !== "boolean") {
        throw new Error("window_control_failed");
      }
      return { windows: result.windows.map(descriptorFrom), truncated: result.truncated };
    },
    getForegroundWindow: async () => {
      const result = await runWindowsHelper(powershellPath, { action: "get_foreground_window" });
      if (!exactKeys(result, ["window"])) throw new Error("window_control_failed");
      return result.window === null ? null : descriptorFrom(result.window);
    },
    activateWindow: async (target) => actionWindowFrom(
      await runWindowsHelper(powershellPath, { action: "activate_window", ...target }),
      target,
    ),
    setWindowState: async (target, state) => actionWindowFrom(
      await runWindowsHelper(powershellPath, { action: "set_window_state", ...target, state }),
      target,
    ),
    closeWindow: async (target) => closeResultFrom(
      await runWindowsHelper(powershellPath, { action: "close_window", ...target }),
      target,
    ),
  };
}

function descriptorJson(window: WindowDescriptor): JsonValue {
  return {
    windowHandle: window.windowHandle,
    processId: window.processId,
    processName: window.processName,
    title: window.title,
    className: window.className,
    bounds: {
      left: window.bounds.left,
      top: window.bounds.top,
      width: window.bounds.width,
      height: window.bounds.height,
    },
    visible: window.visible,
    minimized: window.minimized,
    maximized: window.maximized,
    foreground: window.foreground,
  };
}

export function createWindowCapabilityExecutor(options: WindowCapabilityOptions = {}) {
  const platform = options.platform ?? process.platform;
  const backend = options.backend ?? (platform === "win32"
    ? createWindowsBackend(options.powershellPath ?? defaultPowerShellPath())
    : null);

  return async (
    name: string,
    args: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> => {
    requireActive(signal);
    if (!WINDOW_CAPABILITY_NAMES.includes(name as (typeof WINDOW_CAPABILITY_NAMES)[number])) {
      throw new Error("unsupported_capability");
    }
    if (!backend) throw new Error("unsupported_platform");
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (name === "list_windows") {
      if (!exactKeys(args, ["maxResults"])
        || !Number.isSafeInteger(args.maxResults)
        || Number(args.maxResults) < 1
        || Number(args.maxResults) > MAX_WINDOWS) {
        throw new Error("invalid_arguments");
      }
      const maxResults = Number(args.maxResults);
      const result = await backend.listWindows(maxResults);
      requireActive(signal);
      if (!Array.isArray(result.windows)
        || result.windows.length > maxResults
        || typeof result.truncated !== "boolean") {
        throw new Error("window_control_failed");
      }
      const windows = result.windows.map((window) => descriptorFrom(window));
      return { windows: windows.map(descriptorJson), truncated: result.truncated };
    }

    if (name === "get_foreground_window") {
      if (!exactKeys(args, [])) throw new Error("invalid_arguments");
      const window = await backend.getForegroundWindow();
      requireActive(signal);
      return { window: window === null ? null : descriptorJson(descriptorFrom(window)) };
    }

    if (name === "activate_window") {
      const target = parseWindowIdentity(args, ["windowHandle", "processId"]);
      if (!backend.activateWindow) throw new Error("window_control_failed");
      const window = await backend.activateWindow(target);
      requireActive(signal);
      return { window: descriptorJson(descriptorFrom(window)) };
    }

    if (name === "set_window_state") {
      const target = parseWindowIdentity(args, ["windowHandle", "processId", "state"]);
      if (args.state !== "minimize" && args.state !== "maximize" && args.state !== "restore") {
        throw new Error("invalid_arguments");
      }
      if (!backend.setWindowState) throw new Error("window_control_failed");
      const window = await backend.setWindowState(target, args.state);
      requireActive(signal);
      return { window: descriptorJson(descriptorFrom(window)) };
    }

    const target = parseWindowIdentity(args, ["windowHandle", "processId"]);
    if (!backend.closeWindow) throw new Error("window_control_failed");
    const result = await backend.closeWindow(target);
    requireActive(signal);
    const record = result as unknown as Record<string, unknown>;
    if (!exactKeys(record, ["closeRequested", "closed", "window"])
      || result.closeRequested !== true
      || typeof result.closed !== "boolean") {
      throw new Error("window_control_failed");
    }
    if (result.closed) {
      if (result.window !== null) throw new Error("window_control_failed");
      return { closeRequested: true, closed: true, window: null };
    }
    if (result.window === null) throw new Error("window_control_failed");
    const window = descriptorFrom(result.window);
    if (window.windowHandle !== target.windowHandle || window.processId !== target.processId) {
      throw new Error("window_control_failed");
    }
    return { closeRequested: true, closed: false, window: descriptorJson(window) };
  };
}
