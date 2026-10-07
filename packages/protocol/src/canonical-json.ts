import type { JsonValue } from "./schemas";

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => JSON.stringify(key) + ":" + canonicalJson(child as JsonValue));
  return "{" + entries.join(",") + "}";
}
