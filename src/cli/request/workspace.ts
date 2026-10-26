/**
 * Validates a run's effective workspace: an absolute, existing directory the current user owns,
 * reached through no directory or link the owner and mode-bit checks find another user could use
 * to replace it before launch. Implements PRD §12A.5, C-CLI-03, and C-CLI-15.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { errnoCode } from "../../core/errors.ts";
import { PathInspectionError, type PathUser, pathReplacementReason } from "./path-replacement.ts";
import { usage } from "./values.ts";

/** Returns `cwd` once it is a workspace Elwood may launch in, else throws a usage error. */
export async function validateWorkspace(cwd: string | undefined): Promise<string> {
  if (cwd === undefined) throw usage("The effective workspace could not be resolved.");
  if (!isAbsolute(cwd)) throw usage(`Workspace '${cwd}' must be an absolute path.`);
  const uid = process.getuid?.();
  const user = uid === undefined ? undefined : { uid, gid: process.getgid!() };
  const { info, replacementReason } = await inspectWorkspace(cwd, user);
  if (!info.isDirectory()) throw usage(`Workspace '${cwd}' is not a directory.`);
  if (uid !== undefined && info.uid !== uid)
    throw usage(`Workspace '${cwd}' must be owned by the current user.`);
  if (replacementReason !== undefined)
    throw usage(`Workspace '${cwd}' could be replaced by another user: ${replacementReason}.`);
  return cwd;
}

/** The workspace and, where there is a POSIX user, any reason another user could redirect it. */
async function inspectWorkspace(cwd: string, user: PathUser | undefined) {
  try {
    // The walk first, so a link that cannot be followed is named rather than failing `stat`.
    const replacementReason = user && (await pathReplacementReason(cwd, user));
    return { info: await stat(cwd), replacementReason };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw usage(`Workspace '${cwd}' does not exist.`);
    if (error instanceof PathInspectionError)
      throw usage(`Workspace '${cwd}' could not be inspected: ${error.message}.`);
    throw usage(`Workspace '${cwd}' could not be inspected.`);
  }
}
