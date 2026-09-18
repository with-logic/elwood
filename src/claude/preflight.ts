/**
 * Claude availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { compareVersions, parseVersion } from "../core/versions.ts";
import { buildUpdateWarning, type DistributiveOmit } from "../core/warnings/update.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import { cachedAutoupdate, cachedVersionRead } from "../runtime/update/once.ts";

// Re-exported for existing importers; the implementation lives in core/versions.ts.

export const minimumClaudeVersion = "2.1.144";
export type ClaudePreflightWarning = DistributiveOmit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" | "agent_update_failed" }>,
  "elwoodSessionId"
>;

export async function preflightClaude(
  strictVersionCheck: boolean,
  autoupdate = false,
): Promise<ClaudePreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let updateError: unknown;
  if (autoupdate) {
    // Best-effort: every caller shares the single update attempt, which NEVER rejects. On failure
    // we re-read the installed version and fall through to the compatibility gate — a failed
    // update is only fatal when the INSTALLED CLI is below the minimum (C-LIFE-11).
    const outcome = await cachedAutoupdate("claude", async () => {
      await readClaudeVersion(); // verify existence only after owning the cross-process lease
      await runClaudeUpdate();
    });
    if (!outcome.ok) updateError = outcome.error;
  }
  const result = await readClaudeVersion();
  const version = parseVersion(result.stdout);
  if (!version) {
    if (strictVersionCheck) {
      throw elwoodError("claude_version_unsupported", "Could not parse Claude Code version.");
    }
    return versionWarning(result.stdout);
  }
  if (compareVersions(version, minimumClaudeVersion) < 0) {
    throw elwoodError(
      "claude_version_unsupported",
      `Claude Code ${minimumClaudeVersion}+ is required.`,
      {
        found: version,
        required: minimumClaudeVersion,
      },
    );
  }
  // Installed CLI is compatible: a failed best-effort update is a warning (naming the installed
  // version that will be used), not a start failure.
  return updateError === undefined ? undefined : buildUpdateWarning("claude", version, updateError);
}

async function runClaudeUpdate(): Promise<void> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("claude update"));
  if (result.status !== 0) {
    throw elwoodError(
      "claude_update_failed",
      "`claude update` failed.",
      probeFailureDetails(result),
    );
  }
}

async function readClaudeVersion(): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const result = await cachedVersionRead("claude", () =>
    Promise.resolve(currentCommandRunner()(userShell(), probeShellCommand("claude --version"))),
  );
  if (result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("claude_not_found", "`claude` was not found on PATH.");
  }
  if (result.status !== 0) {
    throw elwoodError(
      "claude_start_failed",
      "`claude --version` failed.",
      probeFailureDetails(result),
    );
  }
  return result;
}

function versionWarning(output: string): ClaudePreflightWarning {
  return {
    agent: "claude",
    source: "lifecycle",
    code: "version_unparseable",
    severity: "warning",
    message: "Could not parse Claude Code version; compatibility was not verified.",
    raw: output,
  };
}

// `ClaudePreflightWarning` is a DISTRIBUTED union (see DistributiveOmit), so re-attaching
// `elwoodSessionId` reconstructs each `ElwoodWarningEvent` member arm-by-arm.
type WithSessionId<W> = W extends unknown ? W & { readonly elwoodSessionId: string } : never;

export function preflightEvent(
  elwoodSessionId: string,
  warning: ClaudePreflightWarning,
): WithSessionId<ClaudePreflightWarning> {
  return { elwoodSessionId, ...warning };
}
