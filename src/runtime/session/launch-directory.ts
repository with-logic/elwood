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

/**
 * Rejects unless `cwd` is an existing directory. Start and resume call it before any probe
 * and again after preflight, since the directory can be removed while preflight runs.
 */
export async function assertLaunchDirectory(agent: ElwoodAgentKind, cwd: string): Promise<void> {
  // An unsupported platform stays preflight's first error, ahead of anything about `cwd`.
  if (currentPlatform() !== "darwin") return;
  let message = notADirectory;
  let details: Readonly<Record<string, string>> = { errno: "ENOTDIR" };
  try {
    if ((await stat(cwd)).isDirectory()) return;
  } catch (error) {
    details = causeDetails(error);
    if (!missingCodes.has(errnoCode(error))) message = uncheckable;
  }
  throw elwoodError(`${agent}_start_failed`, message, { cwd, ...details });
}

/**
 * Runs the launch that follows the last check, and checks `cwd` again only if it fails. When
 * that check fails too, because `cwd` has gone (state setup never makes it, so it fails with
 * `ENOENT` instead of recreating the project), is no longer a directory, or can't be checked,
 * the check's failure is the error, keeping the failed launch's cause and cleanup details
 * (§9.1, §10). While `cwd` is still a directory, the launch's own failure is rethrown.
 */
export async function recheckLaunchDirectoryOnFailure<T>(
  agent: ElwoodAgentKind,
  cwd: string,
  launch: () => Promise<T>,
): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    await assertLaunchDirectory(agent, cwd).catch((directoryError: ElwoodError) => {
      const checked = { cwd, errno: directoryError.details["errno"] };
      const details = { ...launchFailureDetails(error), ...checked };
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
