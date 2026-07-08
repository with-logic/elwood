/**
 * Codex CLI availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import {
  cachedAutoupdate,
  cachedVersionRead,
  invalidateVersionRead,
} from "../runtime/update-once.ts";

export const minimumCodexVersion = "0.124.0";
export type CodexCliCapabilities = { readonly supportsHookTrustBypass: boolean };
export type CodexPreflightWarning = Omit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" }>,
  "elwoodSessionId"
>;
let cachedCapabilities: CodexCliCapabilities | undefined;
let inFlightCapabilities: Promise<CodexCliCapabilities> | undefined;

export async function preflightCodex(
  strictVersionCheck: boolean,
  autoupdate = false,
): Promise<CodexPreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let result = await readCodexVersion();
  if (autoupdate) {
    // Every autoupdate caller awaits the single shared update, then re-reads
    // the same post-update version — so no concurrent caller validates a
    // stale pre-update result or races a second update.
    await cachedAutoupdate("codex", runCodexUpdate);
    result = await readCodexVersion();
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

async function runCodexUpdate(): Promise<void> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("codex update"));
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", { stderr: result.stderr });
  }
  // The update may have changed the binary; drop the cached version read and
  // the capability cache so every caller re-detects against the new binary.
  invalidateVersionRead("codex");
  cachedCapabilities = undefined;
  inFlightCapabilities = undefined;
}

async function readCodexVersion(): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const result = await cachedVersionRead("codex", () =>
    Promise.resolve(currentCommandRunner()(userShell(), probeShellCommand("codex --version"))),
  );
  if (result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("codex_not_found", "Could not find `codex` on PATH.");
  }
  if (result.status !== 0) {
    throw elwoodError("codex_start_failed", "`codex --version` failed.", {
      stderr: result.stderr,
      ...(result.error === undefined ? {} : { error: result.error.message }),
    });
  }
  return result;
}

export function parseCodexVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null;
}

export async function detectCodexCliCapabilities(): Promise<CodexCliCapabilities> {
  if (cachedCapabilities) return cachedCapabilities;
  // Cache the in-flight probe so concurrent first Codex spawns share one
  // `codex --help` subprocess rather than each launching its own.
  inFlightCapabilities ??= detectCapabilities();
  cachedCapabilities = await inFlightCapabilities;
  return cachedCapabilities;
}

async function detectCapabilities(): Promise<CodexCliCapabilities> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("codex --help"));
  const help = `${result.stdout}\n${result.stderr}`;
  return { supportsHookTrustBypass: help.includes("--dangerously-bypass-hook-trust") };
}

export function resetCodexPreflightCacheForTests(): void {
  cachedCapabilities = undefined;
  inFlightCapabilities = undefined;
}

function compareVersions(left: string, right: string): number {
  // Both inputs are dotted numeric triples: parseCodexVersion captures exactly
  // `major.minor.patch` and minimumCodexVersion is a literal triple.
  const rightParts = right.split(".");
  for (const [index, part] of left.split(".").entries()) {
    const diff = Number(part) - Number(rightParts[index]);
    if (diff !== 0) return diff;
  }
  return 0;
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
