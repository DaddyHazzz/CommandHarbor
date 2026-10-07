import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";

export const DESKTOP_CONTROL_CAPABILITY_NAMES = [
  "get_cursor_position",
  "move_mouse",
  "click_mouse",
  "scroll_mouse",
  "type_text",
  "press_key",
  "read_clipboard",
  "write_clipboard",
] as const;

export type MouseButton = "left" | "right" | "middle";
export type KeyModifier = "ctrl" | "alt" | "shift" | "win";

export interface DesktopControlBackend {
  getCursorPosition(): Promise<{ x: number; y: number }>;
  moveMouse(x: number, y: number): Promise<void>;
  clickMouse(button: MouseButton, count: number): Promise<void>;
  scrollMouse(deltaX: number, deltaY: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string, modifiers: KeyModifier[], repeat: number): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
}

export interface DesktopControlCapabilityOptions {
  backend?: DesktopControlBackend;
  platform?: NodeJS.Platform;
  powershellPath?: string;
}

const MAX_COORDINATE = 100_000;
const MAX_SCROLL_DELTA = 10_000;
const MAX_TEXT_CHARS = 16_384;
const MAX_CLIPBOARD_CHARS = 65_536;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;

export function encodeClipboardHelperText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

export function decodeClipboardHelperText(encoded: string): string {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("desktop_control_failed");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("desktop_control_failed");
  }
}

const MODIFIERS = new Set<KeyModifier>(["ctrl", "alt", "shift", "win"]);
const NAMED_KEYS = new Set([
  "backspace", "tab", "enter", "escape", "space",
  "pageup", "pagedown", "end", "home",
  "left", "up", "right", "down",
  "insert", "delete",
  ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
]);

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

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function validKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const key = value.toLowerCase();
  return /^[a-z0-9]$/.test(key) || NAMED_KEYS.has(key);
}

function normalizeModifiers(value: unknown): KeyModifier[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("invalid_arguments");
  const normalized: KeyModifier[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !MODIFIERS.has(item as KeyModifier)) {
      throw new Error("invalid_arguments");
    }
    const modifier = item as KeyModifier;
    if (normalized.includes(modifier)) throw new Error("invalid_arguments");
    normalized.push(modifier);
  }
  return normalized;
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
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class CommandHarborDesktopInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public uint flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public int mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool GetCursorPos(out POINT point);

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

  [DllImport("user32.dll")]
  static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extraInfo);

  [DllImport("user32.dll", SetLastError=true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);

  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", SetLastError=true)]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll", SetLastError=true)]
  static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr SendMessageTimeout(
    IntPtr hWnd,
    uint message,
    UIntPtr wParam,
    IntPtr lParam,
    uint flags,
    uint timeout,
    out UIntPtr result);

  const uint MOUSE_LEFT_DOWN = 0x0002;
  const uint MOUSE_LEFT_UP = 0x0004;
  const uint MOUSE_RIGHT_DOWN = 0x0008;
  const uint MOUSE_RIGHT_UP = 0x0010;
  const uint MOUSE_MIDDLE_DOWN = 0x0020;
  const uint MOUSE_MIDDLE_UP = 0x0040;
  const uint MOUSE_WHEEL = 0x0800;
  const uint MOUSE_HWHEEL = 0x1000;
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  const uint INPUT_KEYBOARD = 1;
  const uint WM_KEYDOWN = 0x0100;
  const uint WM_KEYUP = 0x0101;
  const uint WM_CHAR = 0x0102;
  const uint VK_RETURN = 0x000D;
  const uint SMTO_ABORTIFHUNG = 0x0002;
  const uint EDIT_MESSAGE_TIMEOUT_MS = 250;

  public static POINT Cursor() {
    POINT point;
    if (!GetCursorPos(out point)) throw new InvalidOperationException("cursor_read_failed");
    return point;
  }

  public static void Move(int x, int y) {
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("cursor_move_failed");
  }

  public static void Click(string button, int count) {
    uint down;
    uint up;
    switch (button) {
      case "left": down = MOUSE_LEFT_DOWN; up = MOUSE_LEFT_UP; break;
      case "right": down = MOUSE_RIGHT_DOWN; up = MOUSE_RIGHT_UP; break;
      case "middle": down = MOUSE_MIDDLE_DOWN; up = MOUSE_MIDDLE_UP; break;
      default: throw new ArgumentException("invalid_button");
    }
    for (int i = 0; i < count; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
    }
  }

  public static void Scroll(int deltaX, int deltaY) {
    if (deltaX != 0) mouse_event(MOUSE_HWHEEL, 0, 0, deltaX, UIntPtr.Zero);
    if (deltaY != 0) mouse_event(MOUSE_WHEEL, 0, 0, deltaY, UIntPtr.Zero);
  }

  static INPUT UnicodeInput(char character, bool keyUp) {
    INPUT input = new INPUT();
    input.type = INPUT_KEYBOARD;
    input.U.ki = new KEYBDINPUT {
      wVk = 0,
      wScan = character,
      dwFlags = KEYEVENTF_UNICODE | (keyUp ? KEYEVENTF_KEYUP : 0),
      time = 0,
      dwExtraInfo = UIntPtr.Zero
    };
    return input;
  }

  static IntPtr FocusedEditControl() {
    IntPtr foreground = GetForegroundWindow();
    if (foreground == IntPtr.Zero) return IntPtr.Zero;

    uint processId;
    uint threadId = GetWindowThreadProcessId(foreground, out processId);
    if (threadId == 0) return IntPtr.Zero;

    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(threadId, ref info)) return IntPtr.Zero;

    IntPtr target = info.hwndFocus != IntPtr.Zero ? info.hwndFocus : info.hwndActive;
    if (target == IntPtr.Zero) return IntPtr.Zero;

    StringBuilder className = new StringBuilder(256);
    if (GetClassName(target, className, className.Capacity) <= 0) return IntPtr.Zero;
    string name = className.ToString();
    if (string.Equals(name, "Edit", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)) {
      return target;
    }
    return IntPtr.Zero;
  }

  static void SendEditMessage(IntPtr target, uint message, uint wParam, IntPtr lParam) {
    UIntPtr result;
    IntPtr delivered = SendMessageTimeout(
      target,
      message,
      new UIntPtr(wParam),
      lParam,
      SMTO_ABORTIFHUNG,
      EDIT_MESSAGE_TIMEOUT_MS,
      out result);
    if (delivered == IntPtr.Zero) throw new InvalidOperationException("keyboard_input_failed");
  }

  static void SendEditEnter(IntPtr target) {
    SendEditMessage(target, WM_KEYDOWN, VK_RETURN, new IntPtr(1));
    SendEditMessage(target, WM_CHAR, VK_RETURN, new IntPtr(1));
    SendEditMessage(target, WM_KEYUP, VK_RETURN, new IntPtr(unchecked((int)0xC0000001)));
  }

  static void TypeTextToEdit(IntPtr target, string text) {
    char previous = '\0';
    foreach (char character in text) {
      if (character == '\n' && previous == '\r') {
        previous = character;
        continue;
      }
      if (character == '\r' || character == '\n') {
        SendEditEnter(target);
      } else {
        SendEditMessage(target, WM_CHAR, character, new IntPtr(1));
      }
      previous = character;
    }
  }

  static void TypeTextWithSendInput(string text) {
    foreach (char character in text) {
      INPUT[] inputs = new INPUT[] {
        UnicodeInput(character, false),
        UnicodeInput(character, true)
      };
      uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
      if (sent != inputs.Length) throw new InvalidOperationException("keyboard_input_failed");
    }
  }

  public static void TypeText(string text) {
    IntPtr editControl = FocusedEditControl();
    if (editControl != IntPtr.Zero) {
      TypeTextToEdit(editControl, text);
      return;
    }
    TypeTextWithSendInput(text);
  }

  static void Key(byte virtualKey, bool up) {
    keybd_event(virtualKey, 0, up ? KEYEVENTF_KEYUP : 0, UIntPtr.Zero);
  }

  public static void PressKey(byte virtualKey, byte[] modifiers, int repeat) {
    foreach (byte modifier in modifiers) Key(modifier, false);
    try {
      for (int i = 0; i < repeat; i++) {
        Key(virtualKey, false);
        Key(virtualKey, true);
      }
    } finally {
      for (int i = modifiers.Length - 1; i >= 0; i--) Key(modifiers[i], true);
    }
  }
}
"@

function Convert-Key([string]$Key) {
  $normalized = $Key.ToLowerInvariant()
  if ($normalized.Length -eq 1) {
    $char = [char]$normalized[0]
    if ($char -ge 'a' -and $char -le 'z') { return [byte]([int][char]'A' + ([int]$char - [int][char]'a')) }
    if ($char -ge '0' -and $char -le '9') { return [byte][int]$char }
  }
  $named = @{
    backspace = 0x08; tab = 0x09; enter = 0x0D; escape = 0x1B; space = 0x20;
    pageup = 0x21; pagedown = 0x22; end = 0x23; home = 0x24;
    left = 0x25; up = 0x26; right = 0x27; down = 0x28;
    insert = 0x2D; delete = 0x2E
  }
  if ($named.ContainsKey($normalized)) { return [byte]$named[$normalized] }
  if ($normalized -match '^f([1-9]|1[0-9]|2[0-4])$') {
    return [byte](0x6F + [int]$Matches[1])
  }
  throw 'invalid_key'
}

function Convert-Modifiers($Modifiers) {
  $result = New-Object 'System.Collections.Generic.List[byte]'
  foreach ($modifier in @($Modifiers)) {
    switch ([string]$modifier) {
      'ctrl' { $result.Add([byte]0x11) }
      'alt' { $result.Add([byte]0x12) }
      'shift' { $result.Add([byte]0x10) }
      'win' { $result.Add([byte]0x5B) }
      default { throw 'invalid_modifier' }
    }
  }
  return ,$result.ToArray()
}

$raw = [Console]::In.ReadToEnd()
$request = $raw | ConvertFrom-Json
switch ([string]$request.action) {
  'get_cursor_position' {
    $point = [CommandHarborDesktopInput]::Cursor()
    [Console]::Out.Write(([ordered]@{ x = $point.X; y = $point.Y } | ConvertTo-Json -Compress))
  }
  'move_mouse' {
    [CommandHarborDesktopInput]::Move([int]$request.x, [int]$request.y)
    [Console]::Out.Write('{}')
  }
  'click_mouse' {
    [CommandHarborDesktopInput]::Click([string]$request.button, [int]$request.count)
    [Console]::Out.Write('{}')
  }
  'scroll_mouse' {
    [CommandHarborDesktopInput]::Scroll([int]$request.deltaX, [int]$request.deltaY)
    [Console]::Out.Write('{}')
  }
  'type_text' {
    [CommandHarborDesktopInput]::TypeText([string]$request.text)
    [Console]::Out.Write('{}')
  }
  'press_key' {
    $virtualKey = Convert-Key ([string]$request.key)
    $modifiers = Convert-Modifiers $request.modifiers
    [CommandHarborDesktopInput]::PressKey($virtualKey, $modifiers, [int]$request.repeat)
    [Console]::Out.Write('{}')
  }
  'read_clipboard' {
    $text = if ([System.Windows.Forms.Clipboard]::ContainsText()) {
      [System.Windows.Forms.Clipboard]::GetText()
    } else { '' }
    $textBytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    [Console]::Out.Write(([ordered]@{ textBase64 = [Convert]::ToBase64String($textBytes) } | ConvertTo-Json -Compress))
  }
  'write_clipboard' {
    $clipboardBytes = [Convert]::FromBase64String([string]$request.textBase64)
    $clipboardText = [System.Text.Encoding]::UTF8.GetString($clipboardBytes)
    if ($clipboardText.Length -eq 0) {
      [System.Windows.Forms.Clipboard]::Clear()
    } else {
      [System.Windows.Forms.Clipboard]::SetText($clipboardText)
    }
    [Console]::Out.Write('{}')
  }
  default { throw 'unsupported_action' }
}
`;

type HelperResponse = Record<string, unknown>;

async function runWindowsHelper(
  powershellPath: string,
  request: Record<string, unknown>,
): Promise<HelperResponse> {
  const directory = await mkdtemp(join(tmpdir(), "commandharbor-desktop-"));
  const scriptPath = join(directory, "desktop.ps1");

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
        finish(new Error("desktop_control_timeout"));
      }, PROCESS_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_STDOUT_BYTES) {
          try { child.kill("SIGKILL"); } catch {}
          finish(new Error("desktop_control_output_too_large"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_STDERR_BYTES - stderr.length;
        if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      });
      child.once("error", () => finish(new Error("desktop_control_failed")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error("desktop_control_failed"));
          return;
        }
        try {
          const parsed = stdout.length === 0 ? {} : JSON.parse(stdout.toString("utf8"));
          if (!isRecord(parsed)) throw new Error("invalid_helper_result");
          finish(undefined, parsed);
        } catch {
          finish(new Error("desktop_control_failed"));
        }
      });

      child.stdin.end(JSON.stringify(request), "utf8");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createWindowsBackend(powershellPath: string): DesktopControlBackend {
  return {
    getCursorPosition: async () => {
      const result = await runWindowsHelper(powershellPath, { action: "get_cursor_position" });
      if (!boundedInteger(result.x, -MAX_COORDINATE, MAX_COORDINATE)
        || !boundedInteger(result.y, -MAX_COORDINATE, MAX_COORDINATE)) {
        throw new Error("desktop_control_failed");
      }
      return { x: result.x, y: result.y };
    },
    moveMouse: async (x, y) => { await runWindowsHelper(powershellPath, { action: "move_mouse", x, y }); },
    clickMouse: async (button, count) => {
      await runWindowsHelper(powershellPath, { action: "click_mouse", button, count });
    },
    scrollMouse: async (deltaX, deltaY) => {
      await runWindowsHelper(powershellPath, { action: "scroll_mouse", deltaX, deltaY });
    },
    typeText: async (text) => { await runWindowsHelper(powershellPath, { action: "type_text", text }); },
    pressKey: async (key, modifiers, repeat) => {
      await runWindowsHelper(powershellPath, { action: "press_key", key, modifiers, repeat });
    },
    readClipboard: async () => {
      const result = await runWindowsHelper(powershellPath, { action: "read_clipboard" });
      if (typeof result.textBase64 !== "string") throw new Error("desktop_control_failed");
      return decodeClipboardHelperText(result.textBase64);
    },
    writeClipboard: async (text) => {
      await runWindowsHelper(powershellPath, {
        action: "write_clipboard",
        textBase64: encodeClipboardHelperText(text),
      });
    },
  };
}

export function createDesktopControlCapabilityExecutor(
  options: DesktopControlCapabilityOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const backend = options.backend
    ?? (platform === "win32"
      ? createWindowsBackend(options.powershellPath ?? defaultPowerShellPath())
      : null);

  return async (
    name: string,
    args: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> => {
    requireActive(signal);
    if (!DESKTOP_CONTROL_CAPABILITY_NAMES.includes(
      name as (typeof DESKTOP_CONTROL_CAPABILITY_NAMES)[number],
    )) {
      throw new Error("unsupported_capability");
    }
    if (!backend) throw new Error("unsupported_platform");
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (name === "get_cursor_position") {
      if (!exactKeys(args, [])) throw new Error("invalid_arguments");
      const result = await backend.getCursorPosition();
      requireActive(signal);
      if (!boundedInteger(result.x, -MAX_COORDINATE, MAX_COORDINATE)
        || !boundedInteger(result.y, -MAX_COORDINATE, MAX_COORDINATE)) {
        throw new Error("desktop_control_failed");
      }
      return result;
    }

    if (name === "move_mouse") {
      if (!exactKeys(args, ["x", "y"])
        || !boundedInteger(args.x, -MAX_COORDINATE, MAX_COORDINATE)
        || !boundedInteger(args.y, -MAX_COORDINATE, MAX_COORDINATE)) {
        throw new Error("invalid_arguments");
      }
      await backend.moveMouse(args.x, args.y);
      requireActive(signal);
      return { x: args.x, y: args.y };
    }

    if (name === "click_mouse") {
      if (!exactKeys(args, ["button", "count"])
        || !["left", "right", "middle"].includes(String(args.button))
        || !boundedInteger(args.count, 1, 3)) {
        throw new Error("invalid_arguments");
      }
      const button = args.button as MouseButton;
      await backend.clickMouse(button, args.count);
      requireActive(signal);
      return { button, count: args.count };
    }

    if (name === "scroll_mouse") {
      if (!exactKeys(args, ["deltaX", "deltaY"])
        || !boundedInteger(args.deltaX, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA)
        || !boundedInteger(args.deltaY, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA)) {
        throw new Error("invalid_arguments");
      }
      await backend.scrollMouse(args.deltaX, args.deltaY);
      requireActive(signal);
      return { deltaX: args.deltaX, deltaY: args.deltaY };
    }

    if (name === "type_text") {
      if (!exactKeys(args, ["text"])
        || typeof args.text !== "string"
        || args.text.length > MAX_TEXT_CHARS) {
        throw new Error("invalid_arguments");
      }
      await backend.typeText(args.text);
      requireActive(signal);
      return { characters: Array.from(args.text).length };
    }

    if (name === "press_key") {
      if (!exactKeys(args, ["key", "modifiers", "repeat"])
        || !validKey(args.key)
        || !boundedInteger(args.repeat, 1, 10)) {
        throw new Error("invalid_arguments");
      }
      const key = args.key.toLowerCase();
      const modifiers = normalizeModifiers(args.modifiers);
      await backend.pressKey(key, modifiers, args.repeat);
      requireActive(signal);
      return { key, modifiers, repeat: args.repeat };
    }

    if (name === "read_clipboard") {
      if (!exactKeys(args, [])) throw new Error("invalid_arguments");
      const text = await backend.readClipboard();
      requireActive(signal);
      if (text.length > MAX_CLIPBOARD_CHARS) throw new Error("clipboard_too_large");
      return { text };
    }

    if (!exactKeys(args, ["text"])
      || typeof args.text !== "string"
      || args.text.length > MAX_CLIPBOARD_CHARS) {
      throw new Error("invalid_arguments");
    }
    await backend.writeClipboard(args.text);
    requireActive(signal);
    return { characters: Array.from(args.text).length };
  };
}
