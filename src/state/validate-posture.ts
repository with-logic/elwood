/**
 * Adapter-specific validation of a persisted launch posture (C-STATE-13).
 *
 * A persisted posture must round-trip through the same narrow public unions the
 * session launched with; an out-of-union `permissionMode`, `sandbox`, or
 * `approvalPolicy` invalidates the record rather than resuming with a corrupted
 * policy (PRD §8.2). The runtime allowlists are the single source of truth for
 * each union and are checked against the public types at compile time below.
 */

import type { CodexApprovalPolicy, CodexSandboxMode } from "../codex/session-types.ts";
import type { ClaudePermissionMode } from "../core/types.ts";
import { isStringArray } from "./validate-predicates.ts";

const claudePermissionModes = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const;

const codexSandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
const codexApprovalPolicies = ["untrusted", "on-request", "never"] as const;

// Compile-time drift guards: each tuple must exactly cover its public union, so
// widening the type without extending the allowlist (or vice versa) fails to
// build rather than silently letting out-of-union values through.
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _permissionModeExact: AssertExact<
  (typeof claudePermissionModes)[number],
  ClaudePermissionMode
> = true;
const _sandboxExact: AssertExact<(typeof codexSandboxModes)[number], CodexSandboxMode> = true;
const _approvalExact: AssertExact<(typeof codexApprovalPolicies)[number], CodexApprovalPolicy> =
  true;
void _permissionModeExact;
void _sandboxExact;
void _approvalExact;

/**
 * Validates the launch posture for the record's adapter. Codex records must not
 * carry Claude posture fields and vice versa; any unknown key invalidates.
 */
export function isLaunchPosture(value: unknown, adapter: "claude" | "codex"): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return adapter === "claude" ? isClaudePosture(value) : isCodexPosture(value);
}

function isClaudePosture(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAllowed(value, ["permissionMode", "allowedTools", "disallowedTools", "tools"]) &&
    optionalOneOf(value["permissionMode"], claudePermissionModes) &&
    optionalStringArray(value["allowedTools"]) &&
    optionalStringArray(value["disallowedTools"]) &&
    optionalStringArray(value["tools"])
  );
}

function isCodexPosture(value: Readonly<Record<string, unknown>>): boolean {
  return (
    keysAllowed(value, ["sandbox", "approvalPolicy"]) &&
    optionalOneOf(value["sandbox"], codexSandboxModes) &&
    optionalOneOf(value["approvalPolicy"], codexApprovalPolicies)
  );
}

function keysAllowed(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function optionalOneOf(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === "string" && allowed.includes(value));
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
