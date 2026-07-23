/**
 * Persisted launch posture: the resolved privilege and tool policy a session
 * launched with. Implements PRD §5.2, §5.6, §8.2, C-STATE-13, and C-API-32.
 */

import type { CodexApprovalPolicy, CodexSandboxMode } from "../codex/session-types.ts";
import type { ClaudePermissionMode, ClaudeToolRule } from "../core/types.ts";
import type { SessionRecord } from "./store.ts";

export type ClaudeLaunchPosture = {
  readonly permissionMode?: ClaudePermissionMode;
  readonly allowedTools?: readonly ClaudeToolRule[];
  readonly disallowedTools?: readonly ClaudeToolRule[];
  readonly tools?: readonly ClaudeToolRule[];
};

export type CodexLaunchPosture = {
  readonly sandbox?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
};

export type AdapterState<Posture> = {
  readonly resumeId?: string;
  readonly launch?: Posture;
};

function compact<T extends object>(posture: { [K in keyof T]: T[K] | undefined }): T | undefined {
  const entries = Object.entries(posture).filter((entry) => entry[1] !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

export function claudeLaunchPosture(options: ClaudeLaunchPosture): ClaudeLaunchPosture | undefined {
  const { permissionMode, allowedTools, disallowedTools, tools } = options;
  // COPY the tool arrays so the persisted posture never aliases the caller's array: a
  // later mutation of the caller's array must not change what a resume launches with —
  // otherwise a future resume could gain tools the original process never had
  // (C-API-32/C-STATE-13). `readonly ClaudeToolRule` entries are strings, so a shallow
  // copy is a full snapshot.
  return compact({
    permissionMode,
    allowedTools: allowedTools && [...allowedTools],
    disallowedTools: disallowedTools && [...disallowedTools],
    tools: tools && [...tools],
  });
}

export function codexLaunchPosture(options: CodexLaunchPosture): CodexLaunchPosture | undefined {
  const { sandbox, approvalPolicy } = options;
  return compact({ sandbox, approvalPolicy });
}

export function withClaudeLaunch(
  record: SessionRecord,
  launch: ClaudeLaunchPosture | undefined,
): SessionRecord {
  if (launch === undefined) return record;
  return { ...record, claude: { ...record.claude, launch } };
}

export function withCodexLaunch(
  record: SessionRecord,
  launch: CodexLaunchPosture | undefined,
): SessionRecord {
  if (launch === undefined) return record;
  return { ...record, codex: { ...record.codex, launch } };
}

/** Caller options override the persisted posture field by field (C-API-32). */
export function effectivePosture<T extends object>(
  persisted: T | undefined,
  requested: T | undefined,
): T | undefined {
  return compact({ ...persisted, ...requested } as { [K in keyof T]: T[K] | undefined });
}
