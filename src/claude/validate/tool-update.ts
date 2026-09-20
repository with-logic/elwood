/**
 * Validate Claude partial input rewrites against the same concrete tool schemas
 * used at ingress. Implements PRD §6.4; absent fields are valid partial updates.
 */

import { isBoundedJsonShape } from "../../core/predicates.ts";
import { isRecord, partial } from "./shapes.ts";
import { toolSchema } from "./tool-shapes.ts";

export function isClaudeToolInputUpdate(toolName: string | undefined, value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  // A partial rewrite for a SCHEMA-LESS tool (MCP, generic, future) has no field table,
  // so the finite rule is enforced structurally here too — otherwise such a rewrite still
  // serializes a `null` where the tool's schema wants a number (C-HOOK-18).
  if (!isBoundedJsonShape(value)) return false;
  const checks = toolSchema(toolName ?? "");
  return checks === undefined || partial(value, checks);
}
