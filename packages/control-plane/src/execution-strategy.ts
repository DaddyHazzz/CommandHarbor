export type ExecutionStrategy =
  | "native_api"
  | "cli"
  | "mcp"
  | "webmcp"
  | "semantic_ui"
  | "browser_dom"
  | "pixel";

export const EXECUTION_STRATEGY_ORDER: readonly ExecutionStrategy[] = [
  "native_api",
  "cli",
  "mcp",
  "webmcp",
  "semantic_ui",
  "browser_dom",
  "pixel",
] as const;

export interface StrategyAvailability {
  strategy: ExecutionStrategy;
  available: boolean;
  reason?: string;
}

export interface StrategySelection {
  strategy: ExecutionStrategy;
  rank: number;
  reason: "strongest_available";
}

export function selectExecutionStrategy(
  availability: readonly StrategyAvailability[],
): StrategySelection | null {
  const byStrategy = new Map(availability.map((item) => [item.strategy, item]));
  for (let rank = 0; rank < EXECUTION_STRATEGY_ORDER.length; rank += 1) {
    const strategy = EXECUTION_STRATEGY_ORDER[rank]!;
    if (byStrategy.get(strategy)?.available === true) {
      return { strategy, rank, reason: "strongest_available" };
    }
  }
  return null;
}
