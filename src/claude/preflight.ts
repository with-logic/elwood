/**
 * Claude availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { type DistributiveOmit, updateFailedWarning } from "../core/update-warning.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import { cachedAutoupdate, cachedVersionRead } from "../runtime/update-once.ts";

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
    return versionWarning("claude", result.stdout);
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
  return updateError === undefined
    ? undefined
    : updateFailedWarning("claude", version, updateError);
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

export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(toVersionPart);
  const b = right.split(".").map(toVersionPart);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function toVersionPart(part: string): number {
  const parsed = Number.parseInt(part, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function versionWarning(agent: "claude", output: string): ClaudePreflightWarning {
  return {
    agent,
    source: "lifecycle",
    code: "version_unparseable",
    severity: "warning",
    message: "Could not parse Claude Code version; compatibility was not verified.",
    raw: output,
  };
}
