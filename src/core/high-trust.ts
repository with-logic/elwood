/**
 * The agent-neutral `highTrust` switch: expands to each adapter's most permissive
 * launch posture, and rejects an explicit per-agent posture supplied alongside it.
 * Implements PRD §5.1, §5.2, §5.5, §5.6 and C-API-54.
 */

import type { CodexApprovalPolicy, CodexSandboxMode } from "../codex/session/types.ts";
import { elwoodError } from "./errors.ts";
import type { ClaudePermissionMode } from "./types.ts";

type ClaudeHighTrustOptions = {
  readonly highTrust?: boolean;
  readonly permissionMode?: ClaudePermissionMode;
};

type CodexHighTrustOptions = {
  readonly highTrust?: boolean;
  readonly sandbox?: CodexSandboxMode;
  readonly approvalPolicy?: CodexApprovalPolicy;
};

/** The posture `highTrust` expands to on Claude. */
export const claudeHighTrustPosture = { permissionMode: "bypassPermissions" } as const;

/** The posture `highTrust` expands to on Codex. */
export const codexHighTrustPosture = {
  sandbox: "danger-full-access",
  approvalPolicy: "never",
} as const;

/**
 * Rejects `highTrust: true` combined with an explicit `permissionMode` (C-API-54).
 * Pure: safe to call at lazy-session construction so the conflict fails fast.
 */
export function assertClaudeHighTrust(options: ClaudeHighTrustOptions): void {
  if (options.highTrust === true && options.permissionMode !== undefined) {
    throw elwoodError(
      "claude_high_trust_conflict",
      "highTrust cannot be combined with an explicit permissionMode; it already selects bypassPermissions.",
      { permissionMode: options.permissionMode },
    );
  }
}

/** Rejects `highTrust: true` combined with an explicit `sandbox` or `approvalPolicy` (C-API-54). */
export function assertCodexHighTrust(options: CodexHighTrustOptions): void {
  if (options.highTrust !== true) return;
  const explicit = [
    ...(options.sandbox === undefined ? [] : ["sandbox"]),
    ...(options.approvalPolicy === undefined ? [] : ["approvalPolicy"]),
  ];
  if (explicit.length === 0) return;
  throw elwoodError(
    "codex_high_trust_conflict",
    `highTrust cannot be combined with an explicit ${explicit.join(" or ")}; it already selects danger-full-access with approval policy never.`,
    { explicit: explicit.join(",") },
  );
}

/**
 * Expands `highTrust: true` into `permissionMode: "bypassPermissions"`, dropping the
 * switch itself so the result is idempotent and carries only the concrete posture.
 */
export function applyClaudeHighTrust<T extends ClaudeHighTrustOptions>(options: T): T {
  assertClaudeHighTrust(options);
  const { highTrust, ...rest } = options;
  return highTrust === true ? ({ ...rest, ...claudeHighTrustPosture } as T) : options;
}

/** Expands `highTrust: true` into `danger-full-access` + `never` (see `applyClaudeHighTrust`). */
export function applyCodexHighTrust<T extends CodexHighTrustOptions>(options: T): T {
  assertCodexHighTrust(options);
  const { highTrust, ...rest } = options;
  return highTrust === true ? ({ ...rest, ...codexHighTrustPosture } as T) : options;
}
