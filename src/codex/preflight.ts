/**
 * Codex CLI availability and version checks.
 * Implements PRD §9.2 and §10.
 */

import { elwoodError, notFoundDetails, probeFailureDetails } from "../core/errors.ts";
import type { ElwoodWarningEvent } from "../core/types.ts";
import { verifyBeforeUpdate } from "../core/update-verification.ts";
import { compareVersions, parseVersion } from "../core/versions.ts";
import { buildUpdateWarning, type DistributiveOmit } from "../core/warnings/update.ts";
import {
  createDirectoryProbeCache,
  type ProbeDirectory,
  probeCommandOptions,
  readInDirectory,
} from "../runtime/probe/directory-key.ts";
import { isProbeSetupError } from "../runtime/probe/setup-error.ts";
import {
  type CommandOptions,
  type CommandResult,
  currentCommandRunner,
  currentPlatform,
} from "../runtime/seams.ts";
import { probeShellCommand, userShell } from "../runtime/shell.ts";
import {
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
// Matching-directory capability reads share a run and retain only the derived boolean.
// A rejected probe is not retained, so a transient `--help` failure does not
// poison every later Codex start in the process (C-LIFE-11) — a later start re-probes.
const capabilityProbe = createDirectoryProbeCache<CodexCliCapabilities>(
  maxSettledPreflightDirectoryResults,
);

export async function preflightCodex(
  strictVersionCheck: boolean,
  autoupdate = false,
  directory?: ProbeDirectory,
): Promise<CodexPreflightWarning | undefined> {
  // Platform check is synchronous and first: unsupported hosts throw before
  // any subprocess is spawned.
  if (currentPlatform() !== "darwin") {
    throw elwoodError("unsupported_platform", "Elwood currently supports macOS only.");
  }
  const workspace = directory ?? { cwd: process.cwd() };
  let updateError: unknown;
  if (autoupdate) {
    // Best-effort: the shared update never rejects; on failure we re-read and fall through to the
    // compatibility gate — fatal only when the INSTALLED CLI is below the minimum (C-LIFE-11).
    // Only a test that reset the update module without setting a coordinator sees a throw here.
    const outcome = await cachedAutoupdate(
      "codex",
      () =>
        verifyBeforeUpdate(
          () => readCodexVersion(workspace),
          () => runCodexUpdate(workspace),
        ),
      () => capabilityProbe.clear(),
    );
    if (!outcome.ok) updateError = outcome.error;
  }
  const result = await readCodexVersion(workspace);
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

async function runCodexUpdate(directory: ProbeDirectory): Promise<void> {
  const options = probeCommandOptions(directory);
  const result = await currentCommandRunner()(
    userShell(),
    probeShellCommand("codex update"),
    options,
  );
  if (result.status !== 0) {
    throw elwoodError("codex_update_failed", "`codex update` failed.", probeFailureDetails(result));
  }
}

async function readCodexVersion(directory: ProbeDirectory): Promise<CommandResult> {
  // The mapping to typed errors runs on every call (cache hit or miss) so all
  // callers throw identically; only the subprocess is deduped.
  const result = await cachedVersionRead(
    "codex",
    (options) =>
      Promise.resolve(
        currentCommandRunner()(userShell(), probeShellCommand("codex --version", "codex"), options),
      ),
    directory,
  );
  const missingCommand = result.error?.code === "ENOENT" || result.commandLookupFailed === true;
  if (missingCommand && !isProbeSetupError(result.error)) {
    throw elwoodError(
      "codex_not_found",
      "Could not find `codex` on PATH.",
      notFoundDetails(result, "codex"),
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

export function detectCodexCliCapabilities(
  directory: ProbeDirectory = { cwd: process.cwd() },
): Promise<CodexCliCapabilities> {
  // Matching-directory first spawns share a probe; a rejected read is not retained.
  // A later start retries instead of inheriting the failure.
  return readInDirectory(capabilityProbe, directory.cwd, detectCapabilities, directory.identity);
}

async function detectCapabilities(options: CommandOptions): Promise<CodexCliCapabilities> {
  const result = await currentCommandRunner()(
    userShell(),
    probeShellCommand("codex --help"),
    options,
  );
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
