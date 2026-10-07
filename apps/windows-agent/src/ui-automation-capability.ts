import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@commandharbor/protocol";

export const UI_AUTOMATION_CAPABILITY_NAMES = ["inspect_ui_tree", "find_ui_elements", "perform_ui_action", "set_ui_value"] as const;

const MAX_DEPTH = 6;
const MAX_RESULTS = 200;
const MAX_VISITED = 2000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;
const PATTERN_NAMES = [
  "invoke", "value", "rangeValue", "toggle", "selectionItem",
  "expandCollapse", "scrollItem", "scroll", "text", "window",
] as const;

export interface UiElementDescriptor {
  runtimeId: string;
  parentRuntimeId: string | null;
  depth: number;
  processId: number;
  nativeWindowHandle: string | null;
  name: string;
  automationId: string;
  controlType: string;
  className: string;
  enabled: boolean;
  offscreen: boolean;
  keyboardFocusable: boolean;
  hasKeyboardFocus: boolean;
  bounds: { left: number; top: number; width: number; height: number } | null;
  patterns: Array<(typeof PATTERN_NAMES)[number]>;
}

interface WindowIdentity {
  windowHandle: string;
  processId: number;
}

export type UiQueryField = "any" | "name" | "automationId" | "className" | "controlType";
export type UiQueryMatch = "contains" | "equals";
export type UiElementAction = "focus" | "invoke" | "toggle" | "select" | "expand" | "collapse" | "scrollIntoView";

export interface UiMutationResult {
  applied: true;
  element: UiElementDescriptor | null;
}

export interface UiAutomationBackend {
  inspectUiTree(
    target: WindowIdentity,
    maxDepth: number,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<{ elements: UiElementDescriptor[]; truncated: boolean; visited: number }>;
  findUiElements(
    target: WindowIdentity,
    field: UiQueryField,
    query: string,
    match: UiQueryMatch,
    maxDepth: number,
    maxResults: number,
    signal: AbortSignal,
  ): Promise<{ elements: UiElementDescriptor[]; truncated: boolean; visited: number }>;
performUiAction(
    target: WindowIdentity,
    runtimeId: string,
    action: UiElementAction,
    signal: AbortSignal,
  ): Promise<UiMutationResult>;
  setUiValue(
    target: WindowIdentity,
    runtimeId: string,
    value: string,
    signal: AbortSignal,
  ): Promise<UiMutationResult>;
}

export interface UiAutomationCapabilityOptions {
  backend?: UiAutomationBackend;
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

function boundedCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= -1_000_000 && Number(value) <= 1_000_000;
}

function validBounds(value: unknown): boolean {
  if (!isRecord(value) || !exactKeys(value, ["left", "top", "width", "height"])) return false;
  return boundedCoordinate(value.left)
    && boundedCoordinate(value.top)
    && boundedCoordinate(value.width)
    && Number(value.width) >= 0
    && boundedCoordinate(value.height)
    && Number(value.height) >= 0;
}

function validDescriptor(value: unknown): value is UiElementDescriptor {
  if (!isRecord(value) || !exactKeys(value, [
    "runtimeId", "parentRuntimeId", "depth", "processId", "nativeWindowHandle",
    "name", "automationId", "controlType", "className", "enabled", "offscreen",
    "keyboardFocusable", "hasKeyboardFocus", "bounds", "patterns",
  ])) return false;
  if (typeof value.runtimeId !== "string"
    || value.runtimeId.length < 1
    || value.runtimeId.length > 256
    || !/^-?[0-9]+(?:\.-?[0-9]+)*$/.test(value.runtimeId)
    || (value.parentRuntimeId !== null
      && (typeof value.parentRuntimeId !== "string"
        || value.parentRuntimeId.length > 256
        || !/^-?[0-9]+(?:\.-?[0-9]+)*$/.test(value.parentRuntimeId)))
    || !Number.isSafeInteger(value.depth)
    || Number(value.depth) < 0
    || Number(value.depth) > MAX_DEPTH
    || !Number.isSafeInteger(value.processId)
    || Number(value.processId) < 0
    || Number(value.processId) > 2_147_483_647
    || (value.nativeWindowHandle !== null
      && (typeof value.nativeWindowHandle !== "string"
        || !/^[1-9][0-9]{0,19}$/.test(value.nativeWindowHandle)))
    || typeof value.name !== "string"
    || value.name.length > 1024
    || typeof value.automationId !== "string"
    || value.automationId.length > 512
    || typeof value.controlType !== "string"
    || value.controlType.length > 128
    || typeof value.className !== "string"
    || value.className.length > 512
    || typeof value.enabled !== "boolean"
    || typeof value.offscreen !== "boolean"
    || typeof value.keyboardFocusable !== "boolean"
    || typeof value.hasKeyboardFocus !== "boolean"
    || (value.bounds !== null && !validBounds(value.bounds))
    || !Array.isArray(value.patterns)
    || value.patterns.length > PATTERN_NAMES.length
    || value.patterns.some((pattern) => !PATTERN_NAMES.includes(pattern as (typeof PATTERN_NAMES)[number]))) {
    return false;
  }
  return true;
}

function descriptorJson(element: UiElementDescriptor): JsonValue {
  return {
    runtimeId: element.runtimeId,
    parentRuntimeId: element.parentRuntimeId,
    depth: element.depth,
    processId: element.processId,
    nativeWindowHandle: element.nativeWindowHandle,
    name: element.name,
    automationId: element.automationId,
    controlType: element.controlType,
    className: element.className,
    enabled: element.enabled,
    offscreen: element.offscreen,
    keyboardFocusable: element.keyboardFocusable,
    hasKeyboardFocus: element.hasKeyboardFocus,
    bounds: element.bounds === null ? null : {
      left: element.bounds.left,
      top: element.bounds.top,
      width: element.bounds.width,
      height: element.bounds.height,
    },
    patterns: [...element.patterns],
  };
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const UIA_HELPER = "$ErrorActionPreference = 'Stop'\n$utf8 = New-Object System.Text.UTF8Encoding($false)\n[Console]::InputEncoding = $utf8\n[Console]::OutputEncoding = $utf8\n$OutputEncoding = $utf8\nAdd-Type -AssemblyName UIAutomationClient\nAdd-Type -AssemblyName UIAutomationTypes\n\n$requestText = [Console]::In.ReadToEnd()\n$request = $requestText | ConvertFrom-Json\n\nfunction Write-Result($value) {\n  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 8))\n}\n\nfunction Write-ErrorResult([string]$code) {\n  Write-Result ([ordered]@{ error = $code })\n}\n\nfunction Safe-Text($value, [int]$max) {\n  if ($null -eq $value) { return '' }\n  $text = [string]$value\n  if ($text.Length -le $max) { return $text }\n  return $text.Substring(0, $max)\n}\n\nfunction Runtime-Id($element) {\n  try {\n    $runtime = $element.GetRuntimeId()\n    if ($null -eq $runtime -or $runtime.Length -eq 0) { return $null }\n    return (($runtime | ForEach-Object { [string]$_ }) -join '.')\n  } catch [System.Windows.Automation.ElementNotAvailableException] {\n    return $null\n  }\n}\n\nfunction Pattern-Names($element) {\n  $names = New-Object System.Collections.Generic.List[string]\n  try {\n    foreach ($pattern in $element.GetSupportedPatterns()) {\n      $name = [string]$pattern.ProgrammaticName\n      if ($name -like '*InvokePattern*') { [void]$names.Add('invoke') }\n      elseif ($name -like '*ValuePattern*' -and $name -notlike '*RangeValuePattern*') { [void]$names.Add('value') }\n      elseif ($name -like '*RangeValuePattern*') { [void]$names.Add('rangeValue') }\n      elseif ($name -like '*TogglePattern*') { [void]$names.Add('toggle') }\n      elseif ($name -like '*SelectionItemPattern*') { [void]$names.Add('selectionItem') }\n      elseif ($name -like '*ExpandCollapsePattern*') { [void]$names.Add('expandCollapse') }\n      elseif ($name -like '*ScrollItemPattern*') { [void]$names.Add('scrollItem') }\n      elseif ($name -like '*ScrollPattern*') { [void]$names.Add('scroll') }\n      elseif ($name -like '*TextPattern*') { [void]$names.Add('text') }\n      elseif ($name -like '*WindowPattern*') { [void]$names.Add('window') }\n    }\n  } catch [System.Windows.Automation.ElementNotAvailableException] {\n    return @()\n  }\n  return @($names | Sort-Object -Unique)\n}\n\nfunction Safe-Bounds($element) {\n  try {\n    $rect = $element.Current.BoundingRectangle\n    if ($rect.IsEmpty) { return $null }\n    foreach ($value in @($rect.Left, $rect.Top, $rect.Width, $rect.Height)) {\n      if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return $null }\n    }\n    return [ordered]@{\n      left = [math]::Round($rect.Left)\n      top = [math]::Round($rect.Top)\n      width = [math]::Max(0, [math]::Round($rect.Width))\n      height = [math]::Max(0, [math]::Round($rect.Height))\n    }\n  } catch [System.Windows.Automation.ElementNotAvailableException] {\n    return $null\n  }\n}\n\nfunction Describe-Element($element, $parentRuntimeId, [int]$depth) {\n  try {\n    $runtimeId = Runtime-Id $element\n    if ([string]::IsNullOrEmpty($runtimeId)) { return $null }\n    $native = [int]$element.Current.NativeWindowHandle\n    $controlType = Safe-Text $element.Current.ControlType.ProgrammaticName 128\n    if ($controlType.StartsWith('ControlType.')) { $controlType = $controlType.Substring(12) }\n    return [ordered]@{\n      runtimeId = $runtimeId\n      parentRuntimeId = $parentRuntimeId\n      depth = $depth\n      processId = [int]$element.Current.ProcessId\n      nativeWindowHandle = $(if ($native -gt 0) { [string]$native } else { $null })\n      name = Safe-Text $element.Current.Name 1024\n      automationId = Safe-Text $element.Current.AutomationId 512\n      controlType = $controlType\n      className = Safe-Text $element.Current.ClassName 512\n      enabled = [bool]$element.Current.IsEnabled\n      offscreen = [bool]$element.Current.IsOffscreen\n      keyboardFocusable = [bool]$element.Current.IsKeyboardFocusable\n      hasKeyboardFocus = [bool]$element.Current.HasKeyboardFocus\n      bounds = Safe-Bounds $element\n      patterns = @(Pattern-Names $element)\n    }\n  } catch [System.Windows.Automation.ElementNotAvailableException] {\n    return $null\n  }\n}\n\nfunction Text-Matches([string]$value, [string]$query, [string]$match) {\n  if ($match -eq 'equals') {\n    return [string]::Equals($value, $query, [System.StringComparison]::OrdinalIgnoreCase)\n  }\n  return $value.IndexOf($query, [System.StringComparison]::OrdinalIgnoreCase) -ge 0\n}\n\nfunction Descriptor-Matches($descriptor, [string]$field, [string]$query, [string]$match) {\n  if ($field -eq 'name') { return Text-Matches $descriptor.name $query $match }\n  if ($field -eq 'automationId') { return Text-Matches $descriptor.automationId $query $match }\n  if ($field -eq 'className') { return Text-Matches $descriptor.className $query $match }\n  if ($field -eq 'controlType') { return Text-Matches $descriptor.controlType $query $match }\n  return (Text-Matches $descriptor.name $query $match) -or\n    (Text-Matches $descriptor.automationId $query $match) -or\n    (Text-Matches $descriptor.className $query $match) -or\n    (Text-Matches $descriptor.controlType $query $match)\n}\n\nfunction Find-ElementByRuntimeId($root, [string]$runtimeId) {\n  $script:foundElement = $null\n  $script:findVisited = 0\n\n  function Search-Element($element, $parentRuntimeId, [int]$depth) {\n    if ($null -ne $script:foundElement -or $script:findVisited -ge 2000 -or $depth -gt 6) { return }\n    $script:findVisited += 1\n    $currentRuntimeId = Runtime-Id $element\n    if ($null -eq $currentRuntimeId) { return }\n    if ($currentRuntimeId -eq $runtimeId) {\n      $script:foundElement = [pscustomobject]@{\n        element = $element\n        parentRuntimeId = $parentRuntimeId\n        depth = $depth\n      }\n      return\n    }\n    if ($depth -ge 6) { return }\n\n    try {\n      $child = $walker.GetFirstChild($element)\n      while ($null -ne $child -and $null -eq $script:foundElement -and $script:findVisited -lt 2000) {\n        Search-Element $child $currentRuntimeId ($depth + 1)\n        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }\n      }\n    } catch [System.Windows.Automation.ElementNotAvailableException] {\n      return\n    }\n  }\n\n  Search-Element $root $null 0\n  return $script:foundElement\n}\n\nfunction Apply-UiAction($element, [string]$uiAction) {\n  switch ($uiAction) {\n    'focus' {\n      if (-not [bool]$element.Current.IsKeyboardFocusable) {\n        throw [System.InvalidOperationException]::new('not_focusable')\n      }\n      $element.SetFocus()\n    }\n    'invoke' {\n      $pattern = [System.Windows.Automation.InvokePattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.InvokePattern]::Pattern\n      )\n      $pattern.Invoke()\n    }\n    'toggle' {\n      $pattern = [System.Windows.Automation.TogglePattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.TogglePattern]::Pattern\n      )\n      $pattern.Toggle()\n    }\n    'select' {\n      $pattern = [System.Windows.Automation.SelectionItemPattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.SelectionItemPattern]::Pattern\n      )\n      $pattern.Select()\n    }\n    'expand' {\n      $pattern = [System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.ExpandCollapsePattern]::Pattern\n      )\n      $pattern.Expand()\n    }\n    'collapse' {\n      $pattern = [System.Windows.Automation.ExpandCollapsePattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.ExpandCollapsePattern]::Pattern\n      )\n      $pattern.Collapse()\n    }\n    'scrollIntoView' {\n      $pattern = [System.Windows.Automation.ScrollItemPattern]$element.GetCurrentPattern(\n        [System.Windows.Automation.ScrollItemPattern]::Pattern\n      )\n      $pattern.ScrollIntoView()\n    }\n    default {\n      throw [System.InvalidOperationException]::new('unsupported_ui_action')\n    }\n  }\n}\n\ntry {\n  [UInt64]$raw = 0\n  if (-not [UInt64]::TryParse([string]$request.windowHandle, [ref]$raw) -or $raw -eq 0) {\n    Write-ErrorResult 'stale_window'\n    exit 0\n  }\n  if ([IntPtr]::Size -eq 4 -and $raw -gt [UInt32]::MaxValue) {\n    Write-ErrorResult 'stale_window'\n    exit 0\n  }\n  $hWnd = if ([IntPtr]::Size -eq 4) {\n    [IntPtr]::new([int][uint32]$raw)\n  } else {\n    [IntPtr]::new([long]$raw)\n  }\n\n  try {\n    $root = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)\n  } catch {\n    Write-ErrorResult 'stale_window'\n    exit 0\n  }\n  if ($null -eq $root -or [int]$root.Current.ProcessId -ne [int]$request.processId) {\n    Write-ErrorResult 'stale_window'\n    exit 0\n  }\n\nif ($request.action -eq 'perform_ui_action' -or $request.action -eq 'set_ui_value') {\n    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker\n    $resolved = Find-ElementByRuntimeId $root ([string]$request.runtimeId)\n    if ($null -eq $resolved) {\n      Write-ErrorResult 'stale_element'\n      exit 0\n    }\n\n    try {\n      if ($request.action -eq 'perform_ui_action') {\n        Apply-UiAction $resolved.element ([string]$request.uiAction)\n      } else {\n        $valuePattern = [System.Windows.Automation.ValuePattern]$resolved.element.GetCurrentPattern(\n          [System.Windows.Automation.ValuePattern]::Pattern\n        )\n        if ([bool]$valuePattern.Current.IsReadOnly) {\n          throw [System.InvalidOperationException]::new('read_only_value')\n        }\n        $valuePattern.SetValue([string]$request.value)\n      }\n    } catch [System.Windows.Automation.ElementNotAvailableException] {\n      Write-ErrorResult 'stale_element'\n      exit 0\n    } catch [System.InvalidOperationException] {\n      Write-ErrorResult 'unsupported_ui_action'\n      exit 0\n    } catch {\n      Write-ErrorResult 'ui_action_failed'\n      exit 0\n    }\n\n    Start-Sleep -Milliseconds 50\n    $after = $null\n    try {\n      $currentRoot = [System.Windows.Automation.AutomationElement]::FromHandle($hWnd)\n      if ($null -ne $currentRoot -and [int]$currentRoot.Current.ProcessId -eq [int]$request.processId) {\n        $after = Find-ElementByRuntimeId $currentRoot ([string]$request.runtimeId)\n      }\n    } catch {\n      $after = $null\n    }\n\n    $descriptor = $null\n    if ($null -ne $after) {\n      $descriptor = Describe-Element $after.element $after.parentRuntimeId ([int]$after.depth)\n    }\n    Write-Result ([ordered]@{\n      applied = $true\n      element = $descriptor\n    })\n    exit 0\n  }\n\n  $script:elements = New-Object System.Collections.Generic.List[object]\n  $script:visited = 0\n  $script:truncated = $false\n  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker\n  $maxDepth = [int]$request.maxDepth\n  $maxResults = [int]$request.maxResults\n  $isQuery = [string]$request.action -eq 'find_ui_elements'\n\n  function Visit-Element($element, $parentRuntimeId, [int]$depth) {\n    if ($script:truncated) { return }\n    if ($script:visited -ge 2000) {\n      $script:truncated = $true\n      return\n    }\n    $script:visited += 1\n\n    $descriptor = Describe-Element $element $parentRuntimeId $depth\n    if ($null -eq $descriptor) { return }\n\n    $include = $true\n    if ($isQuery) {\n      $include = Descriptor-Matches $descriptor ([string]$request.field) ([string]$request.query) ([string]$request.match)\n    }\n    if ($include) {\n      if ($script:elements.Count -ge $maxResults) {\n        $script:truncated = $true\n        return\n      }\n      [void]$script:elements.Add($descriptor)\n    }\n    if ($depth -ge $maxDepth) { return }\n\n    try {\n      $child = $walker.GetFirstChild($element)\n      while ($null -ne $child -and -not $script:truncated) {\n        Visit-Element $child $descriptor.runtimeId ($depth + 1)\n        try { $child = $walker.GetNextSibling($child) } catch { $child = $null }\n      }\n    } catch [System.Windows.Automation.ElementNotAvailableException] {\n      return\n    }\n  }\n\n  Visit-Element $root $null 0\n  Write-Result ([ordered]@{\n    elements = @($script:elements.ToArray())\n    truncated = [bool]$script:truncated\n    visited = [int]$script:visited\n  })\n} catch {\n  Write-ErrorResult 'ui_automation_failed'\n}";


async function runUiaHelper(
  powershellPath: string,
  request: Record<string, unknown>,
  signal: AbortSignal,
): Promise<HelperResponse> {
  requireActive(signal);
  const directory = await mkdtemp(join(tmpdir(), "commandharbor-uia-"));
  const scriptPath = join(directory, "uia.ps1");
  try {
    await writeFile(scriptPath, UIA_HELPER, "utf8");
    return await new Promise<HelperResponse>((resolve, reject) => {
      const child = spawn(
        powershellPath,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let settled = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const finish = (error?: Error, result?: HelperResponse): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(result ?? {});
      };
      const terminate = (): void => {
        try { child.kill("SIGKILL"); } catch {}
      };
      const onAbort = (): void => {
        terminate();
        finish(new Error("cancelled"));
      };
      const timeout = setTimeout(() => {
        terminate();
        finish(new Error("ui_automation_timeout"));
      }, PROCESS_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout = Buffer.concat([stdout, chunk]);
        if (stdout.length > MAX_STDOUT_BYTES) {
          terminate();
          finish(new Error("ui_automation_output_too_large"));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        const remaining = MAX_STDERR_BYTES - stderr.length;
        if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
      });
      child.once("error", () => finish(new Error("ui_automation_failed")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(new Error("ui_automation_failed"));
          return;
        }
        try {
          const parsed = stdout.length === 0 ? {} : JSON.parse(stdout.toString("utf8"));
          if (!isRecord(parsed)) throw new Error("invalid_helper_result");
          if (typeof parsed.error === "string") {
            const allowed = new Set(["stale_window", "stale_element", "unsupported_ui_action", "ui_action_failed"]);
            finish(new Error(allowed.has(parsed.error) ? parsed.error : "ui_automation_failed"));
            return;
          }
          finish(undefined, parsed);
        } catch {
          finish(new Error("ui_automation_failed"));
        }
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseResult(
  result: HelperResponse,
  maxDepth: number,
  maxResults: number,
): { elements: UiElementDescriptor[]; truncated: boolean; visited: number } {
  if (!exactKeys(result, ["elements", "truncated", "visited"])
    || !Array.isArray(result.elements)
    || result.elements.length > maxResults
    || typeof result.truncated !== "boolean"
    || !Number.isSafeInteger(result.visited)
    || Number(result.visited) < 1
    || Number(result.visited) > MAX_VISITED) {
    throw new Error("ui_automation_failed");
  }
  const elements = result.elements.map((value) => {
    if (!validDescriptor(value) || value.depth > maxDepth) throw new Error("ui_automation_failed");
    return value;
  });
  return { elements, truncated: result.truncated, visited: Number(result.visited) };
}


function parseRuntimeId(value: JsonValue | undefined): string {
  if (typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !/^-?[0-9]+(?:\.-?[0-9]+)*$/.test(value)) {
    throw new Error("invalid_arguments");
  }
  return value;
}

function parseMutationResult(result: HelperResponse, runtimeId: string): UiMutationResult {
  if (!exactKeys(result, ["applied", "element"]) || result.applied !== true) {
    throw new Error("ui_action_failed");
  }
  if (result.element === null) return { applied: true, element: null };
  if (!validDescriptor(result.element) || result.element.runtimeId !== runtimeId) {
    throw new Error("ui_action_failed");
  }
  return { applied: true, element: result.element };
}

function mutationResultJson(result: UiMutationResult): JsonValue {
  return {
    applied: true,
    element: result.element === null ? null : descriptorJson(result.element),
  };
}

function createWindowsBackend(powershellPath: string): UiAutomationBackend {
  return {
    inspectUiTree: async (target, maxDepth, maxResults, signal) => parseResult(
      await runUiaHelper(
        powershellPath,
        { action: "inspect_ui_tree", ...target, maxDepth, maxResults },
        signal,
      ),
      maxDepth,
      maxResults,
    ),
    findUiElements: async (target, field, query, match, maxDepth, maxResults, signal) => parseResult(
      await runUiaHelper(
        powershellPath,
        { action: "find_ui_elements", ...target, field, query, match, maxDepth, maxResults },
        signal,
      ),
      maxDepth,
      maxResults,
    ),

    performUiAction: async (target, runtimeId, action, signal) => parseMutationResult(
      await runUiaHelper(
        powershellPath,
        { action: "perform_ui_action", ...target, runtimeId, uiAction: action },
        signal,
      ),
      runtimeId,
    ),
    setUiValue: async (target, runtimeId, value, signal) => parseMutationResult(
      await runUiaHelper(
        powershellPath,
        { action: "set_ui_value", ...target, runtimeId, value },
        signal,
      ),
      runtimeId,
    ),
  };
}

function parseBounds(args: Record<string, JsonValue>): { maxDepth: number; maxResults: number } {
  if (!Number.isSafeInteger(args.maxDepth)
    || Number(args.maxDepth) < 0
    || Number(args.maxDepth) > MAX_DEPTH
    || !Number.isSafeInteger(args.maxResults)
    || Number(args.maxResults) < 1
    || Number(args.maxResults) > MAX_RESULTS) {
    throw new Error("invalid_arguments");
  }
  return { maxDepth: Number(args.maxDepth), maxResults: Number(args.maxResults) };
}

function resultJson(result: {
  elements: UiElementDescriptor[];
  truncated: boolean;
  visited: number;
}): JsonValue {
  return {
    elements: result.elements.map(descriptorJson),
    truncated: result.truncated,
    visited: result.visited,
  };
}

export function createUiAutomationCapabilityExecutor(options: UiAutomationCapabilityOptions = {}) {
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
    if (!UI_AUTOMATION_CAPABILITY_NAMES.includes(name as (typeof UI_AUTOMATION_CAPABILITY_NAMES)[number])) {
      throw new Error("unsupported_capability");
    }
    if (!backend) throw new Error("unsupported_platform");
    if (!isRecord(args)) throw new Error("invalid_arguments");

    if (name === "inspect_ui_tree") {
      const target = parseWindowIdentity(
        args,
        ["windowHandle", "processId", "maxDepth", "maxResults"],
      );
      const { maxDepth, maxResults } = parseBounds(args);
      const result = await backend.inspectUiTree(target, maxDepth, maxResults, signal);
      requireActive(signal);
      return resultJson(parseResult(result as unknown as HelperResponse, maxDepth, maxResults));
    }


    if (name === "perform_ui_action") {
      const target = parseWindowIdentity(
        args,
        ["windowHandle", "processId", "runtimeId", "action"],
      );
      const runtimeId = parseRuntimeId(args.runtimeId);
      if (args.action !== "focus"
        && args.action !== "invoke"
        && args.action !== "toggle"
        && args.action !== "select"
        && args.action !== "expand"
        && args.action !== "collapse"
        && args.action !== "scrollIntoView") {
        throw new Error("invalid_arguments");
      }
      const result = await backend.performUiAction(target, runtimeId, args.action, signal);
      requireActive(signal);
      return mutationResultJson(parseMutationResult(result as unknown as HelperResponse, runtimeId));
    }

    if (name === "set_ui_value") {
      const target = parseWindowIdentity(
        args,
        ["windowHandle", "processId", "runtimeId", "value"],
      );
      const runtimeId = parseRuntimeId(args.runtimeId);
      if (typeof args.value !== "string" || args.value.length > 4096) {
        throw new Error("invalid_arguments");
      }
      const result = await backend.setUiValue(target, runtimeId, args.value, signal);
      requireActive(signal);
      return mutationResultJson(parseMutationResult(result as unknown as HelperResponse, runtimeId));
    }

    const target = parseWindowIdentity(
      args,
      ["windowHandle", "processId", "field", "query", "match", "maxDepth", "maxResults"],
    );
    if (args.field !== "any"
      && args.field !== "name"
      && args.field !== "automationId"
      && args.field !== "className"
      && args.field !== "controlType") {
      throw new Error("invalid_arguments");
    }
    if (typeof args.query !== "string" || args.query.length < 1 || args.query.length > 256) {
      throw new Error("invalid_arguments");
    }
    if (args.match !== "contains" && args.match !== "equals") throw new Error("invalid_arguments");
    const { maxDepth, maxResults } = parseBounds(args);
    const result = await backend.findUiElements(
      target,
      args.field,
      args.query,
      args.match,
      maxDepth,
      maxResults,
      signal,
    );
    requireActive(signal);
    return resultJson(parseResult(result as unknown as HelperResponse, maxDepth, maxResults));
  };
}
