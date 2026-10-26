/**
 * Looks for a way another user could change what a workspace path resolves to between
 * validation and launch. Implements PRD §12A.5 and C-CLI-15.
 *
 * The path is resolved name by name, as the kernel resolves it at spawn, following each symlink.
 * Every directory a name is looked up in must be owned by root or the user and not writable by
 * group or others, unless it is sticky or its group is the user's private group; every
 * directory and symlink passed must be owned by root or the user, since a sticky directory lets
 * other users rename their own entries. Finding nothing means only that these owner and
 * mode-bit checks found nothing: an ACL that grants another user write access, or another
 * member of the user's private group, is not seen. A path whose links cannot be followed
 * safely fails with a `PathInspectionError` that names the link.
 */

import type { Stats } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

/** The user whose launch the path must be safe for. */
export type PathUser = { readonly uid: number; readonly gid: number };

/** The path's links cannot be followed safely; the message names the link and the fix. */
export class PathInspectionError extends Error {
  override readonly name = "PathInspectionError";
}

/** As many symlinks as Linux follows in one path; a loop fails as uninspectable. */
const MAX_LINKS = 40;
const STICKY = 0o1000;
const GROUP_WRITE = 0o020;
const OTHER_WRITE = 0o002;

/**
 * The reason another user could redirect `path`, naming the directory or link that lets them,
 * or `undefined` when the owner and mode-bit checks find none. The workspace itself is the
 * caller's to check.
 */
export async function pathReplacementReason(
  path: string,
  user: PathUser,
): Promise<string | undefined> {
  let current = "/";
  let fault = lookupFault(await lstat(current), user, current);
  const pending = namesOf(path);
  let links = 0;
  for (let name = pending.pop(); fault === undefined && name !== undefined; name = pending.pop()) {
    if (name === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    const info = await lstat(next);
    if (info.isSymbolicLink()) {
      fault = ownerFault(info, user, next, "link");
      if (++links > MAX_LINKS)
        throw new PathInspectionError(
          `symbolic link '${next}' is past the ${MAX_LINKS} links a path may follow, as in a loop; fix the links, or choose a workspace reached without them`,
        );
      const target = await linkTarget(next);
      pending.push(...namesOf(target));
      if (isAbsolute(target)) current = "/";
      continue;
    }
    // The last name is the workspace; every other one is a directory the next name is looked in.
    if (pending.length > 0) fault = lookupFault(info, user, next);
    current = next;
  }
  return fault;
}

/**
 * Why another user could replace an entry of `directory`, or `undefined` if they can't. A
 * group-writable directory is safe only when its group is the user's private group: the user's
 * primary group, numbered like the user, as Debian, Ubuntu and Fedora make them. Root's group 0
 * is a shared system group, never a private one. Another member added to a private group is
 * not seen.
 */
export function lookupFault(
  info: Pick<Stats, "uid" | "gid" | "mode">,
  user: PathUser,
  directory: string,
): string | undefined {
  const owner = ownerFault(info, user, directory, "directory");
  if (owner !== undefined) return owner;
  const privateGroup = user.uid !== 0 && info.gid === user.gid && user.gid === user.uid;
  const writable =
    (info.mode & OTHER_WRITE) !== 0 || ((info.mode & GROUP_WRITE) !== 0 && !privateGroup);
  if (!writable || (info.mode & STICKY) !== 0) return undefined;
  return `directory '${directory}' is writable by other users; remove that with 'chmod go-w', or choose a workspace elsewhere`;
}

function ownerFault(
  info: Pick<Stats, "uid">,
  user: PathUser,
  path: string,
  kind: "directory" | "link",
): string | undefined {
  if (info.uid === 0 || info.uid === user.uid) return undefined;
  return `${kind} '${path}' is owned by another user; choose a workspace reached only through your own or root's directories`;
}

/**
 * The target of the link at `path`. One that is not UTF-8 fails: decoded, it would name another
 * path than the bytes the kernel follows, so the walk could check the wrong directories.
 */
async function linkTarget(path: string): Promise<string> {
  const bytes = await readlink(path, { encoding: "buffer" });
  const target = bytes.toString("utf8");
  if (!Buffer.from(target, "utf8").equals(bytes))
    throw new PathInspectionError(
      `symbolic link '${path}' does not point to a UTF-8 path; point it at one, or choose a workspace reached without it`,
    );
  return target;
}

/** The names of `path`, last first, so the next one to resolve is popped. */
function namesOf(path: string): string[] {
  return path
    .split("/")
    .filter((name) => name !== "" && name !== ".")
    .reverse();
}
