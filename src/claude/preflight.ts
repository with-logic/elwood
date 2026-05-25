/**
 * Claude availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import { currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";

export const minimumClaudeVersion = "2.1.144";

export function preflightClaude(strictVersionCheck: boolean, autoupdate = false): void {
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  const result = currentCommandRunner()(userShell(), loginShellCommand("claude --version"));
  if (result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("claude_not_found", "`claude` was not found on PATH.");
  }
  if (result.status !== 0) {
    throw elwoodError("claude_start_failed", "`claude --version` failed.", {
      stderr: result.stderr,
    });
  }
  const version = parseVersion(result.stdout);
  if (!version) {
    if (strictVersionCheck) {
      throw elwoodError("claude_version_unsupported", "Could not parse Claude Code version.");
    }
    return;
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
  if (autoupdate) runClaudeUpdate();
}

function runClaudeUpdate(): void {
  const result = currentCommandRunner()(userShell(), loginShellCommand("claude update"));
  if (result.status !== 0) {
    throw elwoodError("claude_update_failed", "`claude update` failed.", {
      stderr: result.stderr,
    });
  }
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
