/**
 * Codex CLI availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { loginShellCommand, userShell } from "../runtime/shell.ts";

export const minimumCodexVersion = "0.124.0";
export type CodexCliCapabilities = { readonly supportsHookTrustBypass: boolean };
export type CodexPreflightWarning = Omit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" }>,
  "elwoodSessionId"
>;
let cachedCapabilities: CodexCliCapabilities | undefined;

export function preflightCodex(
  strictVersionCheck: boolean,
  autoupdate = false,
): CodexPreflightWarning | undefined {
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let result = currentCommandRunner()(userShell(), loginShellCommand("codex --version"));
  if (result.status === null || result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("codex_not_found", "Could not find `codex` on PATH.");
  }
  if (result.status !== 0) {
    throw elwoodError("codex_start_failed", "`codex --version` failed.", {
      stderr: result.stderr,
    });
  }
  if (autoupdate) {
    runCodexUpdate();
    result = currentCommandRunner()(userShell(), loginShellCommand("codex --version"));
  }
  const version = parseCodexVersion(result.stdout);
  if (!version) {
    if (strictVersionCheck) {
      throw elwoodError("codex_version_unsupported", "Could not parse Codex CLI version.");
    }
    return versionWarning(result.stdout);
  }
  if (compareVersions(version, minimumCodexVersion) < 0) {
    throw elwoodError(
      "codex_version_unsupported",
      `Codex CLI ${minimumCodexVersion} or newer is required for Elwood hooks.`,
      { version, minimumCodexVersion },
    );
  }
  return undefined;
}

function runCodexUpdate(): void {
  const result = currentCommandRunner()(userShell(), loginShellCommand("codex update"));
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", { stderr: result.stderr });
  }
}

export function parseCodexVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

export function detectCodexCliCapabilities(): CodexCliCapabilities {
  if (cachedCapabilities) return cachedCapabilities;
  const result = currentCommandRunner()(userShell(), loginShellCommand("codex --help"));
  const help = `${result.stdout}\n${result.stderr}`;
  cachedCapabilities = {
    supportsHookTrustBypass: help.includes("--dangerously-bypass-hook-trust"),
  };
  return cachedCapabilities;
}

export function resetCodexPreflightCacheForTests(): void {
  cachedCapabilities = undefined;
}

function compareVersions(left: string, right: string): number {
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

function versionWarning(output: string): CodexPreflightWarning {
  return {
    agent: "codex",
    source: "lifecycle",
    code: "version_unparseable",
    severity: "warning",
    message: "Could not parse Codex CLI version; compatibility was not verified.",
    raw: output,
  };
}
