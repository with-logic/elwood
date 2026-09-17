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
