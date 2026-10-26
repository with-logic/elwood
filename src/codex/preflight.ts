/**
 * Codex CLI availability and version checks, run in the session's directory.
 * Implements PRD §9.2, §10, and C-PTY-08.
 */

import { elwoodError, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent, PreflightOptions } from "../core/types.ts";
import { compareVersions, parseVersion } from "../core/versions.ts";
import { buildUpdateWarning, type DistributiveOmit } from "../core/warnings/update.ts";
import { directoryKey } from "../runtime/probe/directory-key.ts";
import { createProbeCache } from "../runtime/probe-cache.ts";
import { type CommandResult, currentCommandRunner, currentPlatform } from "../runtime/seams.ts";
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
// The capability probe per session directory, bounded like the version reads. It shares one
// in-flight `codex --help` across concurrent first spawns AND never keeps a rejection, so a
// transient `--help` failure does not poison every later Codex start (C-LIFE-11).
const capabilityProbe = createProbeCache<CodexCliCapabilities>(maxSettledPreflightDirectoryResults);

/** Checks the `codex` that a session launched in `cwd` would run (C-PTY-08). */
export async function preflightCodex(
  cwd: string,
  options: PreflightOptions = {},
): Promise<CodexPreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  let failedUpdate: Extract<AutoupdateOutcome, { readonly ok: false }> | undefined;
  if (options.autoupdate) {
    // Best-effort: the shared update never rejects; on failure we re-read and fall through to the
    // compatibility gate — fatal only when the INSTALLED CLI is below the minimum (C-LIFE-11).
    const outcome = await cachedAutoupdate(
      "codex",
      cwd,
      async () => {
        await readCodexVersion(cwd); // verify existence only after owning the cross-process lease
        await runCodexUpdate(cwd);
      },
      () => capabilityProbe.clear(),
    );
    if (!outcome.ok) failedUpdate = outcome;
  }
  const result = await readCodexVersion(cwd);
  const version = parseVersion(result.stdout);
  if (!version) {
    if (options.strictVersionCheck) {
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
  return failedUpdate === undefined
    ? undefined
    : buildUpdateWarning("codex", version, failedUpdate.error, failedUpdate.updateCwd);
}

async function runCodexUpdate(cwd: string): Promise<void> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("codex update"), {
    cwd,
  });
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", probeFailureDetails(result));
  }
}

async function readCodexVersion(cwd: string): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const result = await cachedVersionRead("codex", cwd, () =>
    Promise.resolve(
      currentCommandRunner()(userShell(), probeShellCommand("codex --version"), { cwd }),
    ),
  );
  if (result.error?.code === "ENOENT" || result.status === 127) {
    throw elwoodError("codex_not_found", "Could not find `codex` on PATH.");
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
 * What the `codex` in `cwd` supports, from its `codex --help`. `cwd` must be the directory the
 * session's Codex launches in (on resume, the record's, not a given `cwd`): a per-directory tool
 * manager can resolve a different build there. Answers are cached per directory, so one deleted and
 * made again at the same path is probed again (§9.2).
 */
export async function detectCodexCliCapabilities(cwd: string): Promise<CodexCliCapabilities> {
  // Shared once per directory across concurrent first spawns, and kept for the directory, not
  // just its path; a rejected probe is not kept, so a later start re-probes.
  return capabilityProbe.get(await directoryKey(cwd), () => detectCapabilities(cwd));
}

async function detectCapabilities(cwd: string): Promise<CodexCliCapabilities> {
  const result = await currentCommandRunner()(userShell(), probeShellCommand("codex --help"), {
    cwd,
  });
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
