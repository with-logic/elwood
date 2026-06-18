/**
 * Shared assertions and payload builders for hook bridge e2e tests.
 * Implements PRD §12.
 */

import { parseJsonOutput } from "./helpers.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export function assertJson(stdout: string, path: readonly string[], expected: unknown): void {
  let value: unknown = parseJsonOutput<JsonObject>(stdout);
  for (const segment of path) value = (value as JsonObject)[segment];
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)} at ${path.join(".")}, got ${JSON.stringify(value)}`,
    );
  }
}

export function claudeToolEvent(base: JsonObject, hook_event_name: string): JsonObject {
  return { ...base, hook_event_name, tool_name: "Bash", tool_input: { command: "echo ok" } };
}

export function claudePostToolEvent(base: JsonObject): JsonObject {
  return { ...claudeToolEvent(base, "PostToolUse"), tool_response: { output: "ok" } };
}

export function codexToolEvent(
  base: JsonObject,
  hook_event_name: string,
  command: string,
): JsonObject {
  return { ...base, hook_event_name, tool_name: "Bash", tool_input: { command } };
}

export function commandFromToolInput(input: unknown): string {
  if (!input || typeof input !== "object" || !("command" in input)) return "";
  const command = (input as { readonly command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

export function hasHookError(events: readonly unknown[], hookEventName: string): boolean {
  return events.some(
    (event) =>
      Boolean(event && typeof event === "object") &&
      (event as { readonly hookEventName?: unknown }).hookEventName === hookEventName,
  );
}
