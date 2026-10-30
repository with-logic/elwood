/**
 * Codex CLI availability and version checks, run in the session's launch directory.
 * Implements PRD §9.2, §10, and C-PTY-08.
 */

import type { DirectoryIdentity } from "../core/directory-identity.ts";
import { elwoodError, notFoundDetails, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { compareVersions, parseVersion } from "../core/versions.ts";
import { buildUpdateWarning, type DistributiveOmit } from "../core/warnings/update.ts";
import { type DirectoryRead, readInDirectory } from "../runtime/probe/directory-key.ts";
import { createProbeCache } from "../runtime/probe-cache.ts";
import {
  type CommandOptions,
  type CommandResult,
  currentCommandRunner,
  currentPlatform,
} from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import {
  type AutoupdateOutcome,
  cachedAutoupdate,
  cachedVersionRead,
  maxSettledPreflightDirectoryResults,
} from "../runtime/update/once.ts";

// Re-exported for existing importers; the implementation lives in core/versions.ts.

export const minimumCodexVersion = "0.124.0";
export type CodexCliCapabilities = { readonly supportsHookTrustBypass: boolean };
export type CodexPreflightWarning = DistributiveOmit<
  Extract<ElwoodWarningEvent, { readonly code: "version_unparseable" | "agent_update_failed" }>,
  "elwoodSessionId"
>;
// The capability probe per launch directory, bounded like the version reads. It shares one
// in-flight `codex --help` across concurrent first spawns AND never keeps a rejection, so a
// transient `--help` failure does not poison every later Codex start (C-LIFE-11). An answer
// read while its directory was replaced may be the replacement's, so it is not kept either.
const capabilityProbe = createProbeCache<DirectoryRead<CodexCliCapabilities>>(
  maxSettledPreflightDirectoryResults,
  (read) => read.sameDirectory,
);

/** Checks the `codex` that a session launched in `cwd` would run (C-PTY-08). */
export async function preflightCodex(
  cwd: string,
  strictVersionCheck: boolean,
  autoupdate = false,
  identity?: DirectoryIdentity,
): Promise<CodexPreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let failedUpdate: Extract<AutoupdateOutcome, { readonly ok: false }> | undefined;
  if (autoupdate) {
    // Best-effort: the shared update never rejects; on failure we re-read and fall through to the
    // compatibility gate — fatal only when the INSTALLED CLI is below the minimum (C-LIFE-11).
    const outcome = await cachedAutoupdate(
      "codex",
      cwd,
      {
        verify: () => readCodexVersion(cwd, identity),
        update: () => runCodexUpdate(cwd, identity),
      },
      () => capabilityProbe.clear(),
    );
    if (!outcome.ok) failedUpdate = outcome;
  }
  const result = await readCodexVersion(cwd, identity);
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
  return (
    failedUpdate && buildUpdateWarning("codex", version, failedUpdate.error, failedUpdate.updateCwd)
  );
}

async function runCodexUpdate(cwd: string, identity?: DirectoryIdentity): Promise<void> {
  const update = probeShellCommand("codex update");
  const result = await currentCommandRunner()(
    userShell(),
    update,
    identity === undefined ? { cwd } : { cwd, identity },
  );
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", probeFailureDetails(result));
  }
}

async function readCodexVersion(cwd: string, identity?: DirectoryIdentity): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const command = probeShellCommand("codex --version");
  const result = await cachedVersionRead(
    "codex",
    cwd,
    (options) => Promise.resolve(currentCommandRunner()(userShell(), command, options)),
    identity,
  );
  if (
    (result.error?.code === "ENOENT" && result.error.cwd === undefined) ||
    result.status === 127
  ) {
    // The probe's own failure is the cause, so a launch directory that went while it was
    // probed reports why the probe failed, not a missing CLI (C-PTY-08).
    const missing = result.error
      ? "The login shell could not be started to find `codex`."
      : "Could not find `codex` on PATH.";
    throw elwoodError("codex_not_found", missing, notFoundDetails(result, "codex"));
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

/**
 * What the `codex` that a session launched in `cwd` would run supports, from its `codex --help`
 * run in `cwd` (C-PTY-08). On resume that is the record's directory, where Codex relaunches: a
 * per-directory tool manager can resolve a different build in each directory (§9.2).
 */
export function detectCodexCliCapabilities(
  cwd: string,
  identity?: DirectoryIdentity,
): Promise<CodexCliCapabilities> {
  return readInDirectory(capabilityProbe, cwd, detectCapabilities, identity);
}

async function detectCapabilities(options: CommandOptions): Promise<CodexCliCapabilities> {
  const command = probeShellCommand("codex --help");
  const result = await currentCommandRunner()(userShell(), command, options);
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
