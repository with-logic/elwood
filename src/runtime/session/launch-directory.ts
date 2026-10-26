/**
 * The directory a session launches in must already exist. Starting there would otherwise
 * create it: the default state directory lives under it, and making that directory made
 * every missing parent, so a deleted worktree came back empty and the agent ran in it.
 * Implements PRD §5.1, §5.2, §5.5, §5.6 and C-API-61.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import { causeDetails, ElwoodError, elwoodError, errnoCode } from "../../core/errors.ts";
import { currentPlatform } from "../seams.ts";

const notADirectory = "The working directory (`cwd`) is not an existing directory.";
const uncheckable = "Could not check the working directory (`cwd`).";
const replaced = "The working directory (`cwd`) was replaced by another directory.";
const missingCodes = new Set<string | undefined>(["ENOENT", "ENOTDIR"]);

/**
 * `cwd` resolved against the process's working directory. A relative `cwd` can't be resolved
 * once that directory is deleted, and that is the start failure too, naming the `cwd` given.
 */
export function resolveLaunchDirectory(agent: ElwoodAgentKind, cwd: string): string {
  try {
    return resolve(cwd);
  } catch (error) {
    throw elwoodError(`${agent}_start_failed`, notADirectory, { cwd, ...causeDetails(error) });
  }
}

/** Which directory `cwd` named when it was checked (device and inode); none where unchecked. */
export type LaunchDirectoryIdentity = { readonly dev: bigint; readonly ino: bigint } | undefined;

/**
 * Rejects unless `cwd` is an existing directory and, given the directory an earlier check
 * found, still that one. Start and resume call it before any probe.
 */
export async function assertLaunchDirectory(
  agent: ElwoodAgentKind,
  cwd: string,
  checked?: LaunchDirectoryIdentity,
): Promise<LaunchDirectoryIdentity> {
  // An unsupported platform stays preflight's first error, ahead of anything about `cwd`.
  if (currentPlatform() !== "darwin") return undefined;
  let message = notADirectory;
  let details: Readonly<Record<string, string>> = { errno: "ENOTDIR" };
  try {
    const info = await stat(cwd, { bigint: true });
    if (info.isDirectory()) {
      const { dev, ino } = info;
      if (checked === undefined || (dev === checked.dev && ino === checked.ino))
        return { dev, ino };
      [message, details] = [replaced, {}];
    }
  } catch (error) {
    details = causeDetails(error);
    if (!missingCodes.has(errnoCode(error))) message = uncheckable;
  }
  throw elwoodError(`${agent}_start_failed`, message, { cwd, ...details });
}

/**
 * Checks `cwd`, then runs an operation in it: preflight's probes, or the launch. If the operation
 * fails, `cwd` is checked again against the directory found first, so one deleted and made again
 * meanwhile is not taken for the same directory. When that check fails, because `cwd` has gone
 * (state setup never makes it, so it fails with `ENOENT` instead of recreating the project), is
 * no longer a directory, was replaced, or can't be checked, the check's failure is the error,
 * keeping the operation's cause and cleanup details (§9.1, §10). While `cwd` is still that
 * directory, the operation's own failure is rethrown.
 */
export async function recheckLaunchDirectoryOnFailure<T>(
  agent: ElwoodAgentKind,
  cwd: string,
  operation: () => Promise<T>,
): Promise<T> {
  return inCheckedDirectory(agent, cwd, await assertLaunchDirectory(agent, cwd), operation);
}

/**
 * Runs preflight as `recheckLaunchDirectoryOnFailure` does, and checks `cwd` once more after it
 * succeeds: its answers describe the directory its probes ran in, so a `cwd` replaced meanwhile
 * fails the start or resume even when every probe passed, as when a best-effort update's failed
 * read is followed by a read in the new directory (§4.2, C-API-61).
 */
export async function preflightInLaunchDirectory<T>(
  agent: ElwoodAgentKind,
  cwd: string,
  preflight: () => Promise<T>,
): Promise<T> {
  const checked = await assertLaunchDirectory(agent, cwd);
  const answer = await inCheckedDirectory(agent, cwd, checked, preflight);
  await assertLaunchDirectory(agent, cwd, checked);
  return answer;
}

async function inCheckedDirectory<T>(
  agent: ElwoodAgentKind,
  cwd: string,
  checked: LaunchDirectoryIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await assertLaunchDirectory(agent, cwd, checked).catch((directoryError: ElwoodError) => {
      // `errno` is the check's, so a replaced directory has none, not the operation's.
      const { errno: _operationErrno, ...failed } = failureDetails(error);
      const { errno } = directoryError.details;
      const details = { ...failed, cwd, ...(errno ? { errno } : {}) };
      throw elwoodError(directoryError.code, directoryError.message, details);
    });
    throw error;
  }
}

/** What a failed operation reported: a typed error's details under its message, else its cause. */
function failureDetails(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof ElwoodError
    ? { cause: error.message, ...error.details }
    : causeDetails(error);
}
