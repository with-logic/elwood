/**
 * Per-directory probe answers: the key an answer is cached under, and a read that is kept only
 * for the directory it ran in. Implements the per-directory caches of PRD §9.2 (C-PERF-02).
 */

import { accessSync, constants } from "node:fs";
import { stat } from "node:fs/promises";
import { errnoCode } from "../../core/errors.ts";
import { directoryGuardExitCode } from "../checked-command.ts";
import type { ProbeCache } from "../probe-cache.ts";
import type { CommandOptions, CommandResult, DirectoryIdentity } from "../seams.ts";

/** Which directory `cwd` names; none for a path that can't be checked. */
async function identityOf(cwd: string): Promise<DirectoryIdentity | undefined> {
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    return { dev, ino };
  } catch {
    return undefined;
  }
}

/**
 * The key a directory's answer is kept under: `cwd` and which directory it names, so a directory
 * deleted and made again at the same path is probed again rather than answered from the old one.
 */
function keyOf(cwd: string, { dev, ino }: DirectoryIdentity): string {
  return `${dev}:${ino}:${cwd}`;
}

/** A probe answer, and whether its directory was still the one it was keyed by. */
export type DirectoryRead<T> = { readonly value: T; readonly sameDirectory: boolean };

/**
 * `cwd`'s answer from `cache`, else `read()`'s, keyed by `cwd`'s directory. `read` passes its
 * options to the probe, retaining a launch's pinned `expectedIdentity` even when the fresh
 * `observedIdentity` differs; the child must refuse that mismatch instead of trusting it anew.
 * The cache predicate refuses a read whose final boundary saw a different directory, because
 * keeping a replacement's answer under the original key could answer the restored original
 * incorrectly. Replacements wholly between checks can escape detection (§4.2).
 */
export async function readInDirectory<T>(
  cache: ProbeCache<DirectoryRead<T>>,
  cwd: string,
  read: (options: CommandOptions) => Promise<T>,
  expectedIdentity?: DirectoryIdentity,
): Promise<T> {
  const observedIdentity = await identityOf(cwd);
  if (
    expectedIdentity !== undefined &&
    (observedIdentity === undefined ||
      keyOf(cwd, expectedIdentity) !== keyOf(cwd, observedIdentity))
  ) {
    // Retain the launch's pinned identity: adopting the replacement would trust it anew.
    return read({ cwd, identity: expectedIdentity });
  }
  // A directory that can't be identified is read, but its answer is neither shared nor kept.
  if (observedIdentity === undefined) return read({ cwd });
  const key = keyOf(cwd, observedIdentity);
  const { value } = await cache.get(key, async () => {
    const value = await read({ cwd, identity: expectedIdentity ?? observedIdentity });
    const after = await identityOf(cwd);
    return { value, sameDirectory: after !== undefined && keyOf(cwd, after) === key };
  });
  return value;
}

/**
 * A probe's failure, without running, when `cwd` is no longer the directory `identity` names;
 * none when it is, or no identity was given. The child checks its actual kernel cwd too,
 * closing a subsequent replacement before the login shell runs.
 */
export async function refusedProbeDirectory(
  options: CommandOptions,
): Promise<CommandResult | undefined> {
  const { cwd, identity } = options;
  if (identity === undefined) return undefined;
  try {
    const { dev, ino } = await stat(cwd, { bigint: true });
    if (dev === identity.dev && ino === identity.ino) return undefined;
  } catch (error) {
    const code = errnoCode(error);
    const message = String(error);
    return {
      status: null,
      stdout: "",
      stderr: "",
      started: false,
      error: { message, cwd, code },
    };
  }
  return {
    status: null,
    stdout: "",
    stderr: "",
    started: false,
    error: { message: probedDirectoryChanged, cwd },
  };
}

/** Why a probe did not run: its directory was removed or replaced before it could start there. */
export const probedDirectoryChanged =
  "The directory was removed or replaced before the probe started.";

/** A child-side directory refusal never ran the probe; retain its checked launch path. */
export function directoryShellExit(
  status: number | null,
  result: CommandResult,
  options: CommandOptions,
  command: string,
  guardRefused = false,
): CommandResult {
  if (options.identity === undefined) return result;
  // 126/127 can mean the wrapper could not exec the configured shell. If that shell is
  // executable, preserve its own profile's exit instead of inventing a missing command.
  if (status === 126 || status === 127) {
    try {
      accessSync(command, constants.X_OK);
    } catch (error) {
      const code = errnoCode(error);
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: { code, message: `spawn ${command} ${code}` },
      };
    }
  }
  // A profile can choose status 96 too: only our private guard signal identifies refusal.
  if (status !== directoryGuardExitCode || !guardRefused || result.error?.phase !== "login_shell")
    return result;
  return { ...result, started: false, error: { ...result.error, cwd: options.cwd } };
}
