/**
 * Validate Claude partial input rewrites against the same concrete tool schemas
 * used at ingress. Implements PRD §6.4; absent fields are valid partial updates.
 */

import { isRecord, partial } from "./shapes.ts";
import { toolSchema } from "./tool-shapes.ts";

export function isClaudeToolInputUpdate(toolName: string | undefined, value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const checks = toolSchema(toolName ?? "");
  return checks === undefined || partial(value, checks);
}

export function isClaudeToolInput(toolName: string, value: unknown): boolean {
  if (!isRecord(value)) return false;
  const checks = toolSchema(toolName);
  // Future input fields are retained, but every declared field must match its type.
  return checks === undefined || Object.entries(checks).every(([key, check]) => check(value[key]));
}
