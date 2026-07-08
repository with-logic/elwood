/**
 * Claude availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";
import {
  cachedVersionRead,
  invalidateVersionRead,
  shouldRunAutoupdate,
} from "../runtime/update-once.ts";

export const minimumClaudeVersion = "2.1.144";
export type ClaudePreflightWarning = Omit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" }>,
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
  let result = await readClaudeVersion();
  if (autoupdate && shouldRunAutoupdate("claude")) {
    await runClaudeUpdate();
    // The update may have changed the binary; drop the cached read so the
    // post-update version is re-read.
    invalidateVersionRead("claude");
    result = await readClaudeVersion();
  }
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
  return undefined;
}

async function runClaudeUpdate(): Promise<void> {
  const result = await currentCommandRunner()(userShell(), loginShellCommand("claude update"));
  if (result.status !== 0) {
    throw elwoodError("claude_update_failed", "`claude update` failed.", {
      stderr: result.stderr,
    });
  }
}

async function readClaudeVersion(): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const result = await cachedVersionRead("claude", () =>
    Promise.resolve(currentCommandRunner()(userShell(), loginShellCommand("claude --version"))),
  );
  if (result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("claude_not_found", "`claude` was not found on PATH.");
  }
  if (result.status !== 0) {
    throw elwoodError("claude_start_failed", "`claude --version` failed.", {
      stderr: result.stderr,
    });
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
