/**
 * The directory a session launches in must already exist. Starting there would otherwise
 * create it: the default state directory lives under it, and making that directory made
 * every missing parent, so a deleted worktree came back empty and the agent ran in it.
 * Implements PRD §5.1, §5.2, §5.5, §5.6 and C-API-61.
 */

import { type BigIntStats, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ElwoodAgentKind } from "../../core/activity/index.ts";
import type { DirectoryIdentity } from "../../core/directory-identity.ts";
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
type LaunchDirectoryIdentity = DirectoryIdentity | undefined;

/** The launch path and directory identity captured before preflight. */
export type CheckedLaunchDirectory = {
  readonly agent: ElwoodAgentKind;
  readonly cwd: string;
  readonly identity: LaunchDirectoryIdentity;
};

/** Capture the directory before any asynchronous preflight work. */
export async function checkLaunchDirectory(
  agent: ElwoodAgentKind,
  cwd: string,
): Promise<CheckedLaunchDirectory> {
  return { agent, cwd, identity: await assertLaunchDirectory(agent, cwd) };
}

/**
 * Rejects unless `cwd` is an existing directory and, given the directory an earlier check
 * found, still that one. Start and resume call it before any probe.
 */
async function assertLaunchDirectory(
  agent: ElwoodAgentKind,
  cwd: string,
  checked?: LaunchDirectoryIdentity,
): Promise<LaunchDirectoryIdentity> {
  // An unsupported platform stays preflight's first error, ahead of anything about `cwd`.
  if (currentPlatform() !== "darwin") return undefined;
  const info = await stat(cwd, { bigint: true }).catch((error: unknown) => {
    throw unreadable(agent, cwd, error);
  });
  return identify(agent, cwd, info, checked);
}

/** Synchronous checkpoints keep private state setup bound to the initially checked workspace. */
export function assertLaunchDirectoryUnchanged(directory: CheckedLaunchDirectory): void {
  if (directory.identity === undefined) return;
  const { agent, cwd, identity } = directory;
  let info: BigIntStats;
  try {
    info = statSync(cwd, { bigint: true });
  } catch (error) {
    throw unreadable(agent, cwd, error);
  }
  identify(agent, cwd, info, identity);
}

function identify(
  agent: ElwoodAgentKind,
  cwd: string,
  info: BigIntStats,
  checked: LaunchDirectoryIdentity,
): LaunchDirectoryIdentity {
  if (!info.isDirectory())
    throw elwoodError(`${agent}_start_failed`, notADirectory, { cwd, errno: "ENOTDIR" });
  const { dev, ino } = info;
  if (checked === undefined || (dev === checked.dev && ino === checked.ino)) return { dev, ino };
  throw elwoodError(`${agent}_start_failed`, replaced, { cwd });
}

function unreadable(agent: ElwoodAgentKind, cwd: string, error: unknown): ElwoodError {
  const message = missingCodes.has(errnoCode(error)) ? notADirectory : uncheckable;
  return elwoodError(`${agent}_start_failed`, message, { cwd, ...causeDetails(error) });
}

/**
 * Checks the captured directory before invoking the callback, then rechecks only if it fails.
 * After successful preflight, callers must invoke this again before any state write or spawn.
 * On callback failure, `cwd` is checked against the directory found first, so one deleted and made
 * again while the operation failed is not taken for the same directory. When that check fails,
 * because `cwd` has gone (state setup never makes it, so it fails with `ENOENT` instead of
 * recreating the project), is no longer a directory, was replaced, or can't be checked, the
 * check's failure is the error, keeping the failed operation's cause and cleanup details (§9.1,
 * §10). While `cwd` is still that directory, the operation's own failure is rethrown.
 */
export async function recheckLaunchDirectoryOnFailure<T>(
  directory: CheckedLaunchDirectory,
  launch: () => Promise<T>,
): Promise<T> {
  const { agent, cwd, identity } = directory;
  const checked = await assertLaunchDirectory(agent, cwd, identity);
  try {
    return await launch();
  } catch (error) {
    await assertLaunchDirectory(agent, cwd, checked).catch((directoryError: ElwoodError) => {
      // `errno` is the check's, so a replaced directory has none, not the launch's.
      const { errno: _launchErrno, ...launched } = launchFailureDetails(error);
      const { errno } = directoryError.details;
      const details = { ...launched, cwd, ...(errno ? { errno } : {}) };
      throw elwoodError(directoryError.code, directoryError.message, details);
    });
    throw error;
  }
}

/** What a failed launch reported: a typed error's details under its message, else its cause. */
function launchFailureDetails(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof ElwoodError
    ? { cause: error.message, ...error.details }
    : causeDetails(error);
}
