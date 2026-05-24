/**
 * Codex CLI availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import { currentCommandRunner, currentPlatform } from "../runtime/seams.ts";

export const minimumCodexVersion = "0.124.0";
export type CodexCliCapabilities = { readonly supportsHookTrustBypass: boolean };
let cachedCapabilities: CodexCliCapabilities | undefined;

export function preflightCodex(strictVersionCheck: boolean): void {
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  const result = currentCommandRunner()("codex", ["--version"]);
  if (result.status === null || result.error?.code === "ENOENT") {
    throw elwoodError("codex_not_found", "Could not find `codex` on PATH.");
  }
  if (result.status !== 0) throw elwoodError("codex_not_found", "`codex --version` failed.");
  const version = parseCodexVersion(result.stdout);
  if (!version) {
    if (strictVersionCheck) {
      throw elwoodError("codex_version_unsupported", "Could not parse Codex CLI version.");
    }
    return;
  }
  if (compareVersions(version, minimumCodexVersion) < 0) {
    throw elwoodError(
      "codex_version_unsupported",
      `Codex CLI ${minimumCodexVersion} or newer is required for Elwood hooks.`,
      { version, minimumCodexVersion },
    );
  }
}

export function parseCodexVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

export function detectCodexCliCapabilities(): CodexCliCapabilities {
  if (cachedCapabilities) return cachedCapabilities;
  const shell = process.env["SHELL"] ?? "/bin/zsh";
  const result = currentCommandRunner()(shell, ["-l", "-i", "-c", "codex --help"]);
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
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
