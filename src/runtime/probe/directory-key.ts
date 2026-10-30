/**
 * Per-directory probe answers: the key an answer is cached under, and a read that is kept only
 * for the directory it ran in. Implements the per-directory caches of PRD §9.2 (C-PERF-02).
 */

import { accessSync, constants, statSync } from "node:fs";
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
 * options to the probe, which spawns only while `cwd` is still that directory, so a probe that
 * waited for a slot while `cwd` was replaced reads nothing (`runProbe`). The cache's predicate
 * should refuse a read whose `sameDirectory` is false: its directory was replaced while it ran,
 * so it may describe the replacement, and keeping it under the original's key would answer the
 * original with it if that directory came back.
 */
export async function readInDirectory<T>(
  cache: ProbeCache<DirectoryRead<T>>,
  cwd: string,
  read: (options: CommandOptions) => Promise<T>,
  expected?: DirectoryIdentity,
): Promise<T> {
  const identity = await identityOf(cwd);
  if (
    expected !== undefined &&
    (identity === undefined || keyOf(cwd, expected) !== keyOf(cwd, identity))
  ) {
    return read({ cwd, identity: expected });
  }
  // A directory that can't be identified is read, but its answer is neither shared nor kept.
  if (identity === undefined) return read({ cwd });
  const key = keyOf(cwd, identity);
  const { value } = await cache.get(key, async () => {
    const value = await read({ cwd, identity: expected ?? identity });
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
export function probedDirectoryReplaced(options: CommandOptions): CommandResult | undefined {
  const { cwd, identity } = options;
  if (identity === undefined) return undefined;
  try {
    const { dev, ino } = statSync(cwd, { bigint: true });
    if (dev === identity.dev && ino === identity.ino) return undefined;
  } catch (error) {
    const code = errnoCode(error);
    const message = String(error);
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: { message, cwd, code },
    };
  }
  return { status: null, stdout: "", stderr: "", error: { message: probedDirectoryChanged, cwd } };
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
): CommandResult {
  if (options.identity === undefined) return result;
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
  if (status !== directoryGuardExitCode) return result;
  return { ...result, error: { ...result.error!, cwd: options.cwd } };
}
