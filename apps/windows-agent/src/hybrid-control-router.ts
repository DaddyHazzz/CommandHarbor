import { createHash, randomUUID } from "node:crypto";

export const CONTROL_RECEIPT_OUTCOMES = [
  "skipped",
  "applied",
  "located",
  "not_confirmed",
  "stale_window",
  "stale_element",
  "unsupported",
  "oracle_pass",
  "oracle_fail",
  "unchanged",
  "partial_mutation",
  "refused_coordinate",
] as const;

export type ControlReceiptOutcome = (typeof CONTROL_RECEIPT_OUTCOMES)[number];

export type RouterTier = "api" | "semantic" | "structured_visual" | "raw_coordinate";

export type ReceiptTier =
  | "api"
  | "semantic_uia"
  | "semantic_win32"
  | "structured_visual"
  | "raw_coordinate"
  | "system";

export type ControlStepId = "set_target" | "toggle_confirm" | "invoke_apply";
export type ControlAutomationId = "targetInput" | "confirmCheck" | "applyButton";
export type ControlAction = "set_value" | "toggle" | "invoke";

export interface ControlStep {
  id: ControlStepId;
  automationId: ControlAutomationId;
  controlType: string;
  action: ControlAction;
  valueSha256?: string;
  allow: readonly RouterTier[];
  predicateId?: string;
}

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ControlBinding {
  windowHandle: string;
  processId: number;
  processName?: string;
  runtimeId?: string;
  bounds: WindowBounds;
}

export interface ControlRegion {
  regionId: string;
  frameDigest: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface UiElementView {
  runtimeId: string;
  processId: number;
  automationId: string;
  controlType: string;
  enabled: boolean;
  offscreen: boolean;
  patterns: readonly string[];
  bounds: WindowBounds | null;
  hasKeyboardFocus?: boolean;
  nativeWindowHandle?: string | null;
}

export interface OracleObservation {
  pass: boolean;
  predicateId: string;
  unchanged: boolean;
  error?: "stale_window" | "missing_controls";
}

export interface OraclePort {
  observe(binding: ControlBinding): OracleObservation | Promise<OracleObservation>;
}

export interface WindowIdentity {
  windowHandle: string;
  processId: number;
}

export interface MutationResult {
  applied: true;
  element: UiElementView | null;
}

export interface ForegroundWindow {
  windowHandle: string;
  processId: number;
  bounds?: WindowBounds;
}

export interface FindElementsResult {
  elements: readonly UiElementView[];
  truncated: boolean;
}

export interface ExecutorPorts {
  appApi: {
    probe(binding: ControlBinding): "available" | "unavailable" | Promise<"available" | "unavailable">;
    apply?(step: ControlStep, binding: ControlBinding): { applied: boolean } | Promise<{ applied: boolean }>;
  };
  findUiElements(
    target: WindowIdentity,
    field: "automationId",
    query: string,
    match: "equals",
  ): FindElementsResult | Promise<FindElementsResult>;
  performUiAction(
    target: WindowIdentity,
    runtimeId: string,
    action: "toggle" | "invoke" | "scrollIntoView",
  ): MutationResult | Promise<MutationResult>;
  setUiValue(
    target: WindowIdentity,
    runtimeId: string,
  ): MutationResult | Promise<MutationResult>;
  getForegroundWindow(): ForegroundWindow | null | Promise<ForegroundWindow | null>;
  activateWindow(target: WindowIdentity): ForegroundWindow | Promise<ForegroundWindow>;
  moveMouse(point: { x: number; y: number }): void | Promise<void>;
  clickMouse(click: { button: "left"; count: 1 }): void | Promise<void>;
  typeText?(text: string): void | Promise<void>;
  verifyCoordinateTarget?(
    target: WindowIdentity,
    point: { x: number; y: number },
    step: ControlStep,
    region: ControlRegion,
  ): boolean | Promise<boolean>;
  grounding: {
    ground(binding: ControlBinding): ControlRegion | null | Promise<ControlRegion | null>;
  };
}

export interface Disturbance {
  focusChanged: boolean;
  cursorMoved: boolean;
  clickCount: number;
  typedChars: number;
}

export interface ControlReceipt {
  schemaVersion: 1;
  routeId: string;
  attempt: number;
  tier: ReceiptTier;
  outcome: ControlReceiptOutcome;
  tool?: string;
  target: {
    windowHandle: string;
    processId: number;
    runtimeId?: string;
    automationId?: string;
    frameDigest?: string;
  };
  actionDigest: string;
  oracleDigest: string;
  monotonicMs: number;
  durationMs: number;
  disturbance: Disturbance;
}

export type RouteReason =
  | "oracle_pass"
  | "already"
  | "invalid_harness_preflight"
  | "invalid_harness_postflight"
  | "stale_window"
  | "stale_element"
  | "partial_mutation"
  | "unconfirmed_mutation"
  | "refused_coordinate"
  | "exhausted"
  | "unsupported";

export interface RouteResult {
  status: "pass" | "already" | "stop" | "fail";
  reason: RouteReason;
  receipts: ControlReceipt[];
}

export interface RouteOptions {
  now?: () => number;
  newRouteId?: () => string;
  sleep?: (milliseconds: number) => void | Promise<void>;
  settlePollMs?: number;
  settleTimeoutMs?: number;
}

const QUIET: Disturbance = {
  focusChanged: false,
  cursorMoved: false,
  clickCount: 0,
  typedChars: 0,
};

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : "";
}

function validOracleObservation(observation: OracleObservation): boolean {
  const raw = observation as unknown;
  if (raw === null || typeof raw !== "object") return false;
  const value = raw as {
    pass?: unknown;
    predicateId?: unknown;
    unchanged?: unknown;
    error?: unknown;
  };
  return typeof value.pass === "boolean"
    && typeof value.unchanged === "boolean"
    && typeof value.predicateId === "string"
    && value.predicateId.length > 0
    && value.predicateId.length <= 256
    && (value.error === undefined || value.error === "stale_window" || value.error === "missing_controls");
}

function validMutationResult(result: MutationResult): boolean {
  const raw = result as unknown;
  if (raw === null || typeof raw !== "object") return false;
  const value = raw as { applied?: unknown; element?: unknown };
  return value.applied === true
    && (value.element === null || (typeof value.element === "object" && value.element !== null));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function actionDigestFor(tier: ReceiptTier, step: ControlStep): string {
  return sha256Json({
    tier,
    action: step.action,
    automationId: step.automationId,
    valueSha256: step.valueSha256 ?? null,
  });
}

function oracleDigestFor(pass: boolean, predicateId: string): string {
  return sha256Json({ pass, predicateId });
}

function validRectangle(rectangle: WindowBounds | ControlRegion): boolean {
  return Number.isFinite(rectangle.left)
    && Number.isFinite(rectangle.top)
    && Number.isFinite(rectangle.width)
    && Number.isFinite(rectangle.height)
    && rectangle.width > 0
    && rectangle.height > 0;
}

function rectangleInside(outer: WindowBounds, inner: WindowBounds | ControlRegion): boolean {
  return validRectangle(outer)
    && validRectangle(inner)
    && inner.left >= outer.left
    && inner.top >= outer.top
    && inner.left + inner.width <= outer.left + outer.width
    && inner.top + inner.height <= outer.top + outer.height;
}

function validFrameDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

function pointInside(bounds: WindowBounds, point: { x: number; y: number }): boolean {
  return validRectangle(bounds)
    && Number.isSafeInteger(point.x)
    && Number.isSafeInteger(point.y)
    && point.x >= -100_000
    && point.x <= 100_000
    && point.y >= -100_000
    && point.y <= 100_000
    && point.x >= bounds.left
    && point.y >= bounds.top
    && point.x < bounds.left + bounds.width
    && point.y < bounds.top + bounds.height;
}

function receipt(input: {
  routeId: string;
  attempt: number;
  tier: ReceiptTier;
  outcome: ControlReceiptOutcome;
  step: ControlStep;
  binding: ControlBinding;
  pass: boolean;
  predicateId: string;
  started: number;
  ended: number;
  tool?: string | undefined;
  runtimeId?: string | undefined;
  frameDigest?: string | undefined;
  disturbance?: Disturbance | undefined;
}): ControlReceipt {
  const target: ControlReceipt["target"] = {
    windowHandle: input.binding.windowHandle,
    processId: input.binding.processId,
    automationId: input.step.automationId,
  };
  if (input.runtimeId !== undefined) target.runtimeId = input.runtimeId;
  if (input.frameDigest !== undefined) target.frameDigest = input.frameDigest;
  const built: ControlReceipt = {
    schemaVersion: 1,
    routeId: input.routeId,
    attempt: input.attempt,
    tier: input.tier,
    outcome: input.outcome,
    target,
    actionDigest: actionDigestFor(input.tier, input.step),
    oracleDigest: oracleDigestFor(input.pass, input.predicateId),
    monotonicMs: input.ended,
    durationMs: Math.max(0, input.ended - input.started),
    disturbance: input.disturbance ?? QUIET,
  };
  if (input.tool !== undefined) built.tool = input.tool;
  return built;
}

export async function routeStep(
  step: ControlStep,
  binding: ControlBinding,
  oracle: OraclePort,
  ports: ExecutorPorts,
  options: RouteOptions = {},
): Promise<RouteResult> {
  const predicateId = step.predicateId ?? step.id;
  const pre = await oracle.observe(binding);
  if (!validOracleObservation(pre) || pre.error !== undefined || pre.predicateId !== predicateId) {
    return { status: "stop", reason: "invalid_harness_preflight", receipts: [] };
  }
  if (pre.pass) return { status: "already", reason: "already", receipts: [] };

  const clock = options.now ?? (() => performance.now());
  const routeId = options.newRouteId?.() ?? randomUUID();
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const configuredPollMs = options.settlePollMs ?? 50;
  const configuredTimeoutMs = options.settleTimeoutMs ?? 1_500;
  const settlePollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0
    ? Math.max(1, Math.floor(configuredPollMs))
    : 50;
  const settleTimeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0
    ? Math.floor(configuredTimeoutMs)
    : 1_500;
  const receipts: ControlReceipt[] = [];
  let attempt = 0;
  const oracleProblem = (observation: OracleObservation): "stale_window" | "invalid_harness_postflight" | null => {
    if (!validOracleObservation(observation)) return "invalid_harness_postflight";
    if (observation.error === "stale_window") return "stale_window";
    if (observation.error !== undefined || observation.predicateId !== predicateId) {
      return "invalid_harness_postflight";
    }
    return null;
  };
  const settleObservation = async (initial: OracleObservation): Promise<OracleObservation> => {
    let current = initial;
    if (oracleProblem(current) !== null || current.pass || !current.unchanged || settleTimeoutMs === 0) {
      return current;
    }
    const settleStarted = clock();
    const polls = Math.floor(settleTimeoutMs / settlePollMs);
    for (let index = 0; index < polls; index += 1) {
      const elapsedBeforeSleep = Math.max(0, clock() - settleStarted);
      if (elapsedBeforeSleep >= settleTimeoutMs) break;
      await sleep(Math.min(settlePollMs, settleTimeoutMs - elapsedBeforeSleep));
      if (Math.max(0, clock() - settleStarted) >= settleTimeoutMs) break;
      current = await oracle.observe(binding);
      if (oracleProblem(current) !== null || current.pass || !current.unchanged) break;
      if (Math.max(0, clock() - settleStarted) >= settleTimeoutMs) break;
    }
    return current;
  };
  const skipTier = (tier: ReceiptTier) => {
    const skippedAt = clock();
    receipts.push(receipt({
      routeId,
      attempt: attempt++,
      tier,
      outcome: "skipped",
      step,
      binding,
      pass: pre.pass,
      predicateId,
      started: skippedAt,
      ended: clock(),
    }));
  };

  if (step.allow.includes("api")) {
    const started = clock();
    const probe = await ports.appApi.probe(binding);
    if (probe !== "available" || !ports.appApi.apply) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "api",
        outcome: "skipped",
        step,
        binding,
        pass: pre.pass,
        predicateId,
        started,
        ended: clock(),
      }));
    } else {
      try {
        await ports.appApi.apply(step, binding);
      } catch {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "api",
          outcome: "not_confirmed",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
        }));
        return { status: "stop", reason: "unconfirmed_mutation", receipts };
      }
      let post: OracleObservation;
      try {
        post = await oracle.observe(binding);
        post = await settleObservation(post);
      } catch {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "api",
          outcome: "not_confirmed",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
        }));
        return { status: "stop", reason: "unconfirmed_mutation", receipts };
      }
      const postProblem = oracleProblem(post);
      if (postProblem !== null) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "api",
          outcome: postProblem === "stale_window" ? "stale_window" : "oracle_fail",
          step,
          binding,
          pass: false,
        predicateId,
          started,
          ended: clock(),
        }));
        return { status: "stop", reason: postProblem, receipts };
      }
      if (post.pass) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "api",
          outcome: "oracle_pass",
          step,
          binding,
          pass: true,
          predicateId: post.predicateId,
          started,
          ended: clock(),
        }));
        return { status: "pass", reason: "oracle_pass", receipts };
      }
      if (!post.unchanged) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "api",
          outcome: "partial_mutation",
          step,
          binding,
          pass: false,
          predicateId: post.predicateId,
          started,
          ended: clock(),
        }));
        return { status: "stop", reason: "partial_mutation", receipts };
      }
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "api",
        outcome: "not_confirmed",
        step,
        binding,
        pass: false,
        predicateId: post.predicateId,
        started,
        ended: clock(),
      }));
      return { status: "stop", reason: "unconfirmed_mutation", receipts };
    }
  } else skipTier("api");

  let mutation: MutationResult | undefined;
  if (step.allow.includes("semantic")) {
    const started = clock();
    const target = { windowHandle: binding.windowHandle, processId: binding.processId };
    const tool = step.action === "set_value" ? "set_ui_value" : "perform_ui_action";
    const requiredPattern = step.action === "set_value" ? "value" : step.action === "toggle" ? "toggle" : "invoke";
    type SemanticResolution =
      | { kind: "match"; element: UiElementView }
      | { kind: "none" }
      | { kind: "unsupported" };
    const findMatch = async (): Promise<SemanticResolution> => {
      const found = await ports.findUiElements(target, "automationId", step.automationId, "equals");
      if (found.truncated) return { kind: "unsupported" };
      const exact = found.elements.filter((item) => (
        item.automationId === step.automationId
        && item.controlType === step.controlType
      ));
      if (exact.length === 0) return { kind: "none" };
      if (exact.length !== 1) return { kind: "unsupported" };
      const candidate = exact[0]!;
      if (
        candidate.processId !== binding.processId
        || !candidate.enabled
        || candidate.offscreen
        || !candidate.patterns.includes(requiredPattern)
      ) {
        return { kind: "unsupported" };
      }
      return { kind: "match", element: candidate };
    };
    const act = async (runtimeId: string): Promise<MutationResult> => {
      const result = await (
        step.action === "set_value"
          ? ports.setUiValue(target, runtimeId)
          : ports.performUiAction(target, runtimeId, step.action)
      );
      if (!validMutationResult(result)) throw new Error("invalid_mutation_result");
      return result;
    };
    let runtimeId: string | undefined;
    let mutationAttempted = false;
    try {
      const resolution = await findMatch();
      if (resolution.kind === "unsupported") {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "unsupported",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
        }));
        return { status: "stop", reason: "unsupported", receipts };
      }
      if (resolution.kind === "match") {
        runtimeId = resolution.element.runtimeId;
      } else if (binding.runtimeId !== undefined) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "stale_element",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          runtimeId: binding.runtimeId,
        }));
        return { status: "stop", reason: "stale_element", receipts };
      }
      if (runtimeId !== undefined) {
        mutationAttempted = true;
        mutation = await act(runtimeId);
      }
    } catch (error) {
      if (mutationAttempted) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "not_confirmed",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          ...(runtimeId === undefined ? {} : { runtimeId }),
        }));
        return { status: "stop", reason: "unconfirmed_mutation", receipts };
      }
      if (errorCode(error) === "stale_window") {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "stale_window",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          ...(runtimeId === undefined ? {} : { runtimeId }),
        }));
        return { status: "stop", reason: "stale_window", receipts };
      }
      if (errorCode(error) !== "stale_element") throw error;
      const rebound = await findMatch();
      if (rebound.kind !== "match") {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "stale_element",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          ...(runtimeId === undefined ? {} : { runtimeId }),
        }));
        return { status: "stop", reason: "stale_element", receipts };
      }
      runtimeId = rebound.element.runtimeId;
      mutationAttempted = true;
      try {
        mutation = await act(runtimeId);
      } catch {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "not_confirmed",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          runtimeId,
        }));
        return { status: "stop", reason: "unconfirmed_mutation", receipts };
      }
    }
    let post: OracleObservation;
    try {
      post = await oracle.observe(binding);
      if (mutation?.applied) post = await settleObservation(post);
    } catch {
      if (mutationAttempted) {
        receipts.push(receipt({
          routeId,
          attempt: attempt++,
          tier: "semantic_uia",
          outcome: "not_confirmed",
          step,
          binding,
          pass: false,
          predicateId,
          started,
          ended: clock(),
          tool,
          ...(runtimeId === undefined ? {} : { runtimeId }),
        }));
        return { status: "stop", reason: "unconfirmed_mutation", receipts };
      }
      throw new Error("oracle_unreadable");
    }
    const postProblem = oracleProblem(post);
    if (postProblem !== null) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "semantic_uia",
        outcome: postProblem === "stale_window" ? "stale_window" : "oracle_fail",
        step,
        binding,
        pass: false,
        predicateId,
        started,
        ended: clock(),
        tool,
        runtimeId,
      }));
      return { status: "stop", reason: postProblem, receipts };
    }
    if (post.pass) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "semantic_uia",
        outcome: "oracle_pass",
        step,
        binding,
        pass: true,
        predicateId: post.predicateId,
        started,
        ended: clock(),
        tool,
        runtimeId,
      }));
      return { status: "pass", reason: "oracle_pass", receipts };
    }
    if (!post.unchanged) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "semantic_uia",
        outcome: "partial_mutation",
        step,
        binding,
        pass: false,
        predicateId: post.predicateId,
        started,
        ended: clock(),
        tool,
        runtimeId,
      }));
      return { status: "stop", reason: "partial_mutation", receipts };
    }
    if (mutation?.applied) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "semantic_uia",
        outcome: "not_confirmed",
        step,
        binding,
        pass: false,
        predicateId: post.predicateId,
        started,
        ended: clock(),
        tool,
        ...(runtimeId === undefined ? {} : { runtimeId }),
      }));
      return { status: "stop", reason: "unconfirmed_mutation", receipts };
    }
    receipts.push(receipt({
      routeId,
      attempt: attempt++,
      tier: "semantic_uia",
      outcome: mutation === undefined ? "skipped" : "unchanged",
      step,
      binding,
      pass: false,
      predicateId: post.predicateId,
      started,
      ended: clock(),
      ...(mutation === undefined ? {} : { tool }),
      ...(runtimeId === undefined ? {} : { runtimeId }),
    }));
  } else skipTier("semantic_uia");

  let grounded: ControlRegion | null = null;
  if (step.allow.includes("structured_visual")) {
    const visualStarted = clock();
    let region: ControlRegion | null = null;
    try {
      region = await ports.grounding.ground(binding);
    } catch {
      region = null;
    }
    const regionValid = region !== null
      && validRectangle(region)
      && validFrameDigest(region.frameDigest)
      && rectangleInside(binding.bounds, region);
    grounded = regionValid ? region : null;
    receipts.push(receipt({
      routeId,
      attempt: attempt++,
      tier: "structured_visual",
      outcome: grounded ? "located" : region === null ? "skipped" : "unsupported",
      step,
      binding,
      pass: false,
      predicateId,
      started: visualStarted,
      ended: clock(),
      ...(grounded === null ? {} : { frameDigest: grounded.frameDigest }),
    }));
  } else skipTier("structured_visual");

  if (step.allow.includes("raw_coordinate")) {
    const coordinateStarted = clock();
    const box = grounded;
    const disturbance = (focusChanged: boolean, cursorMoved = false, clickCount = 0): Disturbance => ({
      focusChanged,
      cursorMoved,
      clickCount,
      typedChars: 0,
    });
    const refuseCoordinate = (effect?: Disturbance) => {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "raw_coordinate",
        outcome: "refused_coordinate",
        step,
        binding,
        pass: false,
        predicateId,
        started: coordinateStarted,
        ended: clock(),
        ...(effect === undefined ? {} : { disturbance: effect }),
        ...(grounded === null ? {} : { frameDigest: grounded.frameDigest }),
      }));
      return { status: "fail" as const, reason: "refused_coordinate" as const, receipts };
    };
    const stopUnconfirmed = (effect: Disturbance) => {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "raw_coordinate",
        outcome: "not_confirmed",
        step,
        binding,
        pass: false,
        predicateId,
        started: coordinateStarted,
        ended: clock(),
        tool: "click_mouse",
        disturbance: effect,
        ...(grounded === null ? {} : { frameDigest: grounded.frameDigest }),
      }));
      return { status: "stop" as const, reason: "unconfirmed_mutation" as const, receipts };
    };

    if (step.action === "set_value") return refuseCoordinate();
    if (!box || !ports.verifyCoordinateTarget) return refuseCoordinate();
    if (!rectangleInside(binding.bounds, box)) return refuseCoordinate();

    const target = { windowHandle: binding.windowHandle, processId: binding.processId };
    const matches = (window: ForegroundWindow | null) => window?.windowHandle === binding.windowHandle
      && window.processId === binding.processId;

    let foreground: ForegroundWindow | null;
    let focusChanged = false;
    try {
      foreground = await ports.getForegroundWindow();
    } catch {
      return refuseCoordinate();
    }

    if (!matches(foreground)) {
      try {
        await ports.activateWindow(target);
      } catch {
        let afterFailure: ForegroundWindow | null = null;
        try {
          afterFailure = await ports.getForegroundWindow();
        } catch {
          // Keep the conservative disturbance below.
        }
        return refuseCoordinate(disturbance(
          afterFailure !== null && matches(afterFailure),
        ));
      }
      focusChanged = true;
      try {
        foreground = await ports.getForegroundWindow();
      } catch {
        return refuseCoordinate(disturbance(true));
      }
      if (!matches(foreground)) return refuseCoordinate(disturbance(true));
    }

    let liveBounds = foreground?.bounds;
    if (!liveBounds || !rectangleInside(liveBounds, box)) {
      return refuseCoordinate(focusChanged ? disturbance(true) : undefined);
    }

    const point = {
      x: Math.floor(box.left + box.width / 2),
      y: Math.floor(box.top + box.height / 2),
    };
    if (!pointInside(liveBounds, point)) {
      return refuseCoordinate(focusChanged ? disturbance(true) : undefined);
    }

    let verified = false;
    try {
      verified = await ports.verifyCoordinateTarget(target, point, step, box);
    } catch {
      verified = false;
    }
    if (!verified) return refuseCoordinate(focusChanged ? disturbance(true) : undefined);

    try {
      await ports.moveMouse(point);
    } catch {
      return refuseCoordinate(disturbance(focusChanged, true, 0));
    }

    let beforeClick: ForegroundWindow | null = null;
    try {
      beforeClick = await ports.getForegroundWindow();
    } catch {
      return refuseCoordinate(disturbance(focusChanged, true, 0));
    }
    liveBounds = beforeClick?.bounds;
    if (!matches(beforeClick) || !liveBounds || !rectangleInside(liveBounds, box) || !pointInside(liveBounds, point)) {
      return refuseCoordinate(disturbance(true, true, 0));
    }

    try {
      verified = await ports.verifyCoordinateTarget(target, point, step, box);
    } catch {
      verified = false;
    }
    if (!verified) return refuseCoordinate(disturbance(focusChanged, true, 0));

    try {
      await ports.clickMouse({ button: "left", count: 1 });
    } catch {
      return stopUnconfirmed(disturbance(focusChanged, true, 1));
    }

    let clicked: OracleObservation;
    try {
      clicked = await oracle.observe(binding);
      clicked = await settleObservation(clicked);
    } catch {
      return stopUnconfirmed(disturbance(focusChanged, true, 1));
    }

    const clickDisturbance = disturbance(focusChanged, true, 1);
    const clickedProblem = oracleProblem(clicked);
    if (clickedProblem !== null) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "raw_coordinate",
        outcome: clickedProblem === "stale_window" ? "stale_window" : "oracle_fail",
        step,
        binding,
        pass: false,
        predicateId: clicked.predicateId,
        started: coordinateStarted,
        ended: clock(),
        tool: "click_mouse",
        disturbance: clickDisturbance,
        frameDigest: box.frameDigest,
      }));
      return { status: "stop", reason: clickedProblem, receipts };
    }
    if (clicked.pass) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "raw_coordinate",
        outcome: "oracle_pass",
        step,
        binding,
        pass: true,
        predicateId: clicked.predicateId,
        started: coordinateStarted,
        ended: clock(),
        tool: "click_mouse",
        disturbance: clickDisturbance,
        frameDigest: box.frameDigest,
      }));
      return { status: "pass", reason: "oracle_pass", receipts };
    }
    if (!clicked.unchanged) {
      receipts.push(receipt({
        routeId,
        attempt: attempt++,
        tier: "raw_coordinate",
        outcome: "partial_mutation",
        step,
        binding,
        pass: false,
        predicateId: clicked.predicateId,
        started: coordinateStarted,
        ended: clock(),
        tool: "click_mouse",
        disturbance: clickDisturbance,
        frameDigest: box.frameDigest,
      }));
      return { status: "stop", reason: "partial_mutation", receipts };
    }
    return stopUnconfirmed(clickDisturbance);
  } else skipTier("raw_coordinate");
  return { status: "fail", reason: "exhausted", receipts };
}
