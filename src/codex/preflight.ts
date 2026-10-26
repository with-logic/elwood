/**
 * Codex CLI availability and version checks, run in the session's launch directory.
 * Implements PRD §9.2, §10, and C-PTY-08.
 */

import { elwoodError, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { compareVersions, parseVersion } from "../core/versions.ts";
import { buildUpdateWarning, type DistributiveOmit } from "../core/warnings/update.ts";
import { createProbeCache } from "../runtime/probe-cache.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import { cachedAutoupdate, cachedVersionRead } from "../runtime/update/once.ts";

// Re-exported for existing importers; the implementation lives in core/versions.ts.

export const minimumCodexVersion = "0.124.0";
export type CodexCliCapabilities = { readonly supportsHookTrustBypass: boolean };
export type CodexPreflightWarning = DistributiveOmit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" | "agent_update_failed" }>,
  "elwoodSessionId"
>;
// Single-entry cache for the capability probe. It shares one in-flight `codex --help` across
// concurrent first spawns AND never keeps a rejection, so a transient `--help` failure does not
// poison every later Codex start in the process (C-LIFE-11) — a later start re-probes.
const capabilityProbe = createProbeCache<CodexCliCapabilities>(1);

/** Checks the `codex` that a session launched in `cwd` would run (C-PTY-08). */
export async function preflightCodex(
  cwd: string,
  strictVersionCheck: boolean,
  autoupdate = false,
): Promise<CodexPreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let updateError: unknown;
  if (autoupdate) {
    // Best-effort: the shared update never rejects; on failure we re-read and fall through to the
    // compatibility gate — fatal only when the INSTALLED CLI is below the minimum (C-LIFE-11).
    const outcome = await cachedAutoupdate(
      "codex",
      async () => {
        await readCodexVersion(cwd); // verify existence only after owning the cross-process lease
        await runCodexUpdate(cwd);
      },
      () => capabilityProbe.clear(),
    );
    if (!outcome.ok) updateError = outcome.error;
  }
  const result = await readCodexVersion(cwd);
  const version = parseVersion(result.stdout);
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
  // Installed CLI is compatible: a failed best-effort update is a warning, not a start failure.
  return updateError === undefined ? undefined : buildUpdateWarning("codex", version, updateError);
}

async function runCodexUpdate(cwd: string): Promise<void> {
  const update = probeShellCommand("codex update");
  const result = await currentCommandRunner()(userShell(), update, { cwd });
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", probeFailureDetails(result));
  }
}

async function readCodexVersion(cwd: string): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const command = probeShellCommand("codex --version");
  const result = await cachedVersionRead("codex", cwd, () =>
    Promise.resolve(currentCommandRunner()(userShell(), command, { cwd })),
  );
  if (result.error?.code === "ENOENT" || result.status === 127) {
    // The probe's own failure is the cause, so a launch directory that went while it was
    // probed reports why the probe failed, not a missing CLI (C-PTY-08).
    throw elwoodError(
      "codex_not_found",
      "Could not find `codex` on PATH.",
      probeFailureDetails(result),
    );
  }
  if (result.status !== 0) {
    throw elwoodError(
      "codex_start_failed",
      "`codex --version` failed.",
      probeFailureDetails(result),
    );
  }
  return result;
}

export function detectCodexCliCapabilities(): Promise<CodexCliCapabilities> {
  // Shared once across concurrent first spawns; a rejected probe is not kept, so a later start
  // re-probes rather than inheriting the failure.
  return capabilityProbe.get("codex", detectCapabilities);
}

async function detectCapabilities(): Promise<CodexCliCapabilities> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("codex --help"));
  // A bounded probe (timeout/overflow) or nonzero exit is a diagnosable
  // startup failure, not "capability unsupported" — surface it with cause.
  if (result.error !== undefined || result.status !== 0) {
    throw elwoodError("codex_start_failed", "`codex --help` failed.", probeFailureDetails(result));
  }
  const help = `${result.stdout}\n${result.stderr}`;
  return { supportsHookTrustBypass: help.includes("--dangerously-bypass-hook-trust") };
}

export function resetCodexPreflightCacheForTests(): void {
  capabilityProbe.clear();
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
